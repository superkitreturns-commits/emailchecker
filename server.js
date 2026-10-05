import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

import { validateEmail } from './lib/validator.js';
import { presentResult } from './lib/present.js';
import { DisposableList } from './lib/disposable.js';
import { smtpEnabled, heloHost, heloIsPlaceholder, verifyMailbox } from './lib/smtp.js';
import { remoteVerifyMailbox, workerEnabled, workerUrl, workerKey } from './lib/smtp-remote.js';
import { remoteYahooMailbox, yahooWorkerEnabled, yahooHostCount } from './lib/yahoo-remote.js';
import { dnsCacheSize, lookupDomain } from './lib/dns-check.js';
import { greylistPendingSize, greylistResolvedSize } from './lib/greylist.js';
import { JobQueue } from './lib/queue.js';
import { infraKey } from './lib/providers.js';
import { msOracleEnabled } from './lib/ms-oracle.js';
import { initTlds, tldCount, tldSource } from './lib/tlds.js';
import { warmup as warmRdap } from './lib/domain-intel.js';
import { Auth, AuthError, COOKIE, publicUser, readCookie, sessionCookie, clearCookie } from './lib/auth.js';
import { dataDir, initDataDir } from './lib/paths.js';
import { vastEnabled, getInstance, setInstanceState, destroyInstance, InstanceGoneError } from './lib/vast.js';
import {
  initVastState, listInstances, upsertInstance, removeInstance,
  setActive, clearActive, activeInstanceId, activeWorkerUrl, activeWorkerCount, activeWorkers,
  addActiveWorker, removeActiveWorker,
  startSession, endSession, runSummary, liveStats,
  preferredHostId, preferredHostIds, setPreferredHostIds,
  useIpServer, setUseIpServer, instanceKeys
} from './lib/vast-state.js';
import { notePending, autoStatus, launchInstance, resumeAuto, armAuto, workerAnswers } from './lib/vast-auto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
// 100k measured at ~0.05 GB of results in memory, ~0.11 GB while a progress
// snapshot is cloned, and ~2.5 MB of request body - all comfortably inside the
// 8 MB body cap below. It is the rate limits of the mail providers, not this
// number, that bound a run of that size.
const BULK_LIMIT = Number(process.env.BULK_LIMIT || 100000);
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 60);

const app = express();
app.disable('x-powered-by');
// Only trust X-Forwarded-For behind a real proxy; otherwise anyone could fake
// their IP and dodge the rate limit and the login lockout.
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// ---- Security headers --------------------------------------------------
// Written out rather than pulling in helmet: five headers is not worth a
// dependency, and being explicit shows exactly what is allowed.
app.use((_req, res, next) => {
  res.set({
    // Stop browsers guessing content types.
    'X-Content-Type-Options': 'nosniff',
    // No one should be able to frame this and trick users into clicking.
    'X-Frame-Options': 'DENY',
    // Do not leak the checked address in a Referer header - it is in the URL.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      // 'unsafe-inline' is needed for the pre-paint theme script and the
      // inline <style>; there is no user-supplied script anywhere.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'"
    ].join('; ')
  });
  next();
});

// A full 50k batch is ~1.5MB of JSON, and the uploader accepts 5MB files.
// The old 2mb ceiling rejected large batches with a bare 413 before the
// bulk limit was ever consulted.
// Sized against BULK_LIMIT: 100k addresses is ~2.4 MB at typical length and
// ~5 MB at 50 characters each, so this leaves room for a list of long
// corporate addresses instead of refusing it at the door.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '16mb' }));

// ---- Writable state --------------------------------------------------
// On Railway/Render the deploy filesystem is thrown away on every push, so
// DATA_DIR must point at a mounted volume for logins to survive a redeploy.
await initDataDir();

// ---- Shared disposable blocklist -------------------------------------
const disposable = new DisposableList({ dataDir });
await disposable.init();

// ---- Validation dependencies -----------------------------------------
// Port 25 is blocked on managed hosts, so when a worker is configured the
// mailbox probe is sent to the VPS instead of attempted from this process.
const deps = { disposable };
// Decided per call, not once at boot. A vast.ai instance activated later in
// the session changes what workerEnabled() answers, and the old boot-time
// check meant a box could rent, boot and go active while every probe kept
// running locally - the rental did nothing. Installed whenever a worker is
// configured OR vast.ai can supply one later; the local probe stays the
// fallback, so nothing changes on a host with no worker at all.
if (workerEnabled() || vastEnabled()) {
  deps.verifyMailbox = (email, mxHosts, options) =>
    (workerEnabled() ? remoteVerifyMailbox : verifyMailbox)(email, mxHosts, options);
}
// Yahoo's browser probe needs Chrome + a clean IP, which this managed host does
// not have. When a worker is configured, run it on the VPS instead.
if (yahooWorkerEnabled()) deps.yahooMailbox = remoteYahooMailbox;

// ---- Real TLD list (stops valid TLDs being "corrected") ---------------
await initTlds({ dataDir });

