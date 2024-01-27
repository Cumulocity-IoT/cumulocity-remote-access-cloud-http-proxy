import { v4 as uuidV4 } from "uuid";
import { IncomingHttpHeaders } from "http";
import { Socket } from "net";
import { WebSocket } from "ws";
import * as cookieLib from "cookie-parse";
import {
  Client,
  ICurrentTenant,
  MicroserviceClientRequestAuth,
} from "@c8y/client";
import winston from "winston";
import { RCAConfig } from "./model";

import { statistics } from "./statistics";

export class ConnectionHandler {
  static headerSeparator = /\r?\n\r?\n/;
  connectionId: string;
  headersOfInitialRequest: IncomingHttpHeaders | false;
  partialPayloadOfInitialRequest = "";
  queuedBuffersFromAfterHeaders = new Array<Buffer>();
  webSocket: WebSocket | undefined;
  tenant: ICurrentTenant;
  logger: winston.Logger;
  isHealthEndpoint = false;

  constructor(private socket: Socket, logger: winston.Logger) {
    this.connectionId = uuidV4();
    this.logger = logger.child({ connectionId: this.connectionId });
    this.logger.debug(
      `Connection opened from '${socket.remoteAddress}' port: '${socket.remotePort}'.`
    );
    this.listenForIncomingData();
  }

  listenForIncomingData() {
    this.socket.on("data", async (data) => {
      try {
        this.logger.debug(
          `Message received from socket with length: ${data.length}`
        );
        if (!this.headersOfInitialRequest) {
          this.handleFirstMessagesUntilHeadersAreParsed(data);
          return;
        }

        if (
          this.headersOfInitialRequest &&
          (!this.webSocket || this.webSocket.readyState !== WebSocket.OPEN)
        ) {
          this.queuedBuffersFromAfterHeaders.push(data);
          return;
        } else if (this.headersOfInitialRequest && this.webSocket) {
          this.webSocket.send(data);
          return;
        }
      } catch (e) {}
    });
  }

  private handleFirstMessagesUntilHeadersAreParsed(data: Buffer) {
    this.partialPayloadOfInitialRequest += data.toString();
    const headerLines = ConnectionHandler.getHeaderLines(
      this.partialPayloadOfInitialRequest
    );
    this.headersOfInitialRequest =
      ConnectionHandler.parseHeadersIntoObject(headerLines);
    if (!headerLines || !this.headersOfInitialRequest) {
      return;
    }

    const connectionDetails = this.getConnectionDetailsFromCookie(
      this.headersOfInitialRequest
    );

    if (
      !connectionDetails.cloudProxyConfigId &&
      !connectionDetails.cloudProxyDeviceId
    ) {
      if (headerLines[0]?.includes("GET /health ")) {
        this.isHealthEndpoint = true;
        this.answerHealthRequest();
        return;
      } else {
        this.socket.write(
          Buffer.from("HTTP/1.1 418\r\nContent-Length: 0\r\n\r\n")
        );
        this.socket.end();
        return;
      }
    }

    this.logger.info(`Received request for: '${headerLines[0]}'`);
    statistics.totalNumberOfConnections++;
    this.getRCAWebsocketForRequest(
      connectionDetails,
      this.headersOfInitialRequest
    ).then(
      (socket) => {
        this.webSocket = socket;
        this.passDataFromWebsocketToSocket(this.webSocket);
        this.sendCachedDataFromInitialRequest(this.webSocket);
        this.handleConnctionClose(this.webSocket);
      },
      (error) => {
        this.logger.error(`Error.`);
        this.logger.error(error);
        this.socket.write(
          Buffer.from(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n"
          )
        );
        this.socket.end();
      }
    );
  }

  private answerHealthRequest() {
    this.logger.debug(`Recevied message for health.`);
    this.socket.write(
      Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
    );
    this.socket.end();
  }

  private passDataFromWebsocketToSocket(webSocket: WebSocket) {
    webSocket.on("message", (msg) => {
      this.logger.debug(`Message received from Websocket`);
      if (Array.isArray(msg)) {
        msg.forEach((bufmsg) => {
          this.socket.write(bufmsg);
        });
      } else if (msg instanceof Buffer) {
        this.socket.write(msg);
      } else {
        this.socket.write(Buffer.from(msg));
      }
    });
  }

  private sendCachedDataFromInitialRequest(webSocket: WebSocket) {
    webSocket.once("open", () => {
      webSocket.send(
        Buffer.from(this.partialPayloadOfInitialRequest, "binary")
      );
      this.partialPayloadOfInitialRequest = "";
      this.queuedBuffersFromAfterHeaders.forEach((buf) => {
        webSocket.send(buf);
      });
      this.queuedBuffersFromAfterHeaders = [];
    });
  }

  private handleConnctionClose(webSocket: WebSocket) {
    webSocket.once("close", () => {
      this.logger.debug(`Socket closed by Websocket`);
      this.socket.end();
    });

    webSocket.once("error", (e) => {
      this.logger.warn(`Error from Websocket`);
      this.logger.warn(e);
      this.socket.end();
    });

    this.socket.once("close", () => {
      this.logger.debug(`Socket closed by Socket`);
      webSocket.close();
    });

    this.socket.once("error", (e) => {
      this.logger.warn(`Error from Socket`);
      this.logger.warn(e);
      webSocket.close();
    });
  }

