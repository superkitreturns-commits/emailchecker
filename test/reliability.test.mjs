import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../lib/auth.js';
import { JobQueue } from '../lib/queue.js';

// The deferred re-check pass sleeps on the server's timescale (minutes). These
// tests assert credit and progress behaviour, not retry behaviour, so they run
// with the pass off; it has its own tests in classify.test.mjs.
process.env.RETRY_ROUNDS = '0';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'email-validator-test-'));
  const auth = new Auth({ dataDir: dir });
  await auth.init();
  t.after(async () => {
    if (auth.flushTimer) clearTimeout(auth.flushTimer);
    await rm(dir, { recursive: true, force: true });
  });
  const owner = await auth.signup({ username: 'owner', password: 'test-password' });
  const user = await auth.signup({ username: 'customer', password: 'test-password', role: 'user', createdBy: owner.id });
  await auth.transferCredits(owner, user.id, 20);
  return { auth, owner, user, dir };
}
const result = (email, meta = {}) => ({ email, verdict: 'valid', score: 85, checks: [], meta, tookMs: 0 });

test('rejected edits leave live and stored permissions unchanged', async t => {
  const { auth, owner, user, dir } = await fixture(t);
  await assert.rejects(auth.updateUser(owner, user.id, { name: 'Changed', reseller: true, password: 'short' }));
  const live = auth.users.find(u => u.id === user.id);
  assert.equal(live.role, 'user');
  assert.equal(live.name, 'customer');
  const stored = JSON.parse(await readFile(join(dir, 'users.json'), 'utf8')).find(u => u.id === user.id);
  assert.equal(stored.role, 'user');
  await auth.updateUser(owner, user.id, { reseller: true });
  assert.equal(auth.users.find(u => u.id === user.id).role, 'reseller');
});

test('concurrent logins persist every session and concurrent logouts remove them', async t => {
  const { auth, owner, dir } = await fixture(t);
  const sessions = await Promise.all(Array.from({ length: 20 }, () => auth.createSession(owner, true)));
  const stored = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'));
  assert.equal(stored.length, 20);
  for (const { token } of sessions) assert.equal(auth.userForToken(token).id, owner.id);
  await Promise.all(sessions.map(s => auth.destroySession(s.token)));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')), []);
});

test('bulk reservation persists debit and recoverable work together', async t => {
  const { auth, user, dir } = await fixture(t);
  const job = await auth.reserveBulk(user, ['a@test.example', 'b@test.example']);
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === user.id)), 18);
  const restarted = new Auth({ dataDir: dir });
  await restarted.init();
  assert.equal((await restarted.bulkJobs())[0].id, job.id);
  assert.deepEqual((await restarted.bulkJobs())[0].emails, job.emails);
  assert.equal(restarted.creditsOf(restarted.users.find(u => u.id === user.id)), 18);
  await assert.rejects(auth.reserveBulk(user, new Array(100).fill('a@test.example')));
  assert.equal((await auth.bulkJobs()).length, 1);
});

test('resuming a bulk job preserves completed results and checks only unfinished addresses', async t => {
  const { auth, user, dir } = await fixture(t);
  const job = await auth.reserveBulk(user, ['a@test.example', 'b@other.example']);
  job.results[0] = result(job.emails[0]);
  job.done = 1;
  job.order = [0];
  job.summary.valid = 1;
  job.state = 'running';
  await auth.saveBulk(job);
  const restarted = new Auth({ dataDir: dir });
  await restarted.init();
  const called = [];
  const queue = new JobQueue(async email => { called.push(email); return result(email); }, { save: j => restarted.saveBulk(j) });
  const saved = (await restarted.bulkJobs())[0];
  queue.create(saved.emails, saved);
  await queue.drain();
  assert.deepEqual(called, ['b@other.example']);
  assert.equal(queue.get(job.id).state, 'done');
  assert.equal(queue.get(job.id).done, 2);
  assert.deepEqual(queue.get(job.id).order, [0, 1]);
  assert.equal((await restarted.bulkJobs())[0].state, 'done');
  assert.equal(restarted.creditsOf(restarted.users.find(u => u.id === user.id)), 18);
});

