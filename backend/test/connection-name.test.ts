import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConnectionName } from "../src/connection-name";

test("parses connection names", () => {
  assert.deepEqual(parseConnectionName("http:Node-RED"), { secure: false, multiplex: false, label: "Node-RED" });
  assert.deepEqual(parseConnectionName("https:Router"), { secure: true, multiplex: false, label: "Router" });
  assert.deepEqual(parseConnectionName("http+mux:Grafana"), { secure: false, multiplex: true, label: "Grafana" });
  assert.deepEqual(parseConnectionName("https+mux:a:b"), { secure: true, multiplex: true, label: "a:b" });
  assert.deepEqual(parseConnectionName("http+other+mux:x"), { secure: false, multiplex: true, label: "x" });
  assert.deepEqual(parseConnectionName("http+other:x"), { secure: false, multiplex: false, label: "x" });
});

test("ignores other connection names", () => {
  for (const name of ["ssh:device", "vnc", "httpx:a", "mux:http", "HTTP:x", "Http+mux:x", "http+MUX:x", "", undefined]) {
    assert.equal(parseConnectionName(name), undefined, String(name));
  }
});
