import http, { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Store } from "./store.js";
import { randomToken, signToken, verifyToken } from "./auth.js";
import { accessClientInfo } from "./access-info.js";

type Envelope = {
  v: 1;
  type: string;
  channel?: string;
  id: string;
  ts: number;
  payload: any;
};
type PendingHttp = {
  res: ServerResponse;
  timer: NodeJS.Timeout;
  deviceId: string;
  started: boolean;
};
type PendingWs = { socket: WebSocket; timer?: NodeJS.Timeout };

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const dbPath = process.env.DATABASE_PATH ?? "./data/relay.sqlite";
const secret = process.env.JWT_SECRET ?? "local-development-secret-change-me";
mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
const deviceConnections = new Map<string, WebSocket>();
const pendingHttp = new Map<string, PendingHttp>();
const pendingWs = new Map<string, PendingWs>();
const consumedTickets = new Set<string>();

function httpTimeout(channel: string, res: ServerResponse) {
  return setTimeout(() => {
    pendingHttp.delete(channel);
    if (!res.headersSent) json(res, 504, { reason: "tunnel_timeout" });
    else res.destroy(new Error("tunnel timeout"));
  }, 60_000);
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}
async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
function bearer(req: IncomingMessage) {
  const value = req.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}
function account(req: IncomingMessage) {
  const token = verifyToken(bearer(req), secret);
  return token?.kind === "access" ? String(token.sub) : null;
}
function webSession(req: IncomingMessage): {
  deviceId: string;
  accessSessionId: string;
} | null {
  const session = verifyToken(cookies(req).dsh_session, secret);
  return session?.kind === "web-session" &&
    typeof session.deviceId === "string" &&
    typeof session.accessSessionId === "string"
    ? {
        deviceId: session.deviceId,
        accessSessionId: session.accessSessionId,
      }
    : null;
}
function isRelayApi(pathname: string) {
  return (
    pathname === "/health" ||
    pathname === "/devices" ||
    pathname === "/web-ticket" ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/pair/") ||
    pathname.startsWith("/device-management/") ||
    pathname.startsWith("/devices/")
  );
}
function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf("=");
        return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
      }),
  );
}
function upstreamCookie(value: string | undefined) {
  const kept = (value ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith("dsh_session="));
  return kept.length ? kept.join("; ") : undefined;
}
function send(deviceId: string, message: Envelope): boolean {
  const ws = deviceConnections.get(deviceId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}
function envelope(type: string, payload: any, channel?: string): Envelope {
  return { v: 1, type, channel, id: randomUUID(), ts: Date.now(), payload };
}
function normalizeCloseCode(code: unknown): number | undefined {
  if (typeof code !== "number") return undefined;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003)
    return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return undefined;
}
function closeSocket(socket: WebSocket, code: unknown, reason: unknown) {
  const normalized = normalizeCloseCode(code);
  if (normalized === undefined) socket.close();
  else socket.close(normalized, String(reason ?? "").slice(0, 100));
}
function issueTokens(accountId: string) {
  const accessToken = signToken(
    { kind: "access", sub: accountId },
    secret,
    7 * 86400_000,
  );
  const refreshToken = randomToken();
  store.saveRefresh(accountId, refreshToken, Date.now() + 30 * 86400_000);
  return { accessToken, refreshToken };
}
function routeMatch(path: string, pattern: RegExp) {
  return pattern.exec(path);
}