// Pull the RDAP bootstrap now so the first request does not race it.
warmRdap();

// ---- Rate limiting ----------------------------------------------------
// Fixed window per IP. Swap for Redis when you run more than one process.
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function rateLimit(cost = 1) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now - rec.start > RATE_WINDOW_MS) {
      rec = { start: now, count: 0 };
      hits.set(ip, rec);
    }
    rec.count += cost;
    if (rec.count > RATE_MAX) {
      const retryAfter = Math.ceil((rec.start + RATE_WINDOW_MS - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests',
        detail: `Limit is ${RATE_MAX} checks per minute. Try again in ${retryAfter}s.`
      });
    }
    res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_MAX - rec.count)));
    next();
  };
}

// ---- Accounts --------------------------------------------------------
const auth = new Auth({ dataDir });
await auth.init();
await initVastState();

// Attach the signed-in user (if any) to every request.
app.use((req, _res, next) => {
  req.user = auth.userForToken(readCookie(req, COOKIE));
  next();
});

// State-changing requests must come from this site. JSON bodies already need a
// CORS preflight cross-site; this also rejects a foreign Origin outright.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; }
    catch { return res.status(403).json({ error: 'Cross-site request blocked' }); }
    if (originHost !== req.get('host')) {
      return res.status(403).json({ error: 'Cross-site request blocked' });
    }
  }
  next();
});

const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Please sign in', signIn: '/login' });

const authRoute = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
    console.error('auth failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// No public sign-up: the owner creates accounts with `npm run add-user`.

app.post('/api/auth/login', authRoute(async (req, res) => {
  const { email, password, remember } = req.body || {};
  const key = `${req.ip}|${String(email || '').toLowerCase()}`;
  const wait = auth.checkThrottle(key);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
  }
  const user = await auth.verify(email, password);
  if (!user) {
    auth.recordFailure(key);
    // One message for both cases, so the form does not reveal which emails have accounts.
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  auth.clearFailures(key);
  auth.track(user, { login: true });
  const { token, maxAge } = await auth.createSession(user, remember);
  res.set('Set-Cookie', sessionCookie(req, token, maxAge));
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', authRoute(async (req, res) => {
  await auth.destroySession(readCookie(req, COOKIE));
  res.set('Set-Cookie', clearCookie());
  res.json({ ok: true });
}));

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const me = auth.users.find(u => u.id === req.user.id) || req.user;
  res.json({ user: { ...publicUser(me), role: auth.roleOf(me), credits: auth.creditsOf(me), canCreateResellers: auth.canMakeResellers(me) } });
});

