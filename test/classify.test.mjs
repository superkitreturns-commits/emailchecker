/**
 * Classifier tests. Run with: npm test
 *
 * The real replies below were captured from live mail servers on 2026-09-23.
 * They are the reason this module exists: Gmail's 550 and iCloud's 550 look
 * identical until you read the enhanced status code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, parseEnhanced } from '../lib/smtp-codes.js';
import { canonicalize } from '../lib/normalize.js';

const reply = (code, text) => ({ code, text });

test('parseEnhanced pulls the X.Y.Z code out', () => {
  assert.equal(parseEnhanced('550 5.1.1 no such user'), '5.1.1');
  assert.equal(parseEnhanced('550-5.7.1 blocked'), '5.7.1');
  assert.equal(parseEnhanced('451 4.7.1 greylisted'), '4.7.1');
  assert.equal(parseEnhanced('550 No such user here'), null);
});

test('LIVE Gmail: nonexistent mailbox is no-mailbox', () => {
  const c = classifyReply(reply(550,
    "550-5.1.1 The email account that you tried to reach does not exist. Please try\n" +
    "550 5.1.1  https://support.google.com/mail/?p=NoSuchUser - gsmtp"));
  assert.equal(c.kind, 'no-mailbox');
  assert.equal(c.enhanced, '5.1.1');
});

test('LIVE Gmail: existing mailbox is ok', () => {
  assert.equal(classifyReply(reply(250, '250 2.1.0 OK a92af - gsmtp')).kind, 'ok');
});

test('LIVE iCloud: Spamhaus block must NOT be no-mailbox', () => {
  const c = classifyReply(reply(550,
    '550 5.7.1 Mail from IP 106.219.72.198 was rejected due to listing in Spamhaus SBL'));
  assert.equal(c.kind, 'blocked');
  assert.notEqual(c.kind, 'no-mailbox'); // the false-negative this guards against
});

test('LIVE Outlook: Spamhaus block is blocked', () => {
  assert.equal(classifyReply(reply(550,
    '550 5.7.1 Service unavailable, Client host [106.219.72.198] blocked using Spamhaus')).kind, 'blocked');
});

test('LIVE Yahoo: FCrDNS failure is blocked', () => {
  assert.equal(classifyReply(reply(550,
    '550 5.7.25 Forward-confirmed reverse DNS failed tnmpmscs')).kind, 'blocked');
});

test('LIVE Zoho and Proton: honest no-mailbox answers', () => {
  assert.equal(classifyReply(reply(550, '550 5.1.1 User does not exist - <x@zoho.com>')).kind, 'no-mailbox');
  assert.equal(classifyReply(reply(550,
    '550 5.1.1 <x@proton.me>: Recipient address rejected: Address does not exist')).kind, 'no-mailbox');
});

test('4xx is always temporary, never a mailbox verdict', () => {
  assert.equal(classifyReply(reply(451, '451 4.7.1 Greylisted, try again later')).kind, 'temporary');
  assert.equal(classifyReply(reply(421, '421 Too many connections')).kind, 'temporary');
});

test('mailbox full means the mailbox exists', () => {
  assert.equal(classifyReply(reply(552, '552 5.2.2 Mailbox full')).kind, 'mailbox-full');
  assert.equal(classifyReply(reply(552, '552 Requested action aborted: quota exceeded')).kind, 'mailbox-full');
});

test('text fallback when the server omits the enhanced code', () => {
  assert.equal(classifyReply(reply(550, '550 No such user here')).kind, 'no-mailbox');
  assert.equal(classifyReply(reply(550, '550 Unknown recipient')).kind, 'no-mailbox');
  assert.equal(classifyReply(reply(550, '550 Your IP is blacklisted')).kind, 'blocked');
  assert.equal(classifyReply(reply(550, '550 Access denied')).kind, 'blocked');
});

test('blocking language wins over "rejected" in the same reply', () => {
  // Contains both "rejected" and blocking language; must not be no-mailbox.
  assert.equal(classifyReply(reply(550,
    '550 Client host rejected: listed on Spamhaus')).kind, 'blocked');
});

test('an unreadable 5xx refuses to guess', () => {
  assert.equal(classifyReply(reply(550, '550 Administrative prohibition')).kind, 'unknown');
});

test('Gmail canonicalisation: dots and tags collapse', () => {
  assert.equal(canonicalize('j.o.h.n', 'gmail.com').canonical, 'john@gmail.com');
  assert.equal(canonicalize('john+shop', 'gmail.com').canonical, 'john@gmail.com');
  assert.equal(canonicalize('j.o.h.n+shop', 'googlemail.com').canonical, 'john@gmail.com');
});

test('dots are NOT stripped outside consumer Google', () => {
  // Workspace and other providers treat dots as significant.
  assert.equal(canonicalize('first.last', 'acme.com').canonical, 'first.last@acme.com');
  assert.equal(canonicalize('first.last', 'outlook.com').canonical, 'first.last@outlook.com');
});

test('plus tags strip on providers that support them, not elsewhere', () => {
  assert.equal(canonicalize('user+tag', 'outlook.com').canonical, 'user@outlook.com');
  assert.equal(canonicalize('user+tag', 'acme.com').canonical, 'user+tag@acme.com');
});

test('a local part that is only a tag is left alone', () => {
  assert.equal(canonicalize('+tag', 'gmail.com').canonical, '+tag@gmail.com');
});

/* ---- TLD false-positive regression -------------------------------------
 * Reported case: rgbirngartankjuggi@mailtrap.io was "corrected" to
 * mailtrap.in, because distance('io','in') is 1 and nothing checked that
 * .io is itself a real TLD. Same class of bug hit .dev -> .de, .co -> .com
 * and .so -> .io.
 */
