/**
 * DNS layer: does the domain exist, and can it receive mail?
 *
 * Uses a resolver pool. The host's own resolver is tried first when it looks
 * usable, then public resolvers. Infrastructure failures (refused, timeout)
 * fail over to the next resolver; a real answer (NXDOMAIN / no records) is
 * definitive and stops the walk.
 *
 * Override with DNS_SERVERS="1.1.1.1,8.8.8.8".
 * Results are cached by domain, so everyone checking @gmail.com hits cache.
 */
import { Resolver, getServers } from 'node:dns/promises';
import { TTLCache } from './cache.js';

const PUBLIC_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

/** Loopback resolvers are useless inside most containers. */
const isLoopback = (ip) =>
  ip.startsWith('127.') || ip === '::1' || ip.startsWith('[::1]');

/**
 * Build the resolver pool.
 *
 * Each public resolver gets its OWN entry rather than being bundled into one
 * multi-server resolver. c-ares only rotates servers on timeout, not on
 * SERVFAIL - a SERVFAIL is a real response, so it stops there. Splitting them
 * lets our own failover loop actually try the next provider.
 *
 * This matters: resolvers disagree. jerem.us returns SERVFAIL on 1.1.1.1 and
 * 8.8.8.8 but resolves correctly on 9.9.9.9. Bundled, the domain looked dead.
 */
function buildPool() {
  const groups = [];

  if (process.env.DNS_SERVERS) {
    const custom = process.env.DNS_SERVERS.split(',').map(s => s.trim()).filter(Boolean);
    for (const ip of custom) groups.push([ip]);
  } else {
    try {
      const system = getServers().filter(ip => !isLoopback(ip));
      if (system.length) groups.push(system); // host's own set, kept together
    } catch {
      // no usable system resolver
    }
  }

  for (const ip of PUBLIC_SERVERS) groups.push([ip]);
  return groups;
}

// Short timeout and a single try per entry: with several entries to walk,
// failing over quickly beats retrying a resolver that already said no.
const POOL = [...new Map(
  buildPool().map(servers => [servers.join(','), servers])
).values()].map(servers => {
  const r = new Resolver({ timeout: 3000, tries: 1 });
  r.setServers(servers);
  return { servers, resolver: r };
});

// These mean "the DNS system answered" - do not retry elsewhere.
const DEFINITIVE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

/**
 * Run a resolver method across the pool until one answers definitively.
 * Returns { records, code } - code is set when the answer was a negative one.
 */
export async function query(method, domain) {
  let lastCode = null;
  for (const { resolver } of POOL) {
    try {
      const records = await resolver[method](domain);
      return { records, code: null };
    } catch (err) {
      const code = err.code || err.message;
      lastCode = code;
      if (DEFINITIVE.has(code)) return { records: null, code };
      // otherwise: refused / timeout / servfail - try the next resolver
    }
  }
  return { records: null, code: lastCode };
}

const cache = new TTLCache({ ttl: 6 * 60 * 60 * 1000, max: 20000 });

/** Recognise the big mailbox providers from their MX hostnames. */
const PROVIDER_SIGNATURES = [
  [/aspmx.*google|google\.com$|googlemail\.com$/i, 'Google Workspace / Gmail'],
  [/outlook\.com$|protection\.outlook|hotmail\.com$/i, 'Microsoft 365 / Outlook'],
  [/yahoodns\.net$|yahoo\.com$/i, 'Yahoo'],
  [/zoho|zeptomail/i, 'Zoho Mail'],
  [/protonmail|proton\.me/i, 'Proton Mail'],
  [/icloud\.com$|apple\.com$/i, 'Apple iCloud'],
  [/amazonaws\.com$|amazonses/i, 'Amazon SES'],
  [/mimecast/i, 'Mimecast'],
  [/proofpoint|pphosted/i, 'Proofpoint'],
  [/barracuda/i, 'Barracuda'],
  [/messagingengine\.com$/i, 'Fastmail'],
  [/yandex/i, 'Yandex'],
  [/qq\.com$|163\.com$|126\.com$/i, 'Tencent / NetEase'],
  [/secureserver\.net$/i, 'GoDaddy'],
  [/registrar-servers\.com$/i, 'Namecheap'],
  [/improvmx/i, 'ImprovMX'],
  [/migadu/i, 'Migadu'],
  [/mailgun/i, 'Mailgun'],
  [/sendgrid/i, 'SendGrid']
];

function identifyProvider(mxHosts) {
  for (const host of mxHosts) {
    for (const [pattern, name] of PROVIDER_SIGNATURES) {
      if (pattern.test(host)) return name;
    }
  }
  return null;
}

/**
 * Look up a domain's mail infrastructure.
 * @returns {Promise<{domainExists:boolean, hasMx:boolean, mx:Array, provider:?string,
 *                    implicitMx:boolean, error:?string}>}
 */
export async function lookupDomain(domain) {
  const key = String(domain || '').toLowerCase();
  const cached = cache.get(key);
  if (cached) return { ...cached, cached: true };

  const result = {
    domainExists: false,
    hasMx: false,
    nullMx: false,
    mx: [],
    provider: null,
    implicitMx: false,
    error: null
  };

  const mxRes = await query('resolveMx', key);
  if (mxRes.records?.length) {
    // An MX answer at all proves the domain is registered, even when every
    // record in it turns out to be unusable.
    result.domainExists = true;

    // Lowest priority value is tried first.
    result.mx = mxRes.records
      .filter(r => r.exchange && r.exchange !== '.')
      .sort((a, b) => a.priority - b.priority)
      .map(r => ({ exchange: r.exchange.replace(/\.$/, ''), priority: r.priority }));
    result.hasMx = result.mx.length > 0;
    result.provider = identifyProvider(result.mx.map(m => m.exchange));

    // RFC 7505: a lone "MX . 0" is the domain stating it accepts no mail at
    // all. That is a deliberate declaration, not a missing record, so the
    // A-record fallback below must NOT apply - doing so would report a
    // web-only or parked domain as able to receive email.
    result.nullMx = !result.hasMx;
  } else if (mxRes.code && !DEFINITIVE.has(mxRes.code)) {
    result.error = mxRes.code;
  }

  if (!result.hasMx && !result.nullMx) {
    // RFC 5321 s5.1: with no MX, the A/AAAA record is the implicit mail host.
    let aRes = await query('resolve4', key);
    if (!aRes.records?.length) aRes = await query('resolve6', key);

    if (aRes.records?.length) {
      result.domainExists = true;
      result.implicitMx = true;
      result.mx = [{ exchange: key, priority: 0 }];
    } else if (aRes.code && !DEFINITIVE.has(aRes.code) && !result.error) {
      result.error = aRes.code;
    }
  }

  cache.set(key, result);
  return result;
}

export const dnsCacheSize = () => cache.size;
export const dnsServers = () => POOL.map(p => p.servers.join(', '));