// ---- Users: owner manages everyone, a reseller only their own users -----
const requireManager = (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please sign in' })
  : auth.canManageUsers(req.user) ? next()
  : res.status(403).json({ error: 'You do not have access to user management' });

const userView = (u, actor) => {
  const creator = u.createdBy && auth.users.find(x => x.id === u.createdBy);
  return {
    id: u.id, username: u.email, name: u.name, role: auth.roleOf(u),
    disabled: !!u.disabled, createdAt: u.createdAt, credits: auth.creditsOf(u),
    canCreateResellers: auth.roleOf(u) === 'reseller' && !!u.canCreateResellers,
    createdBy: creator ? { id: creator.id, name: creator.name, username: creator.email } : null,
    checks: u.checks || 0, logins: u.logins || 0,
    lastLoginAt: u.lastLoginAt || null, lastActiveAt: u.lastActiveAt || null,
    // Only whoever manages this user may see the password; owners' passwords are never shown.
    password: actor && auth.canEdit(actor, u) ? auth.decrypt(u.pwEnc) : null,
    // Visible-but-not-managed rows (a sub-partner's clients) are reporting
    // only: the UI hides their actions and their password.
    manageable: !!(actor && auth.canEdit(actor, u))
  };
};

app.get('/api/users', requireManager, authRoute(async (req, res) => {
  await auth.locked(() => auth.reload());
  const meNow = auth.users.find(u => u.id === req.user.id) || req.user;
  res.json({ me: auth.roleOf(req.user), canCreateResellers: auth.canMakeResellers(meNow), users: auth.visibleTo(req.user).map(u => userView(u, req.user)) });
}));

app.post('/api/users', requireManager, authRoute(async (req, res) => {
  const { name, username, password, reseller, credits, canCreateResellers } = req.body || {};
  // Permission, affordability, the account and its opening credits all commit
  // together. Splitting them let a failed transfer leave an unfunded account
  // behind after the route had already reported an error.
  const user = await auth.createManagedUser(req.user, {
    name: String(name || ''), username: String(username || ''), password,
    reseller, credits, canCreateResellers
  });
  res.status(201).json({ user: userView(user, req.user) });
}));

app.patch('/api/users/:id', requireManager, authRoute(async (req, res) => {
  const user = await auth.updateUser(req.user, req.params.id, req.body || {});
  res.json({ user: userView(user, req.user) });
}));

app.post('/api/users/:id/credits', requireManager, authRoute(async (req, res) => {
  const user = await auth.transferCredits(req.user, req.params.id, req.body?.amount);
  res.json({ user: userView(user, req.user), myCredits: auth.creditsOf(auth.users.find(u => u.id === req.user.id)) });
}));

app.delete('/api/users/:id', requireManager, authRoute(async (req, res) => {
  await auth.deleteUser(req.user, req.params.id);
  res.json({ ok: true });
}));

// ---- GPU burst capacity (owner only) ------------------------------------
// Lets the owner rent a cheap vast.ai GPU instance on demand, point SMTP
// checks at it once it is up, and destroy it when the run is done - without
// touching the OVH worker that keeps running the whole time. Hidden from
// everyone but the owner: resellers and users never see vast.ai exists.
const requireOwner = (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please sign in' })
  : auth.isOwner(req.user) ? next()
  : res.status(403).json({ error: 'Owner only' });

// The handful of files the worker needs, fetched by a vast.ai instance's own
// boot script - no git remote or registry required. Gated by the same shared
// key the worker already uses, so only an instance we just started can read it.
// worker.js imports the Yahoo oracle, so the oracle and its own import
// (providers.js) must ship too or a rented instance dies at startup with
// ERR_MODULE_NOT_FOUND before it ever serves a probe.
const WORKER_BUNDLE_FILES = [
  'worker.js',
  'lib/smtp.js', 'lib/smtp-codes.js', 'lib/cache.js', 'lib/greylist.js',
  'lib/yahoo-oracle.js', 'lib/providers.js'
];

/**
 * The package.json a rented box boots with - deliberately not the repo's own,
 * which carries dev tooling the box has no use for.
 *
 * patchright is here because the box now takes the Yahoo family too, which
 * needs a real browser (lib/yahoo-oracle.js drives Chromium). The npm package
 * is only the driver: the Chromium binary itself is fetched by the separate
 * `patchright install` step in lib/vast.js, which is allowed to fail. If it
 * does, patchright is still importable and the worker's startup probe simply
 * reports chromium:false, so the box serves SMTP and the app keeps Yahoo on a
 * host that does have a browser.
 */
const WORKER_PACKAGE_JSON = JSON.stringify({
  name: 'email-validator-worker',
  version: '1.0.0',
  type: 'module',
  scripts: { worker: 'node worker.js' },
  dependencies: { express: 'latest', patchright: 'latest' }
}, null, 2);
/**
 * The shared key, or any live per-instance key. A rented box is given its own
 * key rather than the shared one (vast.ai exposes an instance's env in their
 * console), so the bundle it fetches at boot must accept that key too.
 */
function workerKeyMatches(given) {
  const a = Buffer.from(String(given || ''));
  const candidates = [process.env.SMTP_WORKER_KEY || '', ...instanceKeys()].filter(Boolean);
  return candidates.some(want => {
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}
app.get('/internal/worker-bundle', async (req, res) => {
  if (!workerKeyMatches(req.get('x-worker-key'))) return res.status(401).json({ error: 'Bad worker key' });
  const files = [{ path: 'package.json', content: Buffer.from(WORKER_PACKAGE_JSON).toString('base64') }];
  for (const rel of WORKER_BUNDLE_FILES) {
    try { files.push({ path: rel, content: (await readFile(join(__dirname, rel))).toString('base64') }); }
    catch { /* an optional file that is not there is simply skipped */ }
  }
  res.json({ files });
});

// Guards the manual Launch button against a double click renting two boxes.
let launching = false;

// An instance's per-instance worker key never leaves the server: the panel has
// no use for it, and it is the credential that lets a caller drive that box.
const safeInstance = (i) => { if (!i) return i; const { key, ...rest } = i; return rest; };

app.get('/api/admin/vast', requireOwner, authRoute(async (req, res) => {
  res.json({
    enabled: vastEnabled(),
    ovhUrl: process.env.SMTP_WORKER_URL || null,
    activeInstanceId: activeInstanceId(),
    activeUrl: activeWorkerUrl(),
    // activeInstanceId is the first box in the pool; this is how many are
    // actually carrying checks, which is what sets the probe rate.
    activeWorkerIds: activeWorkers().map(w => w.id),
    useIpServer: useIpServer(),
    preferredHostId: preferredHostId(),
    preferredHostIds: preferredHostIds(),
    auto: autoStatus(),
    instances: listInstances().map(safeInstance)
  });
}));

app.post('/api/admin/vast/use', requireOwner, authRoute(async (req, res) => {
  const on = Boolean(req.body?.on);
  await setUseIpServer(on);
  // Switching on only arms the auto-rent. A run already in flight finishes on
  // OVH; the next one is what rents a box.
  if (on) armAuto(queue.pending());
  res.json({ useIpServer: useIpServer() });
}));

app.post('/api/admin/vast/preferred-host', requireOwner, authRoute(async (req, res) => {
  // Accepts either a single hostId (legacy) or an ordered hostIds list.
  let ids = req.body?.hostIds;
  if (!Array.isArray(ids)) {
    ids = String(req.body?.hostId || '').split(/[\s,]+/);
  }
  await setPreferredHostIds(ids);
  res.json({ preferredHostIds: preferredHostIds() });
}));

app.post('/api/admin/vast/launch', requireOwner, authRoute(async (req, res) => {
  if (!vastEnabled()) throw new AuthError(400, 'Set VAST_API_KEY in Railway env first');
  if (!process.env.SMTP_WORKER_KEY) throw new AuthError(400, 'Set SMTP_WORKER_KEY in Railway env first');
  // The rented instance fetches its worker files FROM this address, over the
  // public internet - it is not the browser's address, so it can never be
  // derived from the request. Building it from req.get('host') worked by
  // coincidence on a public deploy and silently sent instances to fetch from
  // their own "localhost" when launched from a local dev server, where the
  // boot script fails before the worker ever starts.
  const publicUrl = (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) || '').replace(/\/+$/, '');
  if (!publicUrl) {
    throw new AuthError(400, 'Set PUBLIC_URL (this app\'s own public https address) in env before launching. A rented instance cannot reach "localhost"');
  }
  // One launch at a time. Renting takes a few seconds against vast.ai's API,
  // and the button gave no feedback during them, so an impatient second click
  // rented a second box - billed, unnoticed, and not what anyone asked for.
  if (launching) {
    throw new AuthError(409, 'A launch is already in progress - wait for it to appear in the list');
  }
  // And refuse a second box while one is still alive. The panel re-renders
  // after a successful launch, which re-enables the button, so the usual way
  // to end up paying for three idle GPUs was simply clicking it three times.
  // ?force=1 is the deliberate way to add another.
  if (req.query.force !== '1') {
    const alive = listInstances().filter(i => !['stopped', 'exited'].includes(i.state));
    if (alive.length) {
      throw new AuthError(409,
        `Instance #${alive[0].id} is already running. Destroy it first, or add ?force=1 to rent another on purpose`);
    }
  }
  launching = true;
  try {
    // Pinned hosts win over the cheapest search and are tried in order, then
    // the cheapest offer. Shared with the automatic burst launcher so a manual
    // and an automatic rental always pick a host the same way.
    const { instance } = await launchInstance();
    res.status(201).json({ instance: safeInstance(instance) });
  } finally {
    launching = false;
  }
}));

// Must come before GET /api/admin/vast/:id - otherwise Express matches
// "summary" as the :id param and this route is never reached.
/**
 * Run the outbound port 25 test on demand, against whichever box is serving
 * checks. Forces a fresh dial rather than reading the worker's cached answer,
 * because the owner clicking "Test" wants the situation now.
 *
 * Works for the active vast.ai instance and, when none is active, for the OVH
 * worker - the question "can this box send on 25" is worth asking of either.
 */
app.post('/api/admin/vast/port25-test', requireOwner, authRoute(async (req, res) => {
  const url = activeWorkerUrl() || (process.env.SMTP_WORKER_URL || '').replace(/\/+$/, '');
  if (!url) throw new AuthError(409, 'No worker is serving checks right now - activate an instance or set SMTP_WORKER_URL');
  const which = activeWorkerUrl() ? `IP Server #${activeInstanceId()}` : 'OVH worker';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let out;
  try {
    const r = await fetch(`${url}/api/worker/port25`, {
      method: 'GET',
      headers: { 'x-worker-key': workerKey() },
      signal: controller.signal
    });
    if (r.status === 404) throw new AuthError(409, `${which} is running an old build without the port 25 test - re-rent it`);
    if (!r.ok) throw new AuthError(502, `${which} answered ${r.status} to the port 25 test`);
    out = await r.json();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError(504, err.name === 'AbortError'
      ? `${which} did not finish the port 25 test in time`
      : `Could not reach ${which} to run the port 25 test`);
  } finally { clearTimeout(timer); }
  port25Cache = { at: Date.now(), url, value: { ok: out.ok, detail: out.detail, targets: out.targets || [] } };
  res.json({ which, ...out });
}));

app.get('/api/admin/vast/summary', requireOwner, authRoute(async (req, res) => {
  res.json(runSummary());
}));

// Polled every few seconds by the panel while an instance is active, so the
// owner can watch checks actually flowing through it in real time.
app.get('/api/admin/vast/live', requireOwner, authRoute(async (req, res) => {
  res.json({ activeInstanceId: activeInstanceId(), ...liveStats(), port25: await activePort25() });
}));

/**
 * Whether the box currently taking checks can actually open outbound port 25.
 * A rented host that blocks it still answers /api/health perfectly well, so
 * without this the panel would show a healthy instance quietly turning every
 * address into "unknown". Cached briefly: the panel polls every 2s and the
 * answer is a property of the host's network, not of the moment.
 */
let port25Cache = { at: 0, url: null, value: null };
async function activePort25() {
  const url = activeWorkerUrl();
  if (!url) return null;
  if (port25Cache.url === url && Date.now() - port25Cache.at < 30000) return port25Cache.value;
  let value = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(`${url}/api/health`, { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (r.ok) {
      const h = await r.json();
      value = { ok: h.port25 ?? null, detail: h.port25Detail || null, targets: h.port25Targets || [] };
    }
  } catch { /* a missed probe just leaves the badge as "checking" */ }
  port25Cache = { at: Date.now(), url, value };
  return value;
}

app.get('/api/admin/vast/:id', requireOwner, authRoute(async (req, res) => {
  let live;
  try { live = await getInstance(req.params.id); }
  catch (err) {
    if (!(err instanceof InstanceGoneError)) throw err;
    // The host reaped it, or it was destroyed from the vast.ai console
    // directly - either way it is not coming back, so stop tracking it.
    await endSession(req.params.id);
    await removeInstance(req.params.id);
    return res.json({ instance: null, removed: true });
  }
  const saved = await upsertInstance({
    id: req.params.id,
    state: live?.actual_status || 'unknown',
    ip: live?.public_ipaddr || null,
    port: live?.ports?.['3001/tcp']?.[0]?.HostPort || null,
    dph: live?.dph_total ?? getLocalFallbackDph(req.params.id)
  });
  // The vast.ai response itself stays on the server; `saved` already holds
  // every field the admin UI reads.
  res.json({ instance: safeInstance(saved) });
}));

app.post('/api/admin/vast/attach', requireOwner, authRoute(async (req, res) => {
  const id = String(req.body?.instanceId || '').trim();
  if (!id) throw new AuthError(400, 'Provide an instance id');
  let live;
  try { live = await getInstance(id); }
  catch (err) {
    if (err instanceof InstanceGoneError) throw new AuthError(404, `No instance #${id} found on vast.ai`);
    throw err;
  }
  const saved = await upsertInstance({
    id, manual: true, createdAt: Date.now(),
    state: live?.actual_status || 'unknown',
    ip: live?.public_ipaddr || null,
    port: live?.ports?.['3001/tcp']?.[0]?.HostPort || null,
    dph: live?.dph_total ?? null
  });
  // An instance created outside this panel was already billing before we
  // knew about it - the log cannot know when, so tracking starts from now.
  if (live?.actual_status === 'running') await startSession(id, live?.dph_total);
  res.status(201).json({ instance: safeInstance(saved) });
}));

app.post('/api/admin/vast/:id/stop', requireOwner, authRoute(async (req, res) => {
  await setInstanceState(req.params.id, 'stopped');
  await endSession(req.params.id);
  // Stopping drops the active worker: nothing is listening at that address
  // once compute pauses, so checks must fall back to OVH immediately.
  if (activeInstanceId() === req.params.id) await clearActive();
  const saved = await upsertInstance({ id: req.params.id, state: 'stopped' });
  res.json({ instance: safeInstance(saved) });
}));

app.post('/api/admin/vast/:id/start', requireOwner, authRoute(async (req, res) => {
  await setInstanceState(req.params.id, 'running');
  const local = getLocalFallbackDph(req.params.id);
  await startSession(req.params.id, local);
  const saved = await upsertInstance({ id: req.params.id, state: 'running' });
  res.json({ instance: safeInstance(saved) });
}));

app.post('/api/admin/vast/:id/activate', requireOwner, authRoute(async (req, res) => {
  let live;
  try { live = await getInstance(req.params.id); }
  catch (err) {
    if (!(err instanceof InstanceGoneError)) throw err;
    await endSession(req.params.id);
    await removeInstance(req.params.id);
    throw new AuthError(404, `Instance #${req.params.id} no longer exists on vast.ai - removed from the list`);
  }
  const ip = live?.public_ipaddr;
  const port = live?.ports?.['3001/tcp']?.[0]?.HostPort;
  if (!ip || !port) throw new AuthError(409, 'Instance has no reachable address yet. Wait for it to boot');
  const url = `http://${ip}:${port}`;
  // Same bar the automatic path applies. Activating a box whose outbound 25 is
  // blocked moves every check onto a host that cannot send, and the run turns
  // into a wall of "unknown" that looks like the addresses are at fault.
  // ?force=1 is there for deliberately activating one anyway.
  let chromium = false;
  if (req.query.force !== '1') {
    const health = await workerAnswers(url);
    const verdict = typeof health === 'string' ? health : health.verdict;
    if (verdict === 'no-port25') {
      // Useless for SMTP and still billing, so it goes the same way an
      // auto-rented blocked box does rather than sitting in the list costing
      // money. ?force=1 still activates one deliberately.
      await upsertInstance({ id: req.params.id, state: 'port25-blocked', ip, port });
      await destroyInstance(req.params.id).catch(() => {});
      await endSession(req.params.id);
      await removeInstance(req.params.id);
      await removeActiveWorker(req.params.id);
      throw new AuthError(409, 'That box cannot send mail - either outbound port 25 is blocked or its IP is refused by the providers (a blocklisted IP answers "unknown" for every address). It was destroyed to stop it billing. Rent another, or re-send with ?force=1 to use it anyway');
    }
    if (verdict !== 'ok') {
      throw new AuthError(409, 'That box is not serving the worker yet (or its port 25 test has not finished). Wait a moment and try again');
    }
    chromium = Boolean(health.chromium);
  }
  // Joins the pool rather than replacing it, so several boxes check at once -
  // the queue reads the count live and widens its slots and provider gaps to
  // match. Use Deactivate on a row to drop just that box.
  await addActiveWorker(req.params.id, url, { chromium });
  await upsertInstance({ id: req.params.id, state: 'active', ip, port, chromium });
  res.json({ activeInstanceId: activeInstanceId(), activeUrl: url, pool: activeWorkerCount() });
}));

// Drop ONE box from the pool, leaving the rest serving. The instance keeps
// running until it is explicitly destroyed.
app.post('/api/admin/vast/:id/deactivate', requireOwner, authRoute(async (req, res) => {
  await removeActiveWorker(req.params.id);
  await upsertInstance({ id: req.params.id, state: 'running' });
  res.json({ ok: true, pool: activeWorkerCount() });
}));

app.post('/api/admin/vast/deactivate', requireOwner, authRoute(async (req, res) => {
  // Switches checks back to the OVH worker. The instance itself keeps
  // running until it is explicitly destroyed - deactivating is reversible.
  await clearActive();
  res.json({ ok: true });
}));

app.delete('/api/admin/vast/:id', requireOwner, authRoute(async (req, res) => {
  await destroyInstance(req.params.id).catch(() => {}); // already gone is fine
  await endSession(req.params.id);
  await removeInstance(req.params.id);
  res.json({ ok: true });
}));

function getLocalFallbackDph(id) {
  return listInstances().find(i => i.id === id)?.dph ?? null;
}

// ---- API ---------------------------------------------------------------

app.post('/api/validate', requireUser, rateLimit(1), async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Provide an "email" string' });
  }
  if (email.length > 320) {
    return res.status(400).json({ error: 'Address is too long' });
  }
  try {
    await auth.charge(req.user, 1);
  } catch (err) {
    return res.status(err.status || 402).json({ error: err.message, credits: auth.creditsOf(req.user) });
  }
  try {
    const result = await validateEmail(email, deps);
    // A single check is counted only once it stands. Counting it first and
    // letting the refund undo it meant the refund subtracted an earlier
    // check instead, and at a total of zero it subtracted nothing at all.
    if (result.meta?.smtp?.workerError) await auth.refund(req.user, 1, { countedCheck: false });
    else auth.track(req.user, { checks: 1 });
    // Only the browser-facing shape leaves the server: see lib/present.js.
    res.json(presentResult(result));
  } catch (err) {
    console.error('validate failed:', err);
    await auth.refund(req.user, 1, { countedCheck: false }).catch(() => {});
    res.status(500).json({ error: 'Validation failed' });
  }
});

// Bulk is queued, not synchronous: a large list takes minutes and no proxy
// will hold a socket open that long. Returns a job id to poll.
const queue = new JobQueue((email) => validateEmail(email, deps), {
  save: (job) => auth.saveBulk(job),
  // Throttle by the mail farm behind the domain, not the domain itself, so
  // the Yahoo-family domains share one budget instead of four.
  groupOf: async (domain) => {
    const dns = await lookupDomain(domain);
    return infraKey(dns.mx.map(m => m.exchange), domain);
  },
  // Rents burst capacity once enough addresses are waiting, and gives it back
  // when they are done. Never blocks the run: OVH checks throughout.
  onDepth: notePending,
  // How many rented boxes are carrying checks. The queue scales both its slot
  // budget and its per-provider spacing by this, because each box is a separate
  // IP with its own rate budget - read live, so a box that comes up mid-run
  // speeds that run up and one that dies slows it back down.
  remoteActive: () => activeWorkerCount(),
  // Yahoo and friends are checked by a browser, not SMTP, so they spread over a
  // different set of IPs: the OVH VPS (always) plus any rented box whose
  // boot-time browser install actually worked.
  browserHosts: () => yahooHostCount()
});
// Order matters: reclaim any instance rented before a restart first, then
// restore jobs. A restored job over the threshold cancels the idle teardown,
// so a run that survived the restart keeps the capacity it was already using.
await resumeAuto();
for (const job of await auth.bulkJobs()) queue.create(job.emails, job);

app.post('/api/validate/bulk', requireUser, rateLimit(5), async (req, res) => {
  const list = req.body?.emails;
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'Provide an "emails" array' });
  }
  if (list.length > BULK_LIMIT) {
    return res.status(400).json({
      error: `Maximum ${BULK_LIMIT} addresses per batch`,
      received: list.length
    });
  }

  const clean = list
    .filter(e => typeof e === 'string' && e.trim() && e.length <= 320)
    .map(e => e.trim());

  if (!clean.length) return res.status(400).json({ error: 'No usable addresses' });

  let saved;
  try {
    saved = await auth.reserveBulk(req.user, clean);
  } catch (err) {
    return res.status(err.status || 402).json({ error: err.message, credits: auth.creditsOf(req.user) });
  }

  const job = queue.create(clean, saved);
  auth.track(req.user, { checks: clean.length });
  res.status(202).json(queue.view(job));
});

