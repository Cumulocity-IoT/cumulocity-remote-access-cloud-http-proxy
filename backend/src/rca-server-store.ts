import winston from "winston";
import { ConnectionDetails } from "./connection-details";
import { RCAConnectionServer } from "./rca-connection-server";

export class RCAServerStore {
  private store = new Map<string, RCAConnectionServer>();

  constructor(private logger: winston.Logger) {}

  async getServer(details: ConnectionDetails, logger: winston.Logger) {
    const id = this.getId(details);

    const fromStore = this.store.get(id);
    if (fromStore) {
      logger.debug("Using existing server", {
        serverActiveConnections: fromStore.socketServer.connections,
      });
      return fromStore;
    }

    logger.debug("Creating new server.");
    const server = await RCAServerStore.newConnectionServer(
      this.logger,
      details,
      () => {
        this.logger.debug("Removing server from store.");
        this.store.delete(id);
      },
      id
    );
    if (details.isWebsocket) {
      return server;
    }

    this.store.set(id, server);
    return server;
  }

  static async newConnectionServer(
    logger: winston.Logger,
    connectionDetails: ConnectionDetails,
    closedCallback: () => void,
    id: string
  ) {
    const promise = new Promise<RCAConnectionServer>((resolve) => {
      new RCAConnectionServer(
        logger,
        connectionDetails,
        (server) => resolve(server),
        closedCallback,
        id
      );
    });
    const newServer = await promise;
    return newServer;
  }

  private getId(details: ConnectionDetails) {
    return `${details.tenant}-${details.user}-${details.cloudProxyDeviceId}-${details.cloudProxyConfigId}-${!!details.isWebsocket}`;
  }
}
