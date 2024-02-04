import { Client, MicroserviceClientRequestAuth } from "@c8y/client";
import * as http from "http";
import { RCAConfig } from "./model";
import { Request } from "express";
import * as cookieLib from "cookie-parse";
import winston from "winston";
import { IncomingHttpHeaders } from "http";

const domainCache = new Map<string, string>();

export class ConnectionDetails {
  client: Client;
  tenant: string;
  domain: string;
  cloudProxyConfigId: string;
  cloudProxyDeviceId: string;
  rcaConfig: RCAConfig | undefined;
  user: string;
  isWebsocket = false;
  queryParamsString = "";
  originalHeaders: IncomingHttpHeaders = {};

  constructor(
    public req: Request<
      {
        cloudProxyDeviceId: string;
      } & {
        cloudProxyConfigId: string;
      }
    >,
    private logger: winston.Logger
  ) {}

  async extractDetails() {
    this.getConnectionDetailsFromParams(this.req);
    this.isWebsocket = !!this.req.headers.upgrade;
    this.queryParamsString = ConnectionDetails.getQueryParamsFromHeaders(
      this.req.headers
    );
    this.originalHeaders = Object.assign({}, this.req.headers);

    const { userId, tenantId, domain } = this.getUserAndTenantFromRequest(
      this.req
    );

    this.user = userId;
    this.tenant = tenantId;
    this.domain = domain;

    this.client = await this.getTenantDetailsClient(this.req.headers, domain);

    if (this.logger.isDebugEnabled()) {
      this.rcaConfig = await this.getRCAConfig();
    }
  }

  private getUserAndTenantFromRequest(req: Request) {
    const basicAuthPrefix = /^Basic\s/;
    const bearerAuthPrefix = /^Bearer\s/;
    const {
      authorization,
      cookie,
      "x-forwarded-host": forwardedHost,
    } = req.headers;
    const host = Array.isArray(forwardedHost)
      ? forwardedHost[0]
      : forwardedHost;
    let domain = host?.replace(/:.*$/, "") || "";
    if (basicAuthPrefix.test(authorization || "")) {
      const basicAuthToken = authorization.replace(basicAuthPrefix, "");
      const decodedToken = Buffer.from(basicAuthToken, "base64").toString();
      const tenantId = decodedToken.replace(/\/.*$/, "");
      const userId = decodedToken.replace(/:.*$/, "").replace(/^.*\//, "");
      const extractDetails = { tenantId, userId, domain };
      this.logger.debug(`Extracted Details (basic)`, { extractDetails });
      return extractDetails;
    }
    let bearerToken = "";
    if (bearerAuthPrefix.test(authorization || "")) {
      bearerToken = authorization.replace(bearerAuthPrefix, "");
    } else {
      const { authorization: authCookie } = cookieLib.parse(cookie || "");
      if (authCookie) {
        bearerToken = authCookie;
      }
    }
    if (!bearerToken) {
      return undefined;
    }

    const {
      iss,
      aud,
      sub,
      ten: tenantId,
    } = JSON.parse(Buffer.from(bearerToken.split(".")[1], "base64").toString());

    const extractDetails = {
      tenantId,
      userId: sub,
      domain: iss || aud || domain,
    };

    this.logger.debug(`Extracted Details (bearer)`, { extractDetails });
    return extractDetails;
  }

  private async getTenantDetailsClient(
    headers: http.IncomingHttpHeaders,
    domain?: string
  ) {
    if (!domain) {
      const initialClient = new Client(
        new MicroserviceClientRequestAuth(headers),
        process.env.C8Y_BASEURL
      );

      const domainFromCache = domainCache.get(this.tenant);
      if (domainFromCache) {
        domain = domainFromCache;
      } else {
        const { data: currentTenant } = await initialClient.tenant.current();

        domain = currentTenant.domainName;
        domainCache.set(this.tenant, domain);
      }
    }

    this.domain = domain;

    const client = new Client(
      new MicroserviceClientRequestAuth(headers),
      `https://${domain}`
    );
    client.core.tenant = this.tenant;
    return client;
  }

  private static getQueryParamsFromHeaders(headers: http.IncomingHttpHeaders) {
    let { authorization: token, "x-xsrf-token": xsrf, cookie } = headers;
    const { "XSRF-TOKEN": xsrf2 } = cookieLib.parse(cookie || "");

    const queryParams: { token?: string; "XSRF-TOKEN"?: string } = {};
    if (token && token !== "Basic ") {
      token = token.replace(/^Basic\s/, "");
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

  private getConnectionDetailsFromParams(
    req: Request<
      {
        cloudProxyDeviceId: string;
      } & {
        cloudProxyConfigId: string;
      }
    >
  ) {
    const { cloudProxyDeviceId, cloudProxyConfigId } = req.params;
    this.cloudProxyConfigId = cloudProxyConfigId;
    this.cloudProxyDeviceId = cloudProxyDeviceId;
  }

  private async getRCAConfig() {
    const response = await this.client.core.fetch(
      `/service/remoteaccess/devices/${this.cloudProxyDeviceId}/configurations`
    );
    if (response.status !== 200) {
      throw Error(
        `Failed to retrieve RCA Config for device: ${this.cloudProxyDeviceId}`
      );
    }

    const configs: RCAConfig[] = await response.json();
    const config = configs.find((conf) => conf.id === this.cloudProxyConfigId);
    if (!config) {
      throw Error(
        `RCA Config ${this.cloudProxyConfigId} does not exist for device ${this.cloudProxyDeviceId}`
      );
    }
    return config;
  }
}
