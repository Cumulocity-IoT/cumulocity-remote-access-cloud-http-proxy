import { AddressInfo, Socket, connect } from "net";
import { WebSocketServer } from "ws";
import winston from "winston";
import { ConnectionDetails } from "../src/connection-details";
import { acceptMultiplexing } from "../src/mux-tunnel";

/** the multistream-select header, the first data of a client requesting multiplexing */
const MULTISTREAM_HEADER = Buffer.from("\x13/multistream/1.0.0\n");

/**
 * - "passthrough": a remote access plugin without multiplexing support, forwarding everything to
 *   an HTTP-like service: a multiplexing request is rejected, other data is echoed
 * - "multiplex": a plugin with multiplexing support (thin-edge.io)
 */
export type DeviceMode = "passthrough" | "multiplex";

export const logger = winston.createLogger({ silent: true });

/**
 * Emulates the Cumulocity remote access endpoint and the device: every websocket is a new
 * remote access session forwarding to an echo service
 */
export async function fakeRemoteAccess(mode: DeviceMode = "passthrough") {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const fake = { websockets: 0, lastAuthorization: "", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => {
    server.clients.forEach((client) => client.terminate());
    server.close();
  } };
  server.on("connection", (ws, req) => {
    fake.websockets++;
    fake.lastAuthorization = req.headers.authorization || "";
    if (mode === "passthrough") {
      ws.once("message", (data: Buffer) => {
        if (data.subarray(0, MULTISTREAM_HEADER.length).equals(MULTISTREAM_HEADER)) {
          // the target does not understand the negotiation (like an HTTP server)
          ws.send(Buffer.from("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
          ws.close();
          return;
        }
        ws.send(data);
        ws.on("message", (more) => ws.send(more));
      });
      return;
    }
    let negotiated = false;
    ws.on("message", (data: Buffer) => {
      if (negotiated) return;
      negotiated = true;
      if (!data.subarray(0, MULTISTREAM_HEADER.length).equals(MULTISTREAM_HEADER)) {
        // not a multiplexing client: passthrough to the echo service
        ws.send(data);
        ws.on("message", (more) => ws.send(more));
        return;
      }
      acceptMultiplexing(ws, data).then((muxer) =>
        muxer.addEventListener("stream", (event: any) => echoStream(event.detail))
      );
    });
  });
  process.env.C8Y_BASEURL = fake.url;
  return fake;
}

export function details(overrides: Partial<ConnectionDetails> = {}) {
  return {
    tenant: "t12345",
    user: "user",
    cloudProxyDeviceId: "1234",
    cloudProxyConfigId: "1",
    isWebsocket: false,
    queryParamsString: "",
    originalHeaders: {},
    loadRCAConfig: async () => ({ id: "1", name: "http:example", hostname: "127.0.0.1", port: "80", protocol: "PASSTHROUGH" }),
    ...overrides,
  } as ConnectionDetails;
}

/** opens a connection to the server and checks that data is echoed through the tunnel */
export async function openConnection(port: number) {
  const socket = connect(port, "localhost");
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  await echo(socket, "ping");
  return socket;
}

export function echo(socket: Socket, message: string) {
  return new Promise<void>((resolve, reject) => {
    let received = "";
    const onData = (data: Buffer) => {
      received += data.toString();
      if (received.length >= message.length) {
        socket.off("data", onData);
        received === message ? resolve() : reject(new Error(`unexpected echo ${received}`));
      }
    };
    socket.on("data", onData);
    socket.write(message);
  });
}

export function close(socket: Socket) {
  return new Promise((resolve) => socket.once("close", resolve).end());
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function echoStream(stream: any) {
  stream.addEventListener("message", (event: any) => {
    const data = event.data;
    stream.send(data instanceof Uint8Array ? data : data.subarray());
  });
  stream.addEventListener("remoteCloseWrite", () => stream.close());
}

/** connection details of a configuration with the given name */
export function detailsFor(name: string, overrides: Partial<ConnectionDetails> = {}) {
  return details({
    loadRCAConfig: async () => ({ id: "1", name, hostname: "127.0.0.1", port: "80", protocol: "PASSTHROUGH" }),
    ...overrides,
  });
}
