import winston from "winston";
import { ConnectionDetails } from "./connection-details";
import { createServer, Server, AddressInfo } from "net";
import { ConnectionHandler } from "./connection-handler";
import { IncomingHttpHeaders } from "http";
import { WebSocket } from "ws";
import { statistics } from "./statistics";

export class RCAConnectionServer {
  available = true;
  socketServer: Server;
  port: number;

  logger: winston.Logger;

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
      const websocket = this.createNewWebsocket();
      statistics.totalNumberOfWebSockets++;
      socket.once("close", () => {
        setTimeout(() => {
          if (!this.socketServer.connections) {
            this.closedCallback();
            setTimeout(() => {
              this.logger.debug("Closing socketServer.");
              this.socketServer.close();
            }, 10_000);
          }
        }, 10_000);
      });
      const handler = new ConnectionHandler(socket, websocket, this.logger);
    }).listen(0, () => {
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
