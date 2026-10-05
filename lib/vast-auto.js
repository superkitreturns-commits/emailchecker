/**
 * Automatic burst capacity.
 *
 * The OVH worker handles every list on its own, but it is one IP with one
 * rate budget: a 20k list takes hours on it. When enough addresses are in
 * flight at once, rent a vast.ai box, wait for its worker to answer, and
 * point SMTP checks at it instead. When the queue drains, destroy it so
 * billing stops.
 *
 * Two things this deliberately does NOT do:
 *   - block the run. OVH starts checking immediately and keeps going the
 *     whole time an instance is booting; the switch is just a change of
 *     address that the next probe picks up (see lib/smtp-remote.js).
 *   - touch the Yahoo family. lib/yahoo-remote.js is pinned to the OVH VPS
 *     because a rented box has no Chromium, so yahoo/aol/att/verizon keep
 *     running exactly as they do today whatever happens here.
 */
import { randomBytes } from 'node:crypto';
import { cheapestOffer, offerByHost, createWorkerInstance, getInstance, setInstanceState, destroyInstance, vastEnabled, InstanceGoneError } from './vast.js';
import {
  preferredHostIds, upsertInstance, removeInstance, clearActive,
  useIpServer, activeInstanceId, startSession, endSession,
  autoInstanceIds, setAutoInstanceIds, listInstances,
  addActiveWorker, removeActiveWorker, activeWorkerCount, yahooWorkerCount
} from './vast-state.js';

/**
 * The machines behind the boxes we already hold.
 *
 * Renting the same machine twice hands back the same public IP, so the second
 * box adds no capacity while the queue counts it as another IP and fires the
 * provider that much faster from the one address.
 */
function rentedMachineIds() {
  const ids = new Set();
  for (const i of listInstances()) if (i?.machineId) ids.add(String(i.machineId));
  return ids;
}

// How many unfinished addresses it takes to be worth renting a second IP.
const THRESHOLD = Number(process.env.VAST_AUTO_THRESHOLD || 2000);
/**
 * How big the pool gets, as a ladder of queue depths.
 *
 * One box is one IP with one rate budget, so the only safe way to go faster is
 * more of them: see the per-IP gap sharding in lib/queue.js. The ladder is
 * deliberately not linear - the first extra IP halves the wait, the sixth
 * barely moves it, because past a few boxes the run is bounded by the Yahoo
 * family, which is pinned to the OVH VPS and cannot be spread at all. So the
 * steps get further apart as they get less valuable.
 *
 * Read as "at least this many addresses in flight -> this many boxes".
 * Override with VAST_AUTO_TIERS="50000:2,100000:3,..." (depth:boxes pairs).
 */
const DEFAULT_TIERS = '50000:2,100000:3,300000:4,500000:5,1000000:6';

function parseTiers(spec) {
  const tiers = String(spec || '')
    .split(',')
    .map(pair => pair.split(':').map(n => Number(String(n).trim())))
    .filter(([depth, boxes]) => Number.isFinite(depth) && Number.isFinite(boxes) && depth > 0 && boxes > 0)
    // Descending, so the first match is the highest tier the depth reaches.
    .sort((a, b) => b[0] - a[0]);
  return tiers.map(([depth, boxes]) => ({ depth, boxes }));
}

const TIERS = parseTiers(process.env.VAST_AUTO_TIERS || DEFAULT_TIERS);
// The ceiling comes from the ladder itself, so raising a tier cannot be undone
// by a stale cap. VAST_MAX_INSTANCES still clamps it if the owner wants less.
const LADDER_MAX = TIERS.reduce((m, t) => Math.max(m, t.boxes), 1);
const MAX_INSTANCES = Math.min(
  LADDER_MAX,
  Number(process.env.VAST_MAX_INSTANCES || LADDER_MAX)
);

/**
 * How many boxes a queue this deep is worth.
 *
 * Below THRESHOLD the run stays on OVH alone - renting for a small list costs
 * more in boot time (2-4 minutes) than it saves. At or above it, one box, then
 * the ladder.
 */
export function desiredInstances(pending) {
  if (pending < THRESHOLD) return 0;
  const tier = TIERS.find(t => pending >= t.depth);
  return Math.min(MAX_INSTANCES, tier ? tier.boxes : 1);
}

export const autoEnabled = () => THRESHOLD > 0 && process.env.VAST_AUTO !== 'off';

