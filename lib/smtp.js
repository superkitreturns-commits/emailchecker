/**
 * SMTP mailbox probe + catch-all detection.
 *
 * DISABLED BY DEFAULT. Requires outbound port 25, which free hosts block
 * (Vercel, Netlify, Railway free/hobby, Render free, Fly, AWS, GCP, Azure).
 * Enable with SMTP_CHECK=true where port 25 is open.
 *
 * Ports 587/465 CANNOT substitute: those are authenticated submission ports
 * that only talk to your own provider. Verification needs direct-to-MX on 25.
 *
 * Accuracy here rests on three rules learned from probing live servers:
 *
 *  1. Classify on the ENHANCED status code, never the 3-digit code.
 *     550 5.1.1 = no such mailbox. 550 5.7.1 = we are blocked. See smtp-codes.js.
 *
 *  2. A failure before RCPT TO tells you nothing about the mailbox, because
 *     the address was never sent. Outlook and Yahoo refuse at MAIL FROM.
 *
 *  3. Probe the real address BEFORE the catch-all canaries. Servers that
 *     clamp down after a few invalid recipients would otherwise poison the
 *     answer for the address you actually care about.
 */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { classifyReply, isRetryableBlock } from './smtp-codes.js';
import { TTLCache } from './cache.js';
import { getResolved, isPending, scheduleRetry } from './greylist.js';

/**
 * The identity we present to the remote server. Getting this wrong is the
 * single biggest cause of bad results, and it fails silently:
 *
 *   EHLO must be a hostname you own, with an A record, and the IP you connect
 *   from must have a PTR record pointing back at it. Yahoo answers a mismatch
 *   with "550 5.7.25 reverse DNS failed" at MAIL FROM - before the recipient
 *   is ever sent - so EVERY Yahoo, AOL, AT&T and Verizon address comes back
 *   unverifiable no matter how good the rest of the code is.
 *
 *   MAIL FROM:<> (the null sender) is correct per RFC but Comcast and several
 *   other cable ISPs reject it from unknown IPs. A real mailbox on the HELO
 *   domain gets through far more often, so that is the default now, derived
 *   from SMTP_HELO unless SMTP_FROM overrides it.
 */
const PLACEHOLDER_HELO = /^(localhost|example\.(com|org|net)|test|invalid|)$/i;

export function heloHost() {
  return process.env.SMTP_HELO || 'localhost';
}

/** True when SMTP_HELO is still a placeholder and will fail reverse-DNS checks. */
export const heloIsPlaceholder = () => PLACEHOLDER_HELO.test(heloHost().trim());

function defaultFrom() {
  if (process.env.SMTP_FROM !== undefined) return process.env.SMTP_FROM;
  // No usable HELO domain to build an address from: fall back to the null
  // sender rather than inventing something that fails SPF outright.
  return heloIsPlaceholder() ? '' : `postmaster@${heloHost()}`;
}

const DEFAULTS = {
  port: 25,
  timeout: 8000,
  connectTimeout: 8000,
  get fromAddress() { return defaultFrom(); },
  get heloHost() { return heloHost(); },
  canaries: Number(process.env.SMTP_CANARIES || 2),
  greylistRetries: 1,
  // Real greylisting wants 30-60s, which is far too slow to hold an HTTP
  // request open. A short retry catches soft throttling; anything still
  // deferred is reported honestly as greylisted rather than guessed at.
  greylistDelay: Number(process.env.SMTP_GREYLIST_DELAY || 5000),
  maxMx: 2
};

/** Catch-all status is a property of the domain, so cache it per domain. */
const catchAllCache = new TTLCache({ ttl: 24 * 60 * 60 * 1000, max: 20000 });

/**
 * Domains where the canaries went unanswered - the server blocked, deferred
 * or dropped us before it said anything useful about them.
 *
 * Without this, every address on such a domain re-sends its canaries, so a
 * list of 400 Yahoo addresses costs 1,200 RCPT commands instead of 400. That
 * extra load is what gets the IP throttled partway through a run, which is
 * what produced the dropped connections in the first place. Short TTL,
 * because a block often clears within the hour.
 */
