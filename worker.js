/**
 * SMTP verification worker - runs on a VPS with outbound port 25 open.
 *
 * This is the only half of the app that needs port 25. It serves one route,
 * has no accounts, no UI and no database; the web app on Railway calls it over
 * HTTPS with a shared key. Run it behind a reverse proxy with TLS, and keep
 * SMTP_WORKER_KEY identical on both sides.
 *
 *   SMTP_CHECK=true SMTP_WORKER_KEY=... SMTP_HELO=mail.yourdomain.com \
 *     npm run worker
 */
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { createConnection } from 'node:net';

import { verifyMailbox, catchAllCacheSize } from './lib/smtp.js';
import { greylistPendingSize, greylistResolvedSize } from './lib/greylist.js';
import { yahooMailbox } from './lib/yahoo-oracle.js';

const PORT = process.env.WORKER_PORT || process.env.PORT || 3001;
const KEY = process.env.SMTP_WORKER_KEY || '';
// SMTP probes hold a TCP connection for seconds, so cap them rather than
// letting a bulk run open thousands of sockets and get the IP blocklisted.
// Must not sit UNDER the app's per-box slot budget (VAST_CONCURRENCY, 25) or
// the box starts answering 503 while the app still has slots free, and a
// rejected probe reads as "unknown" for an address the user paid for.
const MAX_CONCURRENT = Number(process.env.WORKER_CONCURRENCY || 32);

if (!KEY) {
  console.error('SMTP_WORKER_KEY is required - refusing to start an open relay of probes');
  process.exit(1);
}
if (String(process.env.SMTP_CHECK || '').toLowerCase() !== 'true') {
  console.error('SMTP_CHECK must be "true" on the worker, or every probe is skipped');
  process.exit(1);
}

/** Constant-time compare so the key cannot be guessed a byte at a time. */
function keyMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

let inFlight = 0;

/**
 * Can this box actually open outbound connections on port 25?
 *
 * Plenty of hosts (and most rented GPU boxes) silently block outbound 25, and
 * nothing else here can tell the difference between "blocked" and "every
 * mailbox happens to be unreachable" - the probes all just come back unknown.
 *
 * One target is not enough to answer it: a provider can refuse this IP (421,
 * blocklist) while egress itself is fine, and a single host can be down. So
 * dial the big mail providers and report each one, letting the panel show
 * which are reachable and which are not.
 *
 * Cached: the answer is a property of the host's network, not of the moment.
 */
const PORT25_TARGETS = (process.env.PORT25_TEST_HOSTS || [
  'Gmail:gmail-smtp-in.l.google.com',
  'Outlook:outlook-com.olc.protection.outlook.com',
  'Yahoo:mta5.am0.yahoodns.net',
  'iCloud:mx01.mail.icloud.com',
  'Zoho:mx.zoho.com',
  'Mail.ru:mxs.mail.ru'
].join(',')).split(',').map(entry => {
  const [name, host] = entry.includes(':') ? entry.split(':') : [entry, entry];
  return { name: name.trim(), host: (host || name).trim() };
}).filter(t => t.host);

// The same identity the real probes use, so the qualification test measures
// how providers treat THIS box as it will actually appear to them.
const HELO = process.env.SMTP_HELO || 'localhost';
const PROBE_SENDER = process.env.SMTP_MAIL_FROM || `postmaster@${HELO}`;

let port25 = { ok: null, detail: 'not tested yet', at: null, targets: [] };

/** Matches a refusal that is about THIS IP rather than about a mailbox. */
const BLOCKLISTED = /spamhaus|spamcop|barracudacentral|sorbs|dnsbl|rbl\b|blocklist|blacklist|blocked using|poor reputation|not allowed to send|reverse\s*dns|rdns|fcrdns|ptr\s*record/i;

