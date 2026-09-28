/**
 * Accounts and sessions.
 *
 * - Passwords are hashed with scrypt and a per-user salt; only the hash is stored.
 * - A session is a random 32-byte token in an HttpOnly cookie. The server keeps
 *   only a SHA-256 of the token, so a leaked sessions file cannot be replayed.
 * - "Remember me" gives a persistent 30-day cookie; otherwise the cookie lasts
 *   until the browser closes and the server forgets it after 12 hours.
 * - Users and sessions are kept in small JSON files under data/ so logins
 *   survive a restart. Swap for a database when you outgrow one process.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual, createHash, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

export const COOKIE = 'ev_session';
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const SHORT_MS = 12 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export class Auth {
  constructor({ dataDir }) {
    this.usersFile = join(dataDir, 'users.json');
    this.sessionsFile = join(dataDir, 'sessions.json');
    this.users = [];
    this.sessions = new Map();          // tokenHash -> { userId, expires, remember }
    this.attempts = new Map();          // key -> { count, start } for login throttling
    this.queue = Promise.resolve();     // serialises every change to users.json
  }

  /** Run fn with exclusive access to the user list, so concurrent requests cannot lose updates. */
  locked(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async init() {
    // Key for the reversible password copy managers can view. Kept outside users.json.
    const keyFile = join(dirname(this.usersFile), 'secret.key');
    try { this.key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'hex'); } catch {}
    if (!this.key || this.key.length !== 32) {
      this.key = randomBytes(32);
      await writeFile(keyFile, this.key.toString('hex'), { mode: 0o600 });
    }
    this.users = await readJson(this.usersFile, []);
    const saved = await readJson(this.sessionsFile, []);
    const now = Date.now();
    for (const s of saved) if (s.expires > now) this.sessions.set(s.hash, s);
    setInterval(() => this.#sweep(), 60 * 60 * 1000).unref();
  }

  /* ------------------------------ viewable passwords ------------------------------ */
  // AES-256-GCM copy of the password so the owner/reseller can show it again.
  // Login still checks the scrypt hash; this copy is only for display.
  encrypt(pw) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(pw, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  decrypt(blob) {
    if (!blob || !this.key) return null;
    try {
      const b = Buffer.from(blob, 'base64');
      const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch { return null; }
  }

  /* ------------------------------ users ------------------------------ */
  findByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return this.users.find(u => u.email === e);
  }

  /** The owner is the account marked role "owner", or else the first account created. */
  isOwner(user) {
    if (!user) return false;
    if (this.users.some(u => u.role === 'owner')) return user.role === 'owner';
    return this.users[0]?.id === user.id;
  }
  roleOf(user) { return this.isOwner(user) ? 'owner' : (user?.role === 'reseller' ? 'reseller' : 'user'); }
  canManageUsers(user) { return ['owner', 'reseller'].includes(this.roleOf(user)); }
  /** Owner always; a reseller only when the owner gave them "can create resellers". */
  canMakeResellers(user) {
    const role = this.roleOf(user);
    return role === 'owner' || (role === 'reseller' && !!user.canCreateResellers);
  }

  /** Users an actor can see: the owner sees everyone, a reseller only the users they created. */
  visibleTo(actor) {
    const role = this.roleOf(actor);
    if (role === 'owner') return this.users;
    if (role === 'reseller') return this.users.filter(u => u.createdBy === actor.id);
    return [];
  }
  canEdit(actor, target) {
    if (!target || actor.id === target.id) return false;       // manage yourself elsewhere
    if (this.roleOf(target) === 'owner') return false;           // owners are never edited here
    return this.visibleTo(actor).some(u => u.id === target.id);
  }

  /** Re-read users (the CLI may have added some), saving any pending activity first. */
  /** Must be called inside locked(). */
  async reload() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer); this.flushTimer = null;
      await writeJson(this.usersFile, this.users);
    }
    this.users = await readJson(this.usersFile, this.users);
  }

  updateUser(...a) { return this.locked(() => this._updateUser(...a)); }
  async _updateUser(actor, id, { name, password, reseller, disabled, canCreateResellers }) {
    await this.reload();
    const u = this.users.find(x => x.id === id);
    if (!this.canEdit(actor, u)) throw new AuthError(404, 'User not found');
    if (name !== undefined) u.name = String(name).trim().slice(0, 80) || u.email;
    const me = this.users.find(x => x.id === actor.id) || actor;
    if (reseller !== undefined && (reseller ? 'reseller' : 'user') !== u.role) {
      if (!this.canMakeResellers(me)) throw new AuthError(403, 'You cannot change reseller access');
      u.role = reseller ? 'reseller' : 'user';
      if (!reseller) u.canCreateResellers = false;
    }
    if (canCreateResellers !== undefined && !!canCreateResellers !== !!u.canCreateResellers) {
      if (this.roleOf(me) !== 'owner') throw new AuthError(403, 'Only the owner can let a reseller create resellers');
      if (canCreateResellers && u.role !== 'reseller') throw new AuthError(400, 'Turn on Reseller first');
      u.canCreateResellers = !!canCreateResellers;
    }
    let signOut = false;
    if (disabled !== undefined) { u.disabled = !!disabled; signOut = u.disabled; }
    if (password) {
      if (typeof password !== 'string' || password.length < 8) throw new AuthError(400, 'Password must be at least 8 characters');
      u.salt = randomBytes(16).toString('hex');
      u.hash = (await scrypt(password, u.salt, 64)).toString('hex');
      u.pwEnc = this.encrypt(password);
      signOut = true;
    }
    await writeJson(this.usersFile, this.users);
    if (signOut) await this.#dropSessions(u.id);
    return u;
  }

  deleteUser(...a) { return this.locked(() => this._deleteUser(...a)); }
  async _deleteUser(actor, id) {
    await this.reload();
    const u = this.users.find(x => x.id === id);
    if (!this.canEdit(actor, u)) throw new AuthError(404, 'User not found');
    // A deleted reseller's users are handed to whoever deleted them.
    for (const x of this.users) if (x.createdBy === u.id) x.createdBy = actor.id;
    this.users = this.users.filter(x => x.id !== id);
    await writeJson(this.usersFile, this.users);
    await this.#dropSessions(id);
  }

  async #dropSessions(userId) {
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
    await this.#saveSessions();
  }

  /* ------------------------------ credits ------------------------------ */
  // 1 credit = 1 email check. Owners are unlimited (credits: null).
  creditsOf(user) { return this.isOwner(user) ? null : (user.credits || 0); }

  /** Give credits back (e.g. a check failed on our side). */
  refund(user, n) {
    return this.locked(async () => {
      if (this.isOwner(user) || n <= 0) return;
      const u = this.users.find(x => x.id === user.id);
      if (!u) return;
      u.credits = (u.credits || 0) + n;
      await writeJson(this.usersFile, this.users);
    });
  }

  /** Take n credits for n checks; throws 402 when the balance is too low. */
  charge(user, n) { return this.locked(() => this._charge(user, n)); }
  async _charge(user, n) {
    if (this.isOwner(user) || n <= 0) return;
    const u = this.users.find(x => x.id === user.id);
    const have = u?.credits || 0;
    if (have < n) {
      throw new AuthError(402, have
        ? `Not enough credits: this needs ${n.toLocaleString()} but you have ${have.toLocaleString()}. Ask your provider for more.`
        : 'No credits remaining. Top up to keep checking emails.');
    }
    u.credits = have - n;
    await writeJson(this.usersFile, this.users);
  }

  /** Give (or with a negative amount, take back) credits. A reseller pays from their own balance. */
  transferCredits(...a) { return this.locked(() => this._transferCredits(...a)); }
  async _transferCredits(actor, id, amount) {
    await this.reload();
    const target = this.users.find(x => x.id === id);
    if (!this.canEdit(actor, target)) throw new AuthError(404, 'User not found');
    const n = Math.trunc(Number(amount));
    if (!Number.isFinite(n) || n === 0) throw new AuthError(400, 'Enter a number of credits');
    if (Math.abs(n) > 100_000_000) throw new AuthError(400, 'That amount is too large');
    if (n < 0 && (target.credits || 0) < -n) throw new AuthError(400, `They only have ${(target.credits || 0).toLocaleString()} credits`);
    if (!this.isOwner(actor)) {
      const me = this.users.find(x => x.id === actor.id);
      if (n > 0 && (me.credits || 0) < n) throw new AuthError(402, `You only have ${(me.credits || 0).toLocaleString()} credits to give`);
      me.credits = (me.credits || 0) - n;          // giving costs the reseller; taking back refunds them
    }
    target.credits = (target.credits || 0) + n;
    await writeJson(this.usersFile, this.users);
    return target;
  }

  /* ------------------------------ activity ------------------------------ */
  // Counters are updated in memory and flushed to disk at most every 10 s.
  track(user, { checks = 0, login = false } = {}) {
    const u = this.users.find(x => x.id === user.id);
    if (!u) return;
    const now = new Date().toISOString();
    u.lastActiveAt = now;
    if (login) { u.lastLoginAt = now; u.logins = (u.logins || 0) + 1; }
    if (checks) u.checks = (u.checks || 0) + checks;
    if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      writeJson(this.usersFile, this.users).catch(() => {});
    }, 10_000);
  }

  signup(opts) { return this.locked(() => this._signup(opts)); }
  async _signup({ name, email, username, password, role, createdBy, canCreateResellers }) {
    await this.reload();   // pick up accounts added by the CLI
    // A login is an email or a plain username; both are stored in the same field.
    const e = String(username || email || '').trim().toLowerCase();
    const n = String(name || username || '').trim().slice(0, 80);
    if (username !== undefined) {
      if (!/^[a-z0-9._-]{3,32}$/.test(e)) throw new AuthError(400, 'Username must be 3–32 letters, numbers, dots, dashes or underscores');
    } else if (!EMAIL_RE.test(e) || e.length > 254) throw new AuthError(400, 'Enter a valid email address');
    if (typeof password !== 'string' || password.length < 8) throw new AuthError(400, 'Password must be at least 8 characters');
    if (password.length > 200) throw new AuthError(400, 'Password is too long');
    if (this.findByEmail(e)) throw new AuthError(409, 'That username or email is already taken');

    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(password, salt, 64)).toString('hex');
    const user = { id: randomUUID(), email: e, name: n || e.split('@')[0], role: role || (this.users.length ? 'user' : 'owner'), createdBy: createdBy || null, canCreateResellers: role === 'reseller' && !!canCreateResellers, credits: 0, salt, hash, pwEnc: this.key ? this.encrypt(password) : undefined, createdAt: new Date().toISOString() };
    this.users.push(user);
    await writeJson(this.usersFile, this.users);
    return user;
  }

  async setPassword(user, password) {
    if (typeof password !== 'string' || password.length < 8) throw new AuthError(400, 'Password must be at least 8 characters');
    user.salt = randomBytes(16).toString('hex');
    user.hash = (await scrypt(password, user.salt, 64)).toString('hex');
    user.pwEnc = this.encrypt(password);
    await writeJson(this.usersFile, this.users);
    // Sign the user out everywhere after a reset.
    for (const [k, s] of this.sessions) if (s.userId === user.id) this.sessions.delete(k);
    await this.#saveSessions();
  }

  async verify(email, password) {
    // Re-read users so accounts added with `npm run add-user` work without a restart.
    await this.locked(() => this.reload());
    const user = this.findByEmail(email);
    // Hash even when the user is missing so response time does not reveal which emails exist.
    const salt = user?.salt || 'x'.repeat(32);
    const got = await scrypt(String(password || ''), salt, 64);
    if (!user || user.disabled) return null;
    const want = Buffer.from(user.hash, 'hex');
    return got.length === want.length && timingSafeEqual(got, want) ? user : null;
  }

  /* ------------------------------ throttling ------------------------------ */
  /** Allow 8 failed attempts per IP+email in 15 minutes. */
  checkThrottle(key) {
    const rec = this.attempts.get(key);
    if (!rec || Date.now() - rec.start > 15 * 60 * 1000) return 0;
    if (rec.count < 8) return 0;
    return Math.ceil((rec.start + 15 * 60 * 1000 - Date.now()) / 1000);
  }
  recordFailure(key) {
    const rec = this.attempts.get(key);
    if (!rec || Date.now() - rec.start > 15 * 60 * 1000) this.attempts.set(key, { count: 1, start: Date.now() });
    else rec.count++;
  }
  clearFailures(key) { this.attempts.delete(key); }

  /* ------------------------------ sessions ------------------------------ */
  async createSession(user, remember) {
    const token = randomBytes(32).toString('base64url');
    const s = { hash: sha256(token), userId: user.id, remember: !!remember, expires: Date.now() + (remember ? REMEMBER_MS : SHORT_MS) };
    this.sessions.set(s.hash, s);
    await this.#saveSessions();
    return { token, maxAge: remember ? REMEMBER_MS : null };
  }

  userForToken(token) {
    if (!token) return null;
    const s = this.sessions.get(sha256(token));
    if (!s || s.expires < Date.now()) return null;
    const u = this.users.find(x => x.id === s.userId);
    return u && !u.disabled ? u : null;
  }

  async destroySession(token) {
    if (!token) return;
    if (this.sessions.delete(sha256(token))) await this.#saveSessions();
  }

  #sweep() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of this.sessions) if (s.expires < now) { this.sessions.delete(k); changed = true; }
    for (const [k, a] of this.attempts) if (now - a.start > 15 * 60 * 1000) this.attempts.delete(k);
    if (changed) this.#saveSessions().catch(() => {});
  }

  #saveSessions() { return writeJson(this.sessionsFile, [...this.sessions.values()]); }
}

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Public shape of a user: never send the hash or salt. */
export const publicUser = (u, owner = false) => ({ id: u.id, email: u.email, name: u.name, role: owner ? 'owner' : 'user', createdAt: u.createdAt });

/** Read one cookie value from a request. */
export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(req, token, maxAge) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (req.secure) parts.push('Secure');
  if (maxAge) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join('; ');
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}
// Write to a temp file and rename, so a crash mid-write never corrupts the file.
async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