import { suggestDomain } from '../lib/typo.js';

test('real TLDs are never treated as typos', () => {
  for (const d of ['mailtrap.io', 'stripe.dev', 'notion.so', 'something.co',
                   'vercel.app', 'github.io', 'company.ai', 'shop.store',
                   'team.tech', 'site.online', 'x.tv', 'a.cc', 'brand.xyz']) {
    assert.equal(suggestDomain(d), null, `${d} should not be "corrected"`);
  }
});

test('genuine TLD typos are still caught', () => {
  assert.equal(suggestDomain('example.cmo'), 'example.com');
  assert.equal(suggestDomain('gmail.con'), 'gmail.com');
  assert.equal(suggestDomain('yahoo.cm'), 'yahoo.com');
});

test('genuine domain-body typos are still caught', () => {
  assert.equal(suggestDomain('gmial.com'), 'gmail.com');
  assert.equal(suggestDomain('hotmial.com'), 'hotmail.com');
  assert.equal(suggestDomain('gmai.com'), 'gmail.com');
});

/* ---- "inactive" is not "nonexistent" ------------------------------------
 * Reported case: adriamartinlctj5@jerem.us was marked invalid / "does not
 * exist", but the account is real - Google's sign-in recognised it and failed
 * on a 2-Step policy. The SMTP reply actually said 5.2.1 "inactive".
 * RFC 3463 5.2.1 is "mailbox disabled" - the mailbox EXISTS.
 */
test('LIVE Google 5.2.1 inactive means the mailbox exists', () => {
  const c = classifyReply(reply(550,
    '550-5.2.1 The email account that you tried to reach is inactive. For more ' +
    '550 5.2.1 information, go to https://support.google.com/mail/?p=DisabledUser'));
  assert.equal(c.kind, 'mailbox-disabled');
  assert.notEqual(c.kind, 'no-mailbox'); // the false negative this guards against
  assert.equal(c.enhanced, '5.2.1');
});

