import {
  Client,
  ICurrentTenant,
  ICurrentUser,
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
  currentTenant: ICurrentTenant;
  cloudProxyConfigId: string;
  cloudProxyDeviceId: string;
  rcaConfig: RCAConfig;
  currentUser: ICurrentUser;
  isHealtRequest = false;
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
    await this.getTenantDetailsClient(this.req.headers);
    this.rcaConfig = await this.getRCAConfig();
  }

  private async getTenantDetailsClient(headers: http.IncomingHttpHeaders) {
    const initialClient = new Client(
      new MicroserviceClientRequestAuth(headers),
      process.env.C8Y_BASEURL
    );
    const { data: currentTenant } = await initialClient.tenant.current();
    this.currentTenant = currentTenant;
    const { data: user } = await initialClient.user.current();
    this.currentUser = user;
    const client = new Client(
      new MicroserviceClientRequestAuth(headers),
      `https://${currentTenant.domainName}`
    );
    client.core.tenant = currentTenant.name;
    this.client = client;
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
