import * as dotenv from "dotenv";
import { createLogger, format, transports } from "winston";
import { CronJob } from "cron";
import { statistics } from "./statistics";
import { createProxyServer } from "http-proxy";
import { ConnectionDetails } from "./connection-details";
import { RCAConnectionServer } from "./rca-connection-server";
import express from "express";
import { HeaderAdjustment } from "./header-adjustment";

dotenv.config();

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
  defaultMeta: { statistics },
});

logger.debug(JSON.stringify(process.env));
const app = express();

app.get("/health", (req, res) => {
  res.sendStatus(200);
});

app.use("/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res) => {
  // if (process.env.FALLBACK_COOKIE && !req.headers.cookie) {
  //   req.headers.cookie = process.env.FALLBACK_COOKIE;
  // }
  let details: ConnectionDetails;
  try {
    details = new ConnectionDetails(req, logger);
    await details.extractDetails();
  } catch (e) {
    logger.error("Failed to retrieve details", {
      e,
      headers: req.headers,
      params: req.params,
    });
    res.status(400).json(e);
    return;
  }

  statistics.totalNumberOfRequests++;
  // You can define here your custom logic to handle the request
  // and then proxy the request.
  let rcaConnServer: RCAConnectionServer;
  try {
    rcaConnServer = await RCAConnectionServer.newConnectionServer(
      logger,
      details
    );
  } catch (e) {
    res.status(500).json(e);
    return;
  }

  const extraHeaders = {};
  if (req.headers.connection) {
    extraHeaders["Connection"] = "keep-alive";
  }

  HeaderAdjustment.adjust(req.headers, details);

  const proxy = createProxyServer({
    target: { host: "127.0.0.1", port: rcaConnServer.port },
  });

  try {
    if (req.headers.upgrade) {
      proxy.ws(req, req.socket, req.headers, undefined, (e) => {
        logger.error("Error while proxying WS", { error: e });
      });
      return;
    }
    proxy.web(
      req,
      res,
      {
        headers: extraHeaders,
      },
      (e) => {
        logger.error("Error while proxying", { error: e });
        proxy.web(req, res, {
          headers: extraHeaders,
        });
      }
    );
  } catch (e) {
    logger.error(e);
    res.sendStatus(500);
    return;
  }
});

logger.info(`start listening on port ${process.env.SERVER_PORT}`);
app.listen(process.env.SERVER_PORT);

CronJob.from({
  cronTime: "0 * * * * *",
  onTick: () => {
    logger.info("Statistics", { memory: process.memoryUsage() });
  },
  start: true,
});