const canaryBlockedCache = new TTLCache({
  ttl: Number(process.env.SMTP_CANARY_BACKOFF_MS || 30 * 60 * 1000),
  max: 20000
});

/** Read one complete SMTP reply (handles multi-line 250- continuations). */
function readReply(socket, timeout) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeout);

    function onData(chunk) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      // A final line is "250 text"; continuations are "250-text".
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        resolve({ code: parseInt(last.slice(0, 3), 10), text: buffer.trim() });
      }
    }
    function onError(err) { cleanup(); reject(err); }
    function onClose() { cleanup(); reject(new Error('connection closed')); }
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

const send = (socket, line) => socket.write(line + '\r\n');

/** Reject anything that could smuggle a second SMTP command. */
function safeAddress(addr) {
  if (/[\r\n<>]/.test(addr)) throw new Error('invalid address');
  return addr;
}

/**
 * Run one SMTP conversation against a single MX host.
 *
 * @returns {Promise<{stage:string, replies:Object, error:?string}>}
 *   stage is the last stage reached: connect | greeting | ehlo | mailfrom | rcpt
 */
async function converse(mxHost, addresses, opts) {
  let stage = 'connect';
  const replies = {};
  let socket;

  try {
    socket = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: mxHost, port: opts.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('connect timeout'));
      }, opts.connectTimeout);
      s.once('connect', () => { clearTimeout(timer); resolve(s); });
      s.once('error', (e) => { clearTimeout(timer); reject(e); });
    });

    stage = 'greeting';
    const greeting = await readReply(socket, opts.timeout);
    if (greeting.code !== 220) {
      return { stage, replies: { _greeting: greeting }, error: null };
    }

    stage = 'ehlo';
    send(socket, `EHLO ${opts.heloHost}`);
    let hello = await readReply(socket, opts.timeout);
    if (hello.code !== 250) {
      send(socket, `HELO ${opts.heloHost}`);
      hello = await readReply(socket, opts.timeout);
      if (hello.code !== 250) {
        return { stage, replies: { _ehlo: hello }, error: null };
      }
    }

    stage = 'mailfrom';
    send(socket, `MAIL FROM:<${opts.fromAddress ? safeAddress(opts.fromAddress) : ''}>`);
    const from = await readReply(socket, opts.timeout);
    if (from.code !== 250) {
      return { stage, replies: { _mailfrom: from }, error: null };
    }

    stage = 'rcpt';
    for (const addr of addresses) {
      send(socket, `RCPT TO:<${safeAddress(addr)}>`);
      replies[addr] = await readReply(socket, opts.timeout);
    }

    try { send(socket, 'QUIT'); } catch { /* server may have hung up */ }
    return { stage, replies, error: null };
  } catch (err) {
    return { stage, replies, error: err.message };
  } finally {
    try { socket?.destroy(); } catch { /* already gone */ }
  }
}

const result = (status, detail, extra = {}) => ({ status, detail, ...extra });

/**
 * Verify a mailbox, detecting catch-all domains in the same connection.
 *
 * @returns {Promise<{status:string, detail:string, ...}>} status is one of:
 *   deliverable | undeliverable | mailbox-full | catch-all |
 *   blocked | greylisted | unknown
 */
