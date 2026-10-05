/**
 * Microsoft mailbox existence, asked outside SMTP.
 *
 * Microsoft is the biggest hole in SMTP verification. Its servers accept
 * RCPT TO for addresses that do not exist and bounce afterwards, so
 * lib/providers.js correctly marks the whole farm 'unreliable' and refuses to
 * call a 250 a confirmed mailbox. That is honest, and it leaves every
 * outlook/hotmail/live address and every business tenant on Office 365
 * permanently "unknown" - which is most business email in existence.
 *
 * Microsoft answers the same question on a different channel. The sign-in
 * page has to know whether an account exists before it can decide which
 * credential prompt to show, so login.microsoftonline.com exposes that fact
 * directly. No mail is sent and no mailbox is touched: it is the same request
 * a browser makes when somebody types their address into the sign-in box.
 *
 * Two things make this trustworthy rather than clever:
 *
 *  1. THE DIRECTORY CAN BE BLIND. A tenant with user-enumeration protection
 *     turned on answers "exists" for every address, exactly like a catch-all
 *     mail server. So the same defence applies: ask about a random address
 *     that cannot exist, and only believe the directory if it says no. This
 *     mirrors the canary logic in lib/smtp.js and is why a positive answer
 *     here is worth more than a 250 from the same provider.
 *
 *  2. THE TENANT IS NOT ALWAYS VISIBLE IN THE MX. Thousands of companies put
 *     Mimecast, Proofpoint, Barracuda or a Cisco appliance in front of
 *     Office 365. The gateway answers SMTP for the tenant and accepts
 *     everything, so the mail path reveals nothing - but the domain's own SPF
 *     record and autodiscover CNAME still point at Microsoft. Finding the
 *     tenant behind the gateway is what turns those domains from
 *     unverifiable into answerable.
 *
 * Works with no outbound port 25 at all, since it is an HTTPS request.
 */
import { randomBytes } from 'node:crypto';
import { query } from './dns-check.js';
import { TTLCache } from './cache.js';
import { infraKey, GROUP_KEYS, GATEWAY_KEYS } from './providers.js';

const ENDPOINT = 'https://login.microsoftonline.com/common/GetCredentialType';
const UA = 'email-validator/1.0 (+mailbox existence check)';

const TIMEOUT = Number(process.env.MS_ORACLE_TIMEOUT || 6000);

/**
 * One endpoint serves every lookup, so the gap is global rather than
 * per-domain: a bulk run of 400 tenants is still 400 requests at the same
 * host, and a throttled request answers nothing at all.
 */
const GAP_MS = Number(process.env.MS_ORACLE_GAP_MS || 400);

export const msOracleEnabled = () =>
  String(process.env.MS_ORACLE ?? 'true').toLowerCase() !== 'false';

/** Verdicts per address. Directory membership changes rarely. */
const addressCache = new TTLCache({ ttl: 6 * 60 * 60 * 1000, max: 20000 });

/** Whether a domain's mail is Microsoft-backed at all. */
const backedCache = new TTLCache({ ttl: 24 * 60 * 60 * 1000, max: 20000 });

/** Whether a tenant's directory will admit that an address does not exist. */
const blindCache = new TTLCache({ ttl: 24 * 60 * 60 * 1000, max: 20000 });

// ---- request pacing ----------------------------------------------------
// Serialised through one promise chain so concurrent callers queue rather
// than all firing at once.
let chain = Promise.resolve();
let lastAt = 0;

function turn() {
  chain = chain.then(async () => {
    const wait = GAP_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAt = Date.now();
  });
  return chain;
}

/**
 * IfExistsResult, as the sign-in page interprets it.
 *
 * 5 and 6 mean "this account signs in through a linked identity provider" -
 * the consumer Microsoft-account stack for hotmail/outlook/live, or a
 * federated corporate IdP. It is tempting to read that as "no answer", but
 * the directory only says it about accounts it recognises: on hotmail.com a
 * made-up address comes back 1 while a real one comes back 5. Returning a
 * DIFFERENT answer than the one reserved for addresses that do not exist is
 * itself the confirmation.
 *
 * That reasoning only holds where 1 is known to be this domain's answer for a
 * missing account, which is exactly what the canary in directorySees() proves
 * before any of these verdicts is trusted. A tenant that answers 5 for
 * everything fails that canary and is reported unknown.
 */
const RESULTS = {
  0: ['exists', 'Confirmed with Microsoft this account exists'],
  1: ['no-mailbox', 'No Microsoft account is registered for this address'],
  5: ['exists', 'Confirmed with Microsoft, account recognised (linked sign-in)'],
  6: ['exists', 'Confirmed with Microsoft, account recognised (linked sign-in)']
};

/** Ask the directory about one address. Never throws. */
async function ask(username) {
  await turn();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': UA
      },
      body: JSON.stringify({ username, isOtherIdpSupported: true }),
      signal: AbortSignal.timeout(TIMEOUT)
    });

    if (!res.ok) {
      return { status: 'unknown', reason: `Microsoft did not answer (HTTP ${res.status}). Please try again` };
    }

    const data = await res.json();

    // Being throttled is not an answer, and the field is set independently of
    // IfExistsResult - reading the result while throttled is how a blind
    // lookup turns into a confident wrong verdict.
    if (Number(data.ThrottleStatus) > 0) {
      return { status: 'unknown', reason: 'Microsoft rate-limited the lookup. Please try again shortly' };
    }

    const [status, reason] = RESULTS[Number(data.IfExistsResult)]
      || ['unknown', 'Microsoft gave no clear answer for this address'];
    return { status, reason };
  } catch (err) {
    console.error('[ms-oracle]', err.message);
    return { status: 'unknown', reason: 'Microsoft could not be reached. Please try again' };
  }
}

