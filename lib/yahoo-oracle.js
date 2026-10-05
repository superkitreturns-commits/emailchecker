/**
 * Yahoo / AOL mailbox existence, asked outside SMTP.
 *
 * Yahoo-family mail servers (yahoo.com, aol.com, att.net, verizon.net,
 * sbcglobal.net, ymail.com, rocketmail.com and more - see lib/providers.js)
 * accept RCPT TO for addresses that do not exist and bounce afterwards, so
 * a 250 from them is not evidence the mailbox is real. The whole farm is
 * marked 'unreliable' and no SMTP answer is called a verdict.
 *
 * Yahoo answers the same question on a different channel. The sign-in page
 * decides whether to show the password prompt or an error ("Sorry, we don't
 * recognize this email") based on whether the account exists, so driving that
 * page with a headless browser gives a yes/no that the SMTP farm will not.
 * No mail is sent and no mailbox is touched: it is the same request a browser
 * makes when somebody types their address into the sign-in box.
 *
 * Works with no outbound port 25 at all, since it is HTTPS.
 *
 * Driven through patchright rather than vanilla Playwright: Yahoo's sign-in
 * page runs active bot detection (Arkose / reCAPTCHA v3) that trips on the
 * stock Playwright fingerprint - Runtime.enable leaks, HeadlessChrome in the
 * UA, cdc_ globals, and a navigator.webdriver that only fakes undefined on the
 * surface. patchright is an API-compatible fork that patches all of those at
 * the browser level, so the same code survives far more lookups before Yahoo
 * forces a CAPTCHA.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TTLCache } from './cache.js';
import { infraKey } from './providers.js';

const TIMEOUT = Number(process.env.YAHOO_ORACLE_TIMEOUT || 25000);

/**
 * Login endpoints answer with the same backing directory, so pacing is global
 * rather than per-domain: 400 Yahoo-family addresses are still 400 requests at
 * two hosts, and a throttled request answers nothing at all.
 */
const GAP_MS = Number(process.env.YAHOO_ORACLE_GAP_MS || 1500);

/** How many emails to run through one browser context before rotating cookies. */
const BATCH = Number(process.env.YAHOO_ORACLE_BATCH || 15);

/** Retries on a transient failure (network blip, selector miss). */
const RETRIES = Number(process.env.YAHOO_ORACLE_RETRIES || 1);

/**
 * How many probes run in parallel inside the shared browser context. 3 is the
 * sweet spot for a single IP: Yahoo rate-limits per IP, not per connection, so
 * more than 5 workers tends to trip CAPTCHA faster than it speeds anything up.
 * Behind a rotating proxy you can safely raise this to 5-8.
 */
const WORKERS = Math.max(1, Number(process.env.YAHOO_ORACLE_WORKERS || 3));

/**
 * patchright's own guidance for maximum stealth:
 *   - channel: 'chrome'                  (real Chrome, not bundled Chromium)
 *   - launchPersistentContext            (several patches only apply there)
 *   - no custom args / UA / viewport     (each is a fingerprint signal)
 *   - headless: false + Xvfb             (headless chrome is still detectable)
 *
 * `channel: 'chrome'` needs Chrome stable installed on the host; set
 * YAHOO_ORACLE_CHANNEL='chromium' to fall back to the bundled browser.
 */
const CHANNEL = process.env.YAHOO_ORACLE_CHANNEL || 'chrome';
const HEADLESS = String(process.env.YAHOO_ORACLE_HEADLESS ?? 'true').toLowerCase() !== 'false';

export const yahooOracleEnabled = () =>
  String(process.env.YAHOO_ORACLE ?? 'true').toLowerCase() !== 'false';

/** Verdicts per address. Directory membership changes rarely. */
const addressCache = new TTLCache({ ttl: 6 * 60 * 60 * 1000, max: 20000 });

// ---- request pacing ----------------------------------------------------
let chain = Promise.resolve();
let lastAt = 0;

function turn() {
  chain = chain.then(async () => {
    const wait = GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
  });
  return chain;
}

// ---- browser + per-worker contexts (lazy) -------------------------------
// patchright is loaded on first use so hosts that do not want this feature
// never pay the dependency's startup cost. Each worker owns its OWN persistent
// context + user_data_dir, so cookies / local storage / session state are
// strictly isolated between workers. One shared context would let the first
// probe's "signed in" cookies poison the canary probe that follows, which is
// exactly what makes Yahoo show a different page and come back 'unknown'.
let workersInit = null;    // Promise so concurrent callers share one init

/** Worker pool: one entry per concurrent probe. */
let workers = null;        // Array<{ context, page, used, userDataDir }>
const idleQueue = [];      // Array<number> of worker indices ready to use
const waitQueue = [];      // Array<(i:number)=>void> callers waiting for a worker

