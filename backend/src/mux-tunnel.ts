import { Socket } from "net";
import { WebSocket } from "ws";
import winston from "winston";

/**
 * Client side of remote access multiplexing (e.g. thin-edge.io remote access plugin): many TCP
 * connections carried over ONE remote access websocket using yamux (one remote access operation
 * per session instead of one per connection).
 *
 * The protocol is negotiated in-band with multistream-select
 * (https://github.com/multiformats/multistream-select): the client proposes YAMUX_PROTOCOL and
 * starts a yamux session (https://github.com/hashicorp/yamux/blob/master/spec.md) once the device
 * confirms it. Devices without multiplexing support forward the negotiation to the target instead;
 * any other response (or none) means "not supported" and the caller falls back to one websocket
 * per connection.
 *
 * Provided by @chainsafe/libp2p-yamux and @libp2p/multistream-select (ESM only, loaded with a
 * dynamic import).
 */
export const YAMUX_PROTOCOL = "/yamux/1.0.0";
const NEGOTIATION_TIMEOUT_MS = 5_000;
/** websocket send buffer above which the yamux session is told to wait for a drain */
const MAX_WEBSOCKET_BUFFER = 1024 * 1024;
const DRAIN_POLL_MS = 10;

/** a multiplexed remote access session, carrying local TCP connections as streams */
export interface Tunnel {
  readonly isOpen: boolean;
  attach(socket: Socket): void;
  close(): void;
}

// the ESM-only libp2p modules; `import()` must not be rewritten to `require()` by TypeScript
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
type Libraries = { yamux: any; AbstractMessageStream: any; logger: any; select: any; handle: any };
let libraries: Promise<Libraries> | undefined;
function loadLibraries() {
  libraries ??= Promise.all([
    importEsm("@chainsafe/libp2p-yamux"),
    importEsm("@libp2p/utils"),
    importEsm("@libp2p/logger"),
    importEsm("@libp2p/multistream-select"),
  ]).then(([yamux, utils, logger, mss]) => ({
    yamux: yamux.yamux,
    AbstractMessageStream: utils.AbstractMessageStream,
    logger: logger.logger,
    select: mss.select,
    handle: mss.handle,
  }));
  return libraries;
}

/**
 * Opens a websocket and negotiates multiplexing. Resolves to undefined if the device does not
 * support it (the websocket is closed again).
 */
export async function openTunnel(
  createWebsocket: () => WebSocket,
  logger: winston.Logger
): Promise<Tunnel | undefined> {
  const libs = await loadLibraries();
  const ws = createWebsocket();
  try {
    await websocketOpened(ws);
    const transport = createWebSocketMessageStream(libs, ws, "outbound");
    await libs.select(transport, [YAMUX_PROTOCOL], { signal: AbortSignal.timeout(NEGOTIATION_TIMEOUT_MS) });
    logger.info("Multiplexing enabled for remote access session");
    return new YamuxTunnel(createMuxer(libs, transport), ws, logger);
  } catch (error) {
    logger.info(`Multiplexing not available: ${error?.message}`);
    ws.terminate();
    return undefined;
  }
}