// A booting instance usually answers within 2-4 minutes. Past this it is a
// bad host, not a slow one, so stop paying for it and let OVH carry the run.
const BOOT_TIMEOUT_MS = Number(process.env.VAST_AUTO_BOOT_TIMEOUT_MS || 10 * 60 * 1000);
const POLL_MS = Number(process.env.VAST_AUTO_POLL_MS || 15000);
// Draining is debounced: a user who uploads 3k, then another 3k a minute
// later should not pay the rental twice over.
const IDLE_GRACE_MS = Number(process.env.VAST_AUTO_IDLE_MS || 2 * 60 * 1000);
// How long to keep watching a serving box for a browser that is still
// installing. Past this it has no browser and Yahoo simply skips it.
// Matches the worker's own retest window (BROWSER_RETEST_FOR_MS in worker.js):
// giving up here before the box stops looking would strand a browser that did
// eventually install.
const BROWSER_WATCH_MS = Number(process.env.VAST_BROWSER_WATCH_MS || 25 * 60 * 1000);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('[vast-auto]', ...a);

// Only instances this module rented are ones it may destroy. An instance the
// owner launched or attached by hand is theirs and is left completely alone.
// Mirrors the persisted ids so a restart does not orphan a paid rental.
const managed = new Set();
let busy = false;        // a launch or teardown is already in progress
let idleTimer = null;
let lastDepth = 0;
// Set when the owner switches the toggle on while work is already in flight.
// That run keeps going on OVH exactly as it was; renting waits for the next
// one, so flipping the switch never rents anything by itself.
let waitingForNextRun = false;

function publicUrl() {
  return (process.env.PUBLIC_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)
    || '').replace(/\/+$/, '');
}

function ready() {
  if (!autoEnabled() || !vastEnabled()) return false;
  // The "Use IP Server for checks" toggle arms this, nothing more. Switching
  // it on rents nothing by itself: the next run that crosses the threshold is
  // what rents. Switched off, checks stay on the OVH VPS whatever the queue
  // depth is.
  if (!useIpServer()) return false;
  if (!process.env.SMTP_WORKER_KEY) return false;
  // A rented instance fetches its worker files from this app over the public
  // internet. Without a public address it would boot and fetch "localhost".
  return Boolean(publicUrl());
}

/**
 * Rent a box. Pinned hosts win over the cheapest search and are tried in the
 * order the owner listed them; each is looked up fresh because an offer id is
 * a snapshot that expires, while a host id is stable.
 * Shared with the manual Launch button so both paths pick hosts identically.
 */
export async function launchInstance() {
  let offer = null;
  for (const hostId of preferredHostIds()) {
    try { offer = await offerByHost(hostId); break; }
    catch { /* rented out or offline - try the next pinned host */ }
  }
  // Machines already rented, so the search skips them and every box in the
  // pool is a distinct public IP with its own provider rate budget.
  if (!offer) offer = await cheapestOffer(rentedMachineIds());

  // Its own key, not the shared SMTP_WORKER_KEY. vast.ai shows an instance's
  // env in their console and API, so baking the long-lived key into every
  // rental leaked a credential that outlives the box. This one is worthless
  // the moment the instance is destroyed and its record removed.
  const instanceKey = randomBytes(32).toString('hex');
  const created = await createWorkerInstance(offer.id, {
    workerKey: instanceKey,
    helo: process.env.SMTP_HELO,
    bundleUrl: `${publicUrl()}/internal/worker-bundle`
  });
  const id = String(created.new_contract);
  // vast.ai rents in "stopped" and never boots on its own, so without this
  // the onstart script - and the worker - would never run.
  await setInstanceState(id, 'running').catch(() => {});
  // Billing starts when the rental is accepted, not when booting finishes.
  await startSession(id, offer.dph_total);
  const saved = await upsertInstance({
    id, offerId: offer.id, dph: offer.dph_total, gpuName: offer.gpu_name,
    // Recorded so the next rental can avoid this machine: two boxes on one
    // machine share its public IP, which the queue would miscount as two.
    machineId: offer.machine_id != null ? String(offer.machine_id) : null,
    key: instanceKey, createdAt: Date.now(), state: 'booting'
  });
  return { instance: saved, offer };
}

/** The instance's own address once vast.ai has mapped the worker port. */
function addressOf(live) {
  const ip = live?.public_ipaddr;
  const port = live?.ports?.['3001/tcp']?.[0]?.HostPort;
  return ip && port ? `http://${ip}:${port}` : null;
}

/**
 * True once the worker answers AND the box can actually send on port 25.
 *
 * Returns 'wait' while it is still coming up, 'ok' when it is usable, and
 * 'no-port25' for a host that serves HTTP perfectly but cannot open outbound
 * 25. That last case is the dangerous one: without this check the box looked
 * healthy, took over from OVH, and turned every address into "unknown".
 */