  private async getRCAWebsocketForRequest(
    connectionDetails: {
      cloudProxyDeviceId: string;
      cloudProxyConfigId: string;
    },
    headers: IncomingHttpHeaders
  ) {
    const { cloudProxyDeviceId, cloudProxyConfigId } = connectionDetails;
    if (!cloudProxyConfigId || !cloudProxyDeviceId) {
      throw Error("device and config id must be present.");
    }
    this.logger.debug(
      `Parsed deviceId: '${cloudProxyDeviceId}' and configId: '${cloudProxyConfigId}' from headers of initial request.`
    );
    let client: Client;
    try {
      const details = await this.getTenantDetailsClient(headers);
      client = details.client;
      this.tenant = details.currentTenant;
      this.logger.info(
        `Incoming request from tenant: ${this.tenant.name} (${this.tenant.domainName})`
      );
    } catch (e) {
      throw Error("Failed to retrieve tenant id for incoming request.");
    }

    const rcaConfig = await this.getRCAConfig(
      client,
      cloudProxyDeviceId,
      cloudProxyConfigId
    );

    this.logger.info(
      `Trying to establish a connection to '${rcaConfig.hostname}' on port '${rcaConfig.port}'`
    );

    const socket = this.createSocket(
      headers,
      this.tenant,
      cloudProxyDeviceId,
      cloudProxyConfigId
    );

    return socket;
  }

  private getConnectionDetailsFromCookie(headers: IncomingHttpHeaders) {
    const cookie = headers.cookie || "";
    const parsedCookies = cookieLib.parse(cookie);
    const { cloudProxyDeviceId, cloudProxyConfigId } = parsedCookies;
    return { cloudProxyConfigId, cloudProxyDeviceId };
  }

  private async getRCAConfig(
    client: Client,
    deviceId: string,
    configId: string
  ) {
    const response = await client.core.fetch(
      `/service/remoteaccess/devices/${deviceId}/configurations`
    );
    if (response.status !== 200) {
      throw Error(`Failed to retrieve RCA Config for device: ${deviceId}`);
    }

    const configs: RCAConfig[] = await response.json();
    const config = configs.find((conf) => conf.id === configId);
    if (!config) {
      throw Error(
        `RCA Config ${configId} does not exist for device ${deviceId}`
      );
    }
    return config;
  }

  private createSocket(
    headers: IncomingHttpHeaders,
    tenant: ICurrentTenant,
    deviceId: string,
    configId: string
  ) {
    const { cookie, authorization } = headers;
    const queryParams = ConnectionHandler.getQueryParamsFromHeaders(headers);
    const webSocketHeaders: IncomingHttpHeaders = {};
    if (cookie) {
      webSocketHeaders.cookie = cookie;
    }
    if (authorization) {
      webSocketHeaders.authorization = authorization;
    }

    const url = `wss://${tenant.domainName}/service/remoteaccess/client/${deviceId}/configurations/${configId}${queryParams}`;
    const socket = new WebSocket(url, ["binary"], {
      headers: webSocketHeaders,
    });

    socket.on("open", () => {
      if (socket) {
        this.logger.debug(
          `Successfully established websocket connection to ${url}`
        );
      }
    });

    return socket;
  }

  private static getQueryParamsFromHeaders(headers: IncomingHttpHeaders) {
    const { Authorization: token, "X-XSRF-TOKEN": xsrf, cookie } = headers;
    const { "XSRF-TOKEN": xsrf2 } = cookieLib.parse(cookie);
    const queryParams: { token?: string; "XSRF-TOKEN"?: string } = {};
    if (token && token !== "Basic ") {
      Object.assign(queryParams, { token });
    }
    if (xsrf || xsrf2) {
      Object.assign(queryParams, { "XSRF-TOKEN": xsrf || xsrf2 });
    }

    let queryParamsString = "";
    if (Object.keys(queryParams).length) {
      queryParamsString =
        "?" +
        Object.keys(queryParams)
          .map((key) => `${key}=${queryParams[key]}`)
          .join("&");
    }
    return queryParamsString;
  }

  private async getTenantDetailsClient(headers: IncomingHttpHeaders) {
    const initialCLient = new Client(
      new MicroserviceClientRequestAuth(headers),
      process.env.C8Y_BASEURL
    );
    const { data: currentTenant } = await initialCLient.tenant.current();
    const client = new Client(
      new MicroserviceClientRequestAuth(headers),
      `https://${currentTenant.domainName}`
    );
    client.core.tenant = currentTenant.name;
    return { client, currentTenant };
  }

  private static getHeaderLines(partial: string): string[] | false {
    const headerSection = this.getHeaderSection(partial);
    if (headerSection === false) {
      return false;
    }

    const headerLines = headerSection.split(/\r?\n/);
    return headerLines;
  }

  private static getHeaderSection(partial: string): string | false {
    const [headerSection] = partial.split(this.headerSeparator, 1);
    if (headerSection === undefined) {
      return false;
    }
    return headerSection;
  }

  private static parseHeadersIntoObject(
    headerLines: string[] | false
  ): false | IncomingHttpHeaders {
    if (headerLines === false) {
      return false;
    }

    const keyValueSeparator = ": ";
    const headers = headerLines.reduceRight((prev, currentLine) => {
      if (!currentLine.includes(keyValueSeparator)) {
        return prev;
      }
      const [unknownCasingKey, ...values] =
        currentLine.split(keyValueSeparator);
      const lowerCaseKey = unknownCasingKey.toLowerCase();

      const value = values.join(keyValueSeparator);
      const currentEntry = prev[lowerCaseKey];
      if (typeof currentEntry === "string") {
        if (currentEntry !== value) {
          prev[lowerCaseKey] = [currentEntry, value];
        }
      } else if (Array.isArray(currentEntry)) {
        currentEntry.push(value);
      } else {
        prev[lowerCaseKey] = value;
      }

      return prev;
    }, {} as IncomingHttpHeaders);
    return headers;
  }
}
