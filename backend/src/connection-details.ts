import {
  Client,
  IFetchResponse,
  MicroserviceClientRequestAuth,
} from "@c8y/client";
import * as http from "http";
import { RCAConfig } from "./model";
import { Request } from "express";
import * as cookieLib from "cookie-parse";
import winston from "winston";
import { IncomingHttpHeaders } from "http";

export class ConnectionDetails {
  client: Client;
  tenant: string;
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
    try {
      this.getConnectionDetailsFromParams(this.req);
    } catch (e) {
      this.logger.error(
        `Failed to get connection details from request params.`,
        {
          errorObj: e,
        }
      );
      throw e;
    }

    this.isWebsocket = !!this.req.headers.upgrade;
    try {
      this.queryParamsString = ConnectionDetails.getQueryParamsFromHeaders(
        this.req.headers
      );
      this.logger.debug(`Generated query params string from headers`, {
        queryParamsString: this.queryParamsString,
      });
    } catch (e) {
      this.logger.error(`Failed to generate query params from headers.`, {
        errorObj: e,
      });
      throw e;
    }

    this.originalHeaders = Object.assign({}, this.req.headers);

    try {
      const { userId, tenantId } = this.getUserAndTenantFromRequest(this.req);
      this.user = userId;
      this.tenant = tenantId;
      this.logger.debug(`Extracted user and tenant from request`, {
        user: this.user,
        tenant: this.tenant,
      });
    } catch (e) {
      this.logger.error(`Failed to extract user and tenant out of request.`, {
        errorObj: e,
      });
      throw e;
    }

    this.client = await this.getTenantDetailsClient(this.req.headers);

    this.logger.debug(`Created tenant details client`);

    try {
      if (this.logger.isDebugEnabled()) {
        this.rcaConfig = await this.getRCAConfig();
        this.logger.debug(`Retrieved RCA Config`, {
          rcaConfig: this.rcaConfig,
        });
      }
    } catch (e) {
      this.logger.warn(`Failed to retrieve RCA Config.`, { errorObj: e });
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
    if (basicAuthPrefix.test(authorization || "")) {
      const basicAuthToken = authorization.replace(basicAuthPrefix, "");
      const decodedToken = Buffer.from(basicAuthToken, "base64").toString();
      const tenantId = decodedToken.replace(/\/.*$/, "");
      const userId = decodedToken.replace(/:.*$/, "").replace(/^.*\//, "");
      const extractDetails = { tenantId, userId };
      this.logger.debug(`Extracted Details (basic)`, { extractDetails });
      return extractDetails;
    }
    let bearerToken = "";
    try {
      const { authorization: authCookie } = cookieLib.parse(cookie || "");
      if (authCookie) {
        bearerToken = authCookie;
      }
    } catch (e) {
      this.logger.error(`Failed to parse cookie.`, { errorObj: e });
      throw e;
    }
    if (!bearerToken && bearerAuthPrefix.test(authorization || "")) {
      bearerToken = authorization.replace(bearerAuthPrefix, "");
    }
    if (!bearerToken) {
      this.logger.debug("No token found to extract user or tenant from.");
      return undefined;
    }

    try {
      const {
        sub,
        ten: tenantId,
      } = JSON.parse(
        Buffer.from(bearerToken.split(".")[1], "base64").toString()
      );
      const extractDetails = {
        tenantId,
        userId: sub
      };

      this.logger.debug(`Extracted Details (bearer)`, { extractDetails });
      return extractDetails;
    } catch (e) {
      this.logger.error(`Failed to parse JSON from bearerToken.`, {
        errorObj: e,
        bearerToken,
      });
      throw e;
    }
  }

  private async getTenantDetailsClient(headers: http.IncomingHttpHeaders) {
    const client = new Client(
      new MicroserviceClientRequestAuth(headers),
      process.env.C8Y_BASEURL
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
    this.logger.debug(`Extracted connection details from request params`, {
      cloudProxyConfigId,
      cloudProxyDeviceId,
    });
  }

  private async getRCAConfig() {
    let response: IFetchResponse;
    try {
      response = await this.client.core.fetch(
        `/service/remoteaccess/devices/${this.cloudProxyDeviceId}/configurations`
      );
    } catch (e) {
      const msg = `Failed to retrieve RCA Configs for device: ${this.cloudProxyDeviceId}`;
      this.logger.error(msg, { errorObj: e });
      throw Error(msg);
    }
    if (response.status !== 200) {
      const msg = `Failed to retrieve RCA Config for device: ${this.cloudProxyDeviceId}, wrong status code: ${response.status}`;
      throw Error(msg);
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
