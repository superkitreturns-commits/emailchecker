/**
 * Job queue for bulk validation with optional durable progress storage.
 *
 * Large lists cannot run inside an HTTP request: a 5,000-address job takes
 * minutes, and holding a socket open that long fails on every proxy. Jobs are
 * accepted, worked in the background, and polled for progress.
 *
 * Per-domain throttling is the part that protects accuracy. Firing 500
 * concurrent probes at one provider gets the IP greylisted and then blocked,
 * after which results get worse, not faster. One probe at a time per domain
 * with a minimum gap between them keeps the IP clean.
 *
 * The server supplies durable storage. For multiple workers, swap for Redis +
 * BullMQ; the route contract does not change.
 */
import { randomUUID } from 'node:crypto';
import { groupGapMs } from './providers.js';
import { presentResult } from './present.js';

const JOB_TTL = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);
/**
 * Probe concurrency, in two tiers.
 *
 * The OVH VPS is one IP with one rate budget, so it stays deliberately small:
 * pushing it harder gets the IP greylisted and the extra probes come back
 * `unknown`. A rented vast.ai box is a fresh IP whose only job is SMTP, so it
 * carries far more at once - that is the entire point of renting it.
 *
 * The tier is chosen per slot, not per job: an instance that activates
 * mid-run raises capacity for the list already in flight, and a teardown
 * lowers it again, without restarting anything.
 */
const CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 8);
// Per rented box, not in total: three boxes carry three times this.
const REMOTE_CONCURRENCY = Number(process.env.VAST_CONCURRENCY || 25);
// Ceiling on the pool, so a runaway list cannot rent an unbounded number of
// GPUs. Also bounds MAX_WORKERS below. Must be at least the top of the rental
// ladder in lib/vast-auto.js, or the queue would leave the boxes it paid for
// half idle - the ladder tops out at 6.
const REMOTE_MAX_INSTANCES = Number(process.env.VAST_MAX_INSTANCES || 6);

/**
 * Groups that are checked by a browser rather than over SMTP, and so spread
 * across a DIFFERENT set of IPs than everything else.
 *
 * The Yahoo family goes through lib/yahoo-oracle.js, which drives Chromium. The
 * OVH VPS always has one; a rented box only does if its boot-time install
 * worked (lib/vast.js), which it reports and the app verifies. So the number of
 * IPs probing Yahoo is "OVH plus the boxes with a working browser" - never the
 * pool size, and never one.
 *
 * Getting this set wrong is the expensive mistake in both directions: divide by
 * the pool and you triple Yahoo's rate from the one IP actually doing the work
 * (greylisting, which is what the gaps exist to prevent); divide by one and the
 * Yahoo quarter of a big list takes longer than the other three quarters put
 * together.
 */
const BROWSER_GROUPS = new Set(
  (process.env.BROWSER_GROUPS || process.env.PINNED_GROUPS || 'yahoo')
    .split(',').map(g => g.trim()).filter(Boolean)
);
// Workers are spawned for the high tier from the start. A worker with no slot
// costs nothing but a pending promise, and pre-spawning is what lets capacity
// grow mid-run: the pool cannot be resized once Promise.allSettled holds it.
const MAX_WORKERS = Math.max(CONCURRENCY, REMOTE_CONCURRENCY * REMOTE_MAX_INSTANCES);
const PER_DOMAIN_GAP = Number(process.env.PER_DOMAIN_GAP_MS || 350);

/**
 * Progress is saved about SAVES_PER_JOB times per job, whatever its size, so
 * the step grows with the list: 50k saves every 1000, 25k every 500. The
 * bounds keep tiny jobs from saving almost never and huge ones from drifting
 * too far between checkpoints.
 */
const SAVES_PER_JOB = Number(process.env.SAVES_PER_JOB || 50);
const SAVE_MIN_STEP = Number(process.env.SAVE_MIN_STEP || 25);
const SAVE_MAX_STEP = Number(process.env.SAVE_MAX_STEP || 1000);
const SAVE_MAX_GAP_MS = Number(process.env.SAVE_MAX_GAP_MS || 15000);

