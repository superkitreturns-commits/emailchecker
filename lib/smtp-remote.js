/**
 * SMTP verification over HTTP, for when the web app cannot open port 25.
 *
 * Railway, Render, Vercel and every other managed host block outbound 25, so
 * the probe runs on a VPS that does have it open (server.js WORKER_MODE=true)
 * and the app calls it here. Drop-in for verifyMailbox: same arguments, same
 * result shape, so lib/validator.js cannot tell the difference.
 */
import { activeWorkerUrl, activeWorkerKey, activeWorkers, recordLiveCheck } from './vast-state.js';
import { infraKey } from './providers.js';

const WORKER_TIMEOUT = Number(process.env.SMTP_WORKER_TIMEOUT || 30000);

// An activated vast.ai instance takes over from the default worker (the OVH
// VPS) until it is deactivated or destroyed - no redeploy needed to switch.
export const workerUrl = () => (activeWorkerUrl() || process.env.SMTP_WORKER_URL || '').replace(/\/+$/, '');
/**
 * The key for whichever worker workerUrl() points at: a rented instance has
 * its own, the OVH VPS uses the shared one. Signing an instance call with the
 * shared key would still work, but then the shared key would have to live on
 * the rented box, which is exactly what the per-instance key avoids.
 */
export const workerKey = () => activeWorkerKey() || process.env.SMTP_WORKER_KEY || '';
export const workerEnabled = () => Boolean(workerUrl() && workerKey());

/**
 * Pick which rented box probes this address.
 *
 * Round-robin PER PROVIDER GROUP, not globally. The difference matters: the
 * rate limit being respected belongs to one IP at one provider, so what has to
 * be spread out is the sequence of probes a given provider sees from a given
 * IP. Counting per group gives exactly that - with three boxes, probe 0, 3, 6
 * of the Gmail sequence go to box A, so box A hits Gmail every third probe and
 * keeps the full configured gap even though the queue is firing three times as
 * often overall.
 *
 * A global counter would only get there on average, and would drift into
 * bursts whenever the mix of domains in flight changed.
 */
const turn = new Map();   // group key -> probes dispatched

function routeFor(mxHosts, email) {
  const pool = activeWorkers();
  if (pool.length < 2) return null;         // one box (or none): nothing to spread
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  let group = domain;
  try { group = infraKey(mxHosts || [], domain) || domain; } catch { /* domain is a fine fallback */ }
  const n = (turn.get(group) || 0);
  turn.set(group, n + 1);
  return pool[n % pool.length];
}

/** Same contract as verifyMailbox in ./smtp.js. */
export async function remoteVerifyMailbox(email, mxHosts, options = {}) {
  // Only counts toward the IP Server's live counter when this request is
  // actually going to the activated instance, not the default OVH worker.
  const onActiveInstance = Boolean(activeWorkerUrl());
  if (onActiveInstance) recordLiveCheck(email);

  // Which box takes it. Null means there is no pool to spread across, so fall
  // back to the single active url (or the OVH worker) exactly as before.
  const route = routeFor(mxHosts, email);
  const url = route?.url || workerUrl();
  const key = route?.key || workerKey();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT);
  try {
    const res = await fetch(`${url}/api/worker/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-key': key
      },
      body: JSON.stringify({ email, mxHosts, options }),
      signal: controller.signal
    });
    if (!res.ok) {
      const detail = res.status === 401 || res.status === 403
        ? 'Verification worker rejected our key'
        : `Verification worker returned ${res.status}`;
      return { status: 'unknown', detail, workerError: true };
    }
    return await res.json();
  } catch (err) {
    // A worker that is down must not read as a verdict about the mailbox.
    // The underlying error is logged, never returned: it names our own
    // infrastructure, which is no business of the browser's.
    if (err.name !== 'AbortError') console.error('[smtp-worker]', err.message);
    return {
      status: 'unknown',
      detail: err.name === 'AbortError'
        ? 'Verification worker did not answer in time'
        : 'Verification worker could not be reached',
      workerError: true
    };
  } finally {
    clearTimeout(timer);
  }
}
