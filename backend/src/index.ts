import * as dotenv from "dotenv";
import { createServer } from "net";
import { ConnectionHandler } from "./connection-handler";
import { createLogger, format, transports } from "winston";
import { CronJob } from "cron";
import { statistics } from "./statistics";

dotenv.config();

const logger = createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: format.combine(format.timestamp(), format.json()),
  transports: [new transports.Console()],
});

logger.debug(JSON.stringify(process.env));

const socketServer = createServer().listen(process.env.SERVER_PORT);

socketServer.on("connection", async (socket) => {
  const handler = new ConnectionHandler(socket, logger);
  statistics.currentActiveConnections++;
  logActiveConnections();
  socket.once("close", () => {
    statistics.currentActiveConnections--;
    logActiveConnections();
  });
});

function logActiveConnections() {
  logger.debug(
    `Total number of active connections: ${statistics.currentActiveConnections}`
  );
}

CronJob.from({
  cronTime: "0 * * * * *",
  onTick: () => {
    logger.info(
      `Total number of active connections: ${statistics.currentActiveConnections}, connections handled in total: ${statistics.totalNumberOfConnections}`
    );
    logger.debug(`Current memory usage`, process.memoryUsage());
  },
  start: true,
});
