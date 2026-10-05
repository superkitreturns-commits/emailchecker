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
import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);

export const COOKIE = 'ev_session';
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const SHORT_MS = 12 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Partner tiers allowed below the owner. 2 = you -> partner -> sub-partner. */
const MAX_PARTNER_DEPTH = Number(process.env.MAX_PARTNER_DEPTH || 2);

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export class Auth {
  constructor({ dataDir }) {
    this.usersFile = join(dataDir, 'users.json');
    this.sessionsFile = join(dataDir, 'sessions.json');
    // Bulk-job payloads (the address list and per-address results) live one
    // file per job here, NOT inline in users.json. A single large run used to
    // bloat users.json to tens of MB and rewrite the whole thing on every
    // progress snapshot - slow, and prone to corrupting the user records when
    // a write was interrupted. Now a snapshot only rewrites that job's file.
    this.jobsDir = join(dataDir, 'jobs');
    this.users = [];
    this.sessions = new Map();          // tokenHash -> { userId, expires, remember }
    this.attempts = new Map();          // key -> { count, start } for login throttling
    this.sessionQueue = Promise.resolve();
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
    //
    // SECRET_KEY (64 hex chars) takes precedence over the file. On a host with
    // an ephemeral filesystem a generated key would be lost on every redeploy,
    // which silently breaks every stored pwEnc; an env var survives.
    const envKey = String(process.env.SECRET_KEY || '').trim();
    if (envKey) {
      if (!/^[0-9a-f]{64}$/i.test(envKey)) {
        throw new Error('SECRET_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
      }
      this.key = Buffer.from(envKey, 'hex');
    }
    const keyFile = join(dirname(this.usersFile), 'secret.key');
    if (!this.key) {
      try { this.key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'hex'); } catch {}
    }
    if (!this.key || this.key.length !== 32) {
      this.key = randomBytes(32);
      // A read-only or unmounted DATA_DIR used to abort boot here with a raw
      // EACCES stack trace, which on a managed host reads as "the app
      // crashed" with no indication of the cause. The key only needs to
      // persist so stored passwords stay readable across restarts, so a
      // failed write is a warning, not a fatal error: the app runs, and the
      // message says exactly how to make it durable.
      try {
        await writeFile(keyFile, this.key.toString('hex'), { mode: 0o600 });
      } catch (err) {
        this.keyEphemeral = true;
        console.warn(
          `\n  WARNING: could not write ${keyFile} (${err.code || err.message}).\n` +
          '  A new key is generated on every restart, so saved passwords cannot be\n' +
          '  shown again and sessions end at each deploy.\n' +
          '  Fix: set SECRET_KEY to 64 hex characters (openssl rand -hex 32),\n' +
          '  or point DATA_DIR at a writable volume.\n'
        );
      }
    }
    await mkdir(this.jobsDir, { recursive: true }).catch(() => {});
    this.users = await readJson(this.usersFile, []);
    const saved = await readJson(this.sessionsFile, [], { tolerateCorruption: true });
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
    if (role === 'owner') return true;
    if (role !== 'reseller' || !user.canCreateResellers) return false;
    // Depth cap. Unlimited nesting made the tree, the refund path and the
    // see-versus-manage rules compound with every level, for a structure
    // nobody actually sells through. Two partner tiers below the owner is
    // enough for "my reseller has resellers"; past that the chain is cut.
    return this.depthOf(user) < MAX_PARTNER_DEPTH;
  }

  /** How many accounts sit between this user and the owner. Owner = 0. */
  depthOf(user) {
    let depth = 0;
    let current = user;
    const seen = new Set();
    while (current?.createdBy && !seen.has(current.id)) {
      seen.add(current.id);
      current = this.users.find(u => u.id === current.createdBy);
      if (!current || this.isOwner(current)) break;
      depth++;
    }
    return depth + 1;
  }

  /**
   * Every account below an actor, at any depth.
   *
   * A partner who creates a partner has a network, not just a row: without
   * the whole subtree they cannot see how many clients sit under them or how
   * many credits are still out there. Seeing is not managing - see canEdit.
   */
  descendantsOf(id) {
    const out = [];
    const queue = [id];
    const seen = new Set([id]);
    while (queue.length) {
      const parent = queue.shift();
      for (const u of this.users) {
        // createdBy cycles cannot happen through the API, but a hand-edited
        // users.json should not spin forever.
        if (u.createdBy !== parent || seen.has(u.id)) continue;
        seen.add(u.id);
        out.push(u);
        queue.push(u.id);
      }
    }
    return out;
  }

  /** Accounts an actor may SEE: the owner sees everyone, a partner sees their
   *  whole downstream tree. */
  visibleTo(actor) {
    const role = this.roleOf(actor);
    if (role === 'owner') return this.users;
    if (role === 'reseller') return this.descendantsOf(actor.id);
    return [];
  }

  /** Accounts an actor may CHANGE: only the ones they created themselves.
   *  A sub-partner's clients are visible for reporting but belong to that
   *  partner - reaching into them would let credits be taken back from a
   *  client the actor never funded. */
  managedBy(actor) {
    const role = this.roleOf(actor);
    if (role === 'owner') return this.users;
    if (role === 'reseller') return this.users.filter(u => u.createdBy === actor.id);
    return [];
  }

  /**
   * May this actor open the reports page at all?
   *
   * The owner always can. A partner only once the owner has granted it, which
   * is deliberately off by default: the page carries every client's volumes.
   */
  canSeeReports(actor) {
    if (this.isOwner(actor)) return true;
    return this.roleOf(actor) === 'reseller' && !!actor.canViewReports;
  }

  /**
   * Lifetime totals per account the actor may see, newest activity first.
   *
   * Reads the stored lifetime figures rather than the job list: jobs are
   * pruned an hour after they finish, so anything counted from them would
   * reset to zero overnight.
   */
  reportRows(actor) {
    if (!this.canSeeReports(actor)) return [];
    const live = this.users.find(u => u.id === actor.id) || actor;
    // The owner's report covers everyone including themselves; a partner's
    // covers the clients below them, never their own siblings or the owner.
    const scope = this.isOwner(live) ? this.users : this.descendantsOf(live.id);
    return scope.map(u => {
      const stats = u.stats || {};
      const counts = Object.fromEntries(VERDICTS.map(v => [v, stats[v] || 0]));
      const total = VERDICTS.reduce((n, v) => n + counts[v], 0);
      // Jobs still on disk are the ones whose addresses can be downloaded;
      // older runs survive only as the totals above.
      const jobs = Object.values(u.bulkJobs || {})
        .map(j => ({
          id: j.id, state: j.state, total: j.total || 0, done: j.done || 0,
          createdAt: j.createdAt || null, finishedAt: j.finishedAt || null,
          summary: j.summary || {}
        }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return {
        id: u.id, name: u.name, username: u.email, role: this.roleOf(u),
        disabled: !!u.disabled, credits: this.creditsOf(u),
        lastActiveAt: u.lastActiveAt || null,
        counts, total, jobs
      };
    }).sort((a, b) => b.total - a.total);
  }

  /**
   * Every address of one verdict belonging to a user, for export.
   *
   * Only reaches jobs whose payload file still exists: an expired run is kept
   * as totals, not as addresses, so a download after that window is honestly
   * short rather than silently wrong. De-duplicated, since the same address
   * can appear in more than one batch.
   */
  async addressesFor(actor, userId, verdict) {
    if (!this.canSeeReports(actor)) throw new AuthError(403, 'You cannot view reports');
    const allowed = this.reportRows(actor).some(r => r.id === userId);
    if (!allowed) throw new AuthError(404, 'User not found');
    if (!VERDICTS.includes(verdict)) throw new AuthError(400, 'Unknown verdict');

    const u = this.users.find(x => x.id === userId);
    const out = new Set();
    for (const meta of Object.values(u?.bulkJobs || {})) {
      const job = await this.#loadJob(meta);
      if (!job) continue;                       // payload expired or removed
      for (const r of job.results) {
        if (r && r.verdict === verdict && r.email) out.add(r.email);
      }
    }
    return [...out];
  }

  canView(actor, target) {
    if (!target || actor.id === target.id) return false;
    return this.visibleTo(actor).some(u => u.id === target.id);
  }

  canEdit(actor, target) {
    if (!target || actor.id === target.id) return false;       // manage yourself elsewhere
    if (this.roleOf(target) === 'owner') return false;           // owners are never edited here
    return this.managedBy(actor).some(u => u.id === target.id);
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
  async _updateUser(actor, id, { name, password, reseller, disabled, canCreateResellers, canViewReports }) {
    await this.reload();
    const index = this.users.findIndex(x => x.id === id);
    const current = this.users[index];
    if (!this.canEdit(actor, current)) throw new AuthError(404, 'User not found');
    // Validate and prepare a copy; rejected edits must not mutate live permissions.
    const u = { ...current };
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
    // Reports expose every client's address counts, so only the owner hands
    // this out, and only to a partner - a plain client has no one to report on.
    if (canViewReports !== undefined && !!canViewReports !== !!u.canViewReports) {
      if (this.roleOf(me) !== 'owner') throw new AuthError(403, 'Only the owner can grant report access');
      if (canViewReports && u.role !== 'reseller') throw new AuthError(400, 'Turn on Partner first');
      u.canViewReports = !!canViewReports;
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
    const updated = this.users.map((user, i) => i === index ? u : user);
    await writeJson(this.usersFile, updated);
    this.users = updated;
    if (signOut) await this.#dropSessions(u.id);
    return u;
  }

  deleteUser(...a) { return this.locked(() => this._deleteUser(...a)); }
  async _deleteUser(actor, id) {
    await this.reload();
    const u = this.users.find(x => x.id === id);
    if (!this.canEdit(actor, u)) throw new AuthError(404, 'User not found');
    // Credits a running bulk job reserved but never spent. reserveBulk charges
    // the whole batch upfront, so deleting the account mid-run would otherwise
    // bill for addresses that were never checked and never will be.
    const unstarted = Object.values(u.bulkJobs || {})
      .filter(j => j.state !== 'done' && j.state !== 'failed')
      .reduce((sum, j) => sum + Math.max(0, (j.total || 0) - (j.done || 0)), 0);
    const refund = (u.credits || 0) + unstarted;

    // The refund goes to whoever PAID for the account, not to whoever pressed
    // delete. Those are the same person when a reseller removes its own user,
    // which is why paying the deleter looked right - but when the owner tidied
    // up a reseller's user, the reseller had already paid for those credits
    // and got nothing back, so they simply vanished from the system.
    // An owner-funded account needs no refund: owners are unlimited.
    const creator = u.createdBy ? this.users.find(x => x.id === u.createdBy) : null;
    const payee = creator && !this.isOwner(creator) ? creator : null;

    const updated = this.users.filter(x => x.id !== id).map(x => {
      // A deleted reseller's users are handed to whoever deleted them.
      let next = x.createdBy === u.id ? { ...x, createdBy: actor.id } : x;
      if (payee && next.id === payee.id && refund) {
        next = { ...next, credits: (next.credits || 0) + refund };
      }
      return next;
    });
    // Refund and deletion commit together; repeated deletion cannot refund twice.
    await writeJson(this.usersFile, updated);
    this.users = updated;
    await this.#dropSessions(id);
  }

  async #dropSessions(userId) {
    for (const [k, s] of this.sessions) if (s.userId === userId) this.sessions.delete(k);
    await this.#saveSessions();
  }

  /* ------------------------------ credits ------------------------------ */
  // 1 credit = 1 email check. Owners are unlimited (credits: null).
  creditsOf(user) { return this.isOwner(user) ? null : (user.credits || 0); }

  /**
   * Give credits back (e.g. a check failed on our side).
   *
   * `countedCheck` says whether the check being refunded was ever added to the
   * Checks total. Bulk counts the whole batch up front, so a refund there has
   * a check to roll back. A single check is counted only after it succeeds, so
   * rolling back there would subtract somebody else's earlier check - and at a
   * total of zero the clamp below swallowed it, leaving a check recorded for a
   * credit that was handed back.
   */
  refund(user, n, { countedCheck = true } = {}) {
    return this.locked(async () => {
      if (n <= 0) return;
      const u = this.users.find(x => x.id === user.id);
      if (!u) return;
      // Every refund in this codebase means the same thing: that check did not
      // happen. The "Checks" figure sits next to "Credits" in the admin table,
      // so it has to roll back with them - otherwise a user whose probes all
      // failed shows 520 checks against 500 credits spent, and the two columns
      // disagree about the same work.
      // Owners are unlimited so they have no balance to credit, but their
      // check count is still real and must be corrected.
      if (countedCheck) u.checks = Math.max(0, (u.checks || 0) - n);
      if (!this.isOwner(u)) u.credits = (u.credits || 0) + n;
      await writeJson(this.usersFile, this.users);
    });
  }

  /** Take n credits for n checks; throws 402 when the balance is too low. */
  charge(user, n) { return this.locked(() => this._charge(user, n)); }
  async _charge(user, n) {
    if (this.isOwner(user) || n <= 0) return;
    const u = this.users.find(x => x.id === user.id);
    // Belt and braces: userForToken already refuses a disabled account, so a
    // request cannot reach here. Checked again because "cannot spend" is a
    // property of the account, not of one route's guard.
    if (u?.disabled) throw new AuthError(403, 'This account is disabled');
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
    // A suspended manager must not keep moving credits around. Sessions are
    // dropped on disable so this is unreachable over HTTP, but the rule
    // belongs with the balance, not only with the session check.
    const actorNow = this.users.find(x => x.id === actor.id);
    if (actorNow?.disabled) throw new AuthError(403, 'This account is disabled');
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

  #jobFile(id) { return join(this.jobsDir, `${id}.json`); }

  /** The big arrays go to the job's own file; only light metadata to users.json. */
  async #writeJobBlob(job) {
    await writeJson(this.#jobFile(job.id), {
      emails: job.emails || [],
      results: job.results || [],
      order: job.order || []
    });
  }

  async #deleteJobBlob(id) {
    try { await unlink(this.#jobFile(id)); } catch { /* already gone */ }
  }

  /**
   * Rebuild a full job from its stored metadata plus its payload file.
   *
   * Legacy jobs written before the split still carry the arrays inline; use
   * those when no payload file exists so old runs survive the upgrade. Returns
   * null when the payload is gone and there is nothing inline to fall back on.
   */
  async #loadJob(meta) {
    const blob = await readJson(this.#jobFile(meta.id), null, { tolerateCorruption: true });
    const emails = blob?.emails ?? meta.emails;
    if (!Array.isArray(emails)) return null; // payload lost and no inline copy
    return {
      ...meta,
      emails,
      results: blob?.results ?? meta.results ?? new Array(emails.length).fill(null),
      order: blob?.order ?? meta.order ?? []
    };
  }

  /** Reserve bulk credits and the recoverable job together, before starting work. */
  reserveBulk(user, emails) {
    return this.locked(async () => {
      const u = this.users.find(x => x.id === user.id);
      if (!u || u.disabled) throw new AuthError(401, 'Please sign in');
      if (!this.isOwner(u) && (u.credits || 0) < emails.length) {
        throw new AuthError(402, 'Not enough credits for this batch');
      }
      const job = {
        id: randomUUID(), userId: u.id, emails, state: 'queued', total: emails.length,
        done: 0, createdAt: Date.now(), finishedAt: null,
        summary: { valid: 0, risky: 0, unknown: 0, invalid: 0 },
        results: new Array(emails.length).fill(null), order: [], error: null, refunded: 0
      };
      await this.#writeJobBlob(job);
      const cutoff = Date.now() - Number(process.env.JOB_TTL_MS || 3600000);
      const bulkJobs = {};
      for (const [id, j] of Object.entries(u.bulkJobs || {})) {
        if (j.finishedAt && j.finishedAt < cutoff) { await this.#deleteJobBlob(id); continue; }
        // A legacy record still carries its arrays inline and has no payload
        // file yet. Write one BEFORE jobMeta() strips them, or the job's
        // addresses and results would be dropped here with nothing holding
        // them. Only untouched legacy records still have the arrays, so this
        // can never overwrite a newer payload.
        if (Array.isArray(j.emails)) await this.#writeJobBlob(j);
        bulkJobs[id] = jobMeta(j);
      }
      bulkJobs[job.id] = jobMeta(job);
      const updated = { ...u, bulkJobs,
        credits: this.isOwner(u) ? u.credits : (u.credits || 0) - emails.length };
      const users = this.users.map(x => x.id === u.id ? updated : x);
      await writeJson(this.usersFile, users);
      this.users = users;
      return structuredClone(job);
    });
  }

  async bulkJobs() {
    const cutoff = Date.now() - Number(process.env.JOB_TTL_MS || 3600000);
    const metas = this.users.flatMap(u => Object.values(u.bulkJobs || {}))
      .filter(j => !j.finishedAt || j.finishedAt >= cutoff);
    const jobs = [];
    for (const meta of metas) {
      const job = await this.#loadJob(meta);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /**
   * Forget stored jobs belonging to one user.
   *
   * Only finished work can be dropped: deleting a running job would leave its
   * workers writing progress back into a record that no longer exists, and the
   * credits for its unchecked addresses would never be refunded.
   *
   * @param {string} userId
   * @param {?string} jobId  one job, or every finished job when omitted
   * @returns {Promise<number>} how many were removed
   */
  forgetBulk(userId, jobId = null) {
    return this.locked(async () => {
      const u = this.users.find(x => x.id === userId);
      if (!u?.bulkJobs) return 0;

      const kept = {};
      let removed = 0;
      for (const [id, job] of Object.entries(u.bulkJobs)) {
        const finished = job.state === 'done' || job.state === 'failed';
        const match = jobId ? id === jobId : true;
        if (finished && match) { removed++; await this.#deleteJobBlob(id); }
        else kept[id] = job;
      }
      if (!removed) return 0;

      const updated = { ...u, bulkJobs: kept };
      const users = this.users.map(x => x.id === u.id ? updated : x);
      await writeJson(this.usersFile, users);
      this.users = users;
      return removed;
    });
  }

  /** Commit progress and failure refunds together, so retries cannot refund twice. */
  saveBulk(job) {
    return this.locked(async () => {
      const u = this.users.find(x => x.id === job.userId);
      if (!u) return; // Account was removed while the job was running.

      // Read the running job's counters in one synchronous pass, before any
      // await can let its workers move them. This replaces a structuredClone
      // of the whole job, which copied every address and every result - at
      // 100k addresses roughly 50 MB duplicated on each of ~50 saves, purely
      // to keep these few numbers still.
      const { id, state, total, done } = job;
      let failed = 0;
      for (const r of job.results) {
        if (r?.meta?.smtp?.workerError || r?.meta?.validationError) failed++;
      }
      const refunded = failed + (state === 'failed' ? total - done : 0);
      const previous = u.bulkJobs?.[id];
      const refund = Math.max(0, refunded - (previous?.refunded || 0));
      // Written back so the running job carries what was committed; the next
      // save compares against the stored figure, so a retry cannot refund twice.
      job.refunded = refunded;

      // The payload goes to the job's own file, so a progress save never
      // rewrites the whole user list. JSON.stringify walks the arrays
      // synchronously, so the file is a consistent view without a copy.
      await this.#writeJobBlob(job);

      // The whole batch was counted as checks when it was submitted, so the
      // addresses that could not be checked come back off that total here,
      // in step with their credits.
      const meta = { ...jobMeta(job), state, total, done, refunded };
      const updated = { ...u, bulkJobs: { ...u.bulkJobs, [id]: meta },
        // Lifetime verdict totals, carried by DELTA against what this job was
        // last counted for. Jobs are pruned an hour after they finish, so
        // totals read off the job list would quietly reset to zero every
        // night; these outlive the jobs they came from. Working from the delta
        // keeps a repeated save from counting the same addresses twice.
        stats: addStats(u.stats, job.summary, previous?.summary),
        checks: Math.max(0, (u.checks || 0) - refund),
        credits: this.isOwner(u) ? u.credits : (u.credits || 0) + refund };
      const users = this.users.map(x => x.id === u.id ? updated : x);
      await writeJson(this.usersFile, users);
      this.users = users;
    });
  }

  /* ------------------------------ activity ------------------------------ */
  // Counters are updated in memory and flushed to disk at most every 10 s.
  track(user, { checks = 0, login = false } = {}) {
    // Activity must share the user lock with credit/progress writes.
    return this.locked(() => {
      const u = this.users.find(x => x.id === user.id);
      if (!u) return;
      const now = new Date().toISOString();
      u.lastActiveAt = now;
      if (login) { u.lastLoginAt = now; u.logins = (u.logins || 0) + 1; }
      if (checks) u.checks = (u.checks || 0) + checks;
      if (!this.flushTimer) this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.locked(() => writeJson(this.usersFile, this.users)).catch(err => console.error('Activity save failed:', err));
      }, 10_000);
    }).catch(err => console.error('Activity update failed:', err));
  }

  async flush() {
    await this.locked(async () => {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      await writeJson(this.usersFile, this.users);
    });
    await this.sessionQueue;
  }

  /**
   * Validate the input and build a user record. Reads this.users to check the
   * name is free, but does not modify it or write anything - the caller
   * decides when the new row becomes real, which is what lets account
   * creation and its opening credit transfer commit as one write.
   * Must be called inside locked(), after reload().
   */
  async #prepareUser({ name, email, username, password, role, createdBy, canCreateResellers, canViewReports }) {
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
    return { id: randomUUID(), email: e, name: n || e.split('@')[0], role: role || (this.users.length ? 'user' : 'owner'), createdBy: createdBy || null, canCreateResellers: role === 'reseller' && !!canCreateResellers, canViewReports: role === 'reseller' && !!canViewReports, credits: 0, salt, hash, pwEnc: this.key ? this.encrypt(password) : undefined, createdAt: new Date().toISOString() };
  }

  signup(opts) { return this.locked(() => this._signup(opts)); }
  async _signup(opts) {
    await this.reload();   // pick up accounts added by the CLI
    const user = await this.#prepareUser(opts);
    this.users.push(user);
    await writeJson(this.usersFile, this.users);
    return user;
  }

  /**
   * Create a user and hand over its opening credits as ONE committed change.
   *
   * These used to be two calls from the route: signup, then transferCredits.
   * Between them the manager's balance could fall below the opening amount -
   * the transfer then failed, the route returned 402, and the account had
   * already been written. The admin saw "you only have 0 credits", assumed
   * nothing happened, and hit a "username already taken" error on the retry.
   *
   * Checking affordability and writing both changes under one lock means the
   * caller either gets a funded account or no account at all.
   */
  createManagedUser(...a) { return this.locked(() => this._createManagedUser(...a)); }
  async _createManagedUser(actor, { name, username, password, reseller, credits, canCreateResellers, canViewReports }) {
    await this.reload();
    const me = this.users.find(x => x.id === actor.id) || actor;

    if (reseller && !this.canMakeResellers(me)) {
      throw new AuthError(403, 'You cannot create resellers');
    }
    if (canViewReports && this.roleOf(me) !== 'owner') {
      throw new AuthError(403, 'Only the owner can grant report access');
    }
    if (canCreateResellers && this.roleOf(me) !== 'owner') {
      throw new AuthError(403, 'Only the owner can let a reseller create resellers');
    }

    const start = Math.max(0, Math.trunc(Number(credits) || 0));
    if (start > 100_000_000) throw new AuthError(400, 'That amount is too large');
    // The manager pays for the opening balance, so they must hold it first.
    // The owner is unlimited and pays from nothing.
    const payer = !this.isOwner(me);
    if (start && payer && (me.credits || 0) < start) {
      throw new AuthError(402, `You only have ${(me.credits || 0).toLocaleString()} credits to give`);
    }

    const user = await this.#prepareUser({
      name, username, password,
      role: reseller ? 'reseller' : 'user',
      createdBy: actor.id,
      canCreateResellers: !!(reseller && canCreateResellers),
      canViewReports: !!(reseller && canViewReports)
    });
    user.credits = start;

    const next = this.users.map(x => (x.id === me.id && start && payer)
      ? { ...x, credits: (x.credits || 0) - start }
      : x);
    next.push(user);
    await writeJson(this.usersFile, next);
    this.users = next;
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

  #saveSessions() {
    const save = () => writeJson(this.sessionsFile, [...this.sessions.values()]);
    const run = this.sessionQueue.then(save, save);
    this.sessionQueue = run.catch(() => {});
    return run;
  }
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

// `tolerateCorruption` is for disposable data (sessions): a bad file is set
// aside and the fallback used, since the worst case is a re-login. For
// irreplaceable data (users) it stays false, so corruption aborts startup
// rather than letting an empty value overwrite the real records.
async function readJson(file, fallback, { tolerateCorruption = false } = {}) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    // Only a genuinely absent file is allowed to fall back. Any other read
    // error (permissions, I/O) must not be mistaken for "no data yet".
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // The file exists but will not parse - a half-written or corrupted save.
    // Falling back to the empty default here is what silently wiped every
    // user: the next write persisted that empty value over the real data.
    // Preserve the bad file rather than destroy it.
    const backup = `${file}.corrupt-${Date.now()}`;
    try { await rename(file, backup); } catch {}
    if (tolerateCorruption) return fallback;
    throw new Error(
      `${file} exists but is not valid JSON (${err.message}). ` +
      `The unreadable file was moved to ${backup}. Refusing to start with ` +
      `empty data so nothing is overwritten - restore from a backup or fix the file.`
    );
  }
}
export const VERDICTS = ['valid', 'risky', 'unknown', 'invalid'];

/**
 * Lifetime verdict totals, advanced by the change in one job's summary.
 *
 * `counted` is what that job last contributed, so re-saving a job adds only
 * what is new rather than its whole summary again. Clamped at zero because a
 * job whose verdicts were revised downwards (a re-check turning unknown into
 * a real answer) must never drive a lifetime total negative.
 */
function addStats(current, summary, counted) {
  const out = { ...(current || {}) };
  for (const v of VERDICTS) {
    const delta = (summary?.[v] || 0) - (counted?.[v] || 0);
    out[v] = Math.max(0, (out[v] || 0) + delta);
  }
  return out;
}

// The light half of a job that lives in users.json: everything except the big
// arrays (emails/results/order), which are kept in the job's own file. Strips
// any inline arrays left over from a legacy record so they stop being rewritten.
function jobMeta(job) {
  const { emails, results, order, ...meta } = job;
  // summary must be a SNAPSHOT, not the live object. A shallow copy left the
  // stored metadata holding the very object the queue keeps incrementing, so
  // the lifetime totals - which advance by the change since the last save -
  // compared that object against itself and always saw no change.
  if (meta.summary) meta.summary = { ...meta.summary };
  if (meta.phase) meta.phase = { ...meta.phase };
  return meta;
}

// Write to a temp file and rename, so a crash mid-write never corrupts the file.
async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
