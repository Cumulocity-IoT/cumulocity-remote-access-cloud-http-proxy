import winston from "winston";
import { ConnectionDetails } from "./connection-details";
import { createServer, Server, AddressInfo } from "net";
import { ConnectionHandler } from "./connection-handler";
import { IncomingHttpHeaders } from "http";
import { WebSocket } from "ws";
import { statistics } from "./statistics";

/** reads a timeout in seconds from the environment, falling back to the default if unset or invalid */
function timeoutFromEnv(name: string, defaultSeconds: number) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultSeconds * 1000;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.warn(`Ignoring invalid ${name}=${value}, using ${defaultSeconds}s`);
    return defaultSeconds * 1000;
  }
  return seconds * 1000;
}

/**
 * A server is closed after being idle (no open connection) for RCA_IDLE_TIMEOUT seconds (default 10)
 */
const IDLE_TIMEOUT_MS = timeoutFromEnv("RCA_IDLE_TIMEOUT", 10);

export class RCAConnectionServer {
  available = true;
  socketServer: Server;
  port: number;

  logger: winston.Logger;
  private openConnections = 0;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    logger: winston.Logger,
    public details: ConnectionDetails,
    readyCallback: () => void,
    private closedCallback: () => void
  ) {
    this.logger = logger.child({
      tenantId: this.details.tenant,
      userId: this.details.user,
      deviceId: this.details.cloudProxyDeviceId,
      configId: this.details.cloudProxyConfigId,
      ws: this.details.isWebsocket,
      targetHostname: this.details.rcaConfig?.hostname,
      targetPort: this.details.rcaConfig?.port,
    });
    statistics.totalNumberOfServers++;
    statistics.currentActiveServers++;
    this.socketServer = createServer((socket) => {
      // idle tracking (net.Server#connections no longer exists, so it is tracked here)
      this.openConnections++;
      clearTimeout(this.idleTimer);
      socket.once("close", () => {
        this.openConnections--;
        if (this.openConnections === 0) {
          this.scheduleIdleClose();
        }
      });
      const websocket = this.createNewWebsocket();
      statistics.totalNumberOfWebSockets++;
      new ConnectionHandler(socket, websocket, this.logger);
      // only reachable locally: the tunnel itself is not authenticated
    }).listen(0, "localhost", () => {
      const address = this.socketServer.address() as AddressInfo;
      this.port = address.port;
      this.logger.debug(`New server on port: ${this.port}`);
      readyCallback();
    });
    this.socketServer.once("close", () => {
      this.logger.debug("Server closed");
      statistics.currentActiveServers--;
    });
  }

  /** closes the server once it has been idle (no open connection) for the idle timeout */
  private scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.openConnections > 0) return;
      // no new connections are routed here anymore; close the server shortly after
      this.closedCallback();
      setTimeout(() => {
        this.logger.debug("Closing socketServer.");
        this.socketServer.close();
      }, 10_000).unref();
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  /**
   * Uses the credentials of the latest request of the session for new remote access websockets,
   * as the credentials of the first request might have expired by now
   */
  refreshCredentials(latest: ConnectionDetails) {
    this.details.originalHeaders = latest.originalHeaders;
    this.details.queryParamsString = latest.queryParamsString;
  }

  createNewWebsocket() {
    const headers = this.details.originalHeaders;
    const { cookie, authorization } = headers;

    const webSocketHeaders: IncomingHttpHeaders = {};
    if (cookie) {
      webSocketHeaders.cookie = cookie;
    }
    if (authorization) {
      webSocketHeaders.authorization = authorization;
    }

    const { cloudProxyDeviceId, cloudProxyConfigId } = this.details;
    const baseUrl = new URL(process.env.C8Y_BASEURL);
    const wsProtocol = baseUrl.protocol === 'https:' ? "wss" : "ws";
    const host = baseUrl.host;
    const url = `${wsProtocol}://${host}/service/remoteaccess/client/${cloudProxyDeviceId}/configurations/${cloudProxyConfigId}${this.details.queryParamsString}`;
    const socket = new WebSocket(url, ["binary"], {
      headers: webSocketHeaders,
    });

    socket.once("open", () => {
      this.logger.debug(
        `Successfully established websocket connection to ${url}`
      );
    });

    socket.once("unexpected-response", (clientRequest) => {
      this.logger.warn(`unexpected-response websocket connection to ${url}`, {
        clientRequest,
      });
    });

    return socket;
  }
}
