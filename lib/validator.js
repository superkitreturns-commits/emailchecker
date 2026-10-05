/**
 * Validation engine. Runs each layer in order and stops early when a
 * failure makes later checks meaningless (bad syntax => no point in DNS).
 */
import { lookupDomain } from './dns-check.js';
import { suggestDomain, isFreeProvider, POPULAR_DOMAINS } from './typo.js';
import { verifyMailbox, smtpEnabled } from './smtp.js';
import { canonicalize } from './normalize.js';
import { getDomainIntel } from './domain-intel.js';
import { detectLookalikes, detectDomainSpoof } from './homoglyph.js';
import { verifiability, unverifiableReason } from './providers.js';
import { microsoftMailbox } from './ms-oracle.js';
import { yahooMailbox } from './yahoo-oracle.js';

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
 * Opt-in escape hatch for hosts with no outbound port 25, where every single
 * address would otherwise come back "unknown". Read at call time, not at
 * import time, so tests and the worker can flip it.
 */
const unknownFallbackEnabled = () =>
  String(process.env.SMTP_UNKNOWN_FALLBACK || '').toLowerCase() === 'true';

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
 * @param {object} deps    { disposable, verifyMailbox } - the shared
 *                         DisposableList, and an optional mailbox probe
 *                         (used to route SMTP through a remote worker)
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
    result.checks.push(check('syntax', 'Address format', 'fail', 'No address was entered'));
    return finish();
  }
  if (!email.includes('@')) {
    result.checks.push(check('syntax', 'Address format', 'fail', 'Missing the @ symbol'));
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
    result.checks.push(check('syntax', 'Address format', 'fail', 'The domain contains characters mail cannot use'));
    return finish();
  }

  result.meta.local = local;
  result.meta.domain = domain;
  if (domain !== rawDomain) result.meta.unicodeDomain = rawDomain;

  if (email.length > 254) {
    result.checks.push(check('syntax', 'Address format', 'fail', 'Too long, over the 254 character limit'));
    return finish();
  }
  if (local.length > 64) {
    result.checks.push(check('syntax', 'Address format', 'fail', 'The name before @ is over the 64 character limit'));
    return finish();
  }
  if (!local.length) {
    result.checks.push(check('syntax', 'Address format', 'fail', 'Nothing before the @ symbol'));
    return finish();
  }
  if (!domain.length) {
    result.checks.push(check('syntax', 'Address format', 'fail', 'No domain after the @ symbol'));
    return finish();
  }
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    result.checks.push(check('syntax', 'Address format', 'fail', 'A dot is in the wrong place before the @ symbol'));
    return finish();
  }
  // Test the ASCII form so punycode domains pass the same rules.
  const asciiEmail = `${local}@${domain}`;
  if (!SYNTAX_RE.test(asciiEmail)) {
    // A non-Latin character in the local part fails the regex like any other
    // illegal byte, but "not a valid format" hides why. Name the real cause:
    // these addresses are overwhelmingly spoofing, not fat-fingering.
    const localScripts = detectLookalikes(rawLocal);
    result.checks.push(check('syntax', 'Address format', 'fail', localScripts.mixedScript
      ? localScripts.hint
      : 'Not a valid email format'));
    const s = suggestDomain(domain);
    if (s) result.suggestion = `${local}@${s}`;
    return finish();
  }
  result.checks.push(check('syntax', 'Address format', 'pass', 'Correctly formatted address'));

  // ---- 1b. Provider-aware canonical form -------------------------------
  // j.o.h.n+shop@googlemail.com and john@gmail.com are one mailbox. The
  // canonical form is the right de-duplication key and the right probe target.
  const canon = canonicalize(local, domain);
  result.meta.canonical = canon.canonical;
  if (canon.changed) {
    result.checks.push(check('canonical', 'Same inbox', 'info', canon.notes.join('; ')));
  }

  // ---- 1c. Look-alike characters ---------------------------------------
  // Mixed scripts are flagged immediately: a Cyrillic "а" among Latin letters
  // is spoofing, not a typo. ASCII confusables (I/l/1) are held back until we
  // know the mailbox is missing - see below - so they do not become noise.
  const lookalike = detectLookalikes(rawLocal);
  result.meta.lookalike = lookalike;

  // A domain that renders as a well-known one but is not it. Unlike a typo this
  // is deliberate, so it gets no suggestion and never reaches DNS: the
  // impersonating domain may well resolve and have working MX records, and
  // passing it down the chain is exactly how it would come back "valid".
  const spoof = detectDomainSpoof(rawDomain, POPULAR_DOMAINS);
  result.meta.domainSpoof = spoof;
  if (spoof.spoof) {
    result.checks.push(check('lookalike', 'Look-alike characters', 'fail', spoof.hint));
    result.suggestion = `${local}@${spoof.impersonates}`;
    result.verdict = 'invalid';
    result.score = 0;
    return finish();
  }

  // ---- 2. Typo suggestion ---------------------------------------------
  const suggested = suggestDomain(domain);
  if (suggested) {
    result.suggestion = `${local}@${suggested}`;
    result.checks.push(check('typo', 'Typo check', 'warn', `Looks like a typo. Did you mean ${suggested}?`));
  } else {
    result.checks.push(check('typo', 'Typo check', 'pass', 'Spelled correctly, no typo found'));
  }

  // ---- 3. Disposable ---------------------------------------------------
  const isDisposable = deps.disposable?.has(domain) ?? false;
  result.meta.disposable = isDisposable;
  result.checks.push(isDisposable
    ? check('disposable', 'Disposable address', 'fail', 'A temporary throwaway inbox')
    : check('disposable', 'Disposable address', 'pass', 'A real domain, not a throwaway'));

  // ---- 4. Role account --------------------------------------------------
  const isRole = ROLE_ACCOUNTS.has(local);
  result.meta.role = isRole;
  result.checks.push(isRole
    ? check('role', 'Inbox type', 'warn', 'A shared team address, not one person\u2019s inbox')
    : check('role', 'Inbox type', 'pass', 'A personal inbox'));

  // ---- 5 & 6. Domain + MX records ----------------------------------------
  const dns = await lookupDomain(domain);
  result.meta.mx = dns.mx;
  result.meta.provider = dns.provider;
  result.meta.free = isFreeProvider(domain);

  if (!dns.domainExists) {
    // Distinguish "the domain really is not registered" from "we could not ask".
    // Treating a DNS outage as a bad address would be a false negative.
    if (dns.error) {
      result.checks.push(check('domain', 'Domain', 'skip', `Domain lookup unavailable (${dns.error})`));
      result.checks.push(check('mx', 'Mail servers', 'skip', 'Not checked, domain lookup unavailable'));
      result.verdict = 'unknown';
      result.score = 50;
      return finish();
    }
    result.checks.push(check('domain', 'Domain', 'fail', 'This domain is not registered'));
    result.checks.push(check('mx', 'Mail servers', 'skip', 'Not checked, the domain is not registered'));
    result.verdict = 'invalid';
    result.score = 0;
    return finish();
  }
  result.checks.push(check('domain', 'Domain', 'pass', 'Registered and live'));

  if (!dns.mx.length) {
    result.checks.push(check('mx', 'Mail servers', 'fail', dns.nullMx
      // RFC 7505 null MX - the domain has explicitly opted out of email.
      ? 'This domain publishes a null MX and accepts no email'
      : 'Domain cannot receive email'));
    result.verdict = 'invalid';
    result.score = 10;
    return finish();
  }

  const mxDetail = dns.implicitMx
    ? 'No mail server listed, falling back to the domain itself'
    : `Ready to receive mail · ${dns.mx.length} server${dns.mx.length > 1 ? 's' : ''}${dns.provider ? ' · ' + dns.provider : ''}`;
  result.checks.push(check('mx', 'Mail servers', dns.implicitMx ? 'warn' : 'pass', mxDetail));

  // ---- 6b. Who actually runs this mailbox ---------------------------------
  // Decided from the MX hosts, so a company on Yahoo's or Mimecast's servers
  // inherits that infrastructure's behaviour regardless of its domain name.
  // Drives both the verdict policy below and the per-provider throttle.
  const infra = verifiability(dns.mx.map(m => m.exchange), domain);
  result.meta.infra = infra;

  // ---- 7. Domain intelligence (SPF / DMARC / age) -------------------------
  // Started here but awaited after SMTP, so the two run concurrently and the
  // DNS and RDAP lookups cost no extra wall-clock time.
  const wantIntel = opts.intel ?? true;
  const intelPromise = wantIntel
    ? getDomainIntel(domain).catch(() => null)
    : Promise.resolve(null);

  // ---- 7b. Microsoft directory (concurrent with SMTP) ---------------------
  // The one provider whose mailboxes can be confirmed without SMTP at all.
  // Resolves to null for every domain Microsoft does not handle, so the rest
  // of the pipeline is unchanged; for the ones it does, it is the only signal
  // that can beat an 'unreliable' farm or a gateway that accepts everything.
  const wantOracle = opts.oracle ?? true;
  const mxHosts = dns.mx.map(m => m.exchange);
  // Microsoft and Yahoo both expose a directory outside SMTP; each returns
  // null for domains it does not handle, so running them in parallel and
  // keeping the first non-null answer costs nothing on the wrong provider.
  // Yahoo's browser probe needs Chrome and a good IP, so it can be delegated to
  // the same VPS worker the SMTP probe runs on (deps.yahooMailbox) instead of
  // the managed host, which has neither.
  const yahooProbe = deps.yahooMailbox ?? yahooMailbox;
  const oraclePromise = wantOracle
    ? Promise.all([
        microsoftMailbox(canon.canonical, mxHosts).catch(() => null),
        yahooProbe(canon.canonical, mxHosts).catch(e => {
          console.error('[yahoo-oracle]', e.message); return null;
        })
      ]).then(([ms, yh]) => ms || yh)
    : Promise.resolve(null);

  // ---- 8 & 9. SMTP mailbox + catch-all (opt-in) ---------------------------
  // A remote worker counts as SMTP being available, even though this process
  // cannot open port 25 itself.
  const probe = deps.verifyMailbox ?? verifyMailbox;
  const wantSmtp = opts.smtp ?? (smtpEnabled() || Boolean(deps.verifyMailbox));
  if (wantSmtp) {
    // Probe the canonical address: it is the mailbox that actually exists,
    // and it keeps the per-domain catch-all cache from fragmenting.
    const smtp = await probe(canon.canonical, dns.mx.map(m => m.exchange));
    result.meta.smtp = smtp;

    // The directory answer is evidence about this mailbox specifically, so it
    // outranks the farm's reputation: a confirmed account makes an
    // 'unreliable' 250 trustworthy, and a confirmed absence stands even when
    // the mail server happily accepted the address.
    const oracle = await oraclePromise;
    result.meta.msOracle = oracle;
    const oracleConfirmed = oracle?.status === 'exists';
    // Any definitive answer (exists OR no-mailbox) means we HAVE a verdict,
    // so the "provider doesn't confirm" fallback no longer applies.
    const oracleAnswered = oracle?.status === 'exists' || oracle?.status === 'no-mailbox';

    // Each status maps to its own honest row. "blocked" and "greylisted" are
    // deliberately NOT failures: they say nothing about the mailbox. A 250
    // from a provider whose own "250" is not trustworthy (Yahoo-family and
    // friends - see lib/providers.js) is not a pass either, even when this
    // conversation's canaries happened to come back rejected.
    const deliverableRow = (infra.selfVerifiable || oracleConfirmed)
      ? ['pass', smtp.detail]
      : ['skip', unverifiableReason(infra.group, infra.trust)];
    const MAILBOX_ROW = {
      deliverable:    deliverableRow,
      undeliverable:  ['fail', smtp.detail],
      'mailbox-disabled': ['warn', smtp.detail],
      'mailbox-full': ['warn', smtp.detail],
      'catch-all':    ['warn', 'This domain accepts every address, so the inbox cannot be confirmed'],
      blocked:        ['skip', smtp.detail],
      greylisted:     ['skip', smtp.detail],
      unknown:        ['skip', smtp.detail]
    };
    const [status, detail] = MAILBOX_ROW[smtp.status] || ['skip', smtp.detail];
    result.checks.push(check('smtp', 'Inbox', status, detail));

    if (smtp.catchAll === true) {
      result.checks.push(check('catchall', 'Accepts-all domain', 'warn', 'This domain accepts mail sent to any address'));
    } else if (smtp.catchAll === false) {
      result.checks.push(check('catchall', 'Accepts-all domain', 'pass', 'No, unknown addresses are rejected'));
    } else {
      result.checks.push(check('catchall', 'Accepts-all domain', 'skip', 'Could not be determined'));
    }

    // Say out loud when the provider itself is the reason we will not claim a
    // verdict. Without this row the user sees "accepted" next to "unknown"
    // and reasonably assumes the tool is broken. Suppressed when the directory
    // answered (exists OR no-mailbox) - we have a verdict either way.
    if (!infra.selfVerifiable && !oracleAnswered && smtp.status !== 'undeliverable') {
      result.checks.push(check('provider', 'Provider policy', 'warn',
        unverifiableReason(infra.group, infra.trust)));
    }
  } else {
    result.checks.push(check('smtp', 'Inbox', 'skip', 'Deep inbox verification is turned off'));
    // No SMTP, but the directory is an HTTPS lookup and still works here -
    // on a host with no port 25 this is the only mailbox evidence available.
    result.meta.msOracle = await oraclePromise;
  }

  // ---- 9b. Directory row --------------------------------------------------
  const oracle = result.meta.msOracle;
  if (oracle) {
    const ORACLE_ROW = {
      exists: ['pass', oracle.reason],
      'no-mailbox': ['fail', oracle.reason],
      unknown: ['skip', oracle.reason]
    };
    const [status, detail] = ORACLE_ROW[oracle.status] || ['skip', oracle.reason];
    // Friendly, non-technical row label so the user sees a plain answer
    // (not "sign-in" or "directory") about whether their email is real.
    result.checks.push(check('directory', 'Account status', status, detail));
  }

  // The mailbox is missing and the address contains shape-alike characters.
  // This is exactly when "check the I against the l" is worth saying, and the
  // only time it is not noise.
  if (result.meta.smtp?.status === 'undeliverable'
      && lookalike.confusable && !lookalike.mixedScript) {
    result.checks.push(check('lookalike', 'Look-alike characters', 'warn', lookalike.hint));
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
      result.checks.push(check('auth', 'Sender protection', 'warn',
        'No SPF or DMARC record, the domain publishes no mail policy'));
    } else if (!dmarc.present) {
      result.checks.push(check('auth', 'Sender protection', 'warn',
        `${parts.join(', ')}, no DMARC policy published`));
    } else if (!spfEnforcing && !dmarcEnforcing) {
      // Both records exist and neither asks receivers to act on a failure.
      result.checks.push(check('auth', 'Sender protection', 'warn',
        `${parts.join(' · ')}, published but not enforced`));
    } else if (!dmarcEnforcing) {
      result.checks.push(check('auth', 'Sender protection', 'warn',
        `${parts.join(' · ')}, DMARC is monitor-only`));
    } else {
      result.checks.push(check('auth', 'Sender protection', 'pass', parts.join(' · ')));
    }

    // Registration age. Unknown is common and is not a negative signal.
    if (age.known) {
      const days = age.ageDays;
      const withCommas = days.toLocaleString('en-US');
      // Show both units once a domain is old enough that days alone stop
      // being readable - "11,571 days" and "31.7 years" answer different questions.
      const label = days < 365
        ? `${withCommas} days`
        : `${(days / 365).toFixed(1)} years (${withCommas} days)`;

      const AGE_ROW = {
        'very-new': ['fail', `Brand new, registered just ${withCommas} days ago`],
        'new':      ['warn', `Recently created, registered ${withCommas} days ago`],
        'young':    ['warn', `Still young, established ${label} ago`]
      };
      const [status, detail] = AGE_ROW[ageRisk] || ['pass', `Well established, ${label} old`];
      result.checks.push(check('age', 'Domain age', status, detail));
    } else {
      result.checks.push(check('age', 'Domain age', 'skip',
        age.reason === 'not-in-registry'
          ? 'This domain extension does not publish a registration date'
          : 'Registration date not published'));
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
  const oracle = result.meta.msOracle;

  // Hard evidence the mailbox is gone.
  if (smtp?.status === 'undeliverable') {
    result.verdict = 'invalid';
    result.score = 2;
    return;
  }

  // Microsoft's own directory says there is no such account. On this farm that
  // is stronger than anything SMTP returns, including an accepted RCPT TO:
  // accepting mail for missing accounts is exactly the behaviour that makes
  // the farm 'unreliable' in the first place.
  if (oracle?.status === 'no-mailbox') {
    result.verdict = 'invalid';
    result.score = 3;
    return;
  }

  // A confirmed account is per-mailbox evidence, so it answers the questions
  // SMTP could not: a catch-all domain, a gateway that accepts everything, a
  // refused probe and an untrustworthy 250 all stop mattering once the
  // directory has named this specific account. Only the rows above outrank it.
  const oracleConfirmed = oracle?.status === 'exists';

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

  // The directory was asked and could not answer - throttled, federated
  // elsewhere, or a tenant that hides its accounts. On a Microsoft-backed
  // domain that is the end of the evidence, because the farm's own 250 is
  // already known to be worthless. Falling through to DNS-only confidence
  // here would report "valid" for an address nothing has confirmed, on
  // exactly the infrastructure this whole policy exists to be careful about.
  if (oracle?.status === 'unknown') {
    result.verdict = 'unknown';
    result.score = 50;
    return;
  }

  // Genuinely undeterminable: the domain takes everything.
  if (smtp?.status === 'catch-all' && !oracleConfirmed) {
    result.verdict = 'unknown';
    result.score = 55;
    return;
  }

  // We reached the server and it refused or deferred us. It CAN answer, it
  // just would not answer us - so "unknown" is the only honest verdict.
  if ((smtp?.status === 'blocked' || smtp?.status === 'greylisted') && !oracleConfirmed) {
    result.verdict = 'unknown';
    result.score = 50;
    return;
  }

  // status 'unknown' means the SMTP conversation never happened at all: the
  // connection timed out, was reset, or port 25 is closed. We learned nothing
  // about the mailbox, so the only honest verdict is "unknown".
  //
  // This used to fall through to DNS-level confidence and report "valid",
  // which is the single worst failure mode a validator can have: under a bulk
  // run, providers that throttle (Yahoo, Comcast) start dropping connections
  // partway through, and every dropped connection became a confirmed-looking
  // "valid". The deeper the run, the more false positives - silently.
  //
  // SMTP_UNKNOWN_FALLBACK=true restores the old behaviour for a deployment
  // that has no port 25 at all and wants DNS-only scoring rather than a page
  // of "unknown". It is opt-in precisely because it cannot tell "this host
  // has no port 25" apart from "this provider just dropped us".
  if (smtp && smtp.status === 'unknown' && !unknownFallbackEnabled() && !oracleConfirmed) {
    result.verdict = 'unknown';
    result.score = 50;
    return;
  }

  // A provider that accepts mail for addresses that do not exist cannot
  // confirm anything by accepting ours - and that stays true even when this
  // conversation's own canaries got rejected. Yahoo's huge farm answers
  // inconsistently per connection: it has accepted a real-looking address
  // and then refused the very next canary RCPT in the same session, which
  // used to read as "proven not catch-all" and let a made-up address through
  // as a confirmed "valid" mailbox. A clean canary disproof is not strong
  // enough evidence on infrastructure this provider's own 250 is already
  // known to be unreliable, so it is never treated as valid here.
  const infra = result.meta.infra;
  if (smtp?.status === 'deliverable' && infra && !infra.selfVerifiable && !oracleConfirmed) {
    result.verdict = 'unknown';
    result.score = 50;
    return;
  }

  if (result.suggestion) {
    result.verdict = 'risky';
    result.score = 45;
    return;
  }

  // SMTP confirmed delivery on a non-catch-all domain is the strongest
  // positive signal available without sending a real message.
  let score = (smtp?.status === 'deliverable' || oracleConfirmed) ? 97 : 85;
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
