import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
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
async function chunkedOversizedRequest(path: string) {
  return new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = httpRequest(`${base}${path}`, { method: "POST" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }),
      );
    });
    req.on("error", reject);
    req.write("x".repeat(800));
    req.write("x".repeat(800));
    req.end();
  });
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
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once("close", (code) => resolve(code)));
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
      AUTH_RATE_LIMIT_PER_MINUTE: "3",
      MAX_API_BODY_BYTES: "1024",
      MAX_TUNNEL_BODY_BYTES: "1024",
      MAX_TUNNEL_RESPONSE_BYTES: "1024",
      MAX_WS_PAYLOAD_BYTES: "4096",
      APP_ANDROID_LATEST_VERSION: "0.2.0",
      APP_ANDROID_MINIMUM_VERSION: "0.1.0",
      APP_ANDROID_DOWNLOAD_URL: "https://example.com/android",
      APP_ANDROID_RELEASE_NOTES: "Test release",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForRelay();

  const version = await request("/app/version?platform=android");
  assert.equal(version.response.status, 200);
  assert.deepEqual(version.data, {
    platform: "android",
    latestVersion: "0.2.0",
    minimumVersion: "0.1.0",
    downloadUrl: "https://example.com/android",
    releaseNotes: "Test release",
  });
  const invalidPlatform = await request("/app/version?platform=windows");
  assert.equal(invalidPlatform.response.status, 400);
  assert.deepEqual(invalidPlatform.data, { error: "unsupported_platform" });

  const registered = await request("/auth/register", "POST", {
    email: "test@example.com",
    password: "correct-horse",
  });
  assert.equal(registered.response.status, 201);
  const access = registered.data.accessToken;
  const invalidLoginOne = await request("/auth/login", "POST", {
    email: "test@example.com",
    password: "wrong-password",
  });
  assert.equal(invalidLoginOne.response.status, 401);
  const invalidLoginTwo = await request("/auth/login", "POST", {
    email: "test@example.com",
    password: "wrong-password",
  });
  assert.equal(invalidLoginTwo.response.status, 401);
  const limitedLogin = await request("/auth/login", "POST", {
    email: "test@example.com",
    password: "wrong-password",
  });
  assert.equal(limitedLogin.response.status, 429);
  assert.equal(limitedLogin.data.error, "rate_limited");
  assert.equal(limitedLogin.response.headers.get("retry-after"), "60");

  const oversizedApi = await fetch(`${base}/web-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(2_000) }),
  });
  assert.equal(oversizedApi.status, 413);
  assert.deepEqual(await oversizedApi.json(), {
    error: "request_too_large",
    limit: 1024,
  });
  const chunkedOversizedApi = await chunkedOversizedRequest("/web-ticket");
  assert.equal(chunkedOversizedApi.status, 413);
  assert.deepEqual(chunkedOversizedApi.data, {
    error: "request_too_large",
    limit: 1024,
  });
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
    } else if (msg.type === "http_req" && msg.payload.path === "/api/large")
      device.send(
        JSON.stringify({
          v: 1,
          type: "http_res",
          channel: msg.channel,
          id: "large-response",
          ts: Date.now(),
          payload: {
            status: 200,
            headers: { "content-type": "text/plain" },
            bodyB64: Buffer.alloc(2_000, "x").toString("base64"),
          },
        }),
      );
    else if (msg.type === "http_req")
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
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 raw-marker",
      },
    },
  );
  assert.equal(webResponse.status, 200);
  assert.equal(await webResponse.text(), "proxied:/api/test");
  const cookie = webResponse.headers.get("set-cookie");
  assert.match(cookie ?? "", /dsh_session=/);
  assert.match(cookie ?? "", /Path=\//);
  const accessLogResponse = await fetch(
    `${base}/device-management/${session.data.deviceId}/access-sessions`,
    {
      headers: { authorization: `Device ${confirmed.data.deviceToken}` },
    },
  );
  assert.equal(accessLogResponse.status, 200);
  const accessLog = (await accessLogResponse.json()) as any;
  assert.equal(accessLog.sessions.length, 1);
  assert.equal(accessLog.sessions[0].deviceLabel, "iPhone");
  assert.equal(accessLog.sessions[0].platform, "ios");
  assert.equal(accessLog.sessions[0].osVersion, "18.6");
  assert.equal(accessLog.sessions[0].status, "active");
  assert.doesNotMatch(JSON.stringify(accessLog), /raw-marker|user-agent/i);
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
  const oversizedRequest = await fetch(`${base}/api/upload`, {
    method: "POST",
    headers: { cookie: cookie ?? "" },
    body: "x".repeat(2_000),
  });
  assert.equal(oversizedRequest.status, 413);
  assert.deepEqual(await oversizedRequest.json(), {
    reason: "request_too_large",
    limit: 1024,
  });
  const oversizedResponse = await fetch(`${base}/api/large`, {
    headers: { cookie: cookie ?? "" },
  });
  assert.equal(oversizedResponse.status, 502);
  assert.deepEqual(await oversizedResponse.json(), {
    reason: "response_too_large",
  });
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
  const oversizedSocketClosed = closed(browser);
  browser.send(Buffer.alloc(8_000));
  assert.equal(await oversizedSocketClosed, 1009);
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

  const reconnected = await open(`${wsBase}/device`);
  reconnected.send(
    JSON.stringify({
      v: 1,
      type: "auth",
      id: "reconnect-auth",
      ts: Date.now(),
      payload: {
        deviceId: session.data.deviceId,
        deviceToken: confirmed.data.deviceToken,
      },
    }),
  );
  assert.equal((await next(reconnected)).type, "auth_ok");
  const revokedConnection = closed(reconnected);
  const unbound = await fetch(
    `${base}/device-management/${session.data.deviceId}/unbind`,
    {
      method: "POST",
      headers: { authorization: `Device ${confirmed.data.deviceToken}` },
    },
  );
  assert.equal(unbound.status, 200);
  assert.deepEqual(await unbound.json(), { ok: true });
  assert.equal(await revokedConnection, 4003);

  const devicesAfterUnbind = await request("/devices", "GET", undefined, access);
  assert.deepEqual(devicesAfterUnbind.data.devices, []);
  const repeatedUnbind = await fetch(
    `${base}/device-management/${session.data.deviceId}/unbind`,
    {
      method: "POST",
      headers: { authorization: `Device ${confirmed.data.deviceToken}` },
    },
  );
  assert.equal(repeatedUnbind.status, 401);
  assert.deepEqual(await repeatedUnbind.json(), {
    error: "invalid_device_token",
  });

  const staleDevice = await open(`${wsBase}/device`);
  const staleClosed = closed(staleDevice);
  staleDevice.send(
    JSON.stringify({
      v: 1,
      type: "auth",
      id: "stale-auth",
      ts: Date.now(),
      payload: {
        deviceId: session.data.deviceId,
        deviceToken: confirmed.data.deviceToken,
      },
    }),
  );
  assert.equal(await staleClosed, 4003);
});