test('worker failures and validation exceptions are refunded exactly once; ordinary unknowns are charged', async t => {
  const { auth, user } = await fixture(t);
  const emails = ['a@one.example', 'b@two.example', 'c@three.example'];
  const saved = await auth.reserveBulk(user, emails);
  const queue = new JobQueue(async email => {
    if (email === emails[0]) return result(email, { smtp: { status: 'unknown', workerError: true } });
    if (email === emails[1]) throw new Error('Internal failure');
    return { ...result(email, { smtp: { status: 'blocked' } }), verdict: 'unknown' };
  }, { save: j => auth.saveBulk(j) });
  queue.create(emails, saved);
  await queue.drain();
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === user.id)), 19);
  await auth.saveBulk(queue.get(saved.id));
  await auth.saveBulk(queue.get(saved.id));
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === user.id)), 19);
  assert.equal((await auth.bulkJobs())[0].refunded, 2);
});

test('concurrent reservations cannot overspend credits', async t => {
  const { auth, user } = await fixture(t);
  const calls = await Promise.allSettled(Array.from({ length: 3 }, () => auth.reserveBulk(user, new Array(10).fill('a@test.example'))));
  assert.equal(calls.filter(x => x.status === 'fulfilled').length, 2);
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === user.id)), 0);
});

test('failed bulk work refunds remaining addresses without repeating refunds', async t => {
  const { auth, user } = await fixture(t);
  const saved = await auth.reserveBulk(user, ['a@test.example', 'b@test.example']);
  saved.results[0] = result(saved.emails[0]);
  saved.done = 1;
  saved.state = 'failed';
  saved.finishedAt = Date.now();
  await auth.saveBulk(saved);
  await auth.saveBulk(saved);
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === user.id)), 19);
});

test('activity survives concurrent progress commits and is flushed on shutdown', async t => {
  const { auth, user, dir } = await fixture(t);
  const job = await auth.reserveBulk(user, ['a@test.example']);
  await Promise.all([
    auth.saveBulk(job),
    auth.track(user, { checks: 1, login: true }),
    auth.saveBulk(job),
    auth.track(user, { checks: 2 })
  ]);
  await auth.flush();
  const stored = JSON.parse(await readFile(join(dir, 'users.json'), 'utf8')).find(u => u.id === user.id);
  assert.equal(stored.checks, 3);
  assert.equal(stored.logins, 1);
  assert.equal(stored.credits, 19);
});

test('deleting a reseller user refunds only unused credits and persists the wallet', async t => {
  for (const unused of [100, 75, 0]) {
    await t.test(`user has ${unused} unused credits`, async t => {
      const { auth, owner, dir } = await fixture(t);
      const reseller = await auth.signup({ username: 'reseller', password: 'test-password', role: 'reseller', createdBy: owner.id });
      await auth.transferCredits(owner, reseller.id, 200);
      const child = await auth.signup({ username: 'reseller-user', password: 'test-password', role: 'user', createdBy: reseller.id });
      await auth.transferCredits(reseller, child.id, 100);
      await auth.charge(child, 100 - unused);
      const { token } = await auth.createSession(child, true);
      await auth.deleteUser(reseller, child.id);
      assert.equal(auth.creditsOf(auth.users.find(u => u.id === reseller.id)), 100 + unused);
      assert.equal(auth.users.find(u => u.id === child.id), undefined);
      assert.equal(auth.userForToken(token), null);
      const stored = JSON.parse(await readFile(join(dir, 'users.json'), 'utf8'));
      assert.equal(stored.find(u => u.id === reseller.id).credits, 100 + unused);
      assert.equal(stored.find(u => u.id === child.id), undefined);
      await assert.rejects(auth.deleteUser(reseller, child.id));
      assert.equal(auth.creditsOf(auth.users.find(u => u.id === reseller.id)), 100 + unused);
    });
  }
});

test('unauthorized deletion cannot remove a user or credit a reseller', async t => {
  const { auth, owner, user } = await fixture(t);
  const reseller = await auth.signup({ username: 'reseller', password: 'test-password', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, reseller.id, 200);
  await assert.rejects(auth.deleteUser(reseller, user.id));
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === reseller.id)), 200);
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === user.id)), 20);
});

