/**
 * Domain-level risk signals: SPF, DMARC, and registration age.
 *
 * None of these prove a mailbox exists - that is the SMTP layer's job. They
 * answer a different question: "is this domain one a real organisation runs,
 * or one somebody stood up last Tuesday?"
 *
 * A domain registered four days ago with no SPF and no DMARC is a throwaway
 * or a phishing setup even when the mailbox genuinely accepts mail. These
 * signals downgrade confidence; they never declare an address invalid.
 */
import { query } from './dns-check.js';
import { TTLCache } from './cache.js';

// Auth records change occasionally; registration dates effectively never do.
const authCache = new TTLCache({ ttl: 6 * 60 * 60 * 1000, max: 20000 });
const ageCache = new TTLCache({ ttl: 7 * 24 * 60 * 60 * 1000, max: 20000 });

// A timeout is not an answer. Caching one in the long-lived cache would hide
// a real registration date for a week, which is exactly what happened on a
// cold start when the first request raced the bootstrap download.
const ageFailCache = new TTLCache({ ttl: 10 * 60 * 1000, max: 5000 });

const RDAP_TIMEOUT = Number(process.env.RDAP_TIMEOUT || 6000);
const RDAP_ENABLED = String(process.env.RDAP_CHECK ?? 'true').toLowerCase() !== 'false';

/** TXT records arrive as arrays of chunks that must be joined before parsing. */
const flattenTxt = (records) =>
  (records || []).map(r => (Array.isArray(r) ? r.join('') : String(r)));

/**
 * SPF lives in a TXT record on the domain itself.
 * "-all" (hard fail) and "~all" (soft fail) are enforcing; "?all" and "+all"
 * are effectively no policy at all.
 */
function parseSpf(txts) {
  const record = txts.find(t => /^v=spf1\b/i.test(t.trim()));
  if (!record) return { present: false, policy: null, record: null };

  let policy = 'neutral';
  if (/[-]all\s*$/i.test(record)) policy = 'strict';
  else if (/~all\s*$/i.test(record)) policy = 'soft';
  else if (/\+all\s*$/i.test(record)) policy = 'open';

  return { present: true, policy, record: record.slice(0, 200) };
}

/** DMARC lives at _dmarc.<domain>. p= is the policy that matters. */
function parseDmarc(txts) {
  const record = txts.find(t => /^v=DMARC1\b/i.test(t.trim()));
  if (!record) return { present: false, policy: null, record: null };

  const m = record.match(/\bp\s*=\s*(none|quarantine|reject)\b/i);
  return {
    present: true,
    policy: m ? m[1].toLowerCase() : 'none',
    record: record.slice(0, 200)
  };
}

async function lookupAuth(domain) {
  const cached = authCache.get(domain);
  if (cached) return cached;

  const [spfRes, dmarcRes] = await Promise.all([
    query('resolveTxt', domain).catch(() => ({ records: null })),
    query('resolveTxt', `_dmarc.${domain}`).catch(() => ({ records: null }))
  ]);

  const out = {
    spf: parseSpf(flattenTxt(spfRes.records)),
    dmarc: parseDmarc(flattenTxt(dmarcRes.records))
  };
  authCache.set(domain, out);
  return out;
}

const UA = 'email-validator/1.0 (+domain age check)';

/**
 * IANA's RDAP bootstrap maps each TLD to its authoritative RDAP server.
 * Going straight to the registry avoids the public rdap.org redirector,
 * which rate-limits and 403s unknown clients.
 * Loaded once per process, refreshed weekly.
 */
let bootstrapPromise = null;
let bootstrapAt = 0;