const OUTLOOK_MX = /\.protection\.outlook\.com$|\.outlook\.com$|\.mx\.microsoft$/i;
const OUTLOOK_SPF = /include:\s*spf\.protection\.outlook\.com/i;
const AUTODISCOVER = /autodiscover\.outlook\.com\.?$/i;

/** TXT records arrive as arrays of chunks that must be joined before parsing. */
const flattenTxt = (records) =>
  (records || []).map(r => (Array.isArray(r) ? r.join('') : String(r)));

async function detectBacking(domain, mxHosts) {
  const hosts = mxHosts.filter(Boolean).map(h => String(h).toLowerCase());

  // The ordinary case: the mail path points straight at Microsoft.
  if (hosts.some(h => OUTLOOK_MX.test(h))) return { backed: true, via: 'mx' };

  const group = infraKey(hosts, domain);
  if (group === 'microsoft') return { backed: true, via: 'domain' };

  // A farm we recognise that is neither Microsoft nor a gateway runs its own
  // mailboxes - there is no tenant hiding behind Google or Proton, and asking
  // Microsoft about a Gmail address would just burn a request.
  if (GROUP_KEYS.includes(group) && !GATEWAY_KEYS.includes(group)) {
    return { backed: false, via: null };
  }

  // Gateway-fronted or self-hosted-looking. The gateway answers SMTP, but the
  // domain still has to tell the world which servers send its mail, and an
  // Office 365 tenant cannot avoid naming Microsoft there.
  const txt = await query('resolveTxt', domain).catch(() => ({ records: null }));
  const spf = flattenTxt(txt.records).find(t => /^v=spf1\b/i.test(t.trim()));
  if (spf && OUTLOOK_SPF.test(spf)) return { backed: true, via: 'spf' };

  // Outlook clients are pointed at the tenant with this CNAME, so it survives
  // even when SPF has been flattened into raw IP ranges by the gateway.
  const cname = await query('resolveCname', `autodiscover.${domain}`)
    .catch(() => ({ records: null }));
  if ((cname.records || []).some(h => AUTODISCOVER.test(String(h)))) {
    return { backed: true, via: 'autodiscover' };
  }

  return { backed: false, via: null };
}

/**
 * Is this domain's mail ultimately handled by Microsoft, directly or behind a
 * security gateway?
 * @returns {Promise<{backed:boolean, via:?string}>} via is mx | domain | spf | autodiscover
 */
export async function microsoftBacked(domain, mxHosts = []) {
  const d = String(domain || '').toLowerCase();
  if (!d) return { backed: false, via: null };

  const cached = backedCache.get(d);
  if (cached) return cached;

  const out = await detectBacking(d, mxHosts);
  backedCache.set(d, out);
  return out;
}

/**
 * Will this tenant admit that a made-up address does not exist?
 *
 * Only a clean "no such account" on an address that cannot possibly exist
 * proves the directory is discriminating. A throttle or a network error
 * proves nothing and is deliberately not cached as a verdict, so the next
 * address retries instead of inheriting a guess.
 */
async function directorySees(domain) {
  const cached = blindCache.get(domain);
  if (cached !== undefined) return cached;

  const canary = await ask(`${randomBytes(12).toString('hex')}@${domain}`);
  if (canary.status === 'unknown') return null;

  const sees = canary.status === 'no-mailbox';
  blindCache.set(domain, sees);
  return sees;
}

/**
 * Mailbox existence for a Microsoft-backed address.
 *
 * @returns {Promise<?{status:string, reason:string, via:string}>} null when the
 *   domain is not Microsoft-backed, so the caller simply has no extra signal.
 *   status is exists | no-mailbox | unknown.
 */
export async function microsoftMailbox(email, mxHosts = []) {
  if (!msOracleEnabled()) return null;

  const addr = String(email || '').toLowerCase();
  const domain = addr.split('@')[1];
  if (!domain) return null;

  const cached = addressCache.get(addr);
  if (cached) return cached;

  const backing = await microsoftBacked(domain, mxHosts);
  if (!backing.backed) return null;

  const answer = await ask(addr);

  // An answer is only worth keeping if the directory can still be seen to say
  // no. Checked after the real address so a tenant that clamps down mid-run
  // has already given us the answer we actually care about.
  if (answer.status !== 'unknown') {
    const sees = await directorySees(domain);
    if (sees !== true) {
      const blind = {
        status: 'unknown',
        reason: sees === false
          ? 'This organisation hides which accounts exist'
          : 'This organisation\u2019s directory could not be trusted to answer',
        via: backing.via
      };
      // Not cached when the canary itself failed - that is a transient gap,
      // not a property of the tenant.
      if (sees === false) addressCache.set(addr, blind);
      return blind;
    }
  }

  const out = { ...answer, via: backing.via };
  addressCache.set(addr, out);
  return out;
}

export const msOracleCacheSize = () =>
  addressCache.size + backedCache.size + blindCache.size;

/** Test helper: drop all cached directory state. */
export function resetMsOracle() {
  addressCache.store.clear();
  backedCache.store.clear();
  blindCache.store.clear();
}