test('owner deletion preserves unlimited owner credits', async t => {
  const { auth, owner, user } = await fixture(t);
  await auth.deleteUser(owner, user.id);
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === owner.id)), null);
  assert.equal(auth.users.find(u => u.id === owner.id).credits, 0);
});

test('deleting a child reseller refunds its balance and preserves its users', async t => {
  const { auth, owner } = await fixture(t);
  const parent = await auth.signup({ username: 'parent', password: 'test-password', role: 'reseller', createdBy: owner.id, canCreateResellers: true });
  await auth.transferCredits(owner, parent.id, 200);
  const child = await auth.signup({ username: 'child', password: 'test-password', role: 'reseller', createdBy: parent.id });
  await auth.transferCredits(parent, child.id, 100);
  const user = await auth.signup({ username: 'child-user', password: 'test-password', createdBy: child.id });
  await auth.transferCredits(child, user.id, 40);
  await auth.deleteUser(parent, child.id);
  assert.equal(auth.creditsOf(auth.users.find(u => u.id === parent.id)), 160);
  const kept = auth.users.find(u => u.id === user.id);
  assert.equal(kept.createdBy, parent.id);
  assert.equal(kept.credits, 40);
});

/* ---- Job listing --------------------------------------------------------
 * A long batch outlives the tab that started it. Listing is how a user finds
 * work again - so it must never hand them someone else's job.
 * ------------------------------------------------------------------------ */

test('job listing is scoped to its owner and omits result payloads', async () => {
  const q = new JobQueue(async (email) => ({ email, verdict: 'valid', score: 85 }));
  const mineA = q.create(['a@x.com', 'b@x.com'], { userId: 'u1' });
  const theirs = q.create(['c@y.com'], { userId: 'u2' });
  await q.drain();

  const listed = q.listFor('u1');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, mineA.id);
  assert.equal(listed.some(j => j.id === theirs.id), false);

  // The list is a summary; results stay behind the per-job endpoint.
  assert.equal('results' in listed[0], false);
  assert.equal('emails' in listed[0], false);
  assert.equal(listed[0].total, 2);
  assert.equal(listed[0].progress, 100);
});

test('job listing returns newest first', async () => {
  const q = new JobQueue(async (email) => ({ email, verdict: 'valid', score: 85 }));
  const first = q.create(['a@x.com'], { userId: 'u1', createdAt: 1000 });
  const second = q.create(['b@x.com'], { userId: 'u1', createdAt: 2000 });
  await q.drain();

  const listed = q.listFor('u1');
  assert.deepEqual(listed.map(j => j.id), [second.id, first.id]);
});

/* ---- Save cadence ------------------------------------------------------
 * Saving after every address is O(n^2), because each save rewrites the whole
 * job: a 50k list would serialise ~1000 TB and never finish. Checkpoints
 * scale with the list instead, so cost stays linear.
 * ----------------------------------------------------------------------- */

test('progress saves stay roughly constant as the list grows', async () => {
  const counts = {};
  for (const n of [500, 5000]) {
    let saves = 0;
    const q = new JobQueue(async (email) => ({ email, verdict: 'valid', score: 85 }), {
      save: async () => { saves++; }
    });
    q.create(Array.from({ length: n }, (_, i) => `u${i}@d${i}.com`), { userId: 'u1' });
    await q.drain();
    counts[n] = saves;
  }

  // A 10x longer list must not cost 10x the writes.
  assert.ok(counts[5000] < counts[500] * 3,
    `5000 took ${counts[5000]} saves vs ${counts[500]} for 500`);
  // And nowhere near one save per address.
  assert.ok(counts[5000] < 200, `expected far fewer than 5000 saves, got ${counts[5000]}`);
});

test('the final state is always persisted regardless of cadence', async () => {
  const saved = [];
  const q = new JobQueue(async (email) => ({ email, verdict: 'valid', score: 85 }), {
    save: async (job) => { saved.push({ state: job.state, done: job.done }); }
  });
  const job = q.create(Array.from({ length: 300 }, (_, i) => `u${i}@d${i}.com`), { userId: 'u1' });
  await q.drain();

  const last = saved[saved.length - 1];
  assert.equal(last.state, 'done');
  assert.equal(last.done, 300);
  assert.equal(job.summary.valid, 300);
});