/**
 * One provider, carried as far as MAIL FROM.
 *
 * Stopping at the greeting is what made a Spamhaus-listed box look healthy:
 * the connection opens and the 220 arrives normally, and the refusal only
 * comes several commands later, at MAIL FROM. A box qualified on the greeting
 * alone joined the pool and returned "unknown" for every address at that
 * provider - the port was open, the IP just was not welcome.
 *
 * Resolves to {name, host, ok, accepted, blocked, detail} - never rejects.
 * `ok` still means outbound 25 works at all; `accepted` is the new question:
 * will this provider take mail from this IP.
 */
function dialOne({ name, host }, timeout) {
  return new Promise(resolve => {
    const started = Date.now();
    const sock = createConnection({ host, port: 25 });
    let stage = 'greeting';
    let greeting = '';
    const done = (ok, detail, extra = {}) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve({ name, host, ok, detail, ms: Date.now() - started, ...extra });
    };
    sock.setTimeout(timeout);
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      const line = chunk.trim().split(/\r?\n/).pop().slice(0, 200);
      const code = /^([2-5]\d\d)/.exec(line);
      if (!code) return done(false, line ? `unexpected reply: ${line}` : 'no greeting');

      if (stage === 'greeting') {
        greeting = line;
        // A greeting that is not 220 is already a refusal of this IP.
        if (code[1] !== '220') {
          return done(true, `reachable, refused this IP: ${line}`,
            { accepted: false, blocked: BLOCKLISTED.test(line) });
        }
        stage = 'ehlo';
        return sock.write(`EHLO ${HELO}\r\n`);
      }

      if (stage === 'ehlo') {
        if (code[1] !== '250') {
          return done(true, `reachable, EHLO refused: ${line}`,
            { accepted: false, blocked: BLOCKLISTED.test(line) });
        }
        stage = 'mailfrom';
        return sock.write(`MAIL FROM:<${PROBE_SENDER}>\r\n`);
      }

      // The answer that matters: a listed IP is rejected here, not earlier.
      sock.write('QUIT\r\n');
      if (code[1] === '250') return done(true, greeting, { accepted: true, blocked: false });
      return done(true, `reachable, refused this IP: ${line}`,
        { accepted: false, blocked: BLOCKLISTED.test(line) });
    });
    sock.once('timeout', () => done(false, `no reply within ${timeout}ms at ${stage}`));
    sock.once('error', err => done(false, err.code || err.message));
  });
}

// How many providers must actually accept mail from this IP for the box to be
// worth renting. A box the big providers refuse answers "unknown" for every
// address they own, which is most of a real list.
const MIN_ACCEPTING = Number(process.env.PORT25_MIN_ACCEPTING || 1);

async function testPort25({ timeout = 10000 } = {}) {
  const targets = await Promise.all(PORT25_TARGETS.map(t => dialOne(t, timeout)));
  const reachable = targets.filter(t => t.ok).length;
  const accepting = targets.filter(t => t.accepted).length;
  const blocked = targets.filter(t => t.blocked);

  // Reachability alone used to pass the box. It is not the question: a
  // Spamhaus-listed IP greets normally at every provider and is refused at
  // MAIL FROM, so a box that "reached 6/6" could still verify nothing. The
  // box is usable only if somebody will actually take mail from it.
  const usable = reachable > 0 && accepting >= MIN_ACCEPTING;
  let detail;
  if (!reachable) {
    detail = 'no provider answered on port 25 - outbound 25 is blocked on this host';
  } else if (!accepting) {
    const names = blocked.map(t => t.name).join(', ');
    detail = blocked.length
      ? `reachable, but every provider refuses this IP (${names}) - it is on a blocklist, so checks would all be unknown`
      : `reachable, but no provider accepted mail from this IP - checks would all be unknown`;
  } else {
    detail = `${accepting}/${targets.length} providers accept mail from this IP`
      + (blocked.length ? ` · refused by ${blocked.map(t => t.name).join(', ')}` : '');
  }

  port25 = { ok: usable, reachable, accepting, detail, at: Date.now(), targets };
  return port25;
}

