/**
 * Disposable / temporary email domain blocklist.
 *
 * Strategy: ship a small offline fallback, then pull the community list
 * (110k+ domains) on boot and refresh daily. A hardcoded list goes stale
 * within weeks, so the network copy is the source of truth when available.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SOURCES = [
  'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf',
  'https://raw.githubusercontent.com/disposable/disposable-email-domains/master/domains.txt'
];

const REFRESH_MS = 24 * 60 * 60 * 1000;

/** Offline fallback: the most common throwaway services. */
const FALLBACK = `
mailinator.com 10minutemail.com guerrillamail.com guerrillamail.net sharklasers.com
temp-mail.org tempmail.com throwawaymail.com yopmail.com yopmail.fr getnada.com
maildrop.cc dispostable.com trashmail.com trashmail.de mytemp.email fakeinbox.com
tempinbox.com mailnesia.com mintemail.com spamgourmet.com mailcatch.com
33mail.com temp-mail.io emailondeck.com moakt.com tempr.email discard.email
mohmal.com tempmailo.com luxusmail.org inboxkitten.com harakirimail.com
mailsac.com burnermail.io anonaddy.com simplelogin.io grr.la spam4.me
guerrillamailblock.com pokemail.net byom.de mailexpire.com incognitomail.org
tempmailaddress.com emailtemporanea.net nowmymail.com jetable.org
0-mail.com airmail.cc cool.fr.nf courriel.fr.nf spambog.com spambox.us
tempemail.net tempmail.net tmpmail.net tmpmail.org rootfest.net
`.trim().split(/\s+/).filter(Boolean);

export class DisposableList {
  constructor({ dataDir = './data', offline = false } = {}) {
    this.cacheFile = join(dataDir, 'disposable-domains.txt');
    this.offline = offline;
    this.domains = new Set(FALLBACK);
    this.source = 'fallback';
    this.updatedAt = null;
    this.timer = null;
  }

  has(domain) {
    return this.domains.has((domain || '').toLowerCase());
  }

  get size() {
    return this.domains.size;
  }

  /** Load from disk cache immediately, then refresh from network in background. */
  async init() {
    await this.#loadFromDisk();
    if (!this.offline) {
      this.refresh().catch(() => {}); // never block boot on the network
      this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
      this.timer.unref?.();
    }
    return this;
  }

  async #loadFromDisk() {
    try {
      const raw = await readFile(this.cacheFile, 'utf8');
      const parsed = this.#parse(raw);
      if (parsed.size > 1000) {
        this.domains = parsed;
        this.source = 'disk';
      }
    } catch {
      // no cache yet - fallback list stays in place
    }
  }

  async refresh() {
    for (const url of SOURCES) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) continue;
        const raw = await res.text();
        const parsed = this.#parse(raw);
        if (parsed.size < 1000) continue; // sanity check: reject a truncated download

        // Keep the fallback entries merged in so we never lose known-bad domains.
        for (const d of FALLBACK) parsed.add(d);

        this.domains = parsed;
        this.source = 'remote';
        this.updatedAt = new Date().toISOString();
        await writeFile(this.cacheFile, [...parsed].join('\n'), 'utf8').catch(() => {});
        return true;
      } catch {
        continue; // try the next mirror
      }
    }
    return false;
  }

  #parse(raw) {
    const set = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const d = line.trim().toLowerCase();
      if (!d || d.startsWith('#') || d.startsWith('//')) continue;
      set.add(d);
    }
    return set;
  }
}