/* ---- Global probe cap ---------------------------------------------------
 * BULK_CONCURRENCY is a budget for the server, not for one job. Ten users
 * checking at once must not put ten times the load on the SMTP worker -
 * past its own limit probes return `unknown` and the user is charged for a
 * non-answer.
 * ----------------------------------------------------------------------- */

test('concurrent jobs share one probe budget instead of multiplying it', async () => {
  let inFlight = 0, peak = 0, checked = 0;
  const q = new JobQueue(async (email) => {
    inFlight++; peak = Math.max(peak, inFlight); checked++;
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return { email, verdict: 'valid', score: 85 };
  });

  // Ten users submit simultaneously.
  for (let u = 0; u < 10; u++) {
    q.create(Array.from({ length: 20 }, (_, i) => `u${u}-${i}@d${u}-${i}.com`), { userId: `user${u}` });
  }
  await q.drain();

  const cap = Number(process.env.BULK_CONCURRENCY || 8);
  assert.ok(peak <= cap, `peak ${peak} exceeded the ${cap} slot budget`);
  assert.equal(checked, 200);
  // No slot may be lost or double-returned, or the queue stalls over time.
  assert.equal(q.freeSlots, cap);
  assert.equal(q.slotWaiters.length, 0);
});

test('a throwing probe still returns its slot', async () => {
  const q = new JobQueue(async () => { throw new Error('boom'); });
  const job = q.create(Array.from({ length: 12 }, (_, i) => `u${i}@d${i}.com`), { userId: 'u1' });
  await q.drain();

  const cap = Number(process.env.BULK_CONCURRENCY || 8);
  assert.equal(q.freeSlots, cap);
  assert.equal(job.done, 12);
  assert.equal(job.summary.unknown, 12);
});

/* ---- Clearing jobs ------------------------------------------------------
 * Running work must never be dropped: its workers are still writing into the
 * job, and the credits for its unchecked addresses are not yet settled.
 * ----------------------------------------------------------------------- */

test('clearing removes finished jobs and leaves running ones alone', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const q = new JobQueue(async (email) => {
    if (email.startsWith('slow')) await gate;
    return { email, verdict: 'valid', score: 85 };
  });

  const done = q.create(['a@x.com'], { userId: 'u1' });
  await q.drain();
  const running = q.create(['slow@y.com'], { userId: 'u1' });

  const gone = q.forget('u1');
  assert.deepEqual(gone, [done.id]);
  assert.equal(q.get(done.id), undefined);
  assert.ok(q.get(running.id), 'a running job must survive clearing');

  release();
  await q.drain();
});

test('clearing never touches another user', async () => {
  const q = new JobQueue(async (email) => ({ email, verdict: 'valid', score: 85 }));
  const mine = q.create(['a@x.com'], { userId: 'u1' });
  const theirs = q.create(['b@y.com'], { userId: 'u2' });
  await q.drain();

  assert.deepEqual(q.forget('u1'), [mine.id]);
  assert.ok(q.get(theirs.id), 'another user’s job must be untouched');
});

// ---------------------------------------------------------------------------
// Credit integrity. The invariant: credits only ever move between accounts.
// Nobody but the owner can bring a credit into existence.
// ---------------------------------------------------------------------------
const nonOwnerTotal = (auth) =>
  auth.users.filter(u => !auth.isOwner(u)).reduce((s, u) => s + (u.credits || 0), 0);

async function ring(t) {
  const dir = await mkdtemp(join(tmpdir(), 'credits-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const auth = new Auth({ dataDir: dir });
  await auth.init();
  const owner = await auth.signup({ username: 'owner', password: 'password123' });
  return { auth, owner };
}
const balance = (auth, u) => auth.users.find(x => x.id === u.id)?.credits;

test('a reseller cannot give away credits it does not hold', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 1000);
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: res.id });
  await assert.rejects(() => auth.transferCredits(res, kid.id, 5000), /only have/);
  assert.equal(balance(auth, res), 1000);
  assert.equal(nonOwnerTotal(auth), 1000);
});