// Jobs outlive the browser tab that started them: a 50k list runs for hours
// and the id lives only in that tab. Without this the work continues and the
// user can never reach it again.
app.get('/api/jobs', requireUser, (req, res) => {
  res.json({ jobs: queue.listFor(req.user.id), bulkLimit: BULK_LIMIT });
});

// Clearing the list is memory-and-disk only: results already downloaded or
// saved in the browser are untouched, and running work is never dropped.
app.delete('/api/jobs', requireUser, authRoute(async (req, res) => {
  const gone = queue.forget(req.user.id);
  await auth.forgetBulk(req.user.id);
  res.json({ removed: gone.length });
}));

// Stops a running job and hands back the addresses it never got to.
// reserveBulk charges the whole batch upfront, so without the refund a
// cancelled 2,000-address run would bill for all 2,000 after checking 300.
app.post('/api/jobs/:id/cancel', requireUser, authRoute(async (req, res) => {
  const job = queue.get(req.params.id);
  if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found' });
  const cancelled = queue.cancel(req.params.id);
  if (!cancelled) return res.status(409).json({ error: 'That job has already finished' });

  // The stop itself is immediate - workers stop taking addresses the moment
  // the flag is set. Settling the refund is NOT immediate: it has to wait for
  // the probes already open to land, and an SMTP probe can take 30 seconds.
  // Awaiting that here made the button appear frozen for half a minute, so
  // the exact refund is settled in the background and the click returns now.
  queue.unchecked(req.params.id)
    .then(n => (n > 0 ? auth.refund(req.user, n) : null))
    .catch(err => console.error('cancel refund failed:', err));

  // An upper bound, not the final figure: the probes still in flight will each
  // produce a result the user keeps, so the real refund is this or slightly
  // less. The browser refreshes its balance once the background refund lands.
  const atMost = Math.max(0, cancelled.total - cancelled.done);
  res.json({ cancelled: true, refunding: atMost, done: cancelled.done, total: cancelled.total });
}));