async function api(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const input = await body(req);
  if (req.method === "GET" && url.pathname === "/health")
    return json(res, 200, { ok: true });
  if (req.method === "POST" && url.pathname === "/auth/register") {
    if (
      !input?.email ||
      typeof input.password !== "string" ||
      input.password.length < 8
    )
      return json(res, 400, { error: "invalid_credentials" });
    try {
      const acc = store.createAccount(input.email, input.password);
      return json(res, 201, issueTokens(acc.id));
    } catch {
      return json(res, 409, { error: "email_exists" });
    }
  }
  if (req.method === "POST" && url.pathname === "/auth/login") {
    const acc = store.verifyPassword(input?.email ?? "", input?.password ?? "");
    return acc
      ? json(res, 200, issueTokens(acc.id))
      : json(res, 401, { error: "invalid_credentials" });
  }
  if (req.method === "POST" && url.pathname === "/auth/refresh") {
    const accountId = store.consumeRefresh(input?.refreshToken ?? "");
    return accountId
      ? json(res, 200, issueTokens(accountId))
      : json(res, 401, { error: "invalid_refresh_token" });
  }
  if (req.method === "POST" && url.pathname === "/pair/session")
    return json(res, 201, store.createPair());
  if (req.method === "POST" && url.pathname === "/pair/claim") {
    const accountId = account(req);
    if (!accountId) return json(res, 401, { error: "unauthorized" });
    const claimed = store.claimPair(String(input?.code ?? ""), accountId);
    return claimed
      ? json(res, 200, claimed)
      : json(res, 409, { error: "invalid_or_expired_code" });
  }
  if (req.method === "POST" && url.pathname === "/pair/confirm") {
    const result = store.confirmPair(
      input?.deviceId ?? "",
      input?.deviceSecret ?? "",
      input?.deviceName ?? "DSH Computer",
    );
    if (result === "pending") return json(res, 202, { status: "pending" });
    return result
      ? json(res, 200, { deviceToken: result })
      : json(res, 401, { error: "invalid_pair_session" });
  }
  if (req.method === "GET" && url.pathname === "/devices") {
    const accountId = account(req);
    return accountId
      ? json(res, 200, {
          devices: store.listDevices(accountId, (id) =>
            deviceConnections.has(id),
          ),
        })
      : json(res, 401, { error: "unauthorized" });
  }
  if (req.method === "POST" && url.pathname === "/web-ticket") {
    const accountId = account(req);
    const device = store.device(input?.deviceId ?? "");
    if (!accountId || !device || device.account_id !== accountId)
      return json(res, 403, { error: "forbidden" });
    const ticket = signToken(
      {
        kind: "web-ticket",
        sub: accountId,
        deviceId: device.id,
        nonce: randomUUID(),
      },
      secret,
      Number(process.env.WEB_TICKET_TTL_SECONDS ?? 60) * 1000,
    );
    return json(res, 200, {
      ticket,
      expiresIn: Number(process.env.WEB_TICKET_TTL_SECONDS ?? 60),
    });
  }
  const accessSessionsRoute = routeMatch(
    url.pathname,
    /^\/device-management\/([^/]+)\/access-sessions$/,
  );
  if (accessSessionsRoute && req.method === "GET") {
    const deviceToken = req.headers.authorization?.startsWith("Device ")
      ? req.headers.authorization.slice(7)
      : undefined;
    if (
      !deviceToken ||
      !store.findDeviceByToken(accessSessionsRoute[1], deviceToken)
    )
      return json(res, 401, { error: "invalid_device_token" });
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
      : 50;
    return json(res, 200, {
      sessions: store.listAccessSessions(accessSessionsRoute[1], limit),
    });
  }
  const deviceUnbindRoute = routeMatch(
    url.pathname,
    /^\/device-management\/([^/]+)\/unbind$/,
  );
  if (deviceUnbindRoute && req.method === "POST") {
    const deviceToken = req.headers.authorization?.startsWith("Device ")
      ? req.headers.authorization.slice(7)
      : undefined;
    const device = deviceToken
      ? store.findDeviceByToken(deviceUnbindRoute[1], deviceToken)
      : null;
    if (!device)
      return json(res, 401, { error: "invalid_device_token" });
    store.unbind(deviceUnbindRoute[1], device.account_id);
    deviceConnections.get(deviceUnbindRoute[1])?.close(4003, "unbound");
    return json(res, 200, { ok: true });
  }
  const deviceRoute = routeMatch(url.pathname, /^\/devices\/([^/]+)$/);
  if (deviceRoute && req.method === "PATCH") {
    const accountId = account(req);
    if (!accountId || typeof input?.name !== "string" || !input.name.trim())
      return json(res, 400, { error: "invalid_request" });
    store.rename(deviceRoute[1], accountId, input.name.trim());
    return json(res, 200, { ok: true });
  }
  if (deviceRoute && req.method === "DELETE") {
    const accountId = account(req);
    if (!accountId || !store.unbind(deviceRoute[1], accountId))
      return json(res, 404, { error: "not_found" });
    deviceConnections.get(deviceRoute[1])?.close(4003, "unbound");
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not_found" });
}

function authorizeWeb(
  req: IncomingMessage,
  deviceId: string,
  url: URL,
): { ok: boolean; setCookie?: string; accessSessionId?: string } {
  const session = verifyToken(cookies(req).dsh_session, secret);
  if (
    session?.kind === "web-session" &&
    session.deviceId === deviceId &&
    typeof session.accessSessionId === "string"
  ) {
    store.touchAccessSession(session.accessSessionId, deviceId);
    return { ok: true, accessSessionId: session.accessSessionId };
  }
  const rawTicket = url.searchParams.get("ticket") ?? undefined;
  const ticket = verifyToken(rawTicket, secret);
  if (
    ticket?.kind !== "web-ticket" ||
    ticket.deviceId !== deviceId ||
    !ticket.nonce ||
    consumedTickets.has(ticket.nonce)
  )
    return { ok: false };
  consumedTickets.add(ticket.nonce);
  setTimeout(() => consumedTickets.delete(ticket.nonce), 65_000).unref();
  const expiresAt = Date.now() + 2 * 3600_000;
  const accessSessionId = store.createAccessSession(
    deviceId,
    String(ticket.sub),
    accessClientInfo(req.headers["user-agent"]),
    expiresAt,
  );
  const sessionToken = signToken(
    { kind: "web-session", sub: ticket.sub, deviceId, accessSessionId },
    secret,
    2 * 3600_000,
  );
  url.searchParams.delete("ticket");
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return {
    ok: true,
    accessSessionId,
    setCookie: `dsh_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7200${secure}`,
  };
}

async function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deviceId: string,
  path: string,
  setCookie?: string,
) {
  const device = store.device(deviceId);
  if (!deviceConnections.has(deviceId))
    return json(res, 503, { reason: "device_offline" });
  if (device?.dsh_status !== "online")
    return json(res, 503, { reason: "dsh_offline" });
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const channel = `ch_${randomUUID()}`;
  const timer = httpTimeout(channel, res);
  pendingHttp.set(channel, { res, timer, deviceId, started: false });
  res.on("close", () => {
    const pending = pendingHttp.get(channel);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingHttp.delete(channel);
    send(deviceId, envelope("http_close", {}, channel));
  });
  const headers = {
    ...req.headers,
    cookie: upstreamCookie(req.headers.cookie),
  };
  delete headers.host;
  if (!headers.cookie) delete headers.cookie;
  if (
    !send(
      deviceId,
      envelope(
        "http_req",
        {
          method: req.method,
          path,
          headers,
          bodyB64: Buffer.concat(chunks).toString("base64"),
        },
        channel,
      ),
    )
  ) {
    clearTimeout(timer);
    pendingHttp.delete(channel);
    json(res, 503, { reason: "device_offline" });
  } else if (setCookie) res.setHeader("set-cookie", setCookie);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match) {
      const auth = authorizeWeb(req, match[1], url);
      if (!auth.ok) return json(res, 401, { error: "invalid_web_session" });
      return proxyHttp(
        req,
        res,
        match[1],
        `${match[2] ?? "/"}${url.search}`,
        auth.setCookie,
      );
    }
    if (!isRelayApi(url.pathname)) {
      const session = webSession(req);
      if (!session) return json(res, 401, { error: "invalid_web_session" });
      store.touchAccessSession(session.accessSessionId, session.deviceId);
      return proxyHttp(
        req,
        res,
        session.deviceId,
        `${url.pathname}${url.search}`,
      );
    }
    return await api(req, res);
  } catch (error) {
    console.error(
      "request failed",
      error instanceof Error ? error.message : "unknown",
    );
    if (!res.headersSent) json(res, 500, { error: "internal_error" });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  if (url.pathname === "/device")
    return wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  const match = /^\/s\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const session = match ? null : webSession(req);
  const deviceId = match ? match[1] : session?.deviceId;
  if (match && !authorizeWeb(req, deviceId!, url).ok) return socket.destroy();
  if (session) store.touchAccessSession(session.accessSessionId, session.deviceId);
  if (!deviceId || !deviceConnections.has(deviceId)) return socket.destroy();
  const upstreamPath = match
    ? `${match[2] ?? "/"}${url.search}`
    : `${url.pathname}${url.search}`;
  wss.handleUpgrade(req, socket, head, (ws) => {
    const channel = `ch_${randomUUID()}`;
    pendingWs.set(channel, {
      socket: ws,
      timer: setTimeout(() => ws.close(1013, "tunnel timeout"), 10_000),
    });
    const headers = {
      ...req.headers,
      cookie: upstreamCookie(req.headers.cookie),
    };
    if (!headers.cookie) delete headers.cookie;
    send(
      deviceId,
      envelope("ws_open", { path: upstreamPath, headers }, channel),
    );
    ws.on("message", (data, binary) =>
      send(
        deviceId,
        envelope(
          "ws_frame",
          {
            dataB64: Buffer.from(data as any).toString("base64"),
            opcode: binary ? 2 : 1,
          },
          channel,
        ),
      ),
    );
    ws.on("close", (code, reason) => {
      pendingWs.delete(channel);
      send(
        deviceId,
        envelope("ws_close", { code, reason: reason.toString() }, channel),
      );
    });
  });
});

