import { AddressInfo, Socket, connect } from "net";
import { WebSocketServer } from "ws";
import winston from "winston";
import { ConnectionDetails } from "../src/connection-details";

export const logger = winston.createLogger({ silent: true });

/**
 * Emulates the Cumulocity remote access endpoint and the device: every websocket is a new
 * remote access session forwarding to an echo service
 */
export async function fakeRemoteAccess() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const fake = { websockets: 0, lastAuthorization: "", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => {
    server.clients.forEach((client) => client.terminate());
    server.close();
  } };
  server.on("connection", (ws, req) => {
    fake.websockets++;
    fake.lastAuthorization = req.headers.authorization || "";
    ws.on("message", (data) => ws.send(data));
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
