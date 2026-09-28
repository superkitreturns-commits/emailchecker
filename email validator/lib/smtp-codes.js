/**
 * SMTP reply classification.
 *
 * The three-digit code is not enough. These two are both 550 and mean
 * opposite things:
 *
 *   550 5.1.1  The email account does not exist   -> the mailbox is dead
 *   550 5.7.1  blocked using Spamhaus             -> WE are blocked
 *
 * Treating the second as "invalid" marks real, working addresses as dead.
 * That is the worst failure a validator can have, so everything here exists
 * to keep those two cases apart.
 *
 * Measured against live servers (2026-09-23):
 *   Gmail   RCPT -> 550 5.1.1  account does not exist        (honest)
 *   Zoho    RCPT -> 550 5.1.1  User does not exist           (honest)
 *   Proton  RCPT -> 550 5.1.1  Address does not exist        (honest)
 *   iCloud  RCPT -> 550 5.7.1  listed in Spamhaus SBL        (blocked)
 *   Outlook MAIL -> 550 5.7.1  blocked using Spamhaus        (blocked)
 *   Yahoo   MAIL -> 550 5.7.25 reverse DNS failed            (blocked)
 */

/** Enhanced status codes that genuinely mean "this mailbox is not there". */
const NO_MAILBOX = new Set([
  '5.1.0', // other address status
  '5.1.1', // bad destination mailbox address
  '5.1.2', // bad destination system
  '5.1.3', // bad destination mailbox syntax
  '5.1.6', // mailbox has moved, no forwarding
  '5.5.0'  // generic permanent failure, used by some for unknown user
]);

// Deliberately NOT in NO_MAILBOX:
//
//   5.2.1  RFC 3463 calls this "mailbox disabled, not accepting messages".
//          The mailbox EXISTS - it is suspended, inactive or has mail turned
//          off. Google says so literally: "The email account that you tried
//          to reach is inactive." Calling that "does not exist" is a false
//          negative on a real person's address.
//
//   5.4.1  Exchange Online returns "550 5.4.1 Recipient address rejected:
//          Access denied" both for unknown recipients AND for senders it has
//          blocked. Ambiguous, so the reply text decides instead.

/** The mailbox exists but is switched off. */
const MAILBOX_DISABLED = new Set(['5.2.1']);

/** The mailbox exists but cannot take mail right now. */
const MAILBOX_FULL = new Set(['5.2.2', '5.2.3']);

/**
 * Text patterns for servers that omit the enhanced code. Checked in order:
 * blocking language first, because a block message often also contains the
 * word "rejected" and would otherwise look like a missing mailbox.
 */
const BLOCK_PATTERNS = [
  /spamhaus|spamcop|barracudacentral|sorbs|dnsbl|rbl\b|blocklist|blacklist/i,
  /reverse\s*dns|rdns|fcrdns|ptr\s*record/i,
  /client\s*host\s*(?:\[[^\]]*\]\s*)?(?:blocked|rejected)/i,
  /ip\s*(?:address\s*)?(?:is\s*)?(?:blocked|banned|blacklisted|listed)/i,
  /(?:access|connection|service)\s*(?:denied|unavailable|refused)/i,
  /(?:poor|bad|low)\s*reputation|reputation\s*(?:issues?|problems?)/i,
  /not\s*(?:allowed|permitted|authorized)|unauthorized/i,
  /policy\s*(?:reasons?|violation|restrictions?)|security\s*policy/i,
  /too\s*many\s*(?:connections|requests)|rate\s*limit/i,
  /authentication\s*required|must\s*authenticate/i
];