app.delete('/api/jobs/:id', requireUser, authRoute(async (req, res) => {
  const job = queue.get(req.params.id);
  if (job && job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found' });
  const gone = queue.forget(req.user.id, req.params.id);
  await auth.forgetBulk(req.user.id, req.params.id);
  res.json({ removed: gone.length });
}));

app.get('/api/jobs/:id', requireUser, (req, res) => {
  const job = queue.get(req.params.id);
  // Only the user who started a job can read it.
  if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(queue.view(job, Math.max(0, parseInt(req.query.since, 10) || 0)));
});

// Anonymous callers get a liveness answer and nothing else: the full body
// names the verification worker's address and the size of every internal
// cache, which is operator information, not public information.
app.get('/api/health', (req, res) => {
  if (!req.user || !auth.isOwner(req.user)) return res.json({ status: 'ok' });
  res.json({
    status: 'ok',
    smtpChecks: smtpEnabled() || workerEnabled(),
    smtpWorker: workerEnabled() ? workerUrl() : null,
    disposableDomains: disposable.size,
    disposableSource: disposable.source,
    disposableUpdatedAt: disposable.updatedAt,
    dnsCacheEntries: dnsCacheSize(),
    greylistPending: greylistPendingSize(),
    greylistResolved: greylistResolvedSize(),
    knownTlds: tldCount(),
    tldSource: tldSource(),
    activeJobs: queue.size,
    uptimeSeconds: Math.round(process.uptime())
  });
});

// An unknown /api/* path must answer in JSON. Falling through to the static
// handler returned an HTML error page, which breaks any API client.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown endpoint', path: req.originalUrl });
});

