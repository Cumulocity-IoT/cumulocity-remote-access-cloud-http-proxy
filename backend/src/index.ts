import * as dotenv from "dotenv";
import { createLogger, format, transports } from "winston";
import { CronJob } from "cron";
import { statistics } from "./statistics";
import express from "express";
import { RCAServerStore } from "./rca-server-store";
import * as fs from 'fs';
import { ProxyHandler } from "./proxy";
import { agents } from "./agents";
import { version } from "../package.json";

// cleanup left over sockets
fs.rmSync('sockets', {recursive: true, force: true});
fs.mkdirSync('sockets');

dotenv.config();

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
  defaultMeta: { statistics },
});

const serverStore = new RCAServerStore(logger);
// logger.debug(JSON.stringify(process.env));
const app = express();

app.get("/health", (req, res) => {
  res.status(200).json({
    version,
    memory: process.memoryUsage(),
    agent: agents.http.getCurrentStatus(),
    secureAgent: agents.https.getCurrentStatus(),
  });
});

app.use((req, res, next) => {
  if (
    req.headers.authorization ||
    req.headers.cookie?.includes("authorization")
  ) {
    return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="My Realm"');
  res.status(401).send();
});

app.use("/s/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res) => {
  const handler = new ProxyHandler(logger, req, res, true, serverStore);
  await handler.start();
});

app.use("/:cloudProxyDeviceId/:cloudProxyConfigId/", async (req, res) => {
  const handler = new ProxyHandler(logger, req, res, false, serverStore);
  await handler.start();
});

logger.info(`start listening on port ${process.env.SERVER_PORT}`);
const server = app.listen(process.env.SERVER_PORT);

// disable timeouts as otherwise websocket connections are closed after ~60-90 seconds
server.headersTimeout = 0;
server.requestTimeout = 0;

if (!process.env.NO_STATISTICS) {
  CronJob.from({
    cronTime: "0 * * * * *",
    onTick: () => {
      logger.info("Statistics", {
        memory: process.memoryUsage(),
        agent: agents.http.getCurrentStatus(),
        secureAgent: agents.https.getCurrentStatus(),
      });
    },
    start: true,
  });
}
