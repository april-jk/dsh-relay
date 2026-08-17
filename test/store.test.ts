import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

test("expired temporary records are removed", () => {
  const store = new Store(":memory:");
  store.saveRefresh("account", "expired", 1);
  const pair = store.createPair();
  store.db
    .prepare("UPDATE pair_sessions SET expires_at = 1 WHERE code = ?")
    .run(pair.code);

  const removed = store.cleanupExpired(2);
  assert.equal(removed.refreshTokens, 1);
  assert.equal(removed.pairSessions, 1);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) count FROM refresh_tokens").get() as any)
      .count,
    0,
  );
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) count FROM pair_sessions").get() as any)
      .count,
    0,
  );
  store.close();
});

test("admin statistics aggregate metadata without tunnel content", () => {
  const store = new Store(":memory:");
  const now = Date.UTC(2026, 7, 17, 12);
  const account = store.createAccount("stats@example.com", "correct-horse");
  store.db
    .prepare("UPDATE accounts SET created_at = ? WHERE id = ?")
    .run(now - 3600_000, account.id);
  store.db
    .prepare(
      "INSERT INTO devices (id, account_id, name, dsh_status, created_at, last_seen_at) VALUES (?, ?, ?, 'online', ?, ?)",
    )
    .run("dev_stats", account.id, "Stats Mac", now - 7200_000, now);
  store.createAccessSession(
    "dev_stats",
    account.id,
    {
      deviceLabel: "Safari on iPhone",
      platform: "ios",
      osVersion: "18.6",
    },
    now + 3600_000,
    "access_stats",
  );
  store.db
    .prepare(
      "UPDATE access_sessions SET started_at = ?, last_seen_at = ? WHERE id = ?",
    )
    .run(now - 1800_000, now, "access_stats");

  const stats = store.adminStats(now);
  assert.equal(stats.users.total, 1);
  assert.equal(stats.users.new24h, 1);
  assert.equal(stats.devices.paired, 1);
  assert.equal(stats.devices.dshOnline, 1);
  assert.equal(stats.sessions.active, 1);
  assert.equal(stats.sessions.activeUsers30d, 1);
  assert.equal(stats.daily.length, 30);
  assert.equal(stats.daily.at(-1)?.users, 1);
  assert.equal(stats.daily.at(-1)?.sessions, 1);
  assert.deepEqual(stats.recentSessions[0], {
    id: "access_stats",
    email: "stats@example.com",
    deviceName: "Stats Mac",
    platform: "ios",
    startedAt: now - 1800_000,
    lastSeenAt: now,
    status: "active",
  });
  assert.doesNotMatch(JSON.stringify(stats), /password|token|payload/i);

  store.endAccessSession("access_stats", "client closed");
  const ended = store.adminStats(now + 1);
  assert.equal(ended.sessions.active, 0);
  assert.equal(ended.recentSessions[0].status, "ended");
  store.close();
});
