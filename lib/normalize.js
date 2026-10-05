/**
 * Provider-aware address normalisation.
 *
 * Two addresses can be different strings and the same mailbox:
 *   j.o.h.n+shop@googlemail.com  ==  john@gmail.com
 *
 * Canonicalising gives a correct de-duplication key for bulk lists and stops
 * the same mailbox being probed several times.
 *
 * The dot rule is the dangerous one: it is true for CONSUMER gmail.com and
 * googlemail.com only. On a Google Workspace custom domain dots ARE
 * significant, so applying it there would merge two different people.
 */

/** Domains where "+tag" is a documented alias of the base mailbox. */
const PLUS_TAG_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'proton.me', 'protonmail.com', 'pm.me',
  'fastmail.com', 'icloud.com', 'me.com', 'mac.com',
  'zoho.com', 'zohomail.com',
  'yandex.com', 'yandex.ru'
]);

/** Domains where dots in the local part are ignored. Consumer Google only. */
const DOT_BLIND_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Domains that are the same mailbox under a different name. */
const DOMAIN_ALIASES = new Map([
  ['googlemail.com', 'gmail.com']
]);

/**
 * @param {string} local   local part, already lowercased
 * @param {string} domain  ASCII domain, already lowercased
 * @returns {{local, domain, canonical, changed, notes:string[]}}
 */
export function canonicalize(local, domain) {
  const notes = [];
  let l = String(local || '').toLowerCase();
  let d = String(domain || '').toLowerCase();

  const aliased = DOMAIN_ALIASES.get(d);
  if (aliased) {
    notes.push(`${d} is an alias of ${aliased}`);
    d = aliased;
  }

  if (PLUS_TAG_DOMAINS.has(d)) {
    const plus = l.indexOf('+');
    // Keep the whole thing when the local part is only a tag ("+tag@...").
    if (plus > 0) {
      notes.push(`"+${l.slice(plus + 1)}" is a tag, not part of the mailbox`);
      l = l.slice(0, plus);
    }
  }

  if (DOT_BLIND_DOMAINS.has(d) && l.includes('.')) {
    notes.push('Google ignores dots in the local part');
    l = l.replaceAll('.', '');
  }

  const canonical = `${l}@${d}`;
  return {
    local: l,
    domain: d,
    canonical,
    changed: canonical !== `${String(local).toLowerCase()}@${String(domain).toLowerCase()}`,
    notes
  };
}

/**
 * True when the domain is consumer Google. Google Workspace domains route
 * through the same MX servers but do NOT share the dot rule, so this is
 * deliberately an exact-domain test rather than an MX test.
 */
export const isConsumerGoogle = (domain) =>
  DOT_BLIND_DOMAINS.has(String(domain || '').toLowerCase());
