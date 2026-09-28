/**
 * Validation engine. Runs each layer in order and stops early when a
 * failure makes later checks meaningless (bad syntax => no point in DNS).
 */
import { lookupDomain } from './dns-check.js';
import { suggestDomain, isFreeProvider } from './typo.js';
import { verifyMailbox, smtpEnabled } from './smtp.js';
import { canonicalize } from './normalize.js';
import { getDomainIntel } from './domain-intel.js';
import { detectLookalikes } from './homoglyph.js';

const ROLE_ACCOUNTS = new Set([
  'admin', 'administrator', 'billing', 'compliance', 'contact', 'help',
  'hostmaster', 'info', 'inquiries', 'marketing', 'noc', 'noreply',
  'no-reply', 'office', 'postmaster', 'privacy', 'root', 'sales',
  'security', 'abuse', 'spam', 'support', 'sysadmin', 'team', 'webmaster',
  'hello', 'enquiries', 'careers', 'jobs', 'hr', 'legal', 'press', 'media'
]);

// RFC 5322 in practice: permissive enough for real addresses, strict enough
// to reject the malformed input people actually type.
const LOCAL_ATOM = "[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+";
const SYNTAX_RE = new RegExp(
  `^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*@` +
  `(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+` +
  `[a-zA-Z]{2,63}$`
);

const check = (id, label, status, detail) => ({ id, label, status, detail });

/**
 * Convert an internationalised domain to its ASCII (punycode) form so that
 * müller.de validates and resolves the same way xn--mller-kva.de does.
 * Returns null when the domain cannot be represented at all.
 */
