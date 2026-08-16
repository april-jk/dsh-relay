import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { Store } from "../src/store.js";

test("stores event metadata without the Companion payload", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-event-metadata-"));
  const store = new Store(join(dir, "relay.sqlite"));
  t.after(() => store.close());

  store.addEvent("dev_test", "task.changed");
  const event = store.db
    .prepare(
      "SELECT kind, payload_json payloadJson FROM events WHERE device_id = ?",
    )
    .get("dev_test") as { kind: string; payloadJson: string };

  assert.deepEqual(event, { kind: "task.changed", payloadJson: "{}" });
});

test("fails closed when legacy proxy or a web ticket is unavailable", async (t) => {
  const port = 21000 + Math.floor(Math.random() * 1000);
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-secure-defaults-"));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "secure-default-test-secret",
      ALLOW_LEGACY_WEB_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const legacy = await fetch(`${base}/s/dev_unknown/`);
  assert.equal(legacy.status, 426);
  assert.deepEqual(await legacy.json(), { reason: "e2ee_required" });

  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/client-tunnel`);
      socket.once("open", () => resolve());
      socket.once("error", reject);
    }),
  );
});