async function probeMailbox(email, mxHosts, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const domain = email.split('@')[1];
  const canaryCount = Math.max(0, Math.min(10, opts.canaries));

  const cachedCatchAll = catchAllCache.get(domain);

  // Probe the real address first, then canaries - see rule 3 at the top.
  // Canaries are skipped entirely when the catch-all answer is already known,
  // or when this domain recently refused to answer them: sending them again
  // triples the load on a server that is already turning us away.
  const skipCanaries = cachedCatchAll !== undefined || canaryBlockedCache.get(domain) === true;
  const canaries = skipCanaries
    ? []
    : Array.from({ length: canaryCount }, () => `${randomBytes(12).toString('hex')}@${domain}`);
  const addresses = [email, ...canaries];

  let lastError = null;
  let lastStage = null;

  for (const mxHost of mxHosts.slice(0, opts.maxMx)) {
    for (let attempt = 0; attempt <= opts.greylistRetries; attempt++) {
      const { stage, replies, error } = await converse(mxHost, addresses, opts);
      lastStage = stage;

      if (error && stage !== 'rcpt') {
        lastError = error;
        break; // connection-level problem: try the next MX host
      }

      // Rule 2: never reached RCPT, so nothing was learned about the mailbox.
      if (stage !== 'rcpt') {
        const preReply = replies._mailfrom || replies._ehlo || replies._greeting;
        const c = preReply ? classifyReply(preReply) : null;
        if (c?.kind === 'temporary' && attempt < opts.greylistRetries) {
          await new Promise(r => setTimeout(r, opts.greylistDelay));
          continue;
        }
        // The server turned us away before RCPT, so the canaries we queued
        // were never going to be answered. Remember that for this domain.
        if (canaries.length) canaryBlockedCache.set(domain, true);
        return result(
          c?.kind === 'blocked' ? 'blocked' : c?.kind === 'temporary' ? 'greylisted' : 'unknown',
          c?.kind === 'blocked'
            ? `Mail server refused our connection at ${stage.toUpperCase()}, so this mailbox could not be checked`
            : `Conversation ended at ${stage.toUpperCase()} before the address could be checked`,
          { stage, mxHost, code: preReply?.code, enhanced: c?.enhanced, reachedRcpt: false,
            retryable: preReply ? isRetryableBlock(preReply) : true }
        );
      }

      const target = classifyReply(replies[email]);

      // Greylisted on the address itself: retry once from the same IP.
      if (target.kind === 'temporary' && attempt < opts.greylistRetries) {
        await new Promise(r => setTimeout(r, opts.greylistDelay));
        continue;
      }

      // Rule 1: a block is not a verdict about the mailbox.
      if (target.kind === 'blocked') {
        return result('blocked',
          'The mail server refused our IP instead of answering, so the inbox was not checked',
          { stage, mxHost, code: target.code, enhanced: target.enhanced, reachedRcpt: true,
            retryable: isRetryableBlock(replies[email]) });
      }
      if (target.kind === 'temporary') {
        return result('greylisted',
          'The mail server asked us to come back later (greylisting), so the inbox is still unconfirmed',
          { stage, mxHost, code: target.code, enhanced: target.enhanced, reachedRcpt: true,
            retryable: true });
      }

      // Work out catch-all status: cached, or from this run's canaries.
      let catchAll = cachedCatchAll;
      if (catchAll === undefined && canaries.length) {
        const verdicts = canaries.map(a => classifyReply(replies[a]));
        const answered = verdicts.filter(v => v.kind === 'ok' || v.kind === 'no-mailbox');
        if (answered.length) {
          // Every canary accepted => the domain takes anything.
          catchAll = answered.every(v => v.kind === 'ok');
          catchAllCache.set(domain, catchAll);
          canaryBlockedCache.set(domain, false);
        } else {
          // The server took our canaries and told us nothing about them. Stop
          // paying for them on this domain until the backoff expires.
          canaryBlockedCache.set(domain, true);
        }
      }

      if (target.kind === 'no-mailbox') {
        return result('undeliverable', 'Confirmed by the mail server, this inbox does not exist',
          { stage, mxHost, code: target.code, enhanced: target.enhanced, catchAll: catchAll ?? null, reachedRcpt: true });
      }
      if (target.kind === 'mailbox-disabled') {
        return result('mailbox-disabled',
          'The inbox exists but is inactive or suspended, so mail will not arrive',
          { stage, mxHost, code: target.code, enhanced: target.enhanced, catchAll: catchAll ?? null, reachedRcpt: true });
      }
      if (target.kind === 'mailbox-full') {
        return result('mailbox-full', 'The inbox exists but is full and cannot accept mail',
          { stage, mxHost, code: target.code, enhanced: target.enhanced, catchAll: catchAll ?? null, reachedRcpt: true });
      }
      if (target.kind === 'ok') {
        if (catchAll === true) {
          return result('catch-all',
            'This domain accepts every address, so the inbox cannot be confirmed',
            { stage, mxHost, code: target.code, catchAll: true, reachedRcpt: true });
        }
        return result('deliverable', 'Confirmed by the mail server, this inbox is live',
          { stage, mxHost, code: target.code, catchAll: catchAll ?? false, reachedRcpt: true });
      }

      return result('unknown', `The mail server gave a reply we could not read: ${target.reason}`,
        { stage, mxHost, code: target.code, enhanced: target.enhanced, reachedRcpt: true });
    }
  }

  // A connection that never completed is worth one more try on a realistic
  // timescale: dropped sockets are overwhelmingly rate-limiting, which clears.
  // lastError stays in meta for the retry logic and the server log; the
  // message shown to the user never carries a raw socket error.
  if (lastError) console.error('[smtp]', lastError);
  return result('unknown',
    lastError
      ? 'Could not complete an SMTP conversation. Port 25 may be blocked'
      : 'Could not complete an SMTP conversation',
    { stage: lastStage, error: lastError, reachedRcpt: false, retryable: true });
}