async function newWorker() {
  const { chromium } = await import('patchright');
  const userDataDir = mkdtempSync(join(tmpdir(), 'patchright-yahoo-'));

  // Deliberately minimal options. Everything patchright documents as a
  // fingerprint risk is OMITTED: no args[], no userAgent, no viewport{} with
  // dimensions, no devices[] preset, no addInitScript faking navigator - each
  // one re-introduces the exact leaks patchright patches at the browser level.
  // Real Chrome is the preferred channel, but a host that only managed to
  // install the bundled Chromium should still be able to run the probe rather
  // than failing every address: a rented box installs both, and either one
  // going missing used to throw "browser not found" for the whole run.
  const launch = (channel) => chromium.launchPersistentContext(userDataDir, {
    channel,
    headless: HEADLESS,
    viewport: null,              // let the window pick its own real size
    locale: 'en-US',
    ignoreHTTPSErrors: true,
    proxy: process.env.PROXY_SERVER
      ? {
          server: process.env.PROXY_SERVER,
          username: process.env.PROXY_USER,
          password: process.env.PROXY_PASS
        }
      : undefined
  });

  let context;
  try {
    context = await launch(CHANNEL);
  } catch (err) {
    if (CHANNEL === 'chrome') {
      console.warn(`[yahoo-oracle] Chrome unavailable (${err.message.split('\n')[0]}) - falling back to bundled Chromium`);
      context = await launch('chromium');
    } else {
      throw err;
    }
  }

  // Images, fonts and stylesheets are wasted bytes for a form submit.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(type)) return route.abort();
    route.continue();
  });

  // launchPersistentContext opens Chrome with a default about:blank tab; reuse
  // it instead of opening a second one, so each worker is always 1 tab, not 2.
  const page = context.pages()[0] || await context.newPage();
  return { context, page, used: 0, userDataDir };
}

async function initWorkers() {
  if (workers) return;
  if (workersInit) return workersInit;
  workersInit = (async () => {
    const list = [];
    for (let i = 0; i < WORKERS; i++) list.push(await newWorker());
    workers = list;
    for (let i = 0; i < WORKERS; i++) idleQueue.push(i);
  })();
  return workersInit;
}

/** Grab the next idle worker, or wait until one is released. */
async function acquire() {
  if (!workers) await initWorkers();
  if (idleQueue.length) return idleQueue.shift();
  return new Promise(resolve => waitQueue.push(resolve));
}

/**
 * Return a worker to the pool. Clears its own context's cookies and rotates
 * its page every BATCH probes so one check's state never leaks into the next.
 * Because each worker owns a SEPARATE context, clearing cookies here does not
 * touch other workers that may be mid-probe.
 */
async function release(i, { rotate = false } = {}) {
  const w = workers[i];
  w.used++;
  // Always clear cookies between probes within one worker - this is the fix
  // for the canary coming back 'unknown' because the first probe left Yahoo
  // "mid-sign-in" cookies behind.
  await w.context.clearCookies().catch(() => {});
  if (rotate || w.used >= BATCH) {
    await w.page.close().catch(() => {});
    w.page = await w.context.newPage();
    w.used = 0;
  }
  if (waitQueue.length) waitQueue.shift()(i);
  else idleQueue.push(i);
}

const AOL_DOMAINS = new Set([
  'aol.com', 'aim.com', 'love.com', 'games.com', 'wow.com', 'verizon.net'
]);

function loginUrlFor(domain) {
  return AOL_DOMAINS.has(domain) ? 'https://login.aol.com/' : 'https://login.yahoo.com/';
}

/**
 * Drive the sign-in page and read whether the account was recognised.
 * The page is owned by the caller - this function never acquires or releases.
 * @returns {Promise<{status:'exists'|'no-mailbox'|'unknown', reason:string}>}
 */
/**
 * Only the password challenge proves the account exists - Yahoo sends a
 * recognised address there to ask for its password. Every other
 * /account/challenge/* page is Yahoo refusing to answer (a bot check, or an
 * error page such as challenge/fail?pcn=username&eid=4401), which says nothing
 * about the mailbox and must never read as 'exists'.
 */
const EXISTS_URL = /\/account\/challenge\/password/;
const REFUSED_URL = /\/account\/challenge\//;