export async function workerAnswers(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!res.ok) return 'wait';
    const h = await res.json();
    if (h?.role !== 'smtp-worker') return 'wait';
    if (h.port25 === false) return 'no-port25';
    // null means the startup probe has not finished yet - give it another poll
    // rather than routing checks to a box whose egress is still unknown.
    if (h.port25 !== true) return 'wait';
    // The browser is optional, so unlike port 25 it never blocks activation -
    // it only decides whether the Yahoo family may be sent here. null means
    // the launch test has not finished; treat that as "no" for now, and a
    // later poll upgrades it (see refreshCapabilities).
    return { verdict: 'ok', chromium: h.chromium === true };
  } catch { return 'wait'; }
  finally { clearTimeout(timer); }
}

/** Poll a freshly rented instance until its worker is serving, then switch. */
async function activateWhenReady(id) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!managed.has(id)) return;          // torn down while we waited

    let live;
    try { live = await getInstance(id); }
    catch (err) {
      if (err instanceof InstanceGoneError) {
        log(`#${id} disappeared while booting - the rest of the pool carries on`);
        await endSession(id); await removeInstance(id);
        await forget(id);
        return;
      }
      continue;                            // transient API error - keep waiting
    }

    const url = addressOf(live);
    await upsertInstance({
      id, state: live?.actual_status || 'booting',
      ip: live?.public_ipaddr || null,
      port: live?.ports?.['3001/tcp']?.[0]?.HostPort || null
    });
    if (!url) continue;
    const health = await workerAnswers(url);
    const verdict = typeof health === 'string' ? health : health.verdict;
    if (verdict === 'no-port25') {
      log(`#${id} cannot send mail (port 25 blocked, or the IP is refused by every provider) - useless for SMTP, destroying just that box`);
      await upsertInstance({ id, state: 'port25-blocked' });
      await destroy(id);
      return;
    }
    if (verdict !== 'ok') continue;

    // Joins the pool rather than replacing it: every box already serving keeps
    // serving, and the queue widens its gaps and slots to match the new size
    // (lib/queue.js reads the count live).
    const chromium = Boolean(health.chromium);
    await addActiveWorker(id, url, { chromium });
    await upsertInstance({ id, state: 'active', auto: true, chromium });
    log(`#${id} is live at ${url} - pool is now ${activeWorkerCount()} box(es), `
      + `${yahooWorkerCount()} with a browser`
      + (chromium ? '' : ' (this one has no browser, so Yahoo skips it)'));
    // The browser install finishes after the worker starts listening, so a box
    // can be SMTP-ready minutes before it is Yahoo-ready. Keep looking.
    if (!chromium) watchForBrowser(id, url);
    return;
  }

  log(`#${id} never answered within ${Math.round(BOOT_TIMEOUT_MS / 60000)}m - destroying it`);
  await destroy(id);
}

/**
 * Keep polling a serving box until its browser shows up.
 *
 * The boot chain starts the worker only after the browser install, but the
 * install is `|| true` and can also simply be slow, so a box can answer
 * /api/health with chromium:false or null and gain the browser later (the
 * worker tests it once at startup, so in practice this catches the case where
 * the health poll landed before that test finished). Polling costs one request
 * a minute and the alternative is leaving the whole Yahoo list on OVH because
 * of a race during boot.
 */
async function watchForBrowser(id, url) {
  const deadline = Date.now() + BROWSER_WATCH_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (!managed.has(id)) return;              // destroyed meanwhile
    const health = await workerAnswers(url);
    if (typeof health === 'string') continue;  // still booting, or gone
    if (!health.chromium) continue;
    await addActiveWorker(id, url, { chromium: true });
    await upsertInstance({ id, chromium: true });
    log(`#${id} browser is ready - Yahoo now spreads over ${yahooWorkerCount() + 1} IPs (OVH plus ${yahooWorkerCount()})`);
    return;
  }
}

/** Stop tracking a box without touching the rest of the pool. */
async function forget(id) {
  managed.delete(id);
  await setAutoInstanceIds([...managed]);
  await removeActiveWorker(id);
}

/**
 * Give one box back and stop paying for it.
 *
 * Scoped to that box on purpose: a single bad host (no port 25, never booted)
 * used to take the whole run back to OVH, because there was only ever one
 * rental to lose. The others keep checking, and the queue narrows its gaps and
 * slots to the smaller pool on its own.
 */
async function destroy(id) {
  if (!managed.has(id)) return;
  await forget(id);
  await destroyInstance(id).catch(() => {});   // already gone is fine
  await endSession(id);
  await removeInstance(id);
  log(`#${id} destroyed - pool is now ${activeWorkerCount()} box(es)`);
}