// ---- Pages ---------------------------------------------------------------
// Static assets are cached for an hour in production. A deploy that changes
// index.html and app.js together would otherwise pair the new markup with a
// stale script until that hour expired, which broke navigation. Stamping the
// asset URLs with a per-build token makes a changed file a different URL.
const ASSET_V = await (async () => {
  const names = ['app.js', 'analytics.js', 'data.js', 'users.js', 'vast.js', 'login.js', 'style.css', 'login.css'];
  let newest = 0;
  for (const n of names) {
    try { newest = Math.max(newest, (await stat(join(__dirname, 'public', n))).mtimeMs); }
    catch { /* a file that is not there cannot go stale */ }
  }
  return String(Math.round(newest));
})();

// The shells are small and read on nearly every request, so stamp them once at
// boot rather than re-reading and re-writing the HTML per request.
const shell = new Map();
const loadShell = async (name) => {
  const html = (await readFile(join(__dirname, 'public', name), 'utf8'))
    .replace(/(src|href)="(\/[^"?]+\.(?:js|css))"/g, `$1="$2?v=${ASSET_V}"`);
  shell.set(name, html);
  return html;
};
await loadShell('index.html');
await loadShell('login.html');
const sendShell = (res, name) =>
  res.type('html').send(shell.get(name));

