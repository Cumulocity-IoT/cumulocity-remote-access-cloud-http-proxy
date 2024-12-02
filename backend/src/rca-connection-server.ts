import winston from "winston";
import { ConnectionDetails } from "./connection-details";
import { createServer, Server, Socket } from "net";
import { ConnectionHandler } from "./connection-handler";
import { IncomingHttpHeaders } from "http";
import { WebSocket } from "ws";
import { statistics } from "./statistics";
import { createHash } from 'crypto';

let counter = 0;
export class RCAConnectionServer {
  private readonly timeoutDuration = 10_000;
  available = true;
  socketServer: Server;

  logger: winston.Logger;
  path: string;

  private closingTimeout: NodeJS.Timeout;
  private annouceClosingTimeout: NodeJS.Timeout;
  private closingAnnounced = false;

  constructor(
    logger: winston.Logger,
    public details: ConnectionDetails,
    readyCallback: (server: RCAConnectionServer) => void,
    private closedCallback: () => void,
    private id: string
  ) {
    counter++;
    const hashedId = createHash('sha256').update(this.id).digest('hex');
    this.path = `sockets/${hashedId}-${counter}.sock`;
    this.logger = logger.child({
      tenantId: this.details.tenant,
      userId: this.details.user,
      deviceId: this.details.cloudProxyDeviceId,
      configId: this.details.cloudProxyConfigId,
      ws: this.details.isWebsocket,
      targetHostname: this.details.rcaConfig?.hostname,
      targetPort: this.details.rcaConfig?.port,
      unixSocketPath: this.path,
    });

    statistics.totalNumberOfServers++;
    statistics.currentActiveServers++;
    this.socketServer = createServer((socket) => this.socketOpened(socket));
    this.socketServer = this.socketServer.listen({ path: this.path }, () => {
      const address = this.socketServer.address();
      this.logger.debug(`New server`, { address });
      readyCallback(this);
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

    const { domain, cloudProxyDeviceId, cloudProxyConfigId } = this.details;
    const url = `wss://${domain}/service/remoteaccess/client/${cloudProxyDeviceId}/configurations/${cloudProxyConfigId}${this.details.queryParamsString}`;
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

  private socketClosed(socket: Socket) {
    this.logger.debug(`Socket closed.`, {
      remainingConnections: this.socketServer.connections,
    });
    if (this.socketServer.connections) {
      return;
    }
    this.clearClosingAnnouncementTimeout();
    this.annouceClosingTimeout = setTimeout(() => {
      if (!this.socketServer.connections) {
        this.announceClosing();
        this.clearClosingTimeout();
        this.closingTimeout = setTimeout(() => {
          this.logger.debug("Closing socketServer.");
          this.socketServer.close();
        }, this.timeoutDuration);
      }
    }, this.timeoutDuration);
  }

  private socketOpened(socket: Socket) {
    this.logger.debug(`Socket opened.`, {currentConnections: this.socketServer.connections})
    this.clearClosingAnnouncementTimeout();
    this.clearClosingTimeout();
    socket.once("close", () => this.socketClosed(socket));
    const websocket = this.createNewWebsocket();
    statistics.totalNumberOfWebSockets++;
    const handler = new ConnectionHandler(socket, websocket, this.logger);
  }

  private clearClosingTimeout() {
    if (this.closingTimeout) {
      clearTimeout(this.closingTimeout);
      this.closingTimeout = undefined;
    }
  }

  private clearClosingAnnouncementTimeout() {
    if (this.annouceClosingTimeout) {
      clearTimeout(this.annouceClosingTimeout);
      this.annouceClosingTimeout = undefined;
    }
  }

  private announceClosing() {
    if (this.closingAnnounced) {
      return;
    }
    this.closedCallback();
    this.closingAnnounced = true;
  }
}