test('suspended and deactivated wording is also "disabled", not missing', () => {
  assert.equal(classifyReply(reply(550, '550 Account is suspended')).kind, 'mailbox-disabled');
  assert.equal(classifyReply(reply(550, '550 This mailbox is disabled')).kind, 'mailbox-disabled');
  assert.equal(classifyReply(reply(550, '550 User no longer active')).kind, 'mailbox-disabled');
});

test('5.4.1 is ambiguous and never assumed to be a missing mailbox', () => {
  // Exchange Online uses this for blocked senders as well as unknown users.
  assert.notEqual(
    classifyReply(reply(550, '550 5.4.1 Recipient address rejected: Access denied')).kind,
    'no-mailbox');
});

test('a genuine 5.1.1 is still a missing mailbox', () => {
  assert.equal(classifyReply(reply(550,
    '550 5.1.1 The email account that you tried to reach does not exist')).kind, 'no-mailbox');
});

/* ---- look-alike characters ---------------------------------------------
 * The I-vs-l case that caused a real mix-up: "AdriaMartinIctj5@jerem.us"
 * (capital i) and "adriamartinlctj5@jerem.us" (lowercase L) are different
 * addresses that render almost identically.
 */
import { detectLookalikes, detectDomainSpoof } from '../lib/homoglyph.js';
import { POPULAR_DOMAINS } from '../lib/typo.js';
import { identifyProvider } from '../lib/dns-check.js';
import { validateEmail } from '../lib/validator.js';

test('flags the I / l / 1 confusion', () => {
  assert.equal(detectLookalikes('AdriaMartinIctj5').confusable, true);
  assert.equal(detectLookalikes('adriamartinlctj5').confusable, true);
  assert.equal(detectLookalikes('O0liver').groups.includes('O / 0'), true);
  assert.equal(detectLookalikes('rnark').groups[0], '"rn" reads as "m"');
});

test('stays quiet on ordinary names', () => {
  for (const n of ['john', 'JohnSmith', 'sarah', 'mike.jones', 'contact', 'emma_w']) {
    assert.equal(detectLookalikes(n).confusable, false, `${n} should not be flagged`);
  }
});

test('mixed scripts are spoofing, not typos', () => {
  const r = detectLookalikes('p\u0430ypal'); // Cyrillic a
  assert.equal(r.mixedScript, true);
  assert.deepEqual(r.scripts, ['Cyrillic']);
});

test('pure Latin is never mixed-script', () => {
  assert.equal(detectLookalikes('paypal').mixedScript, false);
});

/* ---- Domain homoglyph impersonation -------------------------------------
 * A registered look-alike domain resolves and can have working MX records,
 * so DNS will not catch it. These must never come back usable.
 * ------------------------------------------------------------------------ */

test('a domain imitating a known provider is flagged as spoofing', () => {
  const r = detectDomainSpoof('gmaіl.com', POPULAR_DOMAINS); // Cyrillic i
  assert.equal(r.spoof, true);
  assert.equal(r.impersonates, 'gmail.com');
  assert.deepEqual(r.scripts, ['Cyrillic']);
});

test('legitimate international domains are left alone', () => {
  for (const d of ['müller.de', 'café.fr', 'ångström.se']) {
    assert.equal(detectDomainSpoof(d, POPULAR_DOMAINS).spoof, false, `${d} should not be flagged`);
  }
});

test('ASCII domains are never treated as homoglyph spoofing', () => {
  // Edit-distance impersonation is typo.js's job; this check must not claim it.
  for (const d of ['gmail.com', 'gmial.com', 'paypai.com']) {
    assert.equal(detectDomainSpoof(d, POPULAR_DOMAINS).spoof, false);
  }
});

test('a spoofed domain never reaches a usable verdict', async () => {
  const r = await validateEmail('user@gmaіl.com', {}, { smtp: false, intel: false });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.score, 0);
  assert.equal(r.suggestion, 'user@gmail.com');
  assert.equal(r.checks.some(c => c.id === 'lookalike' && c.status === 'fail'), true);
});

