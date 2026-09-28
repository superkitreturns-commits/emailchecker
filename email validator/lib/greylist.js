/**
 * Deferred greylist resolution.
 *
 * Greylisting is a deliberate "come back later": the server refuses the first
 * contact from an unknown IP and accepts the same triple minutes afterwards.
 * The in-connection retry in smtp.js uses a few seconds because an HTTP
 * request cannot be held open longer than that - which is exactly the wrong
 * timescale for a real greylist, so those addresses stay "greylisted" forever
 * no matter how often the user checks.
 *
 * This module closes that gap. A greylisted probe schedules itself to run
 * again after a realistic delay, off the request path. The answer lands in a
 * cache, so the NEXT check of that address - a page refresh, a bulk re-run -
 * gets the real verdict instead of another deferral.
 *
 * Deliberately in-memory: a greylist entry is worth minutes, not days, and a
 * restart simply means the address is probed fresh.
 */
import { TTLCache } from './cache.js';

/** Resolved verdicts for addresses that were greylisted and later answered. */
const resolved = new TTLCache({ ttl: 6 * 60 * 60 * 1000, max: 20000 });

/** Addresses with a retry already scheduled, so we never queue one twice. */
const pending = new Map();

/**
 * Greylist windows are commonly 60-300s. Retrying sooner than the server's
 * window just burns another deferral and can extend the penalty, so the first
 * retry waits past the common minimum and the second covers the slower ones.
 */
const DELAYS = (process.env.SMTP_GREYLIST_SCHEDULE || '90000,300000')
  .split(',')
  .map(n => Number(n.trim()))
  .filter(n => Number.isFinite(n) && n > 0);

/** Cap the queue so a bulk run of deferred addresses cannot pin memory. */
const MAX_PENDING = Number(process.env.SMTP_GREYLIST_MAX_PENDING || 500);

export const greylistKey = (email) => String(email || '').toLowerCase();

/** A verdict that was reached on a later attempt, or undefined. */
export function getResolved(email) {
  return resolved.get(greylistKey(email));
}

/** True while an address is waiting on a scheduled retry. */
export const isPending = (email) => pending.has(greylistKey(email));

/**
 * Queue background retries for a greylisted address.
 *
 * @param {string} email
 * @param {() => Promise<{status:string}>} probe  re-runs the SMTP conversation
 * @returns {number|null} ms until the first retry, or null if not scheduled
 */
export function scheduleRetry(email, probe) {
  const key = greylistKey(email);
  if (pending.has(key) || resolved.get(key)) return null;
  if (pending.size >= MAX_PENDING) return null;
  if (!DELAYS.length) return null;

  const state = { attempt: 0, timer: null };
  pending.set(key, state);

  const run = async () => {
    let outcome = null;
    try {
      outcome = await probe();
    } catch {
      // A thrown probe is treated exactly like another deferral.
    }

    // Anything other than a fresh deferral is a real answer worth keeping.
    if (outcome && outcome.status !== 'greylisted') {
      resolved.set(key, { ...outcome, viaGreylistRetry: true });
      pending.delete(key);
      return;
    }

    state.attempt += 1;
    if (state.attempt >= DELAYS.length) {
      pending.delete(key); // still deferred; let the next check start over
      return;
    }
    schedule();
  };

  function schedule() {
    state.timer = setTimeout(() => { run(); }, DELAYS[state.attempt]);
    // Never keep the process alive just to finish a speculative retry.
    state.timer.unref?.();
  }

  schedule();
  return DELAYS[0];
}

export const greylistPendingSize = () => pending.size;
export const greylistResolvedSize = () => resolved.size;

/** Test helper: drop all state. */
export function resetGreylist() {
  for (const { timer } of pending.values()) clearTimeout(timer);
  pending.clear();
  resolved.clear();
}