wss.on("connection", (ws, req) => {
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/device")
    return;
  let deviceId: string | null = null;
  const authTimer = setTimeout(() => ws.close(4001, "auth timeout"), 5_000);
  ws.on("message", (raw) => {
    let msg: Envelope;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.close(4000, "invalid json");
    }
    if (!deviceId) {
      if (
        msg.type !== "auth" ||
        !store.findDeviceByToken(
          msg.payload?.deviceId,
          msg.payload?.deviceToken,
        )
      )
        return ws.close(4003, "auth failed");
      const authenticatedId = String(msg.payload.deviceId);
      deviceId = authenticatedId;
      clearTimeout(authTimer);
      deviceConnections.get(authenticatedId)?.close(4002, "replaced");
      deviceConnections.set(authenticatedId, ws);
      store.updateStatus(authenticatedId, "online", "offline");
      return ws.send(JSON.stringify(envelope("auth_ok", {})));
    }
    if (msg.type === "ping")
      return ws.send(JSON.stringify(envelope("pong", {})));
    if (msg.type === "status")
      return store.updateStatus(
        deviceId as string,
        "online",
        msg.payload?.dsh === "online" ? "online" : "offline",
      );
    if (msg.type === "event")
      return store.addEvent(
        deviceId as string,
        msg.payload?.kind ?? "unknown",
        msg.payload,
      );
    if (msg.type === "http_res" && msg.channel) {
      const pending = pendingHttp.get(msg.channel);
      if (!pending) return;
      clearTimeout(pending.timer);
      if (!pending.started) {
        const headers = { ...(msg.payload?.headers ?? {}) };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        const relayCookie = pending.res.getHeader("set-cookie");
        if (relayCookie && headers["set-cookie"])
          headers["set-cookie"] = [relayCookie, headers["set-cookie"]].flat();
        pending.res.writeHead(msg.payload?.status ?? 502, headers);
        pending.started = true;
      }
      const chunk = Buffer.from(msg.payload?.bodyB64 ?? "", "base64");
      if (chunk.length) pending.res.write(chunk);
      const final = msg.payload?.final !== false;
      if (final) {
        pendingHttp.delete(msg.channel);
        pending.res.end();
      } else {
        pending.timer = httpTimeout(msg.channel, pending.res);
      }
    }
    if (msg.type === "ws_open_ok" && msg.channel) {
      const pending = pendingWs.get(msg.channel);
      if (pending?.timer) {
        clearTimeout(pending.timer);
        delete pending.timer;
      }
    }
    if (msg.type === "ws_frame" && msg.channel) {
      const pending = pendingWs.get(msg.channel);
      if (pending?.socket.readyState === WebSocket.OPEN)
        pending.socket.send(Buffer.from(msg.payload?.dataB64 ?? "", "base64"), {
          binary: msg.payload?.opcode === 2,
        });
    }
    if (msg.type === "ws_close" && msg.channel) {
      const socket = pendingWs.get(msg.channel)?.socket;
      if (socket) closeSocket(socket, msg.payload?.code, msg.payload?.reason);
      pendingWs.delete(msg.channel);
    }
  });
  ws.on("close", () => {
    clearTimeout(authTimer);
    if (deviceId && deviceConnections.get(deviceId) === ws) {
      deviceConnections.delete(deviceId);
      store.updateStatus(deviceId, "offline", "offline");
    }
  });
});

server.listen(port, host, () =>
  console.log(`DSH Relay listening on http://${host}:${port}`),
);
process.on("SIGTERM", () =>
  server.close(() => {
    store.close();
    process.exit(0);
  }),
);