/**
 * Statuses that are not answers about the mailbox, and where trying again
 * later can still produce one.
 *
 * 'blocked' and 'unknown' belong here for the same reason 'greylisted' does.
 * Comcast, Charter and Cox refuse connections from IPs they do not recognise
 * and drop sockets once a run picks up pace, so the server is not withholding
 * a verdict about the address - it is declining to talk to us right now.
 * Permanent blocks are excluded by the retryable flag: a 5.7.25 reverse-DNS
 * rejection is infrastructure, and re-probing it a hundred times only
 * deepens the IP's reputation problem. The cure for those is a correct
 * SMTP_HELO with matching PTR, not another attempt.
 */
const UNRESOLVED = new Set(['greylisted', 'blocked', 'unknown']);

/**
 * Verify a mailbox, resolving deferrals and throttling in the background.
 *
 * A deferral is not an answer, so instead of reporting it and forgetting, the
 * address is queued for a retry on a realistic timescale. The request still
 * returns immediately with an honest status; the retry's verdict is served to
 * whoever checks that address next.
 *
 * @returns {Promise<{status:string, detail:string, ...}>} status is one of:
 *   deliverable | undeliverable | mailbox-full | catch-all |
 *   blocked | greylisted | unknown
 */
export async function verifyMailbox(email, mxHosts, options = {}) {
  // A retry may already have answered this since the caller last asked.
  const earlier = getResolved(email);
  if (earlier) return earlier;

  const outcome = await probeMailbox(email, mxHosts, options);
  if (!UNRESOLVED.has(outcome.status)) return outcome;
  // A block the server will give us again no matter how long we wait.
  if (outcome.retryable === false) return outcome;

  const retryInMs = scheduleRetry(
    email,
    () => probeMailbox(email, mxHosts, options),
    { unresolved: UNRESOLVED }
  );
  return {
    ...outcome,
    // Only promise a retry that was actually queued - the queue has a cap.
    retryScheduled: retryInMs !== null || isPending(email),
    retryInMs: retryInMs ?? null
  };
}

export const smtpEnabled = () =>
  String(process.env.SMTP_CHECK || '').toLowerCase() === 'true';

export const catchAllCacheSize = () => catchAllCache.size;
export const canaryBackoffSize = () => canaryBlockedCache.size;

/** Test helper: drop cached catch-all and canary-backoff state. */
export function resetSmtpCaches() {
  catchAllCache.store.clear();
  canaryBlockedCache.store.clear();
}
