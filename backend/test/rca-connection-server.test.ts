import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressInfo } from "net";
import { close, details, fakeRemoteAccess, logger, openConnection, sleep } from "./fake-remote-access";

process.env.RCA_IDLE_TIMEOUT = "0.3";
// loaded after setting the environment, the timeouts are read on import
const { RCAServerStore } = require("../src/rca-server-store") as typeof import("../src/rca-server-store");

test("server stays open while a connection is open and closes once idle", async () => {
  const fake = await fakeRemoteAccess();
  let closed = false;
  const server = await RCAServerStore.newConnectionServer(logger, details(), () => (closed = true));

  const longLived = await openConnection(server.port);
  await close(await openConnection(server.port));
  await sleep(600);
  assert.equal(closed, false, "closed while a connection was still open");

  await close(longLived);
  await sleep(600);
  assert.equal(closed, true, "not closed after being idle");
  assert.equal(fake.websockets, 2);
  server.socketServer.close();
  fake.close();
});

test("a new connection cancels the idle close", async () => {
  const fake = await fakeRemoteAccess();
  let closed = false;
  const server = await RCAServerStore.newConnectionServer(logger, details(), () => (closed = true));

  for (let i = 0; i < 4; i++) {
    await close(await openConnection(server.port));
    await sleep(150);
  }
  assert.equal(closed, false);
  server.socketServer.close();
  fake.close();
});

test("server only listens on the loopback interface", async () => {
  const fake = await fakeRemoteAccess();
  const server = await RCAServerStore.newConnectionServer(logger, details(), () => {});
  const { address } = server.socketServer.address() as AddressInfo;
  assert.ok(["127.0.0.1", "::1"].includes(address), `listening on ${address}`);
  server.socketServer.close();
  fake.close();
});

test("concurrent requests of a session share one server", async () => {
  const fake = await fakeRemoteAccess();
  const store = new RCAServerStore(logger);
  const servers = await Promise.all([1, 2, 3, 4].map(() => store.getServer(details(), logger)));
  assert.equal(new Set(servers).size, 1);
  servers[0].socketServer.close();
  fake.close();
});

test("new remote access websockets use the credentials of the latest request", async () => {
  const fake = await fakeRemoteAccess();
  const store = new RCAServerStore(logger);
  const server = await store.getServer(details({ originalHeaders: { authorization: "Bearer first" } }), logger);
  await close(await openConnection(server.port));
  assert.equal(fake.lastAuthorization, "Bearer first");

  const reused = await store.getServer(details({ originalHeaders: { authorization: "Bearer renewed" } }), logger);
  assert.equal(reused, server);
  await close(await openConnection(server.port));
  assert.equal(fake.lastAuthorization, "Bearer renewed");
  server.socketServer.close();
  fake.close();
});