test('concurrent gifts cannot overdraw a reseller', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 1000);
  const kids = [];
  for (let i = 0; i < 10; i++) {
    kids.push(await auth.signup({ username: 'kid' + i, password: 'password123', createdBy: res.id }));
  }
  // Ten parallel gifts of 200 against a balance of 1000: only five may land.
  const out = await Promise.allSettled(kids.map(k => auth.transferCredits(res, k.id, 200)));
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 5);
  assert.equal(balance(auth, res), 0);
  assert.equal(nonOwnerTotal(auth), 1000, 'no credits may be created or destroyed');
});

test('concurrent charges cannot spend past zero', async (t) => {
  const { auth, owner } = await ring(t);
  const u = await auth.signup({ username: 'spender', password: 'password123', createdBy: owner.id });
  await auth.transferCredits(owner, u.id, 100);
  const out = await Promise.allSettled(Array.from({ length: 50 }, () => auth.charge(u, 10)));
  assert.equal(out.filter(o => o.status === 'fulfilled').length, 10);
  assert.equal(balance(auth, u), 0);
});

test('credits are conserved down and back up a reseller chain', async (t) => {
  const { auth, owner } = await ring(t);
  const a = await auth.signup({ username: 'resa', password: 'password123', role: 'reseller', createdBy: owner.id, canCreateResellers: true });
  await auth.transferCredits(owner, a.id, 1000);
  const b = await auth.signup({ username: 'resb', password: 'password123', role: 'reseller', createdBy: a.id });
  await auth.transferCredits(a, b.id, 500);
  const x = await auth.signup({ username: 'enduser', password: 'password123', createdBy: b.id });
  await auth.transferCredits(b, x.id, 400);
  assert.equal(nonOwnerTotal(auth), 1000);

  await auth.deleteUser(a, b.id);
  assert.equal(auth.users.find(u => u.id === x.id).createdBy, a.id, 'orphaned users move to the deleter');
  await auth.deleteUser(a, x.id);
  assert.equal(balance(auth, a), 1000, 'everything returns to the top of the chain');
  assert.equal(nonOwnerTotal(auth), 1000);
});

test('a reseller cannot reach another reseller\'s users', async (t) => {
  const { auth, owner } = await ring(t);
  const one = await auth.signup({ username: 'resone', password: 'password123', role: 'reseller', createdBy: owner.id });
  const two = await auth.signup({ username: 'restwo', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, two.id, 500);
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: one.id });
  for (const act of [
    () => auth.transferCredits(two, kid.id, 10),
    () => auth.transferCredits(two, kid.id, -10),
    () => auth.updateUser(two, kid.id, { name: 'taken' }),
    () => auth.deleteUser(two, kid.id)
  ]) await assert.rejects(act, /not found/);
});

test('nobody can fund themselves or the owner', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 100);
  await assert.rejects(() => auth.transferCredits(res, res.id, 9999), /not found/);
  await assert.rejects(() => auth.transferCredits(res, owner.id, 9999), /not found/);
  assert.equal(balance(auth, res), 100);
});

test('a plain reseller cannot promote anyone, including itself', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: res.id });
  assert.equal(auth.canMakeResellers(res), false);
  await assert.rejects(() => auth.updateUser(res, kid.id, { reseller: true }), /cannot change reseller access/);
  await assert.rejects(() => auth.updateUser(res, res.id, { canCreateResellers: true }), /not found/);
});

test('creating a user and funding it commit together or not at all', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 100);
  // The balance is drained in parallel with a creation that wants all of it.
  const drain = auth.transferCredits(owner, res.id, -100);
  let failed = null;
  const create = auth.createManagedUser(res, { username: 'victim', password: 'password123', credits: 100 })
    .catch(e => { failed = e; });
  await Promise.allSettled([drain, create]);
  if (failed) {
    assert.equal(auth.users.some(u => u.email === 'victim'), false,
      'a rejected creation must not leave an account behind');
  } else {
    assert.equal(auth.users.find(u => u.email === 'victim').credits, 100);
  }
  assert.ok((balance(auth, res) ?? 0) >= 0);
});

test('a disabled account can neither spend nor move credits', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 500);
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: res.id });
  await auth.updateUser(owner, res.id, { disabled: true });
  const resNow = auth.users.find(u => u.id === res.id);
  await assert.rejects(() => auth.transferCredits(resNow, kid.id, 100), /disabled/);
  await assert.rejects(() => auth.charge(resNow, 1), /disabled/);
  assert.equal(balance(auth, res), 500);
});

