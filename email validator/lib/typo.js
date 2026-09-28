/**
 * Typo detection for common mail domains.
 * Damerau-Levenshtein distance, so transpositions (gmial) score as one edit.
 */
import { isKnownTld } from './tlds.js';

/**
 * Webmail anyone can sign up for without paying or buying another service.
 * This is what "free provider" means to a sender: zero cost to create, so
 * zero cost to abandon or create in bulk.
 */
const FREE_PROVIDERS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.in',
  'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'outlook.in', 'live.com',
  'msn.com', 'aol.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'zoho.com', 'zohomail.com',
  'gmx.com', 'gmx.de', 'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru',
  'rediffmail.com', 'tutanota.com',
  'web.de', 'qq.com', '163.com', '126.com', 'naver.com', 'daum.net'
];

/**
 * Domains that are common enough to be worth correcting towards, but are NOT
 * free signups: ISP mailboxes that come with a paid broadband line, and paid
 * mail hosts. Someone on comcast.net pays their ISP and a hey.com mailbox is
 * a subscription - calling either "free" tells the sender the wrong thing.
 */
const PAID_DOMAINS = [
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
  'btinternet.com', 'orange.fr', 'free.fr', 't-online.de',
  'fastmail.com', 'hey.com'
];

/** Everything worth spell-checking against, free or not. */
const POPULAR_DOMAINS = [...FREE_PROVIDERS, ...PAID_DOMAINS];

/** TLDs we are willing to correct *towards*. */
const POPULAR_TLDS = [
  'com', 'net', 'org', 'edu', 'gov', 'co.uk', 'co.in', 'in', 'io',
  'de', 'fr', 'ru', 'jp', 'br', 'au', 'ca', 'info', 'biz', 'me', 'dev'
];

/** Damerau-Levenshtein edit distance. */
export function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const d = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) d[i][0] = i;
  for (let j = 0; j < cols; j++) d[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,      // deletion
        d[i][j - 1] + 1,      // insertion
        d[i - 1][j - 1] + cost // substitution
      );
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[rows - 1][cols - 1];
}

/**
 * Suggest a corrected domain, or null when the domain looks fine.
 * Threshold scales with length so short domains do not over-match.
 */
export function suggestDomain(domain) {
  if (!domain) return null;
  const lower = domain.toLowerCase();

  // Punycode domains have no meaningful edit distance to an ASCII brand name.
  if (lower.includes('xn--')) return null;

  // Exact match against a known-good domain: nothing to suggest.
  if (POPULAR_DOMAINS.includes(lower)) return null;

  let best = null;
  let bestScore = Infinity;

  for (const candidate of POPULAR_DOMAINS) {
    const d = distance(lower, candidate);
    if (d < bestScore) {
      bestScore = d;
      best = candidate;
    }
  }

  const threshold = lower.length <= 6 ? 1 : lower.length <= 12 ? 2 : 3;
  if (best && bestScore > 0 && bestScore <= threshold) return best;

  // Domain body is fine but the TLD looks mistyped (example.cmo -> example.com).
  // Only ever fires on a TLD that is not itself real - see tlds.js.
  const lastDot = lower.lastIndexOf('.');
  if (lastDot > 0) {
    const base = lower.slice(0, lastDot);
    const tld = lower.slice(lastDot + 1);
    if (!isKnownTld(tld)) {
      for (const goodTld of POPULAR_TLDS) {
        if (tld !== goodTld && distance(tld, goodTld) === 1) {
          return `${base}.${goodTld}`;
        }
      }
    }
  }

  return null;
}

const FREE_SET = new Set(FREE_PROVIDERS);

/** True only for mailboxes that cost nothing to create. */
export function isFreeProvider(domain) {
  return FREE_SET.has(String(domain || '').toLowerCase());
}
