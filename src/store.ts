import Database from "better-sqlite3";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { AccessClientInfo } from "./access-info.js";

export type Device = {
  id: string;
  accountId: string;
  name: string;
  lastSeenAt: number | null;
  dshStatus: "online" | "offline";
  online: boolean;
  createdAt: number;
};
export type Account = { id: string; email: string };
export type AccessSession = AccessClientInfo & {
  id: string;
  startedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  status: "active" | "expired" | "ended";
};

export type AdminStats = {
  generatedAt: number;
  users: { total: number; new24h: number; new7d: number; new30d: number };
  devices: { total: number; paired: number; online: number; dshOnline: number };
  sessions: {
    active: number;
    last24h: number;
    last7d: number;
    last30d: number;
    activeUsers30d: number;
  };
  daily: Array<{ day: string; users: number; sessions: number }>;
  recentSessions: Array<{
    id: string;
    email: string;
    deviceName: string;
    platform: string;
    startedAt: number;
    lastSeenAt: number;
    status: "active" | "expired" | "ended";
  }>;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function passwordHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function passwordMatches(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL, device_token_hash TEXT, last_seen_at INTEGER, dsh_status TEXT NOT NULL DEFAULT 'offline', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pair_sessions (code TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed_by TEXT, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_sessions (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, account_id TEXT NOT NULL, device_label TEXT NOT NULL, platform TEXT NOT NULL, os_version TEXT, started_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ended_reason TEXT);
      CREATE INDEX IF NOT EXISTS access_sessions_device_started ON access_sessions(device_id, started_at DESC);
    `);
    this.cleanupExpired();
  }
  close() {
    this.db.close();
  }
  createAccount(email: string, password: string): Account {
    const id = `acc_${randomUUID()}`;
    this.db
      .prepare("INSERT INTO accounts VALUES (?, ?, ?, ?)")
      .run(id, email.toLowerCase(), passwordHash(password), Date.now());
    return { id, email: email.toLowerCase() };
  }
  findAccount(email: string): (Account & { passwordHash: string }) | null {
    const row = this.db
      .prepare(
        "SELECT id, email, password_hash passwordHash FROM accounts WHERE email = ?",
      )
      .get(email.toLowerCase()) as any;
    return row ?? null;
  }
  findAccountById(id: string): Account | null {
    const row = this.db
      .prepare("SELECT id, email FROM accounts WHERE id = ?")
      .get(id) as Account | undefined;
    return row ?? null;
  }
  verifyPassword(email: string, password: string): Account | null {
    const row = this.findAccount(email);
    return row && passwordMatches(password, row.passwordHash)
      ? { id: row.id, email: row.email }
      : null;
  }
  saveRefresh(accountId: string, token: string, expiresAt: number) {
    this.db
      .prepare("INSERT INTO refresh_tokens VALUES (?, ?, ?)")
      .run(hash(token), accountId, expiresAt);
  }
  consumeRefresh(token: string): string | null {
    const row = this.db
      .prepare(
        "SELECT account_id accountId, expires_at expiresAt FROM refresh_tokens WHERE token_hash = ?",
      )
      .get(hash(token)) as any;
    if (!row) return null;
    if (row.expiresAt < Date.now()) {
      this.db
        .prepare("DELETE FROM refresh_tokens WHERE token_hash = ?")
        .run(hash(token));
      return null;
    }
    this.db
      .prepare("DELETE FROM refresh_tokens WHERE token_hash = ?")
      .run(hash(token));
    return row.accountId;
  }
  createPair(): {
    code: string;
    deviceId: string;
    deviceSecret: string;
    expiresAt: number;
  } {
    const deviceId = `dev_${randomUUID()}`;
    const deviceSecret = randomBytes(32).toString("hex");
    const now = Date.now();
    const expiresAt = now + 5 * 60_000;
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO pair_sessions VALUES (?, ?, ?, ?, NULL, 0, ?)",
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = String(randomInt(100000, 1_000_000));
      if (insert.run(code, deviceId, hash(deviceSecret), expiresAt, now).changes)
        return { code, deviceId, deviceSecret, expiresAt };
    }
    throw new Error("unable to allocate pairing code");
  }
  claimPair(code: string, accountId: string): { deviceId: string } | null {
    const row = this.db
      .prepare("SELECT * FROM pair_sessions WHERE code = ?")
      .get(code) as any;
    if (
      !row ||
      row.used ||
      row.expires_at < Date.now() ||
      (row.claimed_by && row.claimed_by !== accountId)
    )
      return null;
    this.db
      .prepare("UPDATE pair_sessions SET claimed_by = ? WHERE code = ?")
      .run(accountId, code);
    return { deviceId: row.device_id };
  }
  confirmPair(
    deviceId: string,
    deviceSecret: string,
    name: string,
  ): string | "pending" | null {
    const row = this.db
      .prepare(
        "SELECT * FROM pair_sessions WHERE device_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(deviceId) as any;
    if (
      !row ||
      row.used ||
      row.expires_at < Date.now() ||
      hash(deviceSecret) !== row.device_secret_hash
    )
      return null;
    if (!row.claimed_by) return "pending";
    const token = randomBytes(32).toString("hex");
    this.db
      .prepare(
        "INSERT OR REPLACE INTO devices VALUES (?, ?, ?, ?, NULL, 'offline', ?)",
      )
      .run(
        deviceId,
        row.claimed_by,
        name || "DSH Computer",
        hash(token),
        Date.now(),
      );
    this.db
      .prepare("UPDATE pair_sessions SET used = 1 WHERE code = ?")
      .run(row.code);
    return token;
  }
  listDevices(accountId: string, online: (id: string) => boolean): Device[] {
    const rows = this.db
      .prepare(
        "SELECT id, account_id accountId, name, last_seen_at lastSeenAt, dsh_status dshStatus, created_at createdAt FROM devices WHERE account_id = ? ORDER BY created_at",
      )
      .all(accountId) as any[];
    return rows.map((d) => ({ ...d, online: online(d.id) }));
  }
  device(id: string): any {
    return this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id);
  }
  findDeviceByToken(id: string, token: string): any {
    const row = this.device(id);
    return row && row.device_token_hash === hash(token) ? row : null;
  }
  updateStatus(
    id: string,
    status: "online" | "offline",
    dsh: "online" | "offline",
  ) {
    this.db
      .prepare(
        "UPDATE devices SET last_seen_at = ?, dsh_status = ? WHERE id = ?",
      )
      .run(status === "online" ? Date.now() : null, dsh, id);
  }
  rename(id: string, accountId: string, name: string) {
    this.db
      .prepare("UPDATE devices SET name = ? WHERE id = ? AND account_id = ?")
      .run(name, id, accountId);
  }
  unbind(id: string, accountId: string): boolean {
    const changed = this.db
        .prepare(
          "UPDATE devices SET account_id = NULL, device_token_hash = NULL WHERE id = ? AND account_id = ?",
        )
        .run(id, accountId).changes > 0;
    if (changed) {
      this.db
        .prepare(
          "UPDATE access_sessions SET ended_reason = 'unbound' WHERE device_id = ? AND ended_reason IS NULL",
        )
        .run(id);
    }
    return changed;
  }

  createAccessSession(
    deviceId: string,
    accountId: string,
    info: AccessClientInfo,
    expiresAt: number,
    id = `access_${randomUUID()}`,
  ): string {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO access_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        deviceId,
        accountId,
        info.deviceLabel,
        info.platform,
        info.osVersion,
        now,
        now,
        expiresAt,
      );
    this.db
      .prepare("DELETE FROM access_sessions WHERE started_at < ?")
      .run(now - 30 * 86400_000);
    this.db
      .prepare(
        "DELETE FROM access_sessions WHERE device_id = ? AND id NOT IN (SELECT id FROM access_sessions WHERE device_id = ? ORDER BY started_at DESC LIMIT 500)",
      )
      .run(deviceId, deviceId);
    return id;
  }

  touchAccessSession(id: string, deviceId: string) {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE access_sessions SET last_seen_at = ? WHERE id = ? AND device_id = ? AND ended_reason IS NULL AND expires_at > ? AND last_seen_at <= ?",
      )
      .run(now, id, deviceId, now, now - 60_000);
  }

  endAccessSession(id: string, reason: string) {
    this.db
      .prepare(
        "UPDATE access_sessions SET ended_reason = ?, last_seen_at = ? WHERE id = ? AND ended_reason IS NULL",
      )
      .run(reason.slice(0, 100), Date.now(), id);
  }

  listAccessSessions(deviceId: string, limit: number): AccessSession[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        "SELECT id, device_label deviceLabel, platform, os_version osVersion, started_at startedAt, last_seen_at lastSeenAt, expires_at expiresAt, ended_reason endedReason FROM access_sessions WHERE device_id = ? ORDER BY started_at DESC LIMIT ?",
      )
      .all(deviceId, limit) as any[];
    return rows.map(({ endedReason, ...row }) => ({
      ...row,
      status: endedReason ? "ended" : row.expiresAt <= now ? "expired" : "active",
    }));
  }

  adminStats(now = Date.now()): AdminStats {
    const count = (sql: string, ...params: unknown[]) =>
      Number((this.db.prepare(sql).get(...params) as { value: number }).value);
    const since24h = now - 86400_000;
    const since7d = now - 7 * 86400_000;
    const since30d = now - 30 * 86400_000;
    const startDay = new Date(since30d);
    startDay.setUTCHours(0, 0, 0, 0);
    const userRows = this.db
      .prepare(
        "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day, COUNT(*) value FROM accounts WHERE created_at >= ? GROUP BY day",
      )
      .all(startDay.getTime()) as Array<{ day: string; value: number }>;
    const sessionRows = this.db
      .prepare(
        "SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') day, COUNT(*) value FROM access_sessions WHERE started_at >= ? GROUP BY day",
      )
      .all(startDay.getTime()) as Array<{ day: string; value: number }>;
    const usersByDay = new Map(userRows.map((row) => [row.day, row.value]));
    const sessionsByDay = new Map(
      sessionRows.map((row) => [row.day, row.value]),
    );
    const daily: AdminStats["daily"] = [];
    for (let offset = 29; offset >= 0; offset -= 1) {
      const date = new Date(now - offset * 86400_000);
      const day = date.toISOString().slice(0, 10);
      daily.push({
        day,
        users: usersByDay.get(day) ?? 0,
        sessions: sessionsByDay.get(day) ?? 0,
      });
    }
    const recent = this.db
      .prepare(
        `SELECT s.id, a.email, d.name deviceName, s.platform,
                s.started_at startedAt, s.last_seen_at lastSeenAt,
                s.expires_at expiresAt, s.ended_reason endedReason
           FROM access_sessions s
           JOIN accounts a ON a.id = s.account_id
           JOIN devices d ON d.id = s.device_id
          ORDER BY s.started_at DESC
          LIMIT 50`,
      )
      .all() as Array<{
      id: string;
      email: string;
      deviceName: string;
      platform: string;
      startedAt: number;
      lastSeenAt: number;
      expiresAt: number;
      endedReason: string | null;
    }>;
    return {
      generatedAt: now,
      users: {
        total: count("SELECT COUNT(*) value FROM accounts"),
        new24h: count(
          "SELECT COUNT(*) value FROM accounts WHERE created_at >= ?",
          since24h,
        ),
        new7d: count(
          "SELECT COUNT(*) value FROM accounts WHERE created_at >= ?",
          since7d,
        ),
        new30d: count(
          "SELECT COUNT(*) value FROM accounts WHERE created_at >= ?",
          since30d,
        ),
      },
      devices: {
        total: count("SELECT COUNT(*) value FROM devices"),
        paired: count(
          "SELECT COUNT(*) value FROM devices WHERE account_id IS NOT NULL",
        ),
        online: count(
          "SELECT COUNT(*) value FROM devices WHERE last_seen_at IS NOT NULL",
        ),
        dshOnline: count(
          "SELECT COUNT(*) value FROM devices WHERE dsh_status = 'online'",
        ),
      },
      sessions: {
        active: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE ended_reason IS NULL AND expires_at > ?",
          now,
        ),
        last24h: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE started_at >= ?",
          since24h,
        ),
        last7d: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE started_at >= ?",
          since7d,
        ),
        last30d: count(
          "SELECT COUNT(*) value FROM access_sessions WHERE started_at >= ?",
          since30d,
        ),
        activeUsers30d: count(
          "SELECT COUNT(DISTINCT account_id) value FROM access_sessions WHERE started_at >= ?",
          since30d,
        ),
      },
      daily,
      recentSessions: recent.map(({ expiresAt, endedReason, ...row }) => ({
        ...row,
        status: endedReason ? "ended" : expiresAt <= now ? "expired" : "active",
      })),
    };
  }
  addEvent(deviceId: string, kind: string) {
    this.db
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), deviceId, kind, "{}", Date.now());
    this.db
      .prepare(
        "DELETE FROM events WHERE device_id = ? AND id NOT IN (SELECT id FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT 50)",
      )
      .run(deviceId, deviceId);
  }

  cleanupExpired(now = Date.now()) {
    const cleanup = this.db.transaction(() => ({
      refreshTokens: this.db
        .prepare("DELETE FROM refresh_tokens WHERE expires_at < ?")
        .run(now).changes,
      pairSessions: this.db
        .prepare("DELETE FROM pair_sessions WHERE expires_at < ? OR (used = 1 AND created_at < ?)")
        .run(now, now - 5 * 60_000).changes,
      accessSessions: this.db
        .prepare("DELETE FROM access_sessions WHERE started_at < ?")
        .run(now - 30 * 86400_000).changes,
      events: this.db
        .prepare("DELETE FROM events WHERE created_at < ?")
        .run(now - 30 * 86400_000).changes,
    }));
    return cleanup();
  }
}
