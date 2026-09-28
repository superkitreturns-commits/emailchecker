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
import { detectLookalikes } from '../lib/homoglyph.js';

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