async function probe(email, p) {
  const domain = (email.split('@')[1] || '').toLowerCase();
  let result = 'unknown';
  let detail = '';
  try {
    await p.goto(loginUrlFor(domain), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await p.waitForSelector('input[name="username"], #login-username', { timeout: 15000 });
    await p.fill('input[name="username"], #login-username', email);

    await Promise.all([
      Promise.race([
        p.waitForURL(EXISTS_URL, { timeout: 12000 })
          .then(() => { result = 'exists'; }),
        p.waitForSelector('#username-error', { state: 'visible', timeout: 12000 })
          .then(async (el) => {
            detail = (await el.innerText()).trim();
            if (/don'?t recognize|not recognize|no account|invalid/i.test(detail)) {
              result = 'no-mailbox';
            } else {
              result = 'unknown';
            }
          })
      ]).catch(() => {}),
      p.click('#login-signin, button[name="signin"], button[type="submit"]')
        .catch(() => p.keyboard.press('Enter'))
    ]);

    if (result === 'unknown') {
      await p.waitForTimeout(800);
      const url = p.url();
      if (EXISTS_URL.test(url)) result = 'exists';
      else if (REFUSED_URL.test(url)) detail = detail || `refused at ${url.split('?')[0]}`;
      const err = await p.$('#username-error');
      if (err && await err.isVisible()) {
        detail = (await err.innerText()).trim();
        if (/don'?t recognize|not recognize/i.test(detail)) result = 'no-mailbox';
      }
    }
    console.log(`[yahoo-probe] ${email} url=${p.url()} result=${result} detail="${detail}"`);
  } catch (err) {
    console.log(`[yahoo-probe] ${email} THREW: ${err.message.split('\n')[0]}`);
    return { status: 'unknown', reason: 'Yahoo did not answer right now. Please try again' };
  }

  if (result === 'exists') {
    return { status: 'exists', reason: 'Active Yahoo account, ready to receive mail' };
  }
  if (result === 'no-mailbox') {
    return { status: 'no-mailbox', reason: 'No Yahoo account is registered for this address' };
  }
  return { status: 'unknown', reason: 'Yahoo did not answer right now. Please try again' };
}

/**
 * Paced, retried wrapper around probe(). Acquires one worker from the pool,
 * which both bounds concurrency to WORKERS and lets long-running probes run in
 * parallel. The pacing gate (turn) still serialises probe STARTS across the
 * whole pool so Yahoo sees new tabs opened at the configured GAP_MS rhythm,
 * not WORKERS tabs opening at once.
 */
async function ask(email) {
  const i = await acquire();
  const w = workers[i];
  let last;
  try {
    let attempt = 0;
    while (attempt <= RETRIES) {
      await turn();
      last = await probe(email, w.page);
      if (last.status === 'exists' || last.status === 'no-mailbox') break;
      attempt++;
      // Rotate this worker's tab on retry so cookies / storage don't persist a
      // soft-block across the retry. Only this worker's page is replaced; the
      // other workers' sessions and the context's stealth state are untouched.
      if (attempt <= RETRIES) {
        await w.context.clearCookies().catch(() => {});
        await w.page.close().catch(() => {});
        w.page = await w.context.newPage();
        w.used = 0;
      }
    }
  } finally {
    await release(i);
  }
  return last;
}

/**
 * Mailbox existence for a Yahoo-family address.
 *
 * @returns {Promise<?{status:string, reason:string, via:string}>} null when
 *   the domain is not Yahoo-family, so the caller has no extra signal.
 */
export async function yahooMailbox(email, mxHosts = []) {
  if (!yahooOracleEnabled()) { console.log('[yahoo-oracle] disabled'); return null; }

  const addr = String(email || '').toLowerCase();
  const domain = addr.split('@')[1];
  if (!domain) return null;

  const group = infraKey(mxHosts, domain);
  console.log(`[yahoo-oracle] ${addr} mx=${mxHosts.join(',')} group=${group}`);
  if (group !== 'yahoo') return null;

  const cached = addressCache.get(addr);
  if (cached) return cached;

  const answer = await ask(addr);
  console.log(`[yahoo-oracle] ${addr} answer:`, answer);

  const out = { ...answer, via: 'login' };
  addressCache.set(addr, out);
  return out;
}

export const yahooOracleCacheSize = () => addressCache.size;

/** Test / shutdown helper: close every worker and drop state. */
export async function resetYahooOracle() {
  addressCache.store.clear();
  const list = workers || [];
  workers = null;
  workersInit = null;
  idleQueue.length = 0;
  waitQueue.length = 0;
  for (const w of list) {
    await w.context.close().catch(() => {});
    try { rmSync(w.userDataDir, { recursive: true, force: true }); } catch {}
  }
}

// Best-effort cleanup so a `kill` on the server does not leave Chrome
// instances or temp profiles behind.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    for (const w of workers || []) {
      try { rmSync(w.userDataDir, { recursive: true, force: true }); } catch {}
    }
  });
}
