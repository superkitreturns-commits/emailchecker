/**
 * Which vast.ai instances exist and which one (if any) is the live SMTP
 * worker right now. Kept in a small JSON file next to users.json so a launch
 * or an activation survives a restart - losing track of a running instance
 * would mean paying for a GPU nobody can find or destroy again.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './paths.js';

const file = join(dataDir, 'vast-state.json');
let state = { instances: {}, activeInstanceId: null, activeUrl: null, activeKey: null, activeWorkers: [], runLog: [], preferredHostId: null, preferredHostIds: [], useIpServer: false, autoInstanceId: null, autoInstanceIds: [] };
let loaded = false;
// A run log entry older than this no longer matters for the daily summary.
const LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

async function load() {
  if (loaded) return;
  loaded = true;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch {}
}

async function save() {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}

export async function initVastState() { await load(); }

export function listInstances() { return Object.values(state.instances); }
export function getLocalInstance(id) { return state.instances[id] || null; }

export async function upsertInstance(patch) {
  await load();
  state.instances[patch.id] = { ...state.instances[patch.id], ...patch };
  await save();
  return state.instances[patch.id];
}

export async function removeInstance(id) {
  await load();
  delete state.instances[id];
  // Pulling it from the pool rather than clearing the whole thing: the other
  // rented boxes are still serving and must keep serving.
  state.activeWorkers = poolOf().filter(w => w.id !== String(id));
  syncPrimary();
  await save();
}

/**
 * The pool of rented boxes currently carrying SMTP checks.
 *
 * One box is one IP with one rate budget, so capacity scales by renting more
 * of them rather than by probing any single one harder - see the per-IP
 * throttle sharding in lib/queue.js and the routing in lib/smtp-remote.js.
 *
 * activeInstanceId / activeUrl / activeKey stay in the state as a mirror of
 * the FIRST pool member. Every existing caller (the admin panel, the health
 * route, the manual Activate button) reads those and keeps working unchanged;
 * only the callers that want the whole pool read activeWorkers().
 */
function syncPrimary() {
  const first = state.activeWorkers?.[0] || null;
  state.activeInstanceId = first?.id || null;
  state.activeUrl = first?.url || null;
  state.activeKey = first?.key || null;
}

/** Migrate state written before the pool existed. */
function poolOf() {
  if (!Array.isArray(state.activeWorkers)) state.activeWorkers = [];
  if (!state.activeWorkers.length && state.activeInstanceId && state.activeUrl) {
    state.activeWorkers = [{ id: state.activeInstanceId, url: state.activeUrl, key: state.activeKey || null }];
  }
  return state.activeWorkers;
}

/**
 * Add a box to the pool without disturbing the ones already serving.
 *
 * `chromium` records whether the box proved it can launch a browser, which is
 * what decides if the Yahoo family may be routed to it. It is a capability of
 * that box, not of the pool: a box whose browser install failed still carries
 * every other provider.
 */
export async function addActiveWorker(id, url, { chromium = false } = {}) {
  await load();
  const pool = poolOf();
  const entry = { id: String(id), url, key: state.instances[id]?.key || null, chromium: Boolean(chromium) };
  const at = pool.findIndex(w => w.id === entry.id);
  if (at >= 0) pool[at] = entry; else pool.push(entry);
  syncPrimary();
  await save();
  // Only a change in pool SIZE changes the rate each IP sees, so that is what
  // invalidates the live counter; re-adding the same box does not.
  if (at < 0) resetLiveStats();
}

/** Drop one box (destroyed, or failed) and leave the rest of the pool serving. */
export async function removeActiveWorker(id) {
  await load();
  const pool = poolOf();
  const next = pool.filter(w => w.id !== String(id));
  if (next.length === pool.length) return;
  state.activeWorkers = next;
  syncPrimary();
  await save();
  resetLiveStats();
}

/**
 * Every box checks should be routed across right now, newest last. Empty when
 * the owner's toggle is off, so turning it off sends everything back to OVH
 * without touching the rentals themselves.
 */
export const activeWorkers = () => (state.useIpServer ? poolOf().filter(w => w.url) : []);
export const activeWorkerCount = () => activeWorkers().length;
/**
 * The boxes that can run the Yahoo-family browser probe.
 *
 * Separate from activeWorkers() because the two capabilities are independent:
 * a box can have port 25 and no browser, and the Yahoo rate budget must only
 * ever be divided by the IPs actually probing Yahoo. Counting the wrong set
 * here is how you quietly triple Yahoo's rate from one IP.
 */
export const yahooWorkers = () => activeWorkers().filter(w => w.chromium);
export const yahooWorkerCount = () => yahooWorkers().length;

export async function setActive(id, url) {
  await load();
  // Replaces the pool rather than joining it: this is the manual Activate
  // button, and the owner picking one box means that box, not that box plus
  // whatever the auto-scaler happened to have running.
  // Each rented box gets its own key (see launchInstance), so calls to it are
  // signed with that key rather than the long-lived shared one.
  state.activeWorkers = [{ id: String(id), url, key: state.instances[id]?.key || null }];
  syncPrimary();
  await save();
  resetLiveStats();
}

export async function clearActive() {
  await load();
  state.activeWorkers = [];
  syncPrimary();
  await save();
  resetLiveStats();
}

/** Read synchronously in the SMTP request path, so it must already be loaded by boot. */
export const activeWorkerUrl = () => (state.useIpServer && state.activeUrl) || null;
/**
 * The key to sign calls to the active instance with. Falls back to the shared
 * SMTP_WORKER_KEY for instances rented before per-instance keys existed, and
 * for the OVH worker, which has the shared key baked into its own config.
 */
