import { v4 as uuidV4 } from "uuid";
import { Socket } from "net";
import { WebSocket, createWebSocketStream } from "ws";
import winston from "winston";

export class ConnectionHandler {
  connectionId: string;
  queuedBuffersFromAfterHeaders = new Array<Buffer>();
  logger: winston.Logger;
  firstPacketFromSocket = true;
  firstPackaetFromWebSocket = true;

  constructor(
    private socket: Socket,
    private webSocket: WebSocket,
    logger: winston.Logger
  ) {
    this.connectionId = uuidV4();
    this.logger = logger.child({ connectionId: this.connectionId });

    const websocketStream = createWebSocketStream(this.webSocket);
    this.socket.setKeepAlive(true);
    this.socket.pipe(websocketStream);
    websocketStream.pipe(this.socket);

    this.socket.once("close", () => {
      this.logger.debug("Socket closed");
      this.closed();
    });

    this.socket.once("error", (error) => {
      this.logger.debug("SOcket error", { error });
      this.closed();
    });

    websocketStream.once("close", () => {
      this.logger.debug("Websocket closed");
      this.closed();
    });

    websocketStream.once("error", (error) => {
      this.logger.debug("Websocket error", { error });
      this.closed();
    });
  }

  private closed() {
    this.removeListeners();
  }

  private removeListeners() {
    this.webSocket.removeAllListeners();
    this.socket.removeAllListeners();
  }
}