test('a deleted account refunds the reseller who funded it, not whoever deleted it', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 1000);
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: res.id });
  await auth.transferCredits(res, kid.id, 500);
  assert.equal(balance(auth, res), 500);

  // The OWNER removes the account. The reseller paid for those credits, so the
  // reseller gets them back - previously they were destroyed.
  await auth.deleteUser(owner, kid.id);
  assert.equal(balance(auth, res), 1000);
  assert.equal(nonOwnerTotal(auth), 1000);
});

test('only the unused part of a funded account comes back', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 1000);
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: res.id });
  await auth.transferCredits(res, kid.id, 500);
  await auth.charge(auth.users.find(x => x.id === kid.id), 200);   // 200 real checks
  await auth.deleteUser(res, kid.id);
  assert.equal(balance(auth, res), 800, 'the 200 actually spent is gone for good');
});

test('deleting an account mid bulk job reclaims the addresses it never checked', async (t) => {
  const { auth, owner } = await ring(t);
  const res = await auth.signup({ username: 'reseller', password: 'password123', role: 'reseller', createdBy: owner.id });
  await auth.transferCredits(owner, res.id, 1000);
  const kid = await auth.signup({ username: 'kiduser', password: 'password123', createdBy: res.id });
  await auth.transferCredits(res, kid.id, 500);
  // Reserves 300 upfront; none of them run before the account is removed.
  await auth.reserveBulk(auth.users.find(x => x.id === kid.id), Array(300).fill('a@b.com'));
  assert.equal(balance(auth, kid), 200);
  await auth.deleteUser(res, kid.id);
  assert.equal(balance(auth, res), 1000, 'unchecked addresses must not be billed');
});

test('an owner-funded account destroys its credits, since owners are unlimited', async (t) => {
  const { auth, owner } = await ring(t);
  const direct = await auth.signup({ username: 'direct', password: 'password123', createdBy: owner.id });
  await auth.transferCredits(owner, direct.id, 400);
  await auth.deleteUser(owner, direct.id);
  assert.equal(nonOwnerTotal(auth), 0, 'nothing is minted back into the system');
});

test('a refunded check is removed from the Checks total as well as the balance', async (t) => {
  const { auth, owner } = await ring(t);
  const u = await auth.signup({ username: 'checker', password: 'password123', createdBy: owner.id });
  await auth.transferCredits(owner, u.id, 100);

  await auth.charge(u, 10);
  await auth.track(u, { checks: 10 });
  await auth.flush();
  assert.equal(balance(auth, u), 90);
  assert.equal(auth.users.find(x => x.id === u.id).checks, 10);

  // Four of those probes failed on our side and were refunded.
  await auth.refund(u, 4);
  const after = auth.users.find(x => x.id === u.id);
  assert.equal(after.credits, 94, 'credits come back');
  assert.equal(after.checks, 6, 'the Checks column must agree with what was billed');
});

test('a refunded single check leaves the Checks total alone', async (t) => {
  const { auth, owner } = await ring(t);
  const u = await auth.signup({ username: 'solo', password: 'password123', createdBy: owner.id });
  await auth.transferCredits(owner, u.id, 100);

  // The single-check route charges first and counts the check only once it
  // stands, so a refund there has no check of its own to roll back. Rolling
  // one back anyway subtracted an earlier check - and from a total of zero it
  // subtracted nothing, leaving a check billed to a refunded credit.
  await auth.charge(u, 1);
  await auth.refund(u, 1, { countedCheck: false });
  await auth.flush();
  const fresh = auth.users.find(x => x.id === u.id);
  assert.equal(fresh.credits, 100, 'the credit comes back');
  assert.equal(fresh.checks || 0, 0, 'a refunded check is never counted');

  // And it must not eat a check that an earlier, successful run recorded.
  await auth.charge(u, 5);
  await auth.track(u, { checks: 5 });
  await auth.charge(u, 1);
  await auth.refund(u, 1, { countedCheck: false });
  await auth.flush();
  const later = auth.users.find(x => x.id === u.id);
  assert.equal(later.credits, 95, 'only the five that ran are billed');
  assert.equal(later.checks, 5, 'the five earlier checks survive the refund');
});