test('a mixed-script local part says why it was rejected', async () => {
  const r = await validateEmail('pаypal@gmail.com', {}, { smtp: false, intel: false });
  assert.equal(r.verdict, 'invalid');
  assert.match(r.checks[0].detail, /Cyrillic/);
});

/* ---- Provider labelling -------------------------------------------------
 * Consumer Gmail and a Workspace custom domain publish identical MX hosts,
 * so MX alone can only say "Google Workspace / Gmail". The domain settles it.
 * ------------------------------------------------------------------------ */

test('a consumer mailbox is named by its domain, not its MX', () => {
  const googleMx = ['aspmx.l.google.com', 'alt1.aspmx.l.google.com'];
  assert.equal(identifyProvider(googleMx, 'gmail.com'), 'Gmail');
  assert.equal(identifyProvider(googleMx, 'googlemail.com'), 'Gmail');
  assert.equal(identifyProvider(['mx.outlook.com'], 'hotmail.com'), 'Outlook.com');
});

test('a custom domain on the same MX is still reported as Workspace', () => {
  // The hedged label is correct here - this really could be either.
  assert.equal(
    identifyProvider(['aspmx.l.google.com'], 'acme.com'),
    'Google Workspace / Gmail'
  );
});

// ---------------------------------------------------------------------------
// Provider policy, the unknown fall-through, and the deferred re-check pass.
// These three decide whether an unverified address is reported as real data,
// so they are the parts most worth pinning down.
// ---------------------------------------------------------------------------
import { JobQueue } from '../lib/queue.js';
import { isRetryableBlock } from '../lib/smtp-codes.js';
import { infraKey, verifiability } from '../lib/providers.js';

const probe = (status, extra = {}) => async () => ({ status, detail: status, ...extra });

test('a dropped SMTP conversation is unknown, never valid', async () => {
  const r = await validateEmail('someone@gmail.com',
    { verifyMailbox: probe('unknown', { error: 'connect timeout' }) },
    { smtp: true, intel: false });
  assert.equal(r.verdict, 'unknown');
});

test('SMTP_UNKNOWN_FALLBACK restores DNS-only scoring for hosts without port 25', async () => {
  process.env.SMTP_UNKNOWN_FALLBACK = 'true';
  try {
    const r = await validateEmail('someone@gmail.com',
      { verifyMailbox: probe('unknown', { error: 'EACCES' }) },
      { smtp: true, intel: false });
    assert.equal(r.verdict, 'valid');
  } finally {
    delete process.env.SMTP_UNKNOWN_FALLBACK;
  }
});

test('acceptance alone does not confirm a mailbox on an accept-then-bounce provider', async () => {
  const r = await validateEmail('someone@yahoo.com',
    { verifyMailbox: probe('deliverable', { catchAll: null }) },
    { smtp: true, intel: false });
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.checks.some(c => c.id === 'provider'));
});

test('acceptance stays unconfirmed even when this conversation\'s canaries were rejected', async () => {
  // Yahoo's farm answers inconsistently per connection: it can accept a real
  // address and reject the very next canary in the same session, so a clean
  // canary disproof is not strong enough evidence on a provider whose "250"
  // is already known to be unreliable.
  const r = await validateEmail('someone@yahoo.com',
    { verifyMailbox: probe('deliverable', { catchAll: false }) },
    { smtp: true, intel: false });
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.checks.some(c => c.id === 'provider'));
});

test('a confirmed dead mailbox stays invalid on every provider', async () => {
  for (const d of ['gmail.com', 'yahoo.com', 'comcast.net']) {
    const r = await validateEmail(`someone@${d}`,
      { verifyMailbox: probe('undeliverable', { catchAll: false }) },
      { smtp: true, intel: false });
    assert.equal(r.verdict, 'invalid', d);
  }
});

