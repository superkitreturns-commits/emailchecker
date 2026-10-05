/**
 * Mail infrastructure grouping and SMTP verifiability policy.
 *
 * Two facts drive accuracy on a bulk list and neither is visible from the
 * domain alone:
 *
 *  1. SEPARATE DOMAINS SHARE ONE SERVER FARM. yahoo.com, aol.com, att.net,
 *     verizon.net, sbcglobal.net and a dozen more all deliver through
 *     *.yahoodns.net. Throttling per domain lets a list of 400 Yahoo-family
 *     addresses open four parallel streams at the same servers, which is how
 *     a clean IP gets rate-limited halfway through a run. Throttle per GROUP.
 *
 *  2. SOME PROVIDERS CANNOT BE VERIFIED BY ANYONE. Yahoo-family and the big
 *     US cable ISPs accept RCPT TO for addresses that do not exist and bounce
 *     the message afterwards, so a 250 from them is not evidence the mailbox
 *     is real. Every serious vendor reports these as unknown/risky rather
 *     than claiming a verdict. Reporting them "valid" is a false positive
 *     dressed up as a result.
 *
 * Policy here is deliberately about the INFRASTRUCTURE, not the brand: a
 * company running its own domain on Yahoo's servers inherits Yahoo's
 * behaviour, so the MX hosts decide, with the domain only as a fallback.
 */

/**
 * Infrastructure groups. The first pattern to match an MX host wins, so the
 * key is shared by every domain behind that farm.
 *
 * `trust` is how much a RCPT TO answer from this farm is worth:
 *   'reliable'   - the server answers honestly about recipients (Gmail, Proton)
 *   'unreliable' - accepts unknown recipients and bounces later, so a 250
 *                  alone proves nothing; needs catch-all to be disproven
 *   'hostile'    - refuses third-party probes outright, so we usually learn
 *                  nothing at all and must say so
 */
const GROUPS = [
  // Yahoo runs AOL, AT&T, Verizon, Rogers, BT and more on one farm.
  { key: 'yahoo',     trust: 'unreliable', mx: /yahoodns\.net$|\.yahoo\.com$|yahoo\.co\.jp$/i },
  { key: 'google',    trust: 'reliable',   mx: /aspmx.*\.google\.com$|\.googlemail\.com$|google\.com$/i },
  // *.mx.microsoft is the newer suffix Microsoft moves tenants onto; without
  // it a large O365 tenant reads as a self-hosted domain and gets neither the
  // Microsoft throttle nor the directory lookup.
  { key: 'microsoft', trust: 'unreliable', mx: /\.protection\.outlook\.com$|\.outlook\.com$|\.mx\.microsoft$|hotmail\.com$/i },
  { key: 'apple',     trust: 'unreliable', mx: /\.icloud\.com$|\.apple\.com$|mail\.me\.com$/i },
  { key: 'comcast',   trust: 'hostile',    mx: /\.comcast\.net$/i },
  { key: 'charter',   trust: 'hostile',    mx: /\.charter\.net$|\.spectrum\.net$|\.chartermi\.net$/i },
  { key: 'cox',       trust: 'hostile',    mx: /\.cox\.net$/i },
  { key: 'proton',    trust: 'reliable',   mx: /protonmail|proton\.me$/i },
  { key: 'zoho',      trust: 'reliable',   mx: /zoho|zeptomail/i },
  { key: 'fastmail',  trust: 'reliable',   mx: /messagingengine\.com$/i },
  { key: 'yandex',    trust: 'unreliable', mx: /yandex/i },
  { key: 'mailru',    trust: 'unreliable', mx: /\.mail\.ru$/i },
  { key: 'gmx',       trust: 'reliable',   mx: /gmx\.net$|\.united-internet\.de$|web\.de$/i },
  { key: 'qq',        trust: 'unreliable', mx: /qq\.com$|163\.com$|126\.com$/i },
  // Security gateways sit in front of the real mailbox server and answer for
  // it. They are configured per customer and commonly accept everything.
  { key: 'mimecast',  trust: 'unreliable', mx: /mimecast/i },
  { key: 'proofpoint', trust: 'unreliable', mx: /proofpoint|pphosted/i },
  { key: 'barracuda', trust: 'unreliable', mx: /barracuda/i },
  { key: 'cisco-esa', trust: 'unreliable', mx: /iphmx\.com$/i },
  { key: 'secureserver', trust: 'reliable', mx: /secureserver\.net$/i }
];

/**
 * Domains whose provider is known even when the MX lookup is unhelpful.
 * Used only as a fallback behind the MX patterns above.
 */