export const activeWorkerKey = () => (state.useIpServer && state.activeKey) || null;
/** Every live per-instance key, so the bundle endpoint can accept them. */
export const instanceKeys = () => Object.values(state.instances).map(i => i.key).filter(Boolean);
export const activeInstanceId = () => state.activeInstanceId || null;
export const useIpServer = () => Boolean(state.useIpServer);
export async function setUseIpServer(on) {
  await load();
  state.useIpServer = Boolean(on);
  await save();
  resetLiveStats();
}

/**
 * The instance the automatic burst launcher rented, if any. Persisted because
 * it is the only record of "this one is ours to destroy": after a restart an
 * in-memory id would be lost and the rental would bill until someone noticed.
 * An instance the owner launched or attached by hand is never recorded here.
 */
export const autoInstanceId = () => state.autoInstanceId || null;
export async function setAutoInstanceId(id) {
  await load();
  state.autoInstanceId = id ? String(id) : null;
  await save();
}

/**
 * Every instance the burst launcher rented, not just the first.
 *
 * With one instance the single autoInstanceId was enough to answer "is this
 * ours to destroy". A pool needs the whole list, or a restart halfway through
 * a scale-up leaves the boxes it does not remember billing forever with
 * nothing tracking them. autoInstanceId is kept in sync as the head of the
 * list so older code and older state files still read correctly.
 */
export function autoInstanceIds() {
  const list = Array.isArray(state.autoInstanceIds) ? state.autoInstanceIds : [];
  if (!list.length && state.autoInstanceId) return [String(state.autoInstanceId)];
  return list.map(String);
}
export async function setAutoInstanceIds(ids) {
  await load();
  const clean = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
  state.autoInstanceIds = clean;
  state.autoInstanceId = clean[0] || null;   // keep the legacy field in sync
  await save();
}

/** A specific offer to always rent instead of searching for the cheapest one. */
export const preferredHostId = () => state.preferredHostId || null;
export async function setPreferredHostId(id) {
  await load();
  state.preferredHostId = id || null;
  await save();
}

/**
 * Ordered list of host ids to try before falling back to the cheapest offer.
 * Migrates the single legacy preferredHostId into the list so older state
 * keeps working.
 */
export function preferredHostIds() {
  const list = Array.isArray(state.preferredHostIds) ? state.preferredHostIds : [];
  if (!list.length && state.preferredHostId) return [String(state.preferredHostId)];
  return list.map(String);
}
export async function setPreferredHostIds(ids) {
  await load();
  const clean = (Array.isArray(ids) ? ids : [])
    .map(x => String(x).trim())
    .filter(Boolean);
  state.preferredHostIds = clean;
  state.preferredHostId = clean[0] || null; // keep legacy field in sync
  await save();
}

/* ------------------------------ live counter ------------------------------ */
// In-memory only, not persisted: this is a "what is happening right now" view
// for the admin panel, not a durable record (the run log above already is).
// Reset whenever the active instance changes, so the count always answers
// "how many checks has THIS server done since it took over".
let live = { checked: 0, lastEmail: null, lastAt: null };

export function resetLiveStats() { live = { checked: 0, lastEmail: null, lastAt: null }; }
export function recordLiveCheck(email) { live = { checked: live.checked + 1, lastEmail: email, lastAt: Date.now() }; }
export function liveStats() { return { ...live }; }

/* ------------------------------ run log ------------------------------ */
// One entry per "instance was billing compute" stretch, so the summary can
// answer "how long did this run today" and "what did it cost" without
// needing to poll vast.ai's own (paid, historical) billing API.

export async function startSession(id, dph) {
  await load();
  const open = state.runLog.find(s => s.instanceId === id && !s.endedAt);
  if (open) return open; // already running - do not open a second stretch
  const entry = { instanceId: id, dph: dph ?? null, startedAt: Date.now(), endedAt: null };
  state.runLog.push(entry);
  await save();
  return entry;
}

export async function endSession(id) {
  await load();
  const open = state.runLog.filter(s => s.instanceId === id && !s.endedAt);
  for (const s of open) s.endedAt = Date.now();
  if (open.length) {
    state.runLog = state.runLog.filter(s => !s.endedAt || s.endedAt > Date.now() - LOG_RETENTION_MS);
    await save();
  }
  return open;
}

/** Minutes and estimated cost run today (UTC) and total across the whole log. */
export function runSummary() {
  const now = Date.now();
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const since = dayStart.getTime();

  const slice = (entry, from) => {
    const end = entry.endedAt ?? now;
    const start = Math.max(entry.startedAt, from);
    return Math.max(0, end - start);
  };

  let todayMs = 0, todayCost = 0, totalMs = 0, totalCost = 0;
  const perInstance = {};
  for (const e of state.runLog) {
    const todaySpan = slice(e, since);
    const totalSpan = slice(e, 0);
    const dph = e.dph || 0;
    todayMs += todaySpan; todayCost += (todaySpan / 3_600_000) * dph;
    totalMs += totalSpan; totalCost += (totalSpan / 3_600_000) * dph;
    const p = (perInstance[e.instanceId] ||= { instanceId: e.instanceId, ms: 0, cost: 0, running: false });
    p.ms += totalSpan;
    p.cost += (totalSpan / 3_600_000) * dph;
    if (!e.endedAt) p.running = true;
  }
  return {
    today: { minutes: Math.round(todayMs / 60000), costUsd: Math.round(todayCost * 100) / 100 },
    total: { minutes: Math.round(totalMs / 60000), costUsd: Math.round(totalCost * 100) / 100 },
    perInstance: Object.values(perInstance)
  };
}