test('domains on one mail farm share a throttle key', () => {
  const yahooMx = ['mta7.am0.yahoodns.net'];
  assert.equal(infraKey(yahooMx, 'yahoo.com'), infraKey(yahooMx, 'att.net'));
  assert.notEqual(infraKey(yahooMx, 'yahoo.com'),
    infraKey(['gmail-smtp-in.l.google.com'], 'gmail.com'));
  assert.equal(verifiability(yahooMx, 'aol.com').selfVerifiable, false);
  assert.equal(verifiability(['gmail-smtp-in.l.google.com'], 'gmail.com').selfVerifiable, true);
});

test('reverse-DNS and blocklist refusals are not retried; rate limits are', () => {
  assert.equal(isRetryableBlock({ code: 550, text: '550 5.7.25 reverse DNS failed' }), false);
  assert.equal(isRetryableBlock({ code: 550, text: '550 5.7.1 blocked using Spamhaus' }), false);
  assert.equal(isRetryableBlock({ code: 421, text: '421 too many connections' }), true);
});

test('the re-check pass upgrades a deferral to a real answer', async () => {
  const seen = new Map();
  const runner = async (email) => {
    const n = (seen.get(email) || 0) + 1;
    seen.set(email, n);
    return n === 1
      ? { email, verdict: 'unknown', score: 50, meta: { smtp: { status: 'greylisted', retryable: true } } }
      : { email, verdict: 'valid', score: 97, meta: { smtp: { status: 'deliverable' } } };
  };
  const q = new JobQueue(runner, { retryDelays: [5] });
  const job = q.create(['a@example.com']);
  await q.drain();
  assert.equal(job.results[0].verdict, 'valid');
  assert.equal(job.summary.valid, 1);
  assert.equal(job.summary.unknown, 0, 'the old verdict must be removed from the summary');
});

test('a re-check never downgrades a result it could not improve', async () => {
  const runner = async (email) => ({
    email, verdict: 'unknown', score: 50,
    meta: { smtp: { status: 'greylisted', retryable: true } }
  });
  const q = new JobQueue(runner, { retryDelays: [5] });
  const job = q.create(['a@example.com']);
  await q.drain();
  assert.equal(job.results[0].verdict, 'unknown');
  assert.equal(job.summary.unknown, 1);
});

test('a permanent block is not retried, so a bad IP does not get hammered', async () => {
  let calls = 0;
  const runner = async (email) => {
    calls++;
    return { email, verdict: 'unknown', score: 50,
      meta: { smtp: { status: 'blocked', retryable: false } } };
  };
  const q = new JobQueue(runner, { retryDelays: [5] });
  const job = q.create(['a@example.com']);
  await q.drain();
  assert.equal(calls, 1);
});

test('a provider that recovers nothing in a round is dropped from later rounds', async () => {
  const calls = [];
  const runner = async (email) => {
    calls.push(email);
    return { email, verdict: 'unknown', score: 50,
      meta: { smtp: { status: 'greylisted', retryable: true } } };
  };
  const q = new JobQueue(runner, { retryDelays: [5, 5], groupOf: async () => 'comcast' });
  const job = q.create(['a@comcast.net', 'b@comcast.net', 'c@comcast.net']);
  await q.drain();
  // 3 in the main pass + 3 in round one; round two is skipped because nothing
  // improved, so the provider is not hit a third time.
  assert.equal(calls.length, 6);
});

test('a provider that does recover is retried again in the next round', async () => {
  let n = 0;
  const runner = async (email) => {
    n++;
    // One address becomes answerable on its second attempt.
    if (email === 'a@x.com' && n > 3) {
      return { email, verdict: 'valid', score: 97, meta: { smtp: { status: 'deliverable' } } };
    }
    return { email, verdict: 'unknown', score: 50,
      meta: { smtp: { status: 'greylisted', retryable: true } } };
  };
  const q = new JobQueue(runner, { retryDelays: [5, 5], groupOf: async () => 'g' });
  const job = q.create(['a@x.com', 'b@x.com', 'c@x.com']);
  await q.drain();
  assert.equal(job.results[0].verdict, 'valid');
  assert.ok(n > 6, 'the group should still be retried in round two');
});