/** Give the whole pool back: the queue has drained. */
async function teardown() {
  const ids = [...managed];
  if (!ids.length) return;
  for (const id of ids) await destroy(id);
  // The pool is empty now, so checks are on OVH again. The toggle itself is
  // the owner's setting and is left exactly as they set it, so the next big
  // run can rent again.
  if (!activeWorkerCount() && activeInstanceId()) await clearActive();
  log('pool released - checks are back on OVH');
}

/**
 * Called by the queue whenever the amount of unfinished work changes.
 * @param {number} pending unfinished addresses across every running job
 */
export function notePending(pending) {
  lastDepth = pending;

  // The run that was already going when the toggle came on has drained, so
  // the next one is free to rent.
  if (pending === 0) waitingForNextRun = false;

  // Giving an instance back only needs an API key, never the full launch
  // config. Gating this on ready() meant a changed PUBLIC_URL could strand a
  // paid rental with nothing left willing to destroy it.
  if (pending === 0 && managed.size && !idleTimer && vastEnabled()) {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (lastDepth === 0 && managed.size && !busy) {
        busy = true;
        teardown().catch(err => log('teardown failed:', err.message)).finally(() => { busy = false; });
      }
    }, IDLE_GRACE_MS);
    return;
  }

  if (!ready()) return;

  const want = desiredInstances(pending);
  if (!want) return;

  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (waitingForNextRun) return;
  if (busy) return;
  // An instance the owner activated by hand already carries the run, and the
  // size of the pool is then their call, not ours.
  if (!managed.size && activeInstanceId()) return;

  // Scale UP only. Shrinking mid-run would destroy a box that is holding
  // probes in flight to save a few minutes of rental, and the drain path
  // below already releases the whole pool once the queue empties.
  const deficit = want - managed.size;
  if (deficit <= 0) return;

  busy = true;
  (async () => {
    try {
      // Sequentially, not in parallel: each rental is a separate charge, and a
      // failure partway through should leave the boxes already rented working
      // rather than abandoning the scale-up entirely.
      for (let i = 0; i < deficit; i++) {
        const { instance, offer } = await launchInstance();
        managed.add(instance.id);
        await setAutoInstanceIds([...managed]);
        log(`${pending} addresses queued - rented #${instance.id} (${offer.gpu_name}, $${Number(offer.dph_total).toFixed(4)}/hr), ${managed.size}/${want} boxes; OVH keeps checking while they boot`);
        activateWhenReady(instance.id).catch(err => log('activation failed:', err.message));
      }
    } catch (err) {
      log(`could not rent all ${want} instance(s), continuing on ${managed.size}:`, err.message);
    } finally { busy = false; }
  })();
}

/**
 * Reclaim ownership of an instance rented before a restart.
 *
 * Without this the rental keeps billing with nothing tracking it: the id only
 * ever lived in memory. Called once at boot, after the state file is loaded.
 */
export async function resumeAuto() {
  const ids = autoInstanceIds();
  if (!ids.length) return;
  for (const id of ids) managed.add(id);
  log(`resumed ownership of auto-rented ${ids.map(i => `#${i}`).join(', ')} after restart`);
  // A restart used to lose the boot watcher: an instance still coming up was
  // owned but nothing was waiting for it, so it was never activated and got
  // destroyed when the idle timer fired - a rental paid for nothing. Pick the
  // watch back up unless it is already the live worker.
  for (const id of ids) {
    if (activeInstanceId() === id) continue;
    activateWhenReady(id).catch(err => log('resumed activation failed:', err.message));
  }
  // Nothing is queued at boot, so this starts the idle timer, giving any job
  // that survived the restart a grace window to re-register before we destroy it.
  notePending(0);
}

/**
 * Called when the "Use IP Server for checks" toggle is switched on. Work that
 * is already running stays on OVH: the owner asked for the next check to use
 * a rented box, not for this one to be moved mid-flight.
 */
export function armAuto(pendingNow) {
  waitingForNextRun = pendingNow > 0;
}

export const autoStatus = () => ({
  enabled: autoEnabled(),
  ready: ready(),
  threshold: THRESHOLD,
  managedInstanceId: [...managed][0] || null,
  managedInstanceIds: [...managed],
  poolSize: activeWorkerCount(),
  yahooPoolSize: yahooWorkerCount(),
  maxInstances: MAX_INSTANCES,
  tiers: TIERS,
  desired: desiredInstances(lastDepth),
  idleGraceMs: IDLE_GRACE_MS,
  pending: lastDepth,
  waitingForNextRun
});
