import winston from "winston";
import { ConnectionDetails } from "./connection-details";
import { RCAConnectionServer } from "./rca-connection-server";

export class RCAServerStore {
  private store = new Map<string, RCAConnectionServer>();
  /** servers being created, so concurrent requests of a session share one server */
  private pending = new Map<string, Promise<RCAConnectionServer>>();

  constructor(private logger: winston.Logger) {}

  async getServer(details: ConnectionDetails, logger: winston.Logger) {
    const id = this.getId(details);

    const fromStore = this.store.get(id);
    if (fromStore) {
      logger.debug("Using existing server");
      fromStore.refreshCredentials(details);
      return fromStore;
    }

    if (details.isWebsocket) {
      // websocket upgrades get a server of their own
      logger.debug("Creating new server.");
      return RCAServerStore.newConnectionServer(this.logger, details, () => {});
    }

    const pending = this.pending.get(id);
    if (pending) {
      return pending;
    }

    logger.debug("Creating new server.");
    const creation = RCAServerStore.newConnectionServer(this.logger, details, () => {
      this.logger.debug("Removing server from store.");
      this.store.delete(id);
    });
    this.pending.set(id, creation);
    try {
      const server = await creation;
      this.store.set(id, server);
      return server;
    } finally {
      this.pending.delete(id);
    }
  }

  static async newConnectionServer(
    logger: winston.Logger,
    connectionDetails: ConnectionDetails,
    closedCallback: () => void
  ) {
    const promise = new Promise<RCAConnectionServer>((resolve) => {
      const newServer = new RCAConnectionServer(
        logger,
        connectionDetails,
        () => resolve(newServer),
        closedCallback
      );
    });
    const newServer = await promise;
    return newServer;
  }

  private getId(details: ConnectionDetails) {
    return `${details.tenant}/${details.user}/${details.cloudProxyDeviceId}/${details.cloudProxyConfigId}/${details.isWebsocket}`;
  }
}
