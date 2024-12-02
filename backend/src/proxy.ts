import { Logger } from "winston";
import * as express from "express";
import * as http from "http";
import Server, { createProxyServer, ProxyTarget } from "http-proxy";
import { ConnectionDetails } from "./connection-details";
import { RCAConnectionServer } from "./rca-connection-server";
import { statistics } from "./statistics";
import { RCAServerStore } from "./rca-server-store";
import { HeaderAdjustment } from "./header-adjustment";
import { agents } from "./agents";

export class ProxyHandler {
  private logger: Logger;
  private deviceId: string;
  private configId: string;
  constructor(
    logger,
    private request: express.Request<
      {
        cloudProxyDeviceId: string;
      } & {
        cloudProxyConfigId: string;
      }
    >,
    private response: express.Response,
    private secure: boolean,
    private serverStore: RCAServerStore
  ) {
    this.configId = request.params.cloudProxyConfigId;
    this.deviceId = request.params.cloudProxyDeviceId;
    this.logger = logger.child({
      method: request.method,
      url: request.url,
      params: request.params,
    });
  }

  async start() {
    try {
      const hasCustomHost = this.hasCustomHostHeader();
      const target = await this.getTarget();
      const rewriteOptions = this.getRewriteOptions(hasCustomHost);
      const proxy = createProxyServer({
        target,
        agent: this.secure ? agents.https : agents.http,
        secure: false,
        ...rewriteOptions,
      });

      await this.proxyRequest(proxy);
    } catch (e) {
      this.logger.error("Error while proxying request.", { error: e });
      this.response.sendStatus(500);
    }
  }

  private async proxyRequest(proxy: Server) {
    if (this.request.headers.upgrade) {
      this.logger.debug("Handling websocket");
      return await this.handleWebSocket(proxy);
    }

    this.prefixCookiesToBeSet(proxy);

    this.logger.debug("Handling http request");
    await this.handleHttpRequest(proxy);
  }

  private handleHttpRequest(proxy: Server) {
    return new Promise<void>((resolve, reject) => {
      try {
        proxy.web(
          this.request,
          this.response,
          {
            // required as otherwise connection will be closed.
            headers: { connection: "keep-alive" },
          },
          (e) => {
            this.logger.error("Error while proxying", { error: e });
            reject(e);
          }
        );
        this.response.once("finish", () => {
          this.logger.debug("Request finished");
          resolve();
        });
      } catch (e) {
        console.log(e);
        throw e;
      }
    });
  }

  private handleWebSocket(proxy: Server) {
    return new Promise<void>((resolve, reject) => {
      try {
        proxy.ws(
          this.request,
          this.request.socket,
          this.request.headers,
          undefined,
          (e) => {
            this.logger.error("Error while proxying WS", { error: e });
            reject(e);
          }
        );
        this.response.once("finish", () => {
          this.logger.debug("WebSocket finished");
          resolve();
        });
      } catch (e) {
        console.log(e);
        throw e;
      }
    });
  }

  private async getTarget(): Promise<ProxyTarget> {
    let details: ConnectionDetails;
    try {
      details = new ConnectionDetails(this.request, this.logger);
      await details.extractDetails();
    } catch (e) {
      this.logger.error("Failed to retrieve details", {
        e,
        errorMessage: e.errorMessage,
        headers: this.request.headers,
      });
      throw e;
    }

    statistics.totalNumberOfRequests++;
    let rcaConnServer: RCAConnectionServer;
    try {
      rcaConnServer = await this.serverStore.getServer(details, this.logger);
    } catch (e) {
      this.logger.error("Failed to get RCA Server.", { e });
      throw e;
    }

    HeaderAdjustment.adjust(this.request.headers, details);

    const protocol = this.secure ? "https:" : "http:";

    return { socketPath: rcaConnServer.path, protocol };
  }

  private getRewriteOptions(hasCustomHost: boolean): Server.ServerOptions {
    const { "x-forwarded-host": forwardedHost } = this.request.headers;
    return {
      autoRewrite: false,
      changeOrigin: false,
      cookieDomainRewrite:
        typeof forwardedHost === "string"
          ? `.${forwardedHost.replace(/:.*$/, "")}`
          : undefined,
      cookiePathRewrite: `/service/cloud-http-proxy${this.secure ? "/s" : ""}/${
        this.deviceId
      }/${this.configId}/`,
    };
  }

  private hasCustomHostHeader() {
    const headerToLookoutFor = `rca-http-header-host-${this.deviceId}-${this.configId}`;
    return !!this.request.headers[headerToLookoutFor];
  }

  private prefixCookiesToBeSet(
    proxy: Server<
      http.IncomingMessage,
      http.ServerResponse<http.IncomingMessage>
    >
  ) {
    proxy.on("proxyRes", (response) => {
      let location = response.headers.location;
      if (location) {
        const actualProtocol = (this.request.headers["x-forwarded-proto"] as string) || "http";
        let host = this.request.headers.host;
        if (this.request.headers["x-forwarded-host"]) {
        host = this.request.headers["x-forwarded-host"] as string;
        }
        const path = `${process.env.DEV ? '' : '/service/cloud-http-proxy'}${this.secure ? "/s" : ""}/${
            this.deviceId
          }/${this.configId}` as const;
        const url = new URL(location);
        url.protocol = actualProtocol;
        url.host = host;
        url.pathname = `${path}${url.pathname}`;
        let href = url.href;
        response.headers.location = href;
      }
      const cookiesToSet = response.headers["set-cookie"];
      if (!cookiesToSet?.length) {
        return;
      }

      const adjustedCookies = cookiesToSet.map((cookie: string) => {
        return `cloud-http-proxy-${cookie}`;
      });

      response.headers["set-cookie"] = adjustedCookies;
    });
  }
}
