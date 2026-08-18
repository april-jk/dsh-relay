import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
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
function openWithProtocols(url: string, protocols: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
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
  const adminPassword = randomBytes(24).toString("base64url");
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      DATABASE_PATH: join(dir, "relay.sqlite"),
      JWT_SECRET: "test-secret",
      AUTH_RATE_LIMIT_PER_MINUTE: "3",
      MAX_API_BODY_BYTES: "1024",
      MAX_TUNNEL_BODY_BYTES: "1024",
      MAX_TUNNEL_RESPONSE_BYTES: "1024",
      MAX_WS_PAYLOAD_BYTES: "4096",
      ALLOW_LEGACY_WEB_PROXY: "1",
      APP_ANDROID_LATEST_VERSION: "0.2.0",
      APP_ANDROID_MINIMUM_VERSION: "0.1.0",
      APP_ANDROID_DOWNLOAD_URL: "https://example.com/android",
      APP_ANDROID_RELEASE_NOTES: "Test release",
      ADMIN_USERNAME: "relay-admin",
      ADMIN_PASSWORD: adminPassword,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  await waitForRelay();

  const root = await fetch(base, { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/app/");
  const appPage = await fetch(`${base}/app/`);
  assert.equal(appPage.status, 200);
  assert.match(await appPage.text(), /DSH Remote/);

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
  const webLogin = await fetch(`${base}/web-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      email: "test@example.com",
      password: "correct-horse",
    }),
  });
  assert.equal(webLogin.status, 200);
  const webCookie = webLogin.headers.get("set-cookie") ?? "";
  assert.match(webCookie, /dsh_web_auth=/);
  assert.match(webCookie, /HttpOnly/);
  assert.match(webCookie, /SameSite=Strict/);
  const webSession = await fetch(`${base}/web-auth/session`, {
    headers: { cookie: webCookie },
  });
  assert.deepEqual(await webSession.json(), {
    authenticated: true,
    email: "test@example.com",
  });
  const webDevices = await fetch(`${base}/devices`, {
    headers: { cookie: webCookie },
  });
  assert.equal(webDevices.status, 200);
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
        capabilities: ["sealed-tunnel-v1"],
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
    if (msg.type === "client_hello")
      device.send(
        JSON.stringify({
          v: 1,
          type: "server_hello",
          id: "server-hello",
          ts: 0,
          payload: {
            accessSessionId: msg.payload.accessSessionId,
            serverRandomB64: "opaque-random",
            serverProofB64: "opaque-proof",
          },
        }),
      );
    else if (msg.type === "sealed")
      device.send(
        JSON.stringify({
          ...msg,
          id: "sealed-response",
          payload: {
            ...msg.payload,
            ciphertextB64: "cmVsYXktY2Fubm90LWRlY3J5cHQ",
          },
        }),
      );
    else if (msg.type === "http_req" && msg.payload.path === "/api/stream") {
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

  const secureTicket = await request(
    "/web-ticket",
    "POST",
    { deviceId: session.data.deviceId },
    access,
  );
  assert.equal(secureTicket.response.status, 200);
  assert.equal(secureTicket.data.e2eeRequired, true);
  assert.match(secureTicket.data.accessSessionId, /^access_/);
  assert.equal(secureTicket.data.tunnelUrl, `${wsBase}/client-tunnel`);
  const secureClient = await open(`${wsBase}/client-tunnel`, {
    headers: { authorization: `WebTicket ${secureTicket.data.ticket}` },
  });
  secureClient.send(
    JSON.stringify({
      v: 1,
      type: "client_hello",
      id: "client-hello",
      ts: 0,
      payload: {
        accessSessionId: secureTicket.data.accessSessionId,
        clientRandomB64: "opaque-random",
        clientProofB64: "opaque-proof",
      },
    }),
  );
  assert.equal((await next(secureClient)).type, "server_hello");
  secureClient.send(
    JSON.stringify({
      v: 1,
      type: "sealed",
      id: "sealed-request",
      ts: 0,
      payload: {
        accessSessionId: secureTicket.data.accessSessionId,
        seq: "0",
        ciphertextB64: "b3BhcXVl",
      },
    }),
  );
  const sealedResponse = await next(secureClient);
  assert.equal(sealedResponse.type, "sealed");
  assert.equal(
    sealedResponse.payload.ciphertextB64,
    "cmVsYXktY2Fubm90LWRlY3J5cHQ",
  );
  await assert.rejects(
    open(`${wsBase}/client-tunnel`, {
      headers: { authorization: `WebTicket ${secureTicket.data.ticket}` },
    }),
  );

  const browserTicketResponse = await fetch(`${base}/web-ticket`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: webCookie,
      origin: base,
    },
    body: JSON.stringify({ deviceId: session.data.deviceId }),
  });
  assert.equal(browserTicketResponse.status, 200);
  const browserTicket = (await browserTicketResponse.json()) as any;
  const encodedTicket = Buffer.from(browserTicket.ticket).toString("base64url");
  const protocolClient = await openWithProtocols(`${wsBase}/client-tunnel`, [
    "dsh-e2ee-v1",
    `dsh-ticket.${encodedTicket}`,
  ]);
  assert.equal(protocolClient.protocol, "dsh-e2ee-v1");
  protocolClient.send(
    JSON.stringify({
      v: 1,
      type: "client_hello",
      id: "browser-client-hello",
      ts: 0,
      payload: {
        accessSessionId: browserTicket.accessSessionId,
        clientRandomB64: "browser-random",
        clientProofB64: "browser-proof",
      },
    }),
  );
  assert.equal((await next(protocolClient)).type, "server_hello");
  protocolClient.send(
    JSON.stringify({
      v: 1,
      type: "sealed",
      id: "browser-sealed-request",
      ts: 0,
      payload: {
        accessSessionId: browserTicket.accessSessionId,
        seq: "0",
        ciphertextB64: "YnJvd3Nlci1vcGFxdWU",
      },
    }),
  );
  assert.equal((await next(protocolClient)).type, "sealed");

  secureClient.send(
    JSON.stringify({
      v: 1,
      type: "sealed",
      id: "mobile-sealed-request",
      ts: 0,
      payload: {
        accessSessionId: secureTicket.data.accessSessionId,
        seq: "1",
        ciphertextB64: "bW9iaWxlLW9wYXF1ZQ",
      },
    }),
  );
  assert.equal((await next(secureClient)).type, "sealed");
  secureClient.close();
  protocolClient.close();

  const adminLogin = await fetch(`${base}/admin/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      username: "relay-admin",
      password: adminPassword,
    }),
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get("set-cookie") ?? "";
  assert.match(adminCookie, /dsh_admin=/);
  const statsResponse = await fetch(`${base}/admin/api/stats`, {
    headers: { cookie: adminCookie },
  });
  assert.equal(statsResponse.status, 200);
  const stats = (await statsResponse.json()) as any;
  assert.equal(stats.users.total, 1);
  assert.equal(stats.devices.paired, 1);
  assert.ok(stats.sessions.last24h >= 2);
  assert.ok(
    stats.recentSessions.some((entry: any) => entry.status === "ended"),
  );
  assert.equal(stats.daily.length, 30);

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
  assert.equal(accessLog.sessions.length, 3);
  const iphoneSession = accessLog.sessions.find(
    (entry: any) => entry.deviceLabel === "iPhone",
  );
  assert.equal(iphoneSession.platform, "ios");
  assert.equal(iphoneSession.osVersion, "18.6");
  assert.equal(iphoneSession.status, "active");
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
  assert.equal(offlineTicket.response.status, 503);
  assert.deepEqual(offlineTicket.data, { reason: "device_offline" });

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