function websocketOpened(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (error) => reject(new Error(`websocket error: ${error.message}`)));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected response ${res.statusCode}`)));
    ws.once("close", (code) => reject(new Error(`websocket closed (code ${code})`)));
  });
}

/**
 * Device side of the negotiation, for tests: accepts multiplexing on a websocket whose first
 * message(s) `received` have already been read, and returns the yamux session.
 */
export async function acceptMultiplexing(ws: WebSocket, received: Buffer) {
  const libs = await loadLibraries();
  const transport = createWebSocketMessageStream(libs, ws, "inbound");
  transport.onData(received);
  await libs.handle(transport, [YAMUX_PROTOCOL]);
  return createMuxer(libs, transport);
}

function createMuxer(libs: Libraries, transport: any) {
  return libs.yamux({ enableKeepAlive: false })().createStreamMuxer(transport);
}

/** presents the remote access websocket as a libp2p MessageStream, the transport of the yamux session */
function createWebSocketMessageStream(
  libs: Libraries,
  ws: WebSocket,
  direction: "inbound" | "outbound"
) {
  class WebSocketMessageStream extends libs.AbstractMessageStream {
    private drainTimer?: NodeJS.Timeout;

    constructor() {
      super({ log: libs.logger("cloud-http-proxy:mux"), direction });
      ws.on("message", (data: Buffer) => this.onData(data));
      ws.on("close", () => {
        clearInterval(this.drainTimer);
        this.onTransportClosed();
      });
    }

    sendData(data: any) {
      // one websocket message per write: data is a list of chunks (e.g. a length prefix and its
      // payload, or a yamux frame header and its body), which belong together
      ws.send(data.subarray());
      const canSendMore = ws.bufferedAmount < MAX_WEBSOCKET_BUFFER;
      if (!canSendMore && !this.drainTimer) {
        // ws has no drain event: poll until its send buffer has been written to the socket
        this.drainTimer = setInterval(() => {
          if (ws.bufferedAmount < MAX_WEBSOCKET_BUFFER || ws.readyState !== WebSocket.OPEN) {
            clearInterval(this.drainTimer);
            this.drainTimer = undefined;
            this.safeDispatchEvent("drain");
          }
        }, DRAIN_POLL_MS);
      }
      return { sentBytes: data.byteLength, canSendMore };
    }

    sendReset() {
      ws.terminate();
    }

    sendPause() {
      // backpressure from the yamux session: stop reading from the websocket
      ws.pause();
    }

    sendResume() {
      ws.resume();
    }

    async close() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  }
  return new WebSocketMessageStream();
}

/** yamux session (client side) over the remote access websocket */
class YamuxTunnel implements Tunnel {
  private sockets = new Set<Socket>();
  private closed = false;

  constructor(
    private muxer: any,
    private ws: WebSocket,
    private logger: winston.Logger
  ) {
    ws.on("close", (code, reason) => {
      this.logger.info("Multiplexed tunnel closed", { code, reason: reason.toString(), streams: this.sockets.size });
      this.close();
    });
    ws.on("error", () => this.close());
  }

  get isOpen() {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  attach(socket: Socket) {
    if (!this.isOpen) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    this.muxer.createStream().then(
      (stream: any) => this.bridge(socket, stream),
      (error: Error) => {
        this.logger.debug("Could not open a multiplexed stream", { error: error.message });
        socket.destroy();
      }
    );
  }

  /** forwards data between a local connection and a stream, with backpressure in both directions */
  private bridge(socket: Socket, stream: any) {
    // local connection -> device
    socket.on("data", (data: Buffer) => {
      if (!stream.send(data)) {
        socket.pause();
        stream.onDrain().then(
          () => socket.resume(),
          () => socket.destroy()
        );
      }
    });
    socket.on("end", () => {
      // half-close: no more data from the local side
      stream.close().catch(() => stream.abort(new Error("close failed")));
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (stream.status === "open") {
        stream.abort(new Error("local connection closed"));
      }
    });

    // device -> local connection
    stream.addEventListener("message", (event: any) => {
      const data = event.data;
      if (!socket.write(data instanceof Uint8Array ? data : data.subarray())) {
        // the local side is slower: stop reading the stream, so yamux stops granting window
        stream.pause();
        socket.once("drain", () => stream.resume());
      }
    });
    stream.addEventListener("remoteCloseWrite", () => socket.end());
    stream.addEventListener("close", (event: any) => {
      if (event.error) {
        socket.destroy();
      } else {
        socket.end();
      }
    });
    socket.resume();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.muxer.abort(new Error("tunnel closed"));
    this.sockets.forEach((socket) => socket.destroy());
    this.sockets.clear();
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }
}
