/**
 * Turns an internal validation result into the object the browser is given.
 *
 * Everything the UI used to work out for itself - which rows lead, which copy
 * replaces a technical message, why a verdict is uncertain, what the score
 * means - is decided here, and only the finished wording crosses the wire.
 * The frontend is left with nothing but rendering, and the internals (SMTP
 * stages, provider-trust model, directory lookups, raw DNS records) never
 * leave the server.
 */

// Users need to know "can I email this?", so the details lead with the four
// checks that answer it, plus anything that went wrong. The rest (DNS, SPF,
// domain age…) sits behind the technical report.
// 'directory' sits next to 'smtp' because on Microsoft-hosted domains it is
// the row that decides the verdict - hiding a confirmed account behind
// "technical details" leaves the mailbox row reading "couldn't be checked".
const KEY_CHECKS = ['smtp', 'directory', 'catchall', 'disposable', 'role'];
const TECH_ONLY = ['auth', 'age'];   // never a reason on their own to distrust an address

// A mail server that turned us away before RCPT never answered the question;
// one that refused us after RCPT did answer, just not about the mailbox. Only
// the first is honestly described as "did not respond".
const UNREACHABLE = /ECONN|ETIMEDOUT|EHOSTUNREACH|port 25|SMTP conversation|Conversation ended|GREETING|MAILFROM|refused our/i;

/** Replace a technical row with plain wording. Never exposes the original. */
function friendlyCheck(c, result) {
  if (c.id === 'auth') {
    return { ...c, label: 'Sender protection', status: 'skip',
      detail: c.status === 'pass' ? 'Fully protected (SPF & DMARC)' : 'Basic protection only' };
  }
  if (c.id === 'smtp' && c.status === 'skip'
      && result?.meta?.smtp?.reachedRcpt === false && UNREACHABLE.test(c.detail)) {
    return { ...c, detail: 'Mail server did not respond, so the inbox was left unchecked' };
  }
  if (c.id === 'age' && c.status === 'skip') return { ...c, detail: 'Registration date not published' };
  return c;
}

/** Order the rows and mark which belong in the folded technical report. */
function splitChecks(checks) {
  const byId = (id) => checks.find(c => c.id === id);
  const main = KEY_CHECKS.map(byId).filter(Boolean);
  checks.forEach(c => {
    if (KEY_CHECKS.includes(c.id) || TECH_ONLY.includes(c.id)) return;
    if (c.status === 'fail' || c.status === 'warn') main.push(c);
  });
  const tech = checks.filter(c => !main.includes(c));
  return { main, tech };
}

/**
 * Say plainly why a result is not a confident yes. Every competitor hides
 * this behind a green tick; being explicit about what we could not determine
 * is the whole point of the tool.
 */
function explainUncertainty(r) {
  const s = r.meta?.smtp?.status;

  if (s === 'catch-all') {
    return 'This domain accepts mail for every address, so no tool can confirm '
         + 'whether this specific mailbox exists. Treat it as unproven, not as valid.';
  }
  if (s === 'blocked') {
    return 'The mail server refused our IP instead of answering about the mailbox. '
         + 'That is not evidence the address is bad, it simply could not be checked.';
  }
  if (s === 'greylisted') {
    const base = 'The mail server deferred us (greylisting). The address is still unconfirmed; ';
    // Only say a retry is running when one genuinely was queued.
    if (!r.meta.smtp?.retryScheduled) {
      return base + 'checking again in a few minutes usually resolves it.';
    }
    const mins = Math.max(1, Math.round((r.meta.smtp.retryInMs || 0) / 60000));
    return base + `we are retrying in the background in about ${mins} minute`
         + `${mins === 1 ? '' : 's'}. Check this address again after that for the real answer.`;
  }
  if (r.verdict === 'unknown') {
    return 'This address could not be confirmed either way. Reporting it as unknown '
         + 'is more honest than guessing.';
  }
  if (r.verdict === 'valid' && s !== 'deliverable') {
    return 'The domain can receive mail, but the individual mailbox was not verified. '
         + 'Turn on deep checks to confirm the inbox itself.';
  }
  return null;
}

/** The number is confidence that the address is good - say so in words. */
function scoreLabel(score) {
  if (score >= 90) return 'high';
  if (score >= 70) return 'good';
  if (score >= 45) return 'low';
  return 'very low';
}

function scoreMeaning(score) {
  return `${score} / 100 confidence this address is safe to send to. `
       + '90+ verified, 70-89 looks right but the mailbox was not confirmed, '
       + '45-69 uncertain, under 45 do not send.';
}

/** Only the SPF/DMARC/age facts the chips show - never the raw records. */
function publicIntel(intel) {
  if (!intel) return null;
  return {
    spf:   { present: Boolean(intel.spf?.present),   policy: intel.spf?.policy ?? null },
    dmarc: { present: Boolean(intel.dmarc?.present), policy: intel.dmarc?.policy ?? null },
    age:   { known: Boolean(intel.age?.known),       ageDays: intel.age?.ageDays ?? null },
    ageRisk: intel.ageRisk ?? null
  };
}

/**
 * The browser-facing shape of a result. Anything not listed here stays on the
 * server, so adding a field to result.meta never silently publishes it.
 */
export function presentResult(result) {
  if (!result || typeof result !== 'object') return result;

  const { main, tech } = splitChecks(result.checks || []);
  const row = (c, tier) => {
    const f = friendlyCheck(c, result);
    return {
      id: f.id, label: f.label, status: f.status, detail: f.detail,
      tier,
      // The UI skips these when picking the headline issue: on their own they
      // are never a reason to distrust an address.
      advisory: TECH_ONLY.includes(f.id)
    };
  };
  const checks = [...main.map(c => row(c, 'main')), ...tech.map(c => row(c, 'tech'))];

  return {
    email: result.email,
    normalized: result.normalized,
    verdict: result.verdict,
    score: result.score,
    scoreLabel: scoreLabel(result.score),
    scoreMeaning: scoreMeaning(result.score),
    suggestion: result.suggestion,
    checks,
    // The first failing or warning row that is not merely advisory - the one
    // sentence that explains the verdict in a list. Taken in the order the
    // checks ran, not the display order, so the headline issue does not change
    // just because a row was promoted into the summary.
    primaryIssue: (result.checks || [])
      .filter(c => !TECH_ONLY.includes(c.id))
      .find(c => c.status === 'fail' || c.status === 'warn')?.detail || '',
    uncertainty: explainUncertainty(result),
    meta: {
      domain: result.meta?.domain ?? null,
      provider: result.meta?.provider ?? null,
      mxCount: Array.isArray(result.meta?.mx) ? result.meta.mx.length : 0,
      free: Boolean(result.meta?.free),
      role: Boolean(result.meta?.role),
      disposable: Boolean(result.meta?.disposable),
      intel: publicIntel(result.meta?.intel)
    },
    tookMs: result.tookMs
  };
}