const NO_MAILBOX_PATTERNS = [
  /(?:user|mailbox|recipient|account|address)\s*(?:is\s*)?unknown/i,
  /unknown\s*(?:user|mailbox|recipient|account|address)/i,
  /no\s*such\s*(?:user|mailbox|recipient|account|address)/i,
  /(?:does\s*not|doesn'?t)\s*exist/i,
  /(?:user|mailbox|recipient|address)\s*not\s*found/i,
  /invalid\s*(?:recipient|mailbox|user|address)/i,
  /recipient\s*(?:address\s*)?rejected/i,
  /mailbox\s*(?:is\s*)?(?:unavailable|disabled)/i,
  /address\s*(?:is\s*)?(?:unknown|invalid)/i
];

const FULL_PATTERNS = [
  /(?:mailbox|quota|storage)\s*(?:is\s*)?full/i,
  /over\s*quota|quota\s*exceeded|insufficient\s*(?:system\s*)?storage/i
];

/** Exists, but switched off. Checked before the "no mailbox" patterns. */
const DISABLED_PATTERNS = [
  /(?:is\s*)?inactive/i,
  /(?:account|mailbox|user)\s*(?:is\s*)?(?:disabled|suspended|deactivated|locked)/i,
  /(?:disabled|suspended|deactivated)\s*(?:account|mailbox|user)/i,
  /no\s*longer\s*(?:active|in\s*use)/i,
  /not\s*accepting\s*(?:any\s*)?(?:mail|messages)/i
];

/** Pull the X.Y.Z enhanced status code out of a reply, if present. */
export function parseEnhanced(text) {
  // Appears right after the 3-digit code, e.g. "550 5.1.1 ..." or "550-5.1.1 ..."
  const m = String(text || '').match(/\b[245]\d{2}[ -](([245])\.\d{1,3}\.\d{1,3})\b/);
  return m ? m[1] : null;
}

const test = (patterns, text) => patterns.some(re => re.test(text));

/**
 * Classify a single SMTP reply.
 *
 * @param {{code:number, text:string}} reply
 * @returns {{kind:string, enhanced:?string, code:number, reason:string}}
 *   kind is one of:
 *     'ok'           accepted
 *     'no-mailbox'   the mailbox does not exist      -> invalid
 *     'mailbox-full' exists but cannot receive now   -> risky
 *     'blocked'      we were refused, not the address -> unknown
 *     'temporary'    greylisting / throttling        -> retry, then unknown
 *     'unknown'      unclassifiable                  -> unknown
 */
export function classifyReply(reply) {
  const code = Number(reply?.code) || 0;
  const text = String(reply?.text || '');
  const enhanced = parseEnhanced(text);
  const out = (kind, reason) => ({ kind, enhanced, code, reason });

  if (code >= 200 && code < 300) return out('ok', 'Accepted');

  // 4xx is always temporary - greylisting, throttling, or a transient fault.
  // Never a statement about the mailbox.
  if (code >= 400 && code < 500) {
    return out('temporary', enhanced === '4.7.1'
      ? 'Temporarily deferred by policy (greylisting)'
      : 'Temporary failure, retry needed');
  }

  if (code >= 500) {
    // The enhanced code is authoritative when the server sends one.
    if (enhanced) {
      // 5.7.x is the "policy / security" class: we are being refused.
      if (enhanced.startsWith('5.7.')) return out('blocked', 'Refused by server policy or IP reputation');
      if (NO_MAILBOX.has(enhanced))      return out('no-mailbox', 'Mailbox does not exist');
      if (MAILBOX_DISABLED.has(enhanced)) return out('mailbox-disabled', 'Mailbox exists but is inactive');
      if (MAILBOX_FULL.has(enhanced))    return out('mailbox-full', 'Mailbox exists but is full');
      // 5.3.x = system problems, 5.6.x = content. Neither is a mailbox verdict.
      if (enhanced.startsWith('5.3.') || enhanced.startsWith('5.6.')) {
        return out('blocked', 'Server-side failure, not a mailbox answer');
      }
    }

    // No enhanced code: fall back to the reply text.
    if (test(BLOCK_PATTERNS, text))      return out('blocked', 'Refused by server policy or IP reputation');
    if (test(FULL_PATTERNS, text))       return out('mailbox-full', 'Mailbox exists but is full');
    // Before NO_MAILBOX: "account is inactive" would otherwise read as missing.
    if (test(DISABLED_PATTERNS, text))   return out('mailbox-disabled', 'Mailbox exists but is inactive');
    if (test(NO_MAILBOX_PATTERNS, text)) return out('no-mailbox', 'Mailbox does not exist');

    // A bare 5xx we cannot read. Refusing to guess is the correct answer.
    return out('unknown', 'Rejected for an unreadable reason');
  }

  return out('unknown', 'Unrecognised reply');
}

/**
 * Was the failure something that tells us about the mailbox at all?
 * A failure before RCPT TO never is - the address was not even sent yet.
 */
export const STAGES = ['connect', 'greeting', 'ehlo', 'mailfrom', 'rcpt'];

export function stageReachedRcpt(stage) {
  return stage === 'rcpt';
}
