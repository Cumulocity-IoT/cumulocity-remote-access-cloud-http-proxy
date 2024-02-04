import * as dotenv from "dotenv";
import { createLogger, format, transports } from "winston";
import { CronJob } from "cron";
import { statistics } from "./statistics";
import { createProxyServer } from "http-proxy";
import { ConnectionDetails } from "./connection-details";
import { RCAConnectionServer } from "./rca-connection-server";
import express from "express";
import { HeaderAdjustment } from "./header-adjustment";
import { RCAServerStore } from "./rca-server-store";
import Agent from "agentkeepalive";

dotenv.config();

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
  defaultMeta: { statistics },
});

const serverStore = new RCAServerStore(logger);
const agent = new Agent({
  timeout: 60_000, // active socket keepalive for 60 seconds
  freeSocketTimeout: 30_000, // free socket keepalive for 30 seconds
});

logger.debug(JSON.stringify(process.env));
const app = express();

app.get("/health", (req, res) => {
  res.sendStatus(200);
});

app.use("/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res) => {
  const requestLogger = logger.child({
    method: req.method,
    url: req.url,
    params: req.params,
  });
  let details: ConnectionDetails;
  try {
    details = new ConnectionDetails(req, requestLogger);
    await details.extractDetails();
  } catch (e) {
    requestLogger.error("Failed to retrieve details", {
      e,
      headers: req.headers,
    });
    res.status(400).json(e);
    return;
  }

  statistics.totalNumberOfRequests++;
  let rcaConnServer: RCAConnectionServer;
  try {
    rcaConnServer = await serverStore.getServer(details, requestLogger);
  } catch (e) {
    requestLogger.error("Failed to get RCA Server.", { e });
    res.status(500).json(e);
    return;
  }

  HeaderAdjustment.adjust(req.headers, details);

  const proxy = createProxyServer({
    target: { host: "127.0.0.1", port: rcaConnServer.port },
    agent,
  });

  try {
    if (req.headers.upgrade) {
      proxy.ws(req, req.socket, req.headers, undefined, (e) => {
        requestLogger.error("Error while proxying WS", { error: e });
        proxy.ws(req, req.socket, req.headers);
      });
      return;
    }

    proxy.web(
      req,
      res,
      {
        // required as otherwise connection will be closed.
        headers: { connection: "keep-alive" },
      },
      (e) => {
        requestLogger.error("Error while proxying", { error: e });
        // res.sendStatus(500);
        proxy.web(req, res);
      }
    );
  } catch (e) {
    requestLogger.error("catch block", { error: e });
    res.sendStatus(500);
    return;
  }
});

logger.info(`start listening on port ${process.env.SERVER_PORT}`);
app.listen(process.env.SERVER_PORT);

CronJob.from({
  cronTime: "0 * * * * *",
  onTick: () => {
    logger.info("Statistics", {
      memory: process.memoryUsage(),
      agent: agent.getCurrentStatus(),
    });
  },
  start: true,
});