/**
 * Deferred re-check rounds.
 *
 * A 421 means "come back in a few minutes" and a dropped socket usually means
 * "you are going too fast". Both become a real answer on a second attempt -
 * but only on the server's timescale, not ours. The in-connection retry in
 * smtp.js waits seconds because an HTTP request cannot be held open longer,
 * which is the wrong timescale by two orders of magnitude.
 *
 * So the job runs its main pass, then comes back for the deferred addresses
 * once the window has actually passed. This is the difference between
 * reporting "unknown" and getting the answer the server was willing to give
 * all along - real data the old code paid for and then discarded.
 *
 * Set RETRY_ROUNDS=0 to turn the pass off.
 */
// Read at call time, not import time, so a test or a worker can turn the
// pass off without reloading the module.
function retryPlan(override) {
  if (override) return override;
  const delays = (process.env.RETRY_DELAYS_MS || '120000,420000')
    .split(',').map(n => Number(n.trim())).filter(n => Number.isFinite(n) && n > 0);
  const rounds = process.env.RETRY_ROUNDS === undefined
    ? delays.length
    : Number(process.env.RETRY_ROUNDS);
  return delays.slice(0, Math.max(0, rounds));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const domainOf = (email) => String(email).split('@')[1]?.toLowerCase() || '';



export class JobQueue {
  /**
   * @param {Function} runner  async (email) => result
   * @param {object}   deps
   *   save     persist job progress
   *   groupOf  async (domain) => throttle key. Defaults to the domain itself.
   *            The server supplies an MX-aware version, because throttling by
   *            DOMAIN is quietly wrong: yahoo.com, aol.com, att.net and
   *            verizon.net are four domains on one server farm, so a mixed
   *            list opened four parallel streams at the same Yahoo servers and
   *            burned the rate limit four times faster than configured.
   *            Injected rather than imported so the queue stays testable
   *            without DNS.
   */
  constructor(runner, { save = async () => {}, groupOf = null, retryDelays = null, onDepth = null, remoteActive = null, browserHosts = null } = {}) {
    this.save = save;
    // Reports unfinished addresses across every live job, so burst capacity
    // can be rented when one big list (or several at once) needs it.
    this.onDepth = onDepth;
    // () => number: how many rented boxes are carrying checks right now (0 =
    // OVH only). Read on every slot handover and every throttle reservation,
    // so capacity and spacing follow the pool live - an instance that comes up
    // mid-run speeds that run up, and one that goes away slows it back down.
    // Injected rather than imported so the queue stays free of vast state.
    this.remoteActive = remoteActive;
    // () => number: how many IPs can run the browser probe right now (the OVH
    // VPS plus any rented box whose browser works). Only the BROWSER_GROUPS
    // spacing is divided by this. Defaults to 1 - the single always-present
    // OVH browser - so a caller that does not supply it keeps today's spacing.
    this.browserHosts = browserHosts;
    this.retryDelays = retryDelays;
    this.groupOf = groupOf;
    this.groupCache = new Map();
    this.running = new Set();
    this.settled = new Map();   // jobId -> run promise, for cancel to await
    this.runner = runner;          // async (email) => result
    this.jobs = new Map();
    this.lastHitByDomain = new Map();
    this.lastSavedDone = new Map();
    this.lastSavedAt = new Map();

    // Probe slots are shared by every job on this server, not per job.
    this.capacity = this.#targetCapacity();
    this.freeSlots = this.capacity;
    this.slotWaiters = [];
    // Slots to retire as they come back, after capacity dropped while they
    // were in use. Returning them to the pool instead would keep the OVH IP
    // at the rented box's rate long after the box was gone.
    this.overdraft = 0;

    const sweep = setInterval(() => this.#sweep(), 5 * 60 * 1000);
    sweep.unref?.();
  }

  create(emails, saved = {}) {
    const id = saved.id || randomUUID();
    const job = {
      id,
      state: 'queued',
      total: emails.length,
      done: 0,
      createdAt: Date.now(),
      finishedAt: null,
      summary: { valid: 0, risky: 0, unknown: 0, invalid: 0 },
      results: new Array(emails.length).fill(null),
      order: [],
      emails,
      error: null,
      ...saved
    };
    this.jobs.set(id, job);
    if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') {
      // Detached work is tracked for graceful shutdown; progress survives restart.
      const task = this.#run(job, emails).catch(async err => {
        job.state = 'failed';
        job.error = err.message;
        job.finishedAt = Date.now();
        await this.save(job);
        this.#reportDepth();
      });
      this.running.add(task);
      // Held OFF the job object: the job is structuredClone'd on every save,
      // and a Promise cannot be cloned - storing it there threw DataCloneError
      // and silently killed progress persistence for the whole run.
      this.settled.set(id, task);
      task.catch(err => console.error('Bulk progress save failed:', err))
        .finally(() => this.running.delete(task));
    }
    this.#reportDepth();
    return job;
  }

  async drain() {
    await Promise.allSettled([...this.running]);
  }

  /**
   * Stop a running job where it stands.
   *
   * Addresses already checked keep their results - they were paid for and the
   * answers are real. The rest are abandoned, and the caller refunds them.
   * Probes already in flight are allowed to finish rather than being killed
   * mid-connection: dropping an open SMTP socket is what gets an IP greylisted,
   * which would cost far more than the few seconds saved.
   *
   * @returns {object|null} the cancelled job, or null if it was not cancellable
   */
  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return null;
    job.cancelled = true;
    // Marked stopped NOW, not when the last in-flight probe lands. Those can
    // take 30 seconds each, and leaving the state as 'running' until then made
    // a cancel that had already taken effect look like it was ignored.
    job.state = 'cancelled';
    job.phase = null;
    job.finishedAt = Date.now();
    this.save(job).catch(err => console.error('cancel save failed:', err));
    this.#reportDepth();
    return job;
  }

  /**
   * Addresses a cancelled job will never check, counted once the probes that
   * were already open have finished. Waiting is what makes the number exact:
   * at the moment of cancelling, CONCURRENCY probes are still in flight and
   * will each still produce a result that was legitimately paid for.
   */
  async unchecked(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return 0;
    await this.settled.get(jobId)?.catch(() => {});
    return Math.max(0, job.total - job.done);
  }

  /**
   * Unfinished addresses across every job that is still working.
   *
   * The deferred re-check pass counts. It runs AFTER done has reached total -
   * every address has a result, they are just not all good results yet - so
   * measuring only `total - done` reported zero while a job was still probing
   * hundreds of addresses. Rented capacity was then torn down mid-pass, and
   * the re-check finished on the OVH VPS alone: the slowest part of the run,
   * on the least capacity, right at the end.
   */
  pending() {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') continue;
      const unchecked = Math.max(0, job.total - job.done);
      if (unchecked) { n += unchecked; continue; }

      // Main pass over, job still running: what is left is the deferred
      // re-check. Counting it is what keeps rented capacity alive through the
      // slowest part of the run.
      if (job.phase?.stage === 'recheck') {
        n += Math.max(0, job.phase.pending || 0);   // a round is in progress
        continue;
      }
      // No phase yet - this is the gap between the last address of the main
      // pass and #retryDeferred setting the phase. The final checkpoint of the
      // main pass lands exactly here, so without counting the deferred tail
      // directly it reports an empty queue and, with no idle grace, every
      // rented box is destroyed a moment before the re-check needs them.
      // Only reached once per job, when unchecked has just hit zero.
      for (const r of job.results) if (JobQueue.#worthRetrying(r)) n++;
    }
    return n;
  }

  #reportDepth() {
    if (!this.onDepth) return;
    // A reporting bug must never take the run down with it.
    try { this.onDepth(this.pending()); } catch (err) { console.error('onDepth failed:', err); }
  }

  get(id) {
    return this.jobs.get(id);
  }

  /**
   * Every job belonging to one user, newest first.
   *
   * Deliberately omits `results` and `emails`: this answers "what jobs do I
   * have" for a user who closed the tab and lost the id, and a list carrying
   * full result sets for several 50k jobs would be unusable. The individual
   * job endpoint still serves the results.
   */
  /**
   * Drop finished jobs from memory. Running work is left alone: its workers
   * are still writing into the job, and its credits are not yet settled.
   *
   * @returns {string[]} the ids actually removed
   */
  forget(userId, jobId = null) {
    const gone = [];
    for (const [id, job] of this.jobs) {
      if (job.userId !== userId) continue;
      if (job.state !== 'done' && job.state !== 'failed' && job.state !== 'cancelled') continue;
      if (jobId && id !== jobId) continue;
      this.jobs.delete(id);
      this.lastSavedDone.delete(id);
      this.lastSavedAt.delete(id);
      this.settled.delete(id);
      gone.push(id);
    }
    return gone;
  }

  listFor(userId) {
    const mine = [];
    for (const job of this.jobs.values()) {
      if (job.userId !== userId) continue;
      mine.push({
        id: job.id,
        state: job.state,
        total: job.total,
        done: job.done,
        progress: job.total ? Math.round((job.done / job.total) * 100) : 100,
        summary: job.summary,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        phase: job.phase || null,
        error: job.error
      });
    }
    return mine.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Public view. While running, `items` carries the results finished since
   * `since` (in completion order) so the client can show them live; once done,
   * the full `results` array is returned.
   */
  view(job, since = 0) {
    const base = {
      id: job.id,
      state: job.state,
      total: job.total,
      done: job.done,
      progress: job.total ? Math.round((job.done / job.total) * 100) : 100,
      summary: job.summary,
      // Set while the deferred re-check pass is running, so the UI can say
      // "rechecking 42 deferred addresses" instead of looking stalled at 100%.
      phase: job.phase || null,
      error: job.error
    };
    // A stopped job is finished too, and its caller wants the whole result set
    // the same way. Its results array is sparse - the addresses it never
    // reached are still null - so the holes are dropped rather than presented.
    if (job.state === 'done' || job.state === 'cancelled') {
      return { ...base, results: job.results.filter(Boolean).map(presentResult) };
    }
    const order = job.order || [];
    return { ...base, items: order.slice(since).map(i => presentResult(job.results[i])), next: order.length };
  }

  /**
   * Claim one of the shared probe slots, waiting if all are taken.
   *
   * CONCURRENCY is a budget for the whole server, not for one job. Each job
   * used to start its own set of workers, so ten users checking at once put
   * ten times the configured load on the SMTP worker - past its own limit,
   * where probes come back `unknown` and the user is charged for a non-answer.
   */
  /** Rented boxes in the pool, clamped to the configured ceiling. */
  #remoteCount() {
    const n = Number(this.remoteActive?.() || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(Math.floor(n), REMOTE_MAX_INSTANCES);
  }

  #targetCapacity() {
    const n = this.#remoteCount();
    return n ? REMOTE_CONCURRENCY * n : CONCURRENCY;
  }

  /**
   * Follow the active worker's tier.
   *
   * Growing hands the new slots straight to waiting probes, so a list that is
   * already running speeds up the moment the rented box takes over. Shrinking
   * never interrupts a probe in flight: the slots are marked for retirement
   * and disappear as they are released.
   */
  #syncCapacity() {
    const target = this.#targetCapacity();
    if (target === this.capacity) return;
    const delta = target - this.capacity;
    this.capacity = target;
    if (delta > 0) {
      // Cancel pending retirements before minting anything new.
      const revived = Math.min(this.overdraft, delta);
      this.overdraft -= revived;
      let add = delta - revived;
      while (add-- > 0) {
        const next = this.slotWaiters.shift();
        if (next) next();
        else this.freeSlots++;
      }
    } else {
      let drop = -delta;
      const idle = Math.min(this.freeSlots, drop);
      this.freeSlots -= idle;
      this.overdraft += drop - idle;
    }
  }

  async #acquire() {
    this.#syncCapacity();
    if (this.freeSlots > 0) {
      this.freeSlots--;
      return;
    }
    await new Promise(resolve => this.slotWaiters.push(resolve));
  }

  /** Hand the slot to the next waiter, or return it to the pool. */
  #release() {
    this.#syncCapacity();
    if (this.overdraft > 0) { this.overdraft--; return; }   // retired, not reused
    const next = this.slotWaiters.shift();
    if (next) next();
    else this.freeSlots++;
  }

  /**
   * Space probes per infrastructure group without serialising the whole queue.
   *
   * Claiming the slot is SEPARATE from waiting for it. A worker reserves the
   * next free instant for its group synchronously - no await in between, so
   * two workers can never reserve the same instant - and only then sleeps. It
   * holds no concurrency slot while it waits.
   *
   * The earlier version slept while holding a slot, which was tolerable at one
   * shared 350ms gap but deadlocks the run at realistic per-provider gaps: all
   * eight slots end up asleep on Yahoo while Gmail addresses sit in the queue
   * behind them. Reserving first fixes that without loosening the spacing,
   * because a worker delayed further by slot contention probes LATER than its
   * reservation, never sooner.
   */
  /**
   * Resolve an address to its throttle key, memoised per domain so a 50k list
   * costs one lookup per domain rather than one per address.
   */
  async #groupFor(email) {
    const domain = domainOf(email);
    if (!domain || !this.groupOf) return domain;
    if (this.groupCache.has(domain)) return this.groupCache.get(domain);
    let key = domain;
    try {
      key = (await this.groupOf(domain)) || domain;
    } catch {
      // A lookup failure just falls back to the domain - no worse than before.
    }
    this.groupCache.set(domain, key);
    return key;
  }

  /**
   * Spacing for one group, divided across the IPs probing it.
   *
   * The gap exists to protect ONE IP's standing at ONE provider. With three
   * rented boxes, lib/smtp-remote.js sends every third probe of a group to
   * each box, so the queue can fire that group three times as often and each
   * box still waits the full configured gap between its own probes. This is
   * the only safe way to go faster: the per-IP rate never changes, there are
   * just more IPs.
   *
   * Groups in BROWSER_GROUPS divide by their own, usually smaller, count of
   * browser-capable IPs instead - see #spreadFor.
   */
  /** How many IPs are probing this group, so its gap can be divided by them. */
  #spreadFor(group) {
    if (BROWSER_GROUPS.has(group)) {
      // At least 1: OVH always has a browser, so Yahoo is never un-probed.
      const n = Number(this.browserHosts?.() || 1);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    }
    return Math.max(1, this.#remoteCount());
  }

  #reserve(group) {
    if (!group) return 0;
    const spread = this.#spreadFor(group);
    const gap = (groupGapMs(group) || PER_DOMAIN_GAP) / spread;
    const at = Math.max(Date.now(), (this.lastHitByDomain.get(group) || 0) + gap);
    this.lastHitByDomain.set(group, at);
    return at;
  }

  async #throttle(group) {
    const at = this.#reserve(group);
    const wait = at - Date.now();
    if (wait > 0) await sleep(wait);
  }

  /**
   * Persist progress periodically rather than after every address.
   *
   * A save rewrites the whole job, so saving per address costs O(n^2): on a
   * 50k list the final save rewrites 49,999 earlier results, and the run
   * never finishes. The interval scales with the list so every job costs a
   * roughly constant SAVES_PER_JOB writes - 1000 apart on 50k, 500 on 25k -
   * instead of a fixed step that is too coarse for small jobs and far too
   * fine for large ones.
   *
   * SAVE_MAX_GAP_MS bounds the other axis: a slow, heavily throttled job
   * would otherwise go many minutes between saves.
   *
   * Dropping a save is safe. A resumed job keeps completed results and
   * re-checks only the unfinished tail, so a crash costs at most one
   * interval of repeated work, never a wrong or double charge.
   */
  async #checkpoint(job) {
    const interval = Math.max(
      SAVE_MIN_STEP,
      Math.min(SAVE_MAX_STEP, Math.ceil(job.total / SAVES_PER_JOB))
    );
    const since = job.done - (this.lastSavedDone.get(job.id) || 0);
    const elapsed = Date.now() - (this.lastSavedAt.get(job.id) || 0);

    if (since < interval && elapsed < SAVE_MAX_GAP_MS) return;

    this.lastSavedDone.set(job.id, job.done);
    this.lastSavedAt.set(job.id, Date.now());
    await this.save(job);
    // Also the retry window for burst capacity: a rental that failed when the
    // job was created gets another chance here instead of the run finishing
    // on one IP because of one bad minute at the provider.
    this.#reportDepth();
  }

  async #run(job, emails) {
    job.state = 'running';
    job.results ||= new Array(emails.length).fill(null);
    job.order ||= [];

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(MAX_WORKERS, emails.length) },
      async () => {
        while (cursor < emails.length) {
          if (job.cancelled) return;
          const i = cursor++;
          if (job.results[i]) continue; // Completed addresses are never charged or checked again.
          const email = emails[i];
          // Wait out the provider gap BEFORE taking a slot, so a worker idling
          // on a slow provider does not hold capacity the rest of the list
          // needs. #reserve has already claimed this worker's place in the
          // provider's sequence, so the spacing holds either way.
          await this.#throttle(await this.#groupFor(email));
          if (job.cancelled) return;
          await this.#acquire();
          // Checked again after BOTH waits, not just at the top of the loop.
          // Every worker parked in the throttle or waiting for a slot is past
          // that first check, so with a large pool a cancel used to let one
          // probe through per worker - on a 150-worker pool that billed the
          // user for ~124 addresses they had just asked to stop.
          if (job.cancelled) { this.#release(); return; }
          try {
            job.results[i] = await this.runner(email);
          } catch (err) {
            job.results[i] = {
              email, verdict: 'unknown', score: 0,
              checks: [{ id: 'error', label: 'Error', status: 'skip', detail: err.message }],
              meta: { validationError: true }, tookMs: 0
            };
          } finally {
            this.#release();
          }
          job.summary[job.results[i].verdict]++;
          job.done++;
          job.order.push(i);
          await this.#checkpoint(job);
        }
      }
    );

    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find(r => r.status === 'rejected');
    if (failure) throw failure.reason;

    // A cancelled job skips the deferred pass entirely: that pass exists to
    // turn "unknown" into a real answer minutes later, which is exactly the
    // waiting the user just asked to stop.
    if (!job.cancelled) {
      // Claim the re-check work BEFORE anything can observe a drained queue.
      // The last checkpoint of the main pass reports `total - done` = 0, and
      // with no idle grace that is enough to destroy every rented box in the
      // gap before #retryDeferred has had a chance to set the phase. Both
      // lines below are synchronous on purpose: no await may come between the
      // queue reading empty and this saying otherwise.
      const deferred = job.results.filter(r => JobQueue.#worthRetrying(r)).length;
      if (deferred) {
        job.phase = { stage: 'recheck', round: 0, pending: deferred };
        this.#reportDepth();
      }
      await this.#retryDeferred(job, emails);
    }

    job.phase = null;
    job.state = job.cancelled ? 'cancelled' : 'done';
    job.finishedAt = Date.now();
    await this.save(job);
    this.#reportDepth();
  }

  /**
   * Which results are a deferral rather than an answer, and could still
   * become one. A reverse-DNS or blocklist refusal is excluded: it is a fact
   * about our IP that an hour will not change, and hammering a provider that
   * already said no is how a borderline IP becomes a blocked one.
   */
  static #worthRetrying(result) {
    if (!result || result.verdict !== 'unknown') return false;
    const smtp = result.meta?.smtp;
    if (!smtp) return false;
    if (!['greylisted', 'blocked', 'unknown'].includes(smtp.status)) return false;
    return smtp.retryable !== false;
  }

  /**
   * Re-probe deferred addresses after the server's own window has passed.
   *
   * Runs in rounds with growing delays. Each round only keeps a result that
   * is actually better than what we had - a second deferral leaves the
   * original untouched, so a retry can never make a job worse.
   */
  async #retryDeferred(job, emails) {
    const delays = retryPlan(this.retryDelays);
    if (!delays.length) return;

    // Providers that proved unrecoverable in an earlier round. Comcast is the
    // reason this exists: it answers a residential IP with "421 temporarily
    // not available", which is indistinguishable from greylisting by code
    // alone but never clears, because it is about the IP and not the timing.
    // Rather than guess from the text, measure it: a provider that improved
    // nothing in a whole round is not going to improve anything in the next.
    const giveUp = new Set();

    for (let round = 0; round < delays.length; round++) {
      const pending = [];
      for (let i = 0; i < emails.length; i++) {
        if (!JobQueue.#worthRetrying(job.results[i])) continue;
        if (giveUp.has(await this.#groupFor(emails[i]))) continue;
        pending.push(i);
      }
      if (!pending.length) return;

      // resumeAt lets the browser count the wait down. Every address already
      // has a result here, so the bar sits at 100% for the whole delay; with
      // nothing saying when it ends, a 7-minute round reads as a hung job.
      job.phase = {
        stage: 'recheck', round: round + 1, pending: pending.length,
        waitingUntil: Date.now() + delays[round]
      };
      this.#reportDepth();
      await this.save(job);
      await sleep(delays[round]);
      job.phase = { ...job.phase, waitingUntil: null };

      const tried = new Map();   // group -> attempts this round
      const won = new Map();     // group -> attempts that produced an answer

      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(MAX_WORKERS, pending.length) },
        async () => {
          while (cursor < pending.length) {
            if (job.cancelled) return;
            const i = pending[cursor++];
            const email = emails[i];
            const group = await this.#groupFor(email);
            await this.#throttle(group);
            if (job.cancelled) return;
            await this.#acquire();
            if (job.cancelled) { this.#release(); return; }
            let fresh = null;
            try {
              fresh = await this.runner(email);
            } catch {
              // Keep the original result; a failed retry is not new information.
            } finally {
              this.#release();
            }
            tried.set(group, (tried.get(group) || 0) + 1);
            // Only replace a deferral with something conclusive.
            if (fresh && fresh.verdict !== 'unknown') {
              won.set(group, (won.get(group) || 0) + 1);
              job.summary[job.results[i].verdict]--;
              job.summary[fresh.verdict]++;
              fresh.meta = { ...fresh.meta, recheckedRound: round + 1 };
              job.results[i] = fresh;
            }
          }
        }
      );
      const outcomes = await Promise.allSettled(workers);
      const failed = outcomes.find(r => r.status === 'rejected');
      if (failed) throw failed.reason;

      // Enough of a sample to be a pattern rather than noise.
      for (const [group, n] of tried) {
        if (n >= 3 && !won.get(group)) giveUp.add(group);
      }
      await this.save(job);
    }
  }

  #sweep() {
    const cutoff = Date.now() - JOB_TTL;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && job.finishedAt < cutoff) {
        this.jobs.delete(id);
        this.lastSavedDone.delete(id);
        this.lastSavedAt.delete(id);
      }
    }
  }

  get size() {
    return this.jobs.size;
  }
}
