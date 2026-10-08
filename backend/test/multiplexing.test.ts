import { test } from "node:test";
import assert from "node:assert/strict";
import { close, detailsFor, echo, fakeRemoteAccess, logger, openConnection } from "./fake-remote-access";
import { RCAServerStore } from "../src/rca-server-store";

async function exchangeSequentially(port: number, count: number) {
  for (let i = 0; i < count; i++) {
    await close(await openConnection(port));
  }
}

test("http+mux: all connections share one remote access websocket", async () => {
  const fake = await fakeRemoteAccess("multiplex");
  const server = await RCAServerStore.newConnectionServer(logger, detailsFor("http+mux:example", { cloudProxyConfigId: "mux-1" }), () => {});

  await exchangeSequentially(server.port, 5);
  // concurrent connections, with more data than a single frame
  const sockets = await Promise.all([1, 2, 3].map(() => openConnection(server.port)));
  await Promise.all(sockets.map((socket, i) => echo(socket, String(i).repeat(300_000))));
  await Promise.all(sockets.map(close));

  assert.equal(fake.websockets, 1);
  server.socketServer.close();
  fake.close();
});

test("http+mux: falls back to one websocket per connection without device support", async () => {
  const fake = await fakeRemoteAccess("passthrough");
  const server = await RCAServerStore.newConnectionServer(logger, detailsFor("http+mux:example", { cloudProxyConfigId: "mux-2" }), () => {});

  await exchangeSequentially(server.port, 3);

  // one websocket for the (rejected) negotiation, then one per connection without probing again
  assert.equal(fake.websockets, 4);
  server.socketServer.close();
  fake.close();
});

test("http: configurations without the mux option are not multiplexed", async () => {
  const fake = await fakeRemoteAccess("multiplex");
  const server = await RCAServerStore.newConnectionServer(logger, detailsFor("http:example", { cloudProxyConfigId: "plain" }), () => {});

  await exchangeSequentially(server.port, 3);

  assert.equal(fake.websockets, 3);
  server.socketServer.close();
  fake.close();
});

test("configuration lookup failure falls back to one websocket per connection", async () => {
  const fake = await fakeRemoteAccess("multiplex");
  const server = await RCAServerStore.newConnectionServer(
    logger,
    detailsFor("http+mux:example", {
      cloudProxyConfigId: "failing",
      loadRCAConfig: async () => {
        throw new Error("not allowed");
      },
    }),
    () => {}
  );

  await exchangeSequentially(server.port, 2);

  assert.equal(fake.websockets, 2);
  server.socketServer.close();
  fake.close();
});
