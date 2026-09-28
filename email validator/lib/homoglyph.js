/**
 * Look-alike character detection.
 *
 * Two separate problems:
 *
 * 1. Mixed scripts. A Cyrillic "а" is not a Latin "a" but renders identically.
 *    Addresses mixing scripts are almost always spoofing attempts, so this is
 *    always worth a warning.
 *
 * 2. ASCII confusables. Capital I, lowercase l and digit 1 are the same shape
 *    in many fonts, as are capital O and zero. Nobody wants a warning on every
 *    address containing an "l", so this is surfaced only when the mailbox came
 *    back as missing - at that point "check the I vs l" is the single most
 *    useful thing to say.
 *
 * Detection runs on the RAW local part. Lowercasing destroys the evidence:
 * "AdriaMartinIctj5" and "adriamartinlctj5" normalise to different strings,
 * but the capital I is only visible before the address is folded.
 */

/**
 * Characters that render alike, grouped by shape.
 *
 * Kept deliberately narrow. Wider sets (5/S, 8/B, 2/Z, lowercase o vs 0) only
 * confuse in stylised fonts and are not what people actually mistype - they
 * fired on ordinary names like "john" and made the warning worthless.
 */
const CONFUSABLE_GROUPS = [
  { label: 'I / l / 1', chars: new Set(['I', 'l', '1', '|']) },
  { label: 'O / 0',     chars: new Set(['O', '0']) }
];

/** Sequences that read as a single different letter. */
const SEQUENCE_CONFUSABLES = [
  { pattern: /rn/, label: '"rn" reads as "m"' },
  { pattern: /vv/, label: '"vv" reads as "w"' }
];

const SCRIPT_RANGES = [
  { name: 'Cyrillic', re: /[Ѐ-ӿԀ-ԯ]/ },
  { name: 'Greek',    re: /[Ͱ-Ͽ]/ },
  { name: 'Armenian', re: /[԰-֏]/ },
  { name: 'Hebrew',   re: /[֐-׿]/ },
  { name: 'Arabic',   re: /[؀-ۿ]/ }
];

const HAS_LATIN = /[A-Za-z]/;

/**
 * @param {string} rawLocal  local part exactly as typed, before lowercasing
 * @returns {{
 *   mixedScript: boolean, scripts: string[],
 *   confusable: boolean, groups: string[], hint: ?string
 * }}
 */
export function detectLookalikes(rawLocal) {
  const local = String(rawLocal || '');

  // ---- mixed scripts -------------------------------------------------
  const scripts = SCRIPT_RANGES.filter(s => s.re.test(local)).map(s => s.name);
  const mixedScript = scripts.length > 0 && HAS_LATIN.test(local);

  // ---- ASCII confusables ---------------------------------------------
  const groups = [];
  for (const group of CONFUSABLE_GROUPS) {
    // Only interesting when at least one of the shape-alike characters is
    // present; a single "1" is still worth mentioning on a failed lookup.
    if ([...local].some(c => group.chars.has(c))) groups.push(group.label);
  }
  for (const seq of SEQUENCE_CONFUSABLES) {
    if (seq.pattern.test(local)) groups.push(seq.label);
  }

  let hint = null;
  if (mixedScript) {
    hint = `Contains ${scripts.join(' and ')} characters mixed with Latin - `
         + 'these look identical but are different letters';
  } else if (groups.length) {
    hint = `Contains look-alike characters (${groups.join(', ')}) - `
         + 'worth re-checking against the original';
  }

  return { mixedScript, scripts, confusable: groups.length > 0, groups, hint };
}
