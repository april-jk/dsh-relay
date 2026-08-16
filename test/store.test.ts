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
