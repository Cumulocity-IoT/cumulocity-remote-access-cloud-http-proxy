import {
  Client,
  ICurrentTenant,
  ICurrentUser,
  MicroserviceClientRequestAuth,
} from "@c8y/client";
import * as http from "http";
import { RCAConfig } from "./model";
import { Request } from "express";

export class ConnectionDetails {
  client: Client;
  currentTenant: ICurrentTenant;
  cloudProxyConfigId: string;
  cloudProxyDeviceId: string;
  rcaConfig: RCAConfig;
  currentUser: ICurrentUser;
  isHealtRequest = false;
  isWebsocket = false;

  constructor(
    public req: Request<
      {
        cloudProxyDeviceId: string;
      } & {
        cloudProxyConfigId: string;
      }
    >
  ) {}

  async extractDetails() {
    this.getConnectionDetailsFromParams(this.req);
    this.isWebsocket = !!this.req.headers.upgrade;
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
