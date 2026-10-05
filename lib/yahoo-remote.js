/**
 * Yahoo mailbox check over HTTP, for when the web app host has no Chrome or a
 * poor IP. The browser probe runs on the VPS worker (worker.js) that already
 * has patchright/Chromium installed and a clean outbound IP, and the app calls
 * it here. Drop-in for yahooMailbox: same arguments, same result shape.
 */
import { yahooWorkers } from './vast-state.js';

const WORKER_TIMEOUT = Number(process.env.YAHOO_WORKER_TIMEOUT || 45000);

// The OVH VPS: always present, always has Chromium, and the fallback whenever
// no rented box has a working browser. Override with YAHOO_WORKER_URL if it
// ever stops being the same host as the SMTP worker.
const ovhUrl = () =>
  (process.env.YAHOO_WORKER_URL || process.env.SMTP_WORKER_URL || '').replace(/\/+$/, '');
export const yahooWorkerEnabled = () => Boolean(ovhUrl() && process.env.SMTP_WORKER_KEY);

/**
 * Every host that can run this probe: the OVH VPS plus any rented box that
 * proved it can launch a browser.
 *
 * This used to be OVH alone, because a rented box had no Chromium - its boot
 * script installed nothing. Now the boot script installs one (lib/vast.js) and
 * the worker reports whether it actually works, so Yahoo can be spread like
 * every other provider instead of being the one group stuck on a single IP.
 *
 * That mattered out of proportion to its size: Yahoo's 1200ms gap is the
 * slowest of any group, so on a large mixed list the Yahoo quarter took longer
 * than the other three quarters combined, however many boxes were rented. Each
 * extra browser IP divides that directly.
 *
 * A box with no working browser is NOT in this list. Sending Yahoo there would
 * return "could not determine" for every address, and the only thing worse than
 * a slow answer is a confident wrong one.
 */
function hosts() {
  const list = [];
  const ovh = ovhUrl();
  // OVH keeps the shared key; each rented box has its own (vast.ai exposes an
  // instance's env, so the long-lived key never goes on one).
  if (ovh) list.push({ url: ovh, key: process.env.SMTP_WORKER_KEY || '' });
  for (const w of yahooWorkers()) {
    if (w.url && w.key) list.push({ url: w.url, key: w.key });
  }
  return list;
}

/** How many IPs the Yahoo rate budget is currently divided across. */
export const yahooHostCount = () => hosts().length;

/**
 * Round-robin across those hosts.
 *
 * One counter for the whole family rather than one per domain: yahoo.com,
 * aol.com, att.net and verizon.net are one server farm behind four names, so
 * they share one rate budget and must share one rotation - the same reason
 * lib/providers.js throttles them as a single group.
 */
let turn = 0;
function pick() {
  const list = hosts();
  if (!list.length) return null;
  return list[turn++ % list.length];
}

/** Same contract as yahooMailbox in ./yahoo-oracle.js. */
export async function remoteYahooMailbox(email, mxHosts = []) {
  const host = pick();
  if (!host) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_TIMEOUT);
  try {
    const res = await fetch(`${host.url}/api/worker/yahoo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-worker-key': host.key
      },
      body: JSON.stringify({ email, mxHosts }),
      signal: controller.signal
    });
    // A 204 is the worker's way of saying "not a Yahoo-family domain" - same as
    // the local oracle returning null, so the caller gets no extra signal.
    if (res.status === 204) return null;
    if (!res.ok) {
      // Silence here used to make an outdated worker (404 on this route) look
      // identical to "not a Yahoo domain", which is impossible to diagnose.
      console.error(`[yahoo-worker] ${host.url}/api/worker/yahoo -> ${res.status}`,
        res.status === 404 ? '(worker is running an old build without this route)' : '');
      return null;
    }
    return await res.json();
  } catch (err) {
    if (err.name !== 'AbortError') console.error('[yahoo-worker]', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