// The app itself needs a session; the login page is the only public page.
// Each view is its own URL (/verify, /users, ...). The client router reads the
// path, so every one of them has to serve the same shell; a deep link or a
// refresh would otherwise 404 on the static handler.
const VIEWS = ['dashboard', 'verify', 'running', 'upload', 'analysis', 'data', 'users', 'ip-server'];
app.get(['/', '/index.html', ...VIEWS.map(v => `/${v}`)], (req, res) => {
  if (!req.user) return res.redirect(302, '/login');
  sendShell(res, 'index.html');
});
app.get(['/login', '/login.html'], (req, res) => {
  if (req.user) return res.redirect(302, '/');
  sendShell(res, 'login.html');
});

// ---- Static frontend ----------------------------------------------------
app.use(express.static(join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

// ---- Errors -------------------------------------------------------------
// Express hands body-parser failures (malformed JSON, oversized payload) here.
app.use((err, req, res, _next) => {
  const apiRoute = req.path.startsWith('/api');
  if (err?.type === 'entity.too.large') {
    // Says what to do about it: the usual cause is one very large paste, and
    // splitting it is the fix, not retrying the same body.
    const msg = `Request body is too large. Send fewer addresses per batch (the limit is ${BULK_LIMIT.toLocaleString()}) or split the list in two`;
    return apiRoute ? res.status(413).json({ error: msg }) : res.status(413).send(msg);
  }
  if (err instanceof SyntaxError && 'body' in err) {
    const msg = 'Malformed JSON body';
    return apiRoute ? res.status(400).json({ error: msg }) : res.status(400).send(msg);
  }
  console.error('unhandled error:', err);
  return apiRoute
    ? res.status(500).json({ error: 'Internal error' })
    : res.status(500).send('Internal error');
});

const server = app.listen(PORT, () => {
  console.log(`\n  3S Email Validator running at http://localhost:${PORT}`);
  console.log(`  Disposable domains: ${disposable.size} (${disposable.source})`);
  console.log(`  Known TLDs:         ${tldCount()} (${tldSource()})`);
  console.log(`  SMTP deep checks:   ${smtpEnabled() ? 'ON' : 'off (set SMTP_CHECK=true)'}`);
  // The only thing that can confirm a Microsoft mailbox, and it needs no port
  // 25 - so when it is off, that is worth seeing next to the SMTP line.
  console.log(`  MS directory:       ${msOracleEnabled() ? 'ON' : 'off (set MS_ORACLE=true)'}`);

  // The sending identity decides whether the big providers will talk to us at
  // all, and a bad one fails silently - every Yahoo-family address just comes
  // back unverifiable. Say so at boot instead of letting it look like a bug.
  if (smtpEnabled() || workerEnabled()) {
    console.log(`  SMTP HELO:          ${heloHost()}`);
    if (heloIsPlaceholder()) {
      console.log('');
      console.log('  ⚠  SMTP_HELO is a placeholder.');
      console.log('     Yahoo, AOL, AT&T and Verizon reject probes whose HELO name does not');
      console.log('     match a PTR record on the sending IP (550 5.7.25), so every address');
      console.log('     on those providers will come back "unknown".');
      console.log('     Fix: set SMTP_HELO to a hostname you own, give it an A record, and');
      console.log('     set a PTR on the sending IP pointing back at that same name.');
    }
  }
  console.log('');
});

// ---- Last-resort error handling -----------------------------------------
// Without these, node's default for an unhandled rejection is to kill the
// process, and the only trace is whatever the host happened to capture - a
// server that "just disappears" with no reason recorded. A rejection escaping
// one request (an aborted fetch to a worker, a DNS blip mid-probe) is not a
// reason to drop every other run in flight, so it is logged loudly and the
// process keeps serving.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection] server kept running:', err.stack || err.message);
});

// An uncaught exception is different: the stack that threw is gone and state
// may be half-written, so this records WHY and leaves, letting the supervisor
// restart a clean process. Bulk progress is on disk, so a restart resumes.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] exiting for a clean restart:', err?.stack || err);
  process.exit(1);
});

// ---- Graceful shutdown --------------------------------------------------
// systemd sends SIGTERM on restart. Without this, in-flight checks and any
// running bulk job are killed mid-request.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1); // second signal: stop waiting
    shuttingDown = true;
    console.log(`\n  ${signal} received, finishing in-flight requests…`);

    server.close(async () => {
      await queue.drain();
      await auth.flush();
      console.log('  closed cleanly');
      process.exit(0);
    });

    // Do not hang forever on a slow SMTP probe.
    setTimeout(() => {
      console.log('  shutdown timed out, exiting');
      process.exit(1);
    }, 10000).unref();
  });
}