const DOMAIN_GROUPS = new Map(Object.entries({
  'yahoo.com': 'yahoo', 'yahoo.co.uk': 'yahoo', 'yahoo.in': 'yahoo',
  'yahoo.ca': 'yahoo', 'yahoo.fr': 'yahoo', 'yahoo.de': 'yahoo',
  'ymail.com': 'yahoo', 'rocketmail.com': 'yahoo',
  'aol.com': 'yahoo', 'aim.com': 'yahoo',
  'att.net': 'yahoo', 'sbcglobal.net': 'yahoo', 'bellsouth.net': 'yahoo',
  'ameritech.net': 'yahoo', 'pacbell.net': 'yahoo', 'swbell.net': 'yahoo',
  'flash.net': 'yahoo', 'nvbell.net': 'yahoo', 'prodigy.net': 'yahoo',
  'verizon.net': 'yahoo', 'frontier.com': 'yahoo', 'frontiernet.net': 'yahoo',
  'comcast.net': 'comcast', 'xfinity.com': 'comcast',
  'charter.net': 'charter', 'spectrum.net': 'charter',
  'roadrunner.com': 'charter', 'rr.com': 'charter', 'twc.com': 'charter',
  'cox.net': 'cox',
  'gmail.com': 'google', 'googlemail.com': 'google',
  'outlook.com': 'microsoft', 'hotmail.com': 'microsoft',
  'hotmail.co.uk': 'microsoft', 'live.com': 'microsoft', 'msn.com': 'microsoft',
  'icloud.com': 'apple', 'me.com': 'apple', 'mac.com': 'apple'
}));

/** Human labels, for the reason text shown to the user. */
const LABELS = {
  yahoo: 'Yahoo',
  comcast: 'Comcast',
  charter: 'Charter / Spectrum',
  cox: 'Cox',
  microsoft: 'Microsoft',
  apple: 'Apple iCloud',
  google: 'Google',
  mimecast: 'Mimecast', proofpoint: 'Proofpoint',
  barracuda: 'Barracuda', 'cisco-esa': 'Cisco'
};

const TRUST_BY_KEY = Object.fromEntries(GROUPS.map(g => [g.key, g.trust]));

/**
 * The throttle key for an address: every domain behind the same farm returns
 * the same string, so one gap setting governs the whole farm.
 *
 * Falls back to the registrable-looking tail of the first MX host, which
 * groups a company's own `mx1/mx2.example.com` together, and finally to the
 * domain itself when there is no MX at all.
 */
export function infraKey(mxHosts = [], domain = '') {
  const hosts = mxHosts.filter(Boolean).map(h => String(h).toLowerCase());
  for (const host of hosts) {
    const hit = GROUPS.find(g => g.mx.test(host));
    if (hit) return hit.key;
  }
  const known = DOMAIN_GROUPS.get(String(domain).toLowerCase());
  if (known) return known;
  if (hosts.length) {
    // "mx1.mail.example.co.uk" -> "example.co.uk"; good enough to keep one
    // company's mail servers on a single throttle budget.
    const parts = hosts[0].split('.');
    const tail = parts.length > 2 && parts.at(-2).length <= 3 && parts.at(-1).length <= 3
      ? parts.slice(-3)
      : parts.slice(-2);
    return tail.join('.');
  }
  return String(domain).toLowerCase();
}

/**
 * How much an SMTP answer from this infrastructure is worth.
 * @returns {{group:string, trust:string, label:?string, selfVerifiable:boolean}}
 */
export function verifiability(mxHosts = [], domain = '') {
  const group = infraKey(mxHosts, domain);
  const trust = TRUST_BY_KEY[group] || 'reliable';
  return {
    group,
    trust,
    label: LABELS[group] || null,
    // Whether a bare "250 accepted" may be reported as a confirmed mailbox.
    selfVerifiable: trust === 'reliable'
  };
}

/** Reason text for an address we deliberately refuse to call confirmed. */
export function unverifiableReason(group, trust) {
  const who = LABELS[group] || 'This provider';
  if (trust === 'hostile') {
    return `${who} blocks outside inbox checks, so this result cannot be fully confirmed`;
  }
  return `${who} does not reveal which addresses are real, so this result cannot be fully confirmed`;
}

/**
 * Minimum gap between two probes at the same farm, in ms.
 *
 * One global number cannot serve both: Gmail tolerates a steady stream, while
 * Yahoo and the cable ISPs start deferring after a handful of connections and
 * stay annoyed for the rest of the run. Slower on the touchy ones is not lost
 * throughput - a throttled probe returns no answer at all.
 */
const GAPS = {
  yahoo: Number(process.env.GAP_YAHOO_MS || 1200),
  comcast: Number(process.env.GAP_COMCAST_MS || 1500),
  charter: Number(process.env.GAP_CHARTER_MS || 1500),
  cox: Number(process.env.GAP_COX_MS || 1500),
  apple: Number(process.env.GAP_APPLE_MS || 800),
  microsoft: Number(process.env.GAP_MICROSOFT_MS || 500),
  google: Number(process.env.GAP_GOOGLE_MS || 250)
};

const DEFAULT_GAP = Number(process.env.PER_DOMAIN_GAP_MS || 350);

/** How long to wait before the next probe at this infrastructure group. */
export const groupGapMs = (key) =>
  Number.isFinite(GAPS[key]) ? GAPS[key] : DEFAULT_GAP;

export const GROUP_KEYS = GROUPS.map(g => g.key);

/**
 * Groups that are a security appliance in front of somebody else's mailbox
 * server rather than the mailbox server itself.
 *
 * Matching one of these says where the mail is INSPECTED, not where it is
 * delivered, so the real provider is still unknown and worth looking for -
 * see lib/ms-oracle.js, which finds the Office 365 tenant hiding behind them.
 */
export const GATEWAY_KEYS = ['mimecast', 'proofpoint', 'barracuda', 'cisco-esa'];
