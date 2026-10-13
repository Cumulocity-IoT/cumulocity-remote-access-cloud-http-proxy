import winston from "winston";
import { ConnectionDetails } from "./connection-details";
import { createServer, Server, AddressInfo, Socket } from "net";
import { ConnectionHandler } from "./connection-handler";
import { IncomingHttpHeaders } from "http";
import { WebSocket } from "ws";
import { statistics } from "./statistics";
import { openTunnel, Tunnel } from "./mux-tunnel";
import { parseConnectionName } from "./connection-name";

/** reads a timeout in seconds from the environment, falling back to the default if unset or invalid */
function timeoutFromEnv(name: string, defaultSeconds: number) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultSeconds * 1000;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.warn(`Ignoring invalid ${name}=${value}, using ${defaultSeconds}s`);
    return defaultSeconds * 1000;
  }
  return seconds * 1000;
}

/**
 * A server (and its multiplexed tunnel) is closed after being idle (no open connection) for this
 * long, in seconds:
 * - RCA_IDLE_TIMEOUT (default 10): without multiplexing
 * - RCA_MULTIPLEX_IDLE_TIMEOUT (default 60): with multiplexing; a multiplexed tunnel is kept longer,
 *   as re-opening it costs a remote access operation
 */
const IDLE_TIMEOUT_MS = timeoutFromEnv("RCA_IDLE_TIMEOUT", 10);
const MULTIPLEX_IDLE_TIMEOUT_MS = timeoutFromEnv("RCA_MULTIPLEX_IDLE_TIMEOUT", 60);

/**
 * Connections to configurations named `http+mux:` / `https+mux:` are carried over a single remote
 * access websocket using yamux (thin-edge.io remote access multiplexing). Devices without support
 * fall back to one websocket per connection. RCA_MULTIPLEX=false disables multiplexing entirely.
 */
const multiplexEnabled = process.env.RCA_MULTIPLEX !== "false";
/** devices/configurations without multiplexing support are not probed again for a while */
const UNSUPPORTED_TTL_MS = 10 * 60_000;
const multiplexUnsupported = new Map<string, number>();

export class RCAConnectionServer {
  available = true;
  socketServer: Server;
  port: number;

  logger: winston.Logger;
  private openConnections = 0;
  private idleTimer?: NodeJS.Timeout;
  private multiplexRequested?: Promise<boolean>;
  private tunnel?: Promise<Tunnel | undefined>;

  constructor(
    logger: winston.Logger,
    public details: ConnectionDetails,
    readyCallback: () => void,
    private closedCallback: () => void
  ) {
    this.logger = logger.child({
      tenantId: this.details.tenant,
      userId: this.details.user,
      deviceId: this.details.cloudProxyDeviceId,
      configId: this.details.cloudProxyConfigId,
      ws: this.details.isWebsocket,
      targetHostname: this.details.rcaConfig?.hostname,
      targetPort: this.details.rcaConfig?.port,
    });
    statistics.totalNumberOfServers++;
    statistics.currentActiveServers++;
    this.socketServer = createServer({ pauseOnConnect: true }, (socket) => {
      // idle tracking (net.Server#connections no longer exists, so it is tracked here)
      this.openConnections++;
      clearTimeout(this.idleTimer);
      socket.once("close", () => {
        this.openConnections--;
        if (this.openConnections === 0) {
          this.scheduleIdleClose();
        }
      });
      this.connect(socket).catch((error) => {
        this.logger.warn("Failed to connect", { error: error?.message });
        socket.destroy();
      });
      // only reachable locally: the tunnel itself is not authenticated
    }).listen(0, "localhost", () => {
      const address = this.socketServer.address() as AddressInfo;
      this.port = address.port;
      this.logger.debug(`New server on port: ${this.port}`);
      readyCallback();
    });
    this.socketServer.once("close", () => {
      this.logger.debug("Server closed");
      statistics.currentActiveServers--;
      this.tunnel?.then((tunnel) => tunnel?.close());
    });
  }

  /** closes the server once it has been idle (no open connection) for the idle timeout */
  private scheduleIdleClose() {
    clearTimeout(this.idleTimer);
    const timeout = this.tunnel ? MULTIPLEX_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => {
      if (this.openConnections > 0) return;
      // no new connections are routed here anymore; close the server shortly after
      this.closedCallback();
      setTimeout(() => {
        this.logger.debug("Closing socketServer.");
        this.socketServer.close();
      }, 10_000).unref();
    }, timeout);
    this.idleTimer.unref();
  }

  private async connect(socket: Socket) {
    if (await this.shouldMultiplex()) {
      const tunnel = await this.getTunnel();
      if (tunnel) {
        tunnel.attach(socket);
        return;
      }
    }
    this.connectPerConnection(socket);
  }

  /** one remote access websocket for this connection */
  private connectPerConnection(socket: Socket) {
    const websocket = this.createNewWebsocket();
    statistics.totalNumberOfWebSockets++;
    new ConnectionHandler(socket, websocket, this.logger);
    socket.resume();
  }

  /** multiplexing is used for configurations named `http+mux:` / `https+mux:` */
  private shouldMultiplex(): Promise<boolean> {
    if (!multiplexEnabled || this.isMultiplexUnsupported()) {
      return Promise.resolve(false);
    }
    this.multiplexRequested ??= this.details.loadRCAConfig().then(
      (config) => !!parseConnectionName(config?.name)?.multiplex,
      (error) => {
        this.logger.warn("Could not read the remote access configuration, not multiplexing", {
          error: error?.message,
        });
        return false;
      }
    );
    return this.multiplexRequested;
  }

  private multiplexKey() {
    const { tenant, cloudProxyDeviceId, cloudProxyConfigId } = this.details;
    return `${tenant}|${cloudProxyDeviceId}|${cloudProxyConfigId}`;
  }

  private isMultiplexUnsupported() {
    const until = multiplexUnsupported.get(this.multiplexKey());
    return until !== undefined && until > Date.now();
  }

  /** the multiplexed tunnel of this server, (re)opened on demand */
  private getTunnel(): Promise<Tunnel | undefined> {
    if (!this.tunnel) {
      statistics.totalNumberOfWebSockets++;
      this.tunnel = openTunnel(() => this.createNewWebsocket(), this.logger).then((tunnel) => {
        if (!tunnel) {
          multiplexUnsupported.set(this.multiplexKey(), Date.now() + UNSUPPORTED_TTL_MS);
          this.tunnel = undefined;
        }
        return tunnel;
      });
    }
    return this.tunnel.then((tunnel) => {
      if (tunnel && !tunnel.isOpen) {
        this.tunnel = undefined;
        return this.getTunnel();
      }
      return tunnel;
    });
  }

  /**
   * Uses the credentials of the latest request of the session for new remote access websockets,
   * as the credentials of the first request might have expired by now
   */
  refreshCredentials(latest: ConnectionDetails) {
    this.details.originalHeaders = latest.originalHeaders;
    this.details.queryParamsString = latest.queryParamsString;
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

    const { cloudProxyDeviceId, cloudProxyConfigId } = this.details;
    const baseUrl = new URL(process.env.C8Y_BASEURL);
    const wsProtocol = baseUrl.protocol === 'https:' ? "wss" : "ws";
    const host = baseUrl.host;
    const url = `${wsProtocol}://${host}/service/remoteaccess/client/${cloudProxyDeviceId}/configurations/${cloudProxyConfigId}${this.details.queryParamsString}`;
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
}
