/**
 * The set of real top-level domains.
 *
 * This exists to stop edit-distance from "correcting" valid TLDs:
 * .io -> .in, .dev -> .de, .co -> .com, .so -> .io. Those are real domains
 * (mailtrap.io, stripe.dev, notion.so) and flagging them as misspelt is worse
 * than staying quiet.
 *
 * A hand-maintained allowlist can never be complete - there are ~1,440 TLDs
 * and the list changes. So the authoritative list is pulled from IANA and
 * cached; the static set below is only a fallback for the first boot or an
 * offline host.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCE = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

/** Enough of the common TLDs to behave sensibly before the list loads. */
const FALLBACK = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name',
  'pro', 'mobi', 'tel', 'travel', 'jobs', 'coop', 'aero', 'museum',
  'io', 'co', 'me', 'tv', 'cc', 'ai', 'app', 'dev', 'xyz', 'online', 'site',
  'shop', 'store', 'tech', 'cloud', 'email', 'live', 'life', 'world', 'today',
  'space', 'page', 'blog', 'design', 'digital', 'agency', 'studio', 'media',
  'network', 'systems', 'solutions', 'group', 'team', 'works', 'zone', 'link',
  'so', 'ly', 'sh', 'gg', 'im', 'to', 'fm', 'am', 'st', 'ws', 'nu', 'la',
  'uk', 'de', 'fr', 'it', 'es', 'nl', 'be', 'ch', 'at', 'se', 'no', 'dk',
  'fi', 'pl', 'ru', 'ua', 'cz', 'gr', 'pt', 'ie', 'ro', 'hu', 'bg', 'hr',
  'sk', 'si', 'lt', 'lv', 'ee', 'is', 'lu', 'mt', 'cy', 'rs', 'eu',
  'us', 'ca', 'mx', 'br', 'ar', 'cl', 'pe', 've', 'uy', 'ec', 'cr', 'pa',
  'in', 'cn', 'jp', 'kr', 'tw', 'hk', 'sg', 'my', 'th', 'id', 'ph', 'vn',
  'pk', 'bd', 'lk', 'np', 'au', 'nz', 'asia',
  'za', 'ng', 'ke', 'gh', 'eg', 'ma', 'tn', 'il', 'ae', 'sa', 'qa', 'kw',
  'tr', 'ir', 'iq'
]);

let current = FALLBACK;
let source = 'fallback';
let updatedAt = null;
let timer = null;

/** True when the TLD is a real one. Case-insensitive. */
export const isKnownTld = (tld) =>
  current.has(String(tld || '').toLowerCase());

export const tldCount = () => current.size;
export const tldSource = () => source;
export const tldUpdatedAt = () => updatedAt;

function parse(raw) {
  const set = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim().toLowerCase();
    if (!t || t.startsWith('#')) continue;
    set.add(t);
  }
  return set;
}

/**
 * Load from the on-disk cache immediately, then refresh from IANA in the
 * background. Never blocks boot and never throws.
 */
export async function initTlds({ dataDir = './data', offline = false } = {}) {
  const cacheFile = join(dataDir, 'tlds.txt');

  try {
    const parsed = parse(await readFile(cacheFile, 'utf8'));
    if (parsed.size > 500) {
      current = parsed;
      source = 'disk';
    }
  } catch {
    // no cache yet - fallback stays in place
  }

  const refresh = async () => {
    try {
      const res = await fetch(SOURCE, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return false;
      const parsed = parse(await res.text());
      // Sanity check: a truncated download must not shrink the list.
      if (parsed.size < 500) return false;

      for (const t of FALLBACK) parsed.add(t);
      current = parsed;
      source = 'iana';
      updatedAt = new Date().toISOString();
      await writeFile(cacheFile, [...parsed].join('\n'), 'utf8').catch(() => {});
      return true;
    } catch {
      return false;
    }
  };

  if (!offline) {
    refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
    timer.unref?.();
  }

  return { count: tldCount(), source };
}