/**
 * Is a real browser usable on this box?
 *
 * The Yahoo family (yahoo/aol/att/verizon) cannot be settled over SMTP - its
 * farm accepts mail for addresses that do not exist - so it is checked by
 * driving Chromium through lib/yahoo-oracle.js instead. A rented box only has
 * that browser if its boot script managed to download it, which is allowed to
 * fail without taking the SMTP half of the box down with it.
 *
 * So the box must SAY whether it has one, exactly as it does for port 25.
 * Without this the app cannot tell a Yahoo-capable box from one that would
 * turn every Yahoo address into "unknown", and the only safe thing it could do
 * is keep sending all of Yahoo to the one host it knows has a browser.
 *
 * Launching a browser is the only honest test: the package being installed
 * says nothing about whether its Chromium binary and system libraries are
 * actually there.
 */
let chromium = null;   // null = not tested yet

async function testChromium() {
  // Launching is necessary but nowhere near sufficient. A box can start
  // Chromium and still fail every real probe - missing fonts or system
  // libraries, no shared memory, or Yahoo simply refusing a fresh datacenter
  // IP. Measured on a rented box: chromium launched fine and 100% of Yahoo
  // probes came back "unknown". So the test is a REAL probe of an address that
  // certainly does not exist: Yahoo must actively say "no such account".
  //
  // Anything else - an exception, a timeout, or an "unknown" that means Yahoo
  // would not talk to this IP - is a failed test, because routing Yahoo here
  // would turn a quarter of a typical list into unanswered addresses.
  const canary = `zz${Math.random().toString(36).slice(2, 10)}nx7q@yahoo.com`;
  try {
    const { chromium: engine } = await import('patchright');
    const browser = await engine.launch({ headless: true });
    await browser.close();
  } catch (err) {
    chromium = { ok: false, detail: `Chromium will not launch: ${err.message.split('\n')[0]}`, at: Date.now() };
    return chromium;
  }
  try {
    const answer = await yahooMailbox(canary, ['mta5.am0.yahoodns.net']);
    const ok = answer?.status === 'no-mailbox';
    chromium = {
      ok,
      detail: ok
        ? 'Yahoo answers this IP (canary correctly reported as no such account)'
        : `Yahoo will not answer this IP: canary came back "${answer?.status || 'nothing'}"`,
      at: Date.now()
    };
  } catch (err) {
    chromium = { ok: false, detail: `Yahoo probe failed: ${err.message.split('\n')[0]}`, at: Date.now() };
  }
  return chromium;
}

app.post('/api/worker/verify', async (req, res) => {
  if (!keyMatches(req.get('x-worker-key'))) {
    return res.status(401).json({ error: 'Bad worker key' });
  }

  const { email, mxHosts } = req.body || {};
  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'Provide an "email" string' });
  }
  if (!Array.isArray(mxHosts) || !mxHosts.length
      || !mxHosts.every(h => typeof h === 'string' && h.length <= 255)) {
    return res.status(400).json({ error: 'Provide a non-empty "mxHosts" array of hostnames' });
  }

  if (inFlight >= MAX_CONCURRENT) {
    res.set('Retry-After', '5');
    return res.status(503).json({ error: 'Worker at capacity' });
  }

  inFlight++;
  try {
    // Connection options stay server-side: the caller must not be able to set
    // the port, the HELO name or the canary count.
    res.json(await verifyMailbox(email, mxHosts.slice(0, 5)));
  } catch (err) {
    console.error('worker verify failed:', err);
    res.status(500).json({ status: 'unknown', detail: 'Worker failed to complete the probe' });
  } finally {
    inFlight--;
  }
});

// The Yahoo/AOL browser probe, run here because this box has Chrome and a clean
// IP. Returns null (as 204) for non-Yahoo domains, same as the local oracle.
app.post('/api/worker/yahoo', async (req, res) => {
  if (!keyMatches(req.get('x-worker-key'))) {
    return res.status(401).json({ error: 'Bad worker key' });
  }
  const { email, mxHosts } = req.body || {};
  if (typeof email !== 'string' || !email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'Provide an "email" string' });
  }
  // Refuse rather than mislead: a box with no browser would return "could not
  // determine" for every address, which the app would bank as a real answer.
  // Until testChromium() confirms the browser (chromium === null during that
  // first launch + canary probe), treat the box as unproven and refuse too.
  if (!chromium?.ok) {
    return res.status(503).json({
      status: 'unknown',
      reason: chromium?.detail || 'Browser check has not finished yet',
    });
  }
  const hosts = Array.isArray(mxHosts) ? mxHosts.slice(0, 5) : [];
  try {
    const answer = await yahooMailbox(email, hosts);
    if (!answer) return res.status(204).end();
    res.json(answer);
  } catch (err) {
    console.error('worker yahoo failed:', err);
    res.status(500).json({ status: 'unknown', reason: 'Worker failed to complete the Yahoo probe' });
  }
});