async function getBootstrap() {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  if (bootstrapPromise && Date.now() - bootstrapAt < WEEK) return bootstrapPromise;

  bootstrapAt = Date.now();
  bootstrapPromise = (async () => {
    try {
      const res = await fetch('https://data.iana.org/rdap/dns.json', {
        signal: AbortSignal.timeout(RDAP_TIMEOUT),
        headers: { accept: 'application/json', 'user-agent': UA }
      });
      if (!res.ok) return null;
      const data = await res.json();

      const map = new Map();
      for (const [tlds, urls] of data.services || []) {
        const base = urls.find(u => u.startsWith('https://')) || urls[0];
        if (!base) continue;
        for (const tld of tlds) map.set(tld.toLowerCase(), base.replace(/\/?$/, '/'));
      }
      return map.size ? map : null;
    } catch {
      return null;
    }
  })();

  // A failed download must not be remembered for a week - drop it so the
  // next caller retries instead of every domain reporting "unavailable".
  bootstrapPromise.then(map => {
    if (!map) { bootstrapPromise = null; bootstrapAt = 0; }
  });

  return bootstrapPromise;
}

/** Load the bootstrap ahead of the first request so nothing races it. */
export const warmup = () => getBootstrap().catch(() => null);

/**
 * Registration date via RDAP - the structured successor to WHOIS.
 * Many ccTLDs (.io, .de, .co.uk among them) publish no RDAP service at all,
 * so "unknown" is a completely normal outcome and never counts against a domain.
 */
async function lookupAge(domain) {
  if (!RDAP_ENABLED) return { known: false, reason: 'disabled' };

  const cached = ageCache.get(domain) || ageFailCache.get(domain);
  if (cached) return cached;

  let out = { known: false, reason: 'unavailable' };
  try {
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    const map = await getBootstrap();
    const base = map?.get(tld);

    if (!base) {
      out = { known: false, reason: 'not-in-registry' };
    } else {
      const res = await fetch(`${base}domain/${encodeURIComponent(domain)}`, {
        signal: AbortSignal.timeout(RDAP_TIMEOUT),
        headers: { accept: 'application/rdap+json', 'user-agent': UA }
      });

      if (res.status === 404) {
        // The registry answered and has no such domain.
        out = { known: false, reason: 'not-registered' };
      } else if (res.ok) {
        const data = await res.json();
        const reg = (data.events || []).find(e => e.eventAction === 'registration');
        if (reg?.eventDate) {
          const registered = new Date(reg.eventDate);
          if (!Number.isNaN(registered.getTime())) {
            out = {
              known: true,
              registered: registered.toISOString(),
              ageDays: Math.max(0, Math.floor((Date.now() - registered.getTime()) / 86400000))
            };
          }
        }
      }
    }
  } catch {
    // Timeouts and network errors are normal here - never block on RDAP.
    out = { known: false, reason: 'lookup-failed' };
  }

  // Definitive answers are cached for a week; "we could not ask" is retried
  // in ten minutes. 'not-in-registry' is definitive: that TLD runs no RDAP.
  const definitive = out.known || out.reason === 'not-in-registry';
  (definitive ? ageCache : ageFailCache).set(domain, out);
  return out;
}

/**
 * @returns {Promise<{spf, dmarc, age, authScore:number, ageRisk:?string}>}
 */
export async function getDomainIntel(domain) {
  const d = String(domain || '').toLowerCase();
  const [auth, age] = await Promise.all([lookupAuth(d), lookupAge(d)]);

  // How seriously does this domain take its own mail identity?
  let authScore = 0;
  if (auth.spf.present) authScore += auth.spf.policy === 'open' ? 5 : 15;
  if (auth.dmarc.present) {
    authScore += auth.dmarc.policy === 'reject' ? 20
      : auth.dmarc.policy === 'quarantine' ? 15 : 8;
  }

  let ageRisk = null;
  if (age.known) {
    if (age.ageDays < 30) ageRisk = 'very-new';
    else if (age.ageDays < 90) ageRisk = 'new';
    else if (age.ageDays < 365) ageRisk = 'young';
  }

  return { spf: auth.spf, dmarc: auth.dmarc, age, authScore, ageRisk };
}

export const intelCacheSize = () => authCache.size + ageCache.size;