test('the Checks total never goes negative', async (t) => {
  const { auth, owner } = await ring(t);
  const u = await auth.signup({ username: 'checker', password: 'password123', createdBy: owner.id });
  await auth.transferCredits(owner, u.id, 100);
  await auth.refund(u, 50);           // refund with no checks recorded
  assert.equal(auth.users.find(x => x.id === u.id).checks, 0);
});

test('an owner refund corrects the check count without inventing credits', async (t) => {
  const { auth, owner } = await ring(t);
  await auth.track(owner, { checks: 5 });
  await auth.flush();
  await auth.refund(owner, 2);
  const o = auth.users.find(x => x.id === owner.id);
  assert.equal(o.checks, 3, 'the count is real even though the balance is unlimited');
  assert.equal(auth.creditsOf(o), null, 'the owner stays unlimited');
});

test('a partner sees their whole downstream but manages only their own clients', async (t) => {
  const { auth, owner } = await ring(t);
  const a = await auth.signup({ username: 'partnera', password: 'password123', role: 'reseller', createdBy: owner.id, canCreateResellers: true });
  await auth.transferCredits(owner, a.id, 1000);
  const b = await auth.signup({ username: 'partnerb', password: 'password123', role: 'reseller', createdBy: a.id });
  await auth.transferCredits(a, b.id, 400);
  const bClient = await auth.signup({ username: 'bclient', password: 'password123', createdBy: b.id });
  await auth.transferCredits(b, bClient.id, 100);

  const visible = auth.visibleTo(a).map(u => u.email).sort();
  assert.deepEqual(visible, ['bclient', 'partnerb'], 'the whole subtree is visible');

  assert.equal(auth.canEdit(a, auth.users.find(u => u.id === b.id)), true);
  assert.equal(auth.canEdit(a, auth.users.find(u => u.id === bClient.id)), false,
    "a sub-partner's client is reporting only");
  await assert.rejects(() => auth.transferCredits(a, bClient.id, 50), /not found/);
  await assert.rejects(() => auth.deleteUser(a, bClient.id), /not found/);
});

test('an unrelated partner still sees nothing', async (t) => {
  const { auth, owner } = await ring(t);
  const a = await auth.signup({ username: 'partnera', password: 'password123', role: 'reseller', createdBy: owner.id });
  const other = await auth.signup({ username: 'partnerx', password: 'password123', role: 'reseller', createdBy: owner.id });
  const aClient = await auth.signup({ username: 'aclient', password: 'password123', createdBy: a.id });
  assert.equal(auth.visibleTo(other).length, 0);
  assert.equal(auth.canEdit(other, auth.users.find(u => u.id === aClient.id)), false);
});

test('partner nesting stops at the configured depth', async (t) => {
  const { auth, owner } = await ring(t);
  const mk = (name, by) => auth.signup({
    username: name, password: 'password123', role: 'reseller',
    createdBy: by, canCreateResellers: true
  });
  const tier1 = await mk('tierone', owner.id);
  const tier2 = await mk('tiertwo', tier1.id);
  const tier3 = await mk('tierthree', tier2.id);

  // MAX_PARTNER_DEPTH = 2 means two partner tiers below the owner:
  // owner -> tier1 (partner) -> tier2 (sub-partner). Tier 2 is the floor.
  assert.equal(auth.canMakeResellers(auth.users.find(u => u.id === tier1.id)), true);
  assert.equal(auth.canMakeResellers(auth.users.find(u => u.id === tier2.id)), false,
    'a sub-partner cannot start a third tier, even with the flag set');
  assert.equal(auth.canMakeResellers(auth.users.find(u => u.id === tier3.id)), false);
  await assert.rejects(
    () => auth.createManagedUser(auth.users.find(u => u.id === tier2.id),
      { username: 'toodeep', password: 'password123', reseller: true }),
    /cannot create/i
  );
  // Plain clients are unaffected - depth only limits partner creation.
  const client = await auth.createManagedUser(auth.users.find(u => u.id === tier2.id),
    { username: 'deepclient', password: 'password123' });
  assert.equal(client.role, 'user');
});