/**
 * Re-run the outbound port 25 test on demand.
 *
 * /api/health reports the cached answer from startup, which is the right thing
 * for routing decisions - the result is a property of the host's network, not
 * of the moment. But the panel's "Test port 25" button exists precisely to ask
 * again now, after a provider blocklisting has been cleared or an IP has been
 * changed, so this one measures fresh rather than reading the cache.
 */
app.get('/api/worker/port25', async (req, res) => {
  if (!keyMatches(req.get('x-worker-key'))) {
    return res.status(401).json({ error: 'Bad worker key' });
  }
  try {
    res.json(await testPort25());
  } catch (err) {
    console.error('worker port25 test failed:', err);
    res.status(500).json({ ok: false, detail: 'Worker failed to run the port 25 test', targets: [] });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    role: 'smtp-worker',
    inFlight,
    maxConcurrent: MAX_CONCURRENT,
    // Both capabilities the app routes on. null means "still testing" - the
    // app waits rather than assuming either way.
    port25: port25 ? port25.ok : null,
    port25Detail: port25?.detail || null,
    port25Targets: port25?.targets || null,
    chromium: chromium ? chromium.ok : null,
    chromiumDetail: chromium?.detail || null,
    catchAllCacheEntries: catchAllCacheSize(),
    greylistPending: greylistPendingSize(),
    greylistResolved: greylistResolvedSize(),
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.use((req, res) => res.status(404).json({ error: 'Unknown endpoint', path: req.originalUrl }));

const server = app.listen(PORT, () => {
  console.log(`\n  SMTP worker listening on port ${PORT}`);
  console.log(`  HELO name: ${process.env.SMTP_HELO || 'localhost'}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

// Test both capabilities once at startup so the first health poll already has
// the answers, and the app never has to guess what this box can do.
// The browser install runs in the background on a rented box (lib/vast.js), so
// it usually is NOT finished when the worker starts listening. One test at
// startup would therefore record "no browser" permanently and the box would
// never take a single Yahoo address, even once Chrome had landed minutes
// later. So keep testing until it works, then stop.
const BROWSER_RETEST_MS = Number(process.env.BROWSER_RETEST_MS || 60000);
const BROWSER_RETEST_FOR_MS = Number(process.env.BROWSER_RETEST_FOR_MS || 25 * 60 * 1000);

(async () => {
  const deadline = Date.now() + BROWSER_RETEST_FOR_MS;
  let first = true;
  while (Date.now() < deadline) {
    const r = await testChromium();
    if (r.ok) {
      console.log(`  browser (Yahoo/AOL): READY - ${r.detail}`);
      return;
    }
    if (first) {
      console.log(`  browser (Yahoo/AOL): not yet - ${r.detail}`);
      console.log('  (still installing in the background; SMTP is already serving)');
      first = false;
    }
    await new Promise(r => setTimeout(r, BROWSER_RETEST_MS));
  }
  console.log(`  browser (Yahoo/AOL): UNAVAILABLE after ${Math.round(BROWSER_RETEST_FOR_MS / 60000)}m - this box stays SMTP-only`);
})();
testPort25().then(r => {
  console.log(`\n  outbound port 25: ${r.ok ? 'OPEN' : 'BLOCKED'} - ${r.detail}`);
  for (const t of r.targets) console.log(`    ${t.ok ? 'pass' : 'FAIL'}  ${t.name.padEnd(9)} ${t.detail}`);
});
