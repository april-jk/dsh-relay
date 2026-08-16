import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

export type Device = { id: string; accountId: string; name: string; lastSeenAt: number | null; dshStatus: 'online' | 'offline'; online: boolean; createdAt: number };
export type Account = { id: string; email: string };

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function passwordHash(password: string): string { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function passwordMatches(password: string, stored: string): boolean { const [salt, expected] = stored.split(':'); if (!salt || !expected) return false; const actual = scryptSync(password, salt, 64); return timingSafeEqual(actual, Buffer.from(expected, 'hex')); }

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS refresh_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, account_id TEXT, name TEXT NOT NULL, device_token_hash TEXT, last_seen_at INTEGER, dsh_status TEXT NOT NULL DEFAULT 'offline', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pair_sessions (code TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, claimed_by TEXT, used INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
  }
  close() { this.db.close(); }
  createAccount(email: string, password: string): Account { const id = `acc_${randomUUID()}`; this.db.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?)').run(id, email.toLowerCase(), passwordHash(password), Date.now()); return { id, email: email.toLowerCase() }; }
  findAccount(email: string): (Account & { passwordHash: string }) | null { const row = this.db.prepare('SELECT id, email, password_hash passwordHash FROM accounts WHERE email = ?').get(email.toLowerCase()) as any; return row ?? null; }
  verifyPassword(email: string, password: string): Account | null { const row = this.findAccount(email); return row && passwordMatches(password, row.passwordHash) ? { id: row.id, email: row.email } : null; }
  saveRefresh(accountId: string, token: string, expiresAt: number) { this.db.prepare('INSERT INTO refresh_tokens VALUES (?, ?, ?)').run(hash(token), accountId, expiresAt); }
  consumeRefresh(token: string): string | null { const row = this.db.prepare('SELECT account_id accountId, expires_at expiresAt FROM refresh_tokens WHERE token_hash = ?').get(hash(token)) as any; if (!row || row.expiresAt < Date.now()) return null; this.db.prepare('DELETE FROM refresh_tokens WHERE token_hash = ?').run(hash(token)); return row.accountId; }
  createPair(): { code: string; deviceId: string; deviceSecret: string; expiresAt: number } { const code = String(Math.floor(100000 + Math.random() * 900000)); const deviceId = `dev_${randomUUID()}`; const deviceSecret = randomBytes(32).toString('hex'); const now = Date.now(); const expiresAt = now + 5 * 60_000; this.db.prepare('INSERT INTO pair_sessions VALUES (?, ?, ?, ?, NULL, 0, ?)').run(code, deviceId, hash(deviceSecret), expiresAt, now); return { code, deviceId, deviceSecret, expiresAt }; }
  claimPair(code: string, accountId: string): { deviceId: string } | null { const row = this.db.prepare('SELECT * FROM pair_sessions WHERE code = ?').get(code) as any; if (!row || row.used || row.expires_at < Date.now() || (row.claimed_by && row.claimed_by !== accountId)) return null; this.db.prepare('UPDATE pair_sessions SET claimed_by = ? WHERE code = ?').run(accountId, code); return { deviceId: row.device_id }; }
  confirmPair(deviceId: string, deviceSecret: string, name: string): string | 'pending' | null { const row = this.db.prepare('SELECT * FROM pair_sessions WHERE device_id = ? ORDER BY created_at DESC LIMIT 1').get(deviceId) as any; if (!row || row.used || row.expires_at < Date.now() || hash(deviceSecret) !== row.device_secret_hash) return null; if (!row.claimed_by) return 'pending'; const token = randomBytes(32).toString('hex'); this.db.prepare('INSERT OR REPLACE INTO devices VALUES (?, ?, ?, ?, NULL, \'offline\', ?)').run(deviceId, row.claimed_by, name || 'DSH Computer', hash(token), Date.now()); this.db.prepare('UPDATE pair_sessions SET used = 1 WHERE code = ?').run(row.code); return token; }
  listDevices(accountId: string, online: (id: string) => boolean): Device[] { const rows = this.db.prepare('SELECT id, account_id accountId, name, last_seen_at lastSeenAt, dsh_status dshStatus, created_at createdAt FROM devices WHERE account_id = ? ORDER BY created_at').all(accountId) as any[]; return rows.map((d) => ({ ...d, online: online(d.id) })); }
  device(id: string): any { return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id); }
  findDeviceByToken(id: string, token: string): any { const row = this.device(id); return row && row.device_token_hash === hash(token) ? row : null; }
  updateStatus(id: string, status: 'online' | 'offline', dsh: 'online' | 'offline') { this.db.prepare('UPDATE devices SET last_seen_at = ?, dsh_status = ? WHERE id = ?').run(status === 'online' ? Date.now() : null, dsh, id); }
  rename(id: string, accountId: string, name: string) { this.db.prepare('UPDATE devices SET name = ? WHERE id = ? AND account_id = ?').run(name, id, accountId); }
  unbind(id: string, accountId: string): boolean { return this.db.prepare('UPDATE devices SET account_id = NULL, device_token_hash = NULL WHERE id = ? AND account_id = ?').run(id, accountId).changes > 0; }
  addEvent(deviceId: string, kind: string, payload: unknown) { this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(randomUUID(), deviceId, kind, JSON.stringify(payload), Date.now()); this.db.prepare('DELETE FROM events WHERE device_id = ? AND id NOT IN (SELECT id FROM events WHERE device_id = ? ORDER BY created_at DESC LIMIT 50)').run(deviceId, deviceId); }
}
