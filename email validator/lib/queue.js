/**
 * In-memory job queue for bulk validation.
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
 * State lives in this process. For multiple workers, swap this for Redis +
 * BullMQ; the route contract does not change.
 */
import { randomUUID } from 'node:crypto';

const JOB_TTL = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);
const CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 8);
const PER_DOMAIN_GAP = Number(process.env.PER_DOMAIN_GAP_MS || 350);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const domainOf = (email) => String(email).split('@')[1]?.toLowerCase() || '';

export class JobQueue {
  constructor(runner) {
    this.runner = runner;          // async (email) => result
    this.jobs = new Map();
    this.lastHitByDomain = new Map();

    const sweep = setInterval(() => this.#sweep(), 5 * 60 * 1000);
    sweep.unref?.();
  }

  create(emails) {
    const id = randomUUID();
    const job = {
      id,
      state: 'queued',
      total: emails.length,
      done: 0,
      createdAt: Date.now(),
      finishedAt: null,
      summary: { valid: 0, risky: 0, unknown: 0, invalid: 0 },
      results: [],
      error: null
    };
    this.jobs.set(id, job);
    // Run detached: the HTTP response returns immediately.
    this.#run(job, emails).catch(err => {
      job.state = 'failed';
      job.error = err.message;
      job.finishedAt = Date.now();
    });
    return job;
  }

  get(id) {
    return this.jobs.get(id);
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
      error: job.error
    };
    if (job.state === 'done') return { ...base, results: job.results };
    const order = job.order || [];
    return { ...base, items: order.slice(since).map(i => job.results[i]), next: order.length };
  }

  /**
   * Wait until this domain has not been probed for PER_DOMAIN_GAP ms.
   * Serialises per domain without serialising the whole queue.
   */
  async #throttle(domain) {
    if (!domain) return;
    for (;;) {
      const last = this.lastHitByDomain.get(domain) || 0;
      const wait = last + PER_DOMAIN_GAP - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    this.lastHitByDomain.set(domain, Date.now());
  }

  async #run(job, emails) {
    job.state = 'running';
    job.results = new Array(emails.length);
    job.order = [];

    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, emails.length) },
      async () => {
        while (cursor < emails.length) {
          const i = cursor++;
          const email = emails[i];
          try {
            await this.#throttle(domainOf(email));
            job.results[i] = await this.runner(email);
          } catch (err) {
            job.results[i] = {
              email, verdict: 'unknown', score: 0,
              checks: [{ id: 'error', label: 'Error', status: 'skip', detail: err.message }],
              meta: {}, tookMs: 0
            };
          }
          job.summary[job.results[i].verdict]++;
          job.done++;
          job.order.push(i);
        }
      }
    );

    await Promise.all(workers);
    job.state = 'done';
    job.finishedAt = Date.now();
  }

  #sweep() {
    const cutoff = Date.now() - JOB_TTL;
    for (const [id, job] of this.jobs) {
      if ((job.finishedAt ?? job.createdAt) < cutoff) this.jobs.delete(id);
    }
  }

  get size() {
    return this.jobs.size;
  }
}
