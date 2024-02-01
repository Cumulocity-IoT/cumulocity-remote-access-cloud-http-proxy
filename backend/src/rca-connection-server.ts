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
    readyCallback: () => void
  ) {
    this.logger = logger.child({
      tenantId: this.details.currentTenant.name,
      userId: this.details.currentUser.id,
      deviceId: this.details.cloudProxyDeviceId,
      configId: this.details.cloudProxyConfigId,
      ws: this.details.isWebsocket,
      targetHostname: this.details.rcaConfig.hostname,
      targetPort: this.details.rcaConfig.port,
      method: this.details.req.method,
      url: this.details.req.url,
      requestId: this.details.req.headers["x-request-id"],
      connection: this.details.req.headers.connection,
      payloadLength: this.details.req.headers["content-length"],
    });
    statistics.totalNumberOfServers++;
    statistics.currentActiveServers++;
    this.socketServer = createServer((socket) => {
      const websocket = this.createNewWebsocket();
      const handler = new ConnectionHandler(socket, websocket, this.logger);
      this.socketServer.close();
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

    const { currentTenant, cloudProxyDeviceId, cloudProxyConfigId } =
      this.details;
    const url = `wss://${currentTenant.domainName}/service/remoteaccess/client/${cloudProxyDeviceId}/configurations/${cloudProxyConfigId}${this.details.queryParamsString}`;
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

  static async newConnectionServer(
    logger: winston.Logger,
    connectionDetails: ConnectionDetails
  ) {
    const promise = new Promise<RCAConnectionServer>((resolve) => {
      const newServer = new RCAConnectionServer(logger, connectionDetails, () =>
        resolve(newServer)
      );
    });
    const newServer = await promise;
    return newServer;
  }
}
