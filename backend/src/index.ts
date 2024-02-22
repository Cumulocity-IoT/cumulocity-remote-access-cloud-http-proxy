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
import { HttpsAgent } from "agentkeepalive";
import { createProxyMiddleware } from "http-proxy-middleware";

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

const httpsAgent = new HttpsAgent({
  timeout: 60_000, // active socket keepalive for 60 seconds
  freeSocketTimeout: 30_000, // free socket keepalive for 30 seconds
});

logger.debug(JSON.stringify(process.env));
const app = express();

app.get("/health", (req, res) => {
  res.sendStatus(200);
});

app.setMaxListeners(200);

async function getTarget(
  req: express.Request<
    {
      cloudProxyDeviceId: string;
    } & {
      cloudProxyConfigId: string;
    }
  >
) {
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
      params: req.params || {},
      path: req.path,
      url: req.url,
      baseUrl: req.baseUrl,
    });
    // res.status(400).json(e);
    // return;
    throw e;
  }

  statistics.totalNumberOfRequests++;
  let rcaConnServer: RCAConnectionServer;
  try {
    rcaConnServer = await serverStore.getServer(details, requestLogger);
  } catch (e) {
    requestLogger.error("Failed to get RCA Server.", { e });
    // res.status(500).json(e);
    // return;
    throw e;
  }

  HeaderAdjustment.adjust(req.headers, details);

  const protocol = req.path.startsWith("/s/") ? "https" : "http";

  return `${protocol}://localhost:${rcaConnServer.port}`;
}

function hostRewrite(req: express.Request<any>, secure: boolean) {
  let host = req.headers.host;
  if (req.headers["x-forwarded-host"]) {
    host = req.headers["x-forwarded-host"] as string;
  }
  return `${host}/service/cloud-http-proxy${secure ? "/s" : ""}/${
    req.params.cloudProxyDeviceId
  }/${req.params.cloudProxyConfigId}`;
}

app.use(
  "/s/:cloudProxyDeviceId/:cloudProxyConfigId/",
  async (req, res, next) => {
    const handler = createProxyMiddleware({
      router: () => getTarget(req as express.Request<any>),
      agent: httpsAgent,
      changeOrigin: true,
      logProvider: () => logger,
      secure: false,
      pathRewrite: (a, req) => {
        return a.replace(
          `/s/${req.params.cloudProxyDeviceId}/${req.params.cloudProxyConfigId}`,
          ""
        );
      },
      autoRewrite: false,
      hostRewrite: hostRewrite(req, true),
      protocolRewrite: (req.headers["x-forwarded-proto"] as string) || "http",
      ws: false,
    });

    if (req.headers.upgrade) {
      return handler.upgrade(req, req.socket, req.headers);
    }

    return handler(req, res, next);
  }
);

app.use("/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res, next) => {
  const handler = createProxyMiddleware({
    router: () => getTarget(req as express.Request<any>),
    agent: agent,
    changeOrigin: true,
    logProvider: () => logger,
    pathRewrite: (a) => {
      return a.replace(
        `/${req.params.cloudProxyDeviceId}/${req.params.cloudProxyConfigId}`,
        ""
      );
    },
    headers: {
      connection:
        req.headers?.connection === "close"
          ? "keep-alive"
          : req.headers?.connection,
    },
    autoRewrite: false,
    hostRewrite: hostRewrite(req, false),
    protocolRewrite: (req.headers["x-forwarded-proto"] as string) || "http",
    ws: false,
  });

  if (req.headers.upgrade) {
    return handler.upgrade(req, req.socket, req.headers);
  }

  return handler(req, res, next);
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