function toAsciiDomain(domain) {
  if (!/[^\x00-\x7F]/.test(domain)) return domain; // already ASCII
  try {
    const host = new URL(`http://${domain}`).hostname;
    return host || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} input   raw address
 * @param {object} deps    { disposable } - the shared DisposableList
 * @param {object} opts    { smtp: boolean }
 */
export async function validateEmail(input, deps = {}, opts = {}) {
  const started = Date.now();
  const raw = String(input ?? '').trim();
  const email = raw.toLowerCase();

  const result = {
    email: raw,
    normalized: email,
    verdict: 'invalid',
    score: 0,
    suggestion: null,
    checks: [],
    meta: {
      local: null, domain: null, mx: [], provider: null,
      free: false, role: false, disposable: false
    },
    tookMs: 0
  };

  const finish = () => {
    result.tookMs = Date.now() - started;
    return result;
  };

  // ---- 1. Syntax ------------------------------------------------------
  if (!email) {
    result.checks.push(check('syntax', 'Format', 'fail', 'No address entered'));
    return finish();
  }
  if (!email.includes('@')) {
    result.checks.push(check('syntax', 'Format', 'fail', 'Missing the @ symbol'));
    return finish();
  }

  const atIndex = email.lastIndexOf('@');
  const local = email.slice(0, atIndex);
  // Lowercasing destroys the I-vs-l evidence, so keep the original around.
  const rawLocal = raw.slice(0, raw.lastIndexOf('@'));
  const rawDomain = email.slice(atIndex + 1);

  // Everything downstream - regex, DNS, blocklist - works on the ASCII form.
  const domain = toAsciiDomain(rawDomain);
  if (!domain) {
    result.meta.local = local;
    result.meta.domain = rawDomain;
    result.checks.push(check('syntax', 'Format', 'fail', 'Domain contains unusable characters'));
    return finish();
  }

  result.meta.local = local;
  result.meta.domain = domain;
  if (domain !== rawDomain) result.meta.unicodeDomain = rawDomain;

  if (email.length > 254) {
    result.checks.push(check('syntax', 'Format', 'fail', 'Longer than the 254 character limit'));
    return finish();
  }
  if (local.length > 64) {
    result.checks.push(check('syntax', 'Format', 'fail', 'The part before @ exceeds 64 characters'));
    return finish();
  }
  if (!local.length) {
    result.checks.push(check('syntax', 'Format', 'fail', 'Nothing before the @ symbol'));
    return finish();
  }
  if (!domain.length) {
    result.checks.push(check('syntax', 'Format', 'fail', 'Nothing after the @ symbol'));
    return finish();
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    result.checks.push(check('syntax', 'Format', 'fail', 'Misplaced dot before the @ symbol'));
    return finish();
  }
  // Test the ASCII form so punycode domains pass the same rules.
  const asciiEmail = `${local}@${domain}`;
  if (!SYNTAX_RE.test(asciiEmail)) {
    result.checks.push(check('syntax', 'Format', 'fail', 'Not a valid email format'));
    const s = suggestDomain(domain);
    if (s) result.suggestion = `${local}@${s}`;
    return finish();
  }
  result.checks.push(check('syntax', 'Format', 'pass', 'Valid email structure'));

  // ---- 1b. Provider-aware canonical form -------------------------------
  // j.o.h.n+shop@googlemail.com and john@gmail.com are one mailbox. The
  // canonical form is the right de-duplication key and the right probe target.
  const canon = canonicalize(local, domain);
  result.meta.canonical = canon.canonical;
  if (canon.changed) {
    result.checks.push(check('canonical', 'Same mailbox', 'info', canon.notes.join('; ')));
  }

  // ---- 1c. Look-alike characters ---------------------------------------
  // Mixed scripts are flagged immediately: a Cyrillic "а" among Latin letters
  // is spoofing, not a typo. ASCII confusables (I/l/1) are held back until we
  // know the mailbox is missing - see below - so they do not become noise.
  const lookalike = detectLookalikes(rawLocal);
  result.meta.lookalike = lookalike;
  if (lookalike.mixedScript) {
    result.checks.push(check('lookalike', 'Look-alikes', 'fail', lookalike.hint));
  }

  // ---- 2. Typo suggestion ---------------------------------------------
  const suggested = suggestDomain(domain);
  if (suggested) {
    result.suggestion = `${local}@${suggested}`;
    result.checks.push(check('typo', 'Spelling', 'warn', `Looks like a typo for ${suggested}`));
  } else {
    result.checks.push(check('typo', 'Spelling', 'pass', 'No common typo detected'));
  }

  // ---- 3. Disposable ---------------------------------------------------
  const isDisposable = deps.disposable?.has(domain) ?? false;
  result.meta.disposable = isDisposable;
  result.checks.push(isDisposable
    ? check('disposable', 'Disposable', 'fail', 'Temporary throwaway email service')
    : check('disposable', 'Disposable', 'pass', 'Not a throwaway domain'));

  // ---- 4. Role account --------------------------------------------------
  const isRole = ROLE_ACCOUNTS.has(local);
  result.meta.role = isRole;
  result.checks.push(isRole
    ? check('role', 'Mailbox type', 'warn', 'Shared role address, not a personal inbox')
    : check('role', 'Mailbox type', 'pass', 'Personal mailbox'));

  // ---- 5 & 6. Domain + MX records ----------------------------------------
  const dns = await lookupDomain(domain);
  result.meta.mx = dns.mx;
  result.meta.provider = dns.provider;
  result.meta.free = isFreeProvider(domain);

  if (!dns.domainExists) {
    // Distinguish "the domain really is not registered" from "we could not ask".
    // Treating a DNS outage as a bad address would be a false negative.
    if (dns.error) {
      result.checks.push(check('domain', 'Domain', 'skip', `DNS lookup unavailable (${dns.error})`));
      result.checks.push(check('mx', 'Mail server', 'skip', 'Skipped - DNS lookup unavailable'));
      result.verdict = 'unknown';
      result.score = 50;
      return finish();
    }
    result.checks.push(check('domain', 'Domain', 'fail', 'This domain does not exist'));
    result.checks.push(check('mx', 'Mail server', 'skip', 'Skipped - domain does not exist'));
    result.verdict = 'invalid';
    result.score = 0;
    return finish();
  }
  result.checks.push(check('domain', 'Domain', 'pass', 'Domain is registered and resolves'));

  if (!dns.mx.length) {
    result.checks.push(check('mx', 'Mail server', 'fail', dns.nullMx
      // RFC 7505 null MX - the domain has explicitly opted out of email.
      ? 'This domain publishes a null MX and accepts no email'
      : 'Domain cannot receive email'));
    result.verdict = 'invalid';
    result.score = 10;
    return finish();
  }

  const mxDetail = dns.implicitMx
    ? 'No MX record; falling back to the domain A record'
    : `${dns.mx.length} mail server${dns.mx.length > 1 ? 's' : ''}${dns.provider ? ' · ' + dns.provider : ''}`;
  result.checks.push(check('mx', 'Mail server', dns.implicitMx ? 'warn' : 'pass', mxDetail));

  // ---- 7. Domain intelligence (SPF / DMARC / age) -------------------------
  // Started here but awaited after SMTP, so the two run concurrently and the
  // DNS and RDAP lookups cost no extra wall-clock time.
  const wantIntel = opts.intel ?? true;
  const intelPromise = wantIntel
    ? getDomainIntel(domain).catch(() => null)
    : Promise.resolve(null);

  // ---- 8 & 9. SMTP mailbox + catch-all (opt-in) ---------------------------
  const wantSmtp = opts.smtp ?? smtpEnabled();
  if (wantSmtp) {
    // Probe the canonical address: it is the mailbox that actually exists,
    // and it keeps the per-domain catch-all cache from fragmenting.
    const smtp = await verifyMailbox(canon.canonical, dns.mx.map(m => m.exchange));
    result.meta.smtp = smtp;

    // Each status maps to its own honest row. "blocked" and "greylisted" are
    // deliberately NOT failures: they say nothing about the mailbox.
    const MAILBOX_ROW = {
      deliverable:    ['pass', smtp.detail],
      undeliverable:  ['fail', smtp.detail],
      'mailbox-disabled': ['warn', smtp.detail],
      'mailbox-full': ['warn', smtp.detail],
      'catch-all':    ['warn', 'Cannot be confirmed on a catch-all domain'],
      blocked:        ['skip', smtp.detail],
      greylisted:     ['skip', smtp.detail],
      unknown:        ['skip', smtp.detail]
    };
    const [status, detail] = MAILBOX_ROW[smtp.status] || ['skip', smtp.detail];
    result.checks.push(check('smtp', 'Mailbox', status, detail));

    if (smtp.catchAll === true) {
      result.checks.push(check('catchall', 'Catch-all', 'warn', 'Domain accepts mail for any address'));
    } else if (smtp.catchAll === false) {
      result.checks.push(check('catchall', 'Catch-all', 'pass', 'Domain rejects unknown addresses'));
    } else {
      result.checks.push(check('catchall', 'Catch-all', 'skip', 'Could not be determined'));
    }
  } else {
    result.checks.push(check('smtp', 'Mailbox', 'skip', 'Deep verification is turned off'));
  }

  // The mailbox is missing and the address contains shape-alike characters.
  // This is exactly when "check the I against the l" is worth saying, and the
  // only time it is not noise.
  if (result.meta.smtp?.status === 'undeliverable'
      && lookalike.confusable && !lookalike.mixedScript) {
    result.checks.push(check('lookalike', 'Look-alikes', 'warn', lookalike.hint));
  }

  const intel = await intelPromise;
  result.meta.intel = intel;

  if (intel) {
    const { spf, dmarc, age, ageRisk } = intel;

    // Authentication. Publishing a record is not the same as enforcing one:
    // SPF "?all"/"+all" asserts nothing and DMARC p=none is monitor-only, so
    // a domain can hold both records and still tell receivers to do nothing.
    // Grade on what the policy actually instructs, not on its presence.
    const parts = [];
    if (spf.present) parts.push(`SPF (${spf.policy})`);
    if (dmarc.present) parts.push(`DMARC (p=${dmarc.policy})`);

    const spfEnforcing = spf.present && (spf.policy === 'strict' || spf.policy === 'soft');
    const dmarcEnforcing = dmarc.present
      && (dmarc.policy === 'reject' || dmarc.policy === 'quarantine');

    if (!spf.present && !dmarc.present) {
      result.checks.push(check('auth', 'Authentication', 'warn',
        'No SPF or DMARC record - the domain publishes no mail policy'));
    } else if (!dmarc.present) {
      result.checks.push(check('auth', 'Authentication', 'warn',
        `${parts.join(', ')} - no DMARC policy published`));
    } else if (!spfEnforcing && !dmarcEnforcing) {
      // Both records exist and neither asks receivers to act on a failure.
      result.checks.push(check('auth', 'Authentication', 'warn',
        `${parts.join(' · ')} - published but not enforced`));
    } else if (!dmarcEnforcing) {
      result.checks.push(check('auth', 'Authentication', 'warn',
        `${parts.join(' · ')} - DMARC is monitor-only`));
    } else {
      result.checks.push(check('auth', 'Authentication', 'pass', parts.join(' · ')));
    }

    // Registration age. Unknown is common and is not a negative signal.
    if (age.known) {
      const days = age.ageDays;
      const withCommas = days.toLocaleString('en-US');
      // Show both units once a domain is old enough that days alone stop
      // being readable - "11,571 days" and "31.7 years" answer different questions.
      const label = days < 365
        ? `${withCommas} days old`
        : `${(days / 365).toFixed(1)} years old (${withCommas} days)`;

      const AGE_ROW = {
        'very-new': ['fail', `Registered ${withCommas} days ago - very high risk`],
        'new':      ['warn', `Registered ${withCommas} days ago - recently created`],
        'young':    ['warn', `${label} - still a young domain`]
      };
      const [status, detail] = AGE_ROW[ageRisk] || ['pass', `Registered ${label}`];
      result.checks.push(check('age', 'Domain age', status, detail));
    } else {
      result.checks.push(check('age', 'Domain age', 'skip',
        age.reason === 'not-in-registry'
          ? 'No RDAP record published for this TLD'
          : 'Registration date unavailable'));
    }
  }

  scoreResult(result);
  return finish();
}

/**
 * Turn the check results into a verdict and a 0-100 confidence score.
 *
 * The ordering matters. A confirmed dead mailbox outranks everything; a
 * server that refused our IP outranks nothing at all, because it is not a
 * statement about the address. Reporting "blocked" as "invalid" would mark
 * real, working addresses dead - the failure this whole layer exists to avoid.
 */
function scoreResult(result) {
  const smtp = result.meta.smtp;

  // Hard evidence the mailbox is gone.
  if (smtp?.status === 'undeliverable') {
    result.verdict = 'invalid';
    result.score = 2;
    return;
  }

  if (result.meta.disposable) {
    result.verdict = 'risky';
    result.score = 25;
    return;
  }

  // Exists, but cannot take mail right now. Both are real mailboxes, so
  // neither may be reported as invalid - that would be a false negative on a
  // real person's address.
  if (smtp?.status === 'mailbox-disabled') {
    result.verdict = 'risky';
    result.score = 30;
    return;
  }
  if (smtp?.status === 'mailbox-full') {
    result.verdict = 'risky';
    result.score = 65;
    return;
  }

  // Genuinely undeterminable: the domain takes everything.
  if (smtp?.status === 'catch-all') {
    result.verdict = 'unknown';
    result.score = 55;
    return;
  }

  // We reached the server and it refused or deferred us. It CAN answer, it
  // just would not answer us - so "unknown" is the only honest verdict.
  if (smtp?.status === 'blocked' || smtp?.status === 'greylisted') {
    result.verdict = 'unknown';
    result.score = 50;
    return;
  }

  // status 'unknown' means the conversation never happened at all (port 25
  // blocked, connect timeout). Deliberately NOT forced to "unknown": on a host
  // without port 25 that would make every single address unknown and the tool
  // useless. Instead we fall through to DNS-level confidence - the same answer
  // you get with deep checks switched off - and the Mailbox row says why.

  if (result.suggestion) {
    result.verdict = 'risky';
    result.score = 45;
    return;
  }

  // SMTP confirmed delivery on a non-catch-all domain is the strongest
  // positive signal available without sending a real message.
  let score = smtp?.status === 'deliverable' ? 97 : 85;
  if (result.meta.role) score -= 15;
  if (result.checks.some(c => c.id === 'mx' && c.status === 'warn')) score -= 10;

  // Domain risk signals. These never make an address invalid - a confirmed
  // mailbox on a four-day-old domain genuinely exists - but they lower
  // confidence and can tip "valid" into "risky". An unknown registration date
  // is not a penalty: most ccTLDs publish no RDAP at all.
  const intel = result.meta.intel;
  let domainConcern = false;

  if (intel) {
    if (!intel.spf.present && !intel.dmarc.present) {
      score -= 10;
      domainConcern = true;
    } else if (!intel.dmarc.present) {
      score -= 4;
    } else if (intel.dmarc.policy !== 'reject' && intel.dmarc.policy !== 'quarantine') {
      // Records exist but instruct receivers to do nothing. Worth a nudge, not
      // a flag: plenty of large, legitimate providers still sit on p=none, so
      // this deliberately does NOT set domainConcern and tip them to "risky".
      score -= 3;
    }

    const AGE_PENALTY = { 'very-new': 25, 'new': 15, 'young': 5 };
    const penalty = AGE_PENALTY[intel.ageRisk];
    if (penalty) {
      score -= penalty;
      if (intel.ageRisk !== 'young') domainConcern = true;
    }
  }

  result.score = Math.max(0, Math.min(100, score));
  result.verdict = (result.meta.role || domainConcern) ? 'risky' : 'valid';
}

export const VERDICTS = ['valid', 'risky', 'unknown', 'invalid'];
