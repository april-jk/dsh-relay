import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const port = 19000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  token?: string,
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, data: (await response.json()) as any };
}
async function waitForRelay() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("relay did not start");
}
function open(url: string, options?: any): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}
function next(ws: WebSocket): Promise<any> {
  return new Promise((resolve) =>
    ws.once("message", (data) => resolve(JSON.parse(data.toString()))),
  );
}

test("pairs a device and tunnels HTTP and WebSocket traffic", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-relay-test-"));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForRelay();

  const registered = await request("/auth/register", "POST", {
    email: "test@example.com",
    password: "correct-horse",
  });
  assert.equal(registered.response.status, 201);
  const access = registered.data.accessToken;
  const session = await request("/pair/session", "POST", {});
  const claimed = await request(
    "/pair/claim",
    "POST",
    { code: session.data.code },
    access,
  );
  assert.equal(claimed.response.status, 200);
  const confirmed = await request("/pair/confirm", "POST", {
    deviceId: session.data.deviceId,
    deviceSecret: session.data.deviceSecret,
    deviceName: "Test Mac",
  });
  assert.equal(confirmed.response.status, 200);

  const device = await open(`${wsBase}/device`);
  device.send(
    JSON.stringify({
      v: 1,
      type: "auth",
      id: "auth",
      ts: Date.now(),
      payload: {
        deviceId: session.data.deviceId,
        deviceToken: confirmed.data.deviceToken,
      },
    }),
  );
  assert.equal((await next(device)).type, "auth_ok");
  device.send(
    JSON.stringify({
      v: 1,
      type: "status",
      id: "status",
      ts: Date.now(),
      payload: { dsh: "online" },
    }),
  );
  device.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "http_req" && msg.payload.path === "/api/stream") {
      device.send(
        JSON.stringify({
          v: 1,
          type: "http_res",
          channel: msg.channel,
          id: "stream-head",
          ts: Date.now(),
          payload: {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            bodyB64: "",
            seq: 0,
            final: false,
          },
        }),
      );
      device.send(
        JSON.stringify({
          v: 1,
          type: "http_res",
          channel: msg.channel,
          id: "stream-body",
          ts: Date.now(),
          payload: {
            bodyB64: Buffer.from("data: ready\n\n").toString("base64"),
            seq: 1,
            final: false,
          },
        }),
      );
      device.send(
        JSON.stringify({
          v: 1,
          type: "http_res",
          channel: msg.channel,
          id: "stream-end",
          ts: Date.now(),
          payload: { bodyB64: "", seq: 2, final: true },
        }),
      );
    } else if (msg.type === "http_req")
      device.send(
        JSON.stringify({
          v: 1,
          type: "http_res",
          channel: msg.channel,
          id: "response",
          ts: Date.now(),
          payload: {
            status: 200,
            headers: { "content-type": "text/plain" },
            bodyB64: Buffer.from(`proxied:${msg.payload.path}`).toString(
              "base64",
            ),
          },
        }),
      );
    if (msg.type === "ws_open")
      device.send(
        JSON.stringify({
          v: 1,
          type: "ws_open_ok",
          channel: msg.channel,
          id: "open",
          ts: Date.now(),
          payload: {},
        }),
      );
    if (msg.type === "ws_frame")
      device.send(JSON.stringify({ ...msg, id: "echo", ts: Date.now() }));
  });

  const ticketResult = await request(
    "/web-ticket",
    "POST",
    { deviceId: session.data.deviceId },
    access,
  );
  const webResponse = await fetch(
    `${base}/s/${session.data.deviceId}/api/test?ticket=${encodeURIComponent(ticketResult.data.ticket)}`,
  );
  assert.equal(webResponse.status, 200);
  assert.equal(await webResponse.text(), "proxied:/api/test");
  const cookie = webResponse.headers.get("set-cookie");
  assert.match(cookie ?? "", /dsh_session=/);
  assert.match(cookie ?? "", /Path=\//);
  const absoluteAsset = await fetch(`${base}/assets/index.js`, {
    headers: { cookie: cookie ?? "" },
  });
  assert.equal(absoluteAsset.status, 200);
  assert.equal(await absoluteAsset.text(), "proxied:/assets/index.js");
  const stream = await fetch(`${base}/api/stream`, {
    headers: { cookie: cookie ?? "" },
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(await stream.text(), "data: ready\n\n");
  const reused = await fetch(
    `${base}/s/${session.data.deviceId}/?ticket=${encodeURIComponent(ticketResult.data.ticket)}`,
  );
  assert.equal(reused.status, 401);

  const browser = await open(`${wsBase}/api/socket`, {
    headers: { cookie },
  });
  const echoed = new Promise<string>((resolve) =>
    browser.once("message", (data) => resolve(data.toString())),
  );
  browser.send("new task");
  assert.equal(await echoed, "new task");
  browser.close();
  device.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const offlineTicket = await request(
    "/web-ticket",
    "POST",
    { deviceId: session.data.deviceId },
    access,
  );
  const offline = await fetch(
    `${base}/s/${session.data.deviceId}/?ticket=${encodeURIComponent(offlineTicket.data.ticket)}`,
  );
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { reason: "device_offline" });
});
