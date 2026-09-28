# Email Validator

A fast, transparent email checking tool. Shows every check it runs and why —
instead of a green tick with no reasoning behind it.

Runs eight checks for free with no API key, no signup, and no per-check cost.
Two more deep checks are built in and switched off by default.

---

## Running it

```bash
npm install
npm start
```

Open <http://localhost:3000>.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## The checks

| # | Check | What it catches | Enabled |
|---|-------|-----------------|---------|
| 1 | Format | Malformed addresses, bad characters, length limits | Always |
| 1b | Same mailbox | Gmail dot/+tag/googlemail aliases of one inbox | Always |
| 2 | Spelling | `gmial.com` → `gmail.com`, mistyped TLDs | Always |
| 3 | Disposable | Throwaway services, from an auto-updating blocklist | Always |
| 4 | Mailbox type | Role accounts (`info@`, `admin@`, `support@`) | Always |
| 5 | Domain | Domains that are not registered | Always |
| 6 | Mail server | MX records; domains that cannot receive mail at all | Always |
| 7 | Authentication | SPF and DMARC policy published by the domain | Always |
| 8 | Domain age | Registration date via RDAP; flags freshly created domains | Always |
| 9 | Mailbox | Whether the specific inbox exists (SMTP `RCPT TO`) | Opt-in |
| 10 | Catch-all | Domains that accept every address, making #9 meaningless | Opt-in |

Checks 1–8 cost nothing and work on any host. See **Deep checks** below for 9–10.

### Verdicts

- **valid** — passes every check that ran
- **risky** — deliverable but questionable: disposable, a role account, or a likely typo
- **unknown** — could not be determined: a catch-all domain, a mail server that
  refused our IP, greylisting, or DNS being unavailable. Never a guess.
- **invalid** — malformed, or the domain cannot receive mail

The score (0–100) is a confidence figure, not a probability. Treat it as a
ranking signal for sorting a list, not as a guarantee.

---

## API

### `POST /api/validate`

```bash
curl -X POST http://localhost:3000/api/validate \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com"}'
```

```json
{
  "email": "user@example.com",
  "normalized": "user@example.com",
  "verdict": "valid",
  "score": 85,
  "suggestion": null,
  "checks": [
    { "id": "syntax", "label": "Format", "status": "pass", "detail": "Valid email structure" }
  ],
  "meta": {
    "local": "user",
    "domain": "example.com",
    "mx": [{ "exchange": "mail.example.com", "priority": 10 }],
    "provider": "Google Workspace / Gmail",
    "free": false,
    "role": false,
    "disposable": false
  },
  "tookMs": 26
}
```

`status` on each check is one of `pass`, `warn`, `fail`, `skip`, or `info`.

### `POST /api/validate/bulk`

Queued, not synchronous — a large list takes minutes and no proxy will hold a
socket open that long. Returns **202** with a job id immediately.

```bash
curl -X POST http://localhost:3000/api/validate/bulk \
  -H "Content-Type: application/json" \
  -d '{"emails":["a@gmail.com","b@gmial.com"]}'
```

```json
{ "id": "0246dcd3-...", "state": "running", "total": 2, "done": 0, "progress": 0,
  "summary": { "valid": 0, "risky": 0, "unknown": 0, "invalid": 0 } }
```

### `GET /api/jobs/:id`

Poll for progress. While running it returns counters only; once `state` is
`done` it also carries `results`. Jobs expire after `JOB_TTL_MS` (1 hour).

**Per-domain throttling** is the part that protects accuracy: probes to one
domain are spaced `PER_DOMAIN_GAP_MS` apart regardless of worker concurrency.
Firing hundreds of concurrent probes at one provider gets the IP greylisted
and then blocked, after which results get worse, not faster.

### `GET /?email=user@example.com`

The page reads the `email` query parameter, fills the box and runs the check,
so any result can be shared as a link. The URL updates on each check.

### `GET /api/health`

Service status, blocklist size and source, DNS cache size, uptime.

---

## Configuration

Copy `.env.example` to `.env`, or set the variables directly.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP port |
| `SMTP_CHECK` | `false` | Enable deep checks 9–10. **Needs outbound port 25.** |
| `BULK_LIMIT` | `5000` | Max addresses per bulk request |
| `RATE_MAX` | `60` | Requests per IP per minute |
| `DNS_SERVERS` | *(auto)* | Comma-separated resolvers, e.g. `1.1.1.1,8.8.8.8` |
| `SMTP_HELO` | `localhost` | EHLO hostname. **Must match your PTR record** on a real server. |
| `SMTP_CANARIES` | `2` | Random probes per domain for catch-all detection (0–10) |
| `SMTP_GREYLIST_DELAY` | `5000` | Inline retry delay for 4xx deferrals, in ms |
| `RDAP_CHECK` | `true` | Look up domain registration age. Set `false` to skip. |
| `RDAP_TIMEOUT` | `6000` | RDAP request timeout, in ms |
| `BULK_CONCURRENCY` | `8` | Bulk workers running at once |
| `PER_DOMAIN_GAP_MS` | `350` | Minimum gap between probes to the same domain |
| `JOB_TTL_MS` | `3600000` | How long finished jobs stay pollable |

### DNS resolution

The host's own resolver is tried first when it looks usable, then public
resolvers (`1.1.1.1`, `8.8.8.8`, `9.9.9.9`) as failover. A refused or timed-out
lookup moves to the next resolver; a real "no such domain" answer is final.

This matters: many containers ship a loopback resolver with nothing behind it.
Without failover, every domain would be reported as non-existent.

---

## Domain signals (7 and 8)

SPF, DMARC and registration age answer a different question from the SMTP
layer. They do not prove a mailbox exists — they say whether the *domain* is
one a real organisation runs, or one somebody stood up last Tuesday.

A domain registered four days ago with no SPF and no DMARC is a throwaway or a
phishing setup even when its mail server accepts the address. These signals
lower confidence and can tip a `valid` into `risky`. **They never make an
address `invalid`** — a confirmed mailbox on a new domain genuinely exists.

| Signal | Effect on score |
|---|---|
| No SPF **and** no DMARC | −10, and downgrades to `risky` |
| SPF but no DMARC | −4 |
| Registered < 30 days | −25, downgrades to `risky` |
| Registered < 90 days | −15, downgrades to `risky` |
| Registered < 1 year | −5 |
| Registration date unknown | **no penalty** |

A definitive answer (a date, or a TLD with no RDAP service) is cached for
seven days. A timeout or network error is cached for only ten minutes - a
failed lookup is not an answer, and caching one would hide a real date for a
week.

That last row matters: most ccTLDs (`.io`, `.de`, `.co.uk`) publish no RDAP
service at all, so an unknown date is normal and must not count against a
domain.

Registration lookups go through the **IANA RDAP bootstrap**
(`data.iana.org/rdap/dns.json`), which maps each TLD to its authoritative
registry. Querying the registry directly avoids the public `rdap.org`
redirector, which rate-limits and returns 403 to unknown clients. The
bootstrap is fetched once and refreshed weekly; results are cached per domain
for seven days, auth records for six hours.

Both lookups run **concurrently with the SMTP probe**, so they add no
wall-clock time to a check.

---

## Deep checks (9 and 10)

Turning these on requires **outbound port 25**, which most hosts block.

```bash
SMTP_CHECK=true npm start
```

### Where port 25 works

| Host | Status |
|------|--------|
| OVH, RackNerd, Contabo | Usually open by default (Contabo throttles to ~25/min) |
| Render (paid instances) | Open, no ticket needed |
| Vultr, DigitalOcean, Linode | Blocked by default, unblocked on request |
| Hetzner | Verify current policy before buying — reports conflict |
| Vercel, Netlify, Cloudflare Pages | Permanently blocked |
| Railway, Fly, Render free | Blocked (Railway: Pro plan only) |
| AWS, GCP, Azure | Blocked, effectively unappealable |

**Ports 587 and 465 cannot substitute.** Those are authenticated *submission*
ports that only talk to your own mail provider. Verification requires a
direct-to-MX conversation on port 25. Transactional email APIs (SendGrid,
Resend, Mailgun) do not help either — they send mail, they do not verify it.

### Reply classification — the thing most validators get wrong

**Never classify on the three-digit SMTP code.** These two are both `550` and
mean opposite things:

```
550 5.1.1  The email account does not exist   ->  the mailbox is dead
550 5.7.1  blocked using Spamhaus             ->  WE are blocked
```

A validator that reads every `550` as "invalid" marks real, working addresses
as dead every time a provider refuses its IP. That is the worst failure this
tool can have, so `lib/smtp-codes.js` classifies on the **enhanced status
code** (`X.Y.Z`), falling back to reply text only when the server omits one.

| Enhanced code | Meaning | Verdict |
|---|---|---|
| `5.1.1`, `5.1.0`, `5.1.6`, `5.5.0` | No such user | invalid |
| `5.2.1` | Mailbox disabled | invalid |
| `5.2.2`, `5.2.3` | Mailbox full | risky — it exists |
| `5.7.*` | Policy / IP reputation block | **unknown, never invalid** |
| `4.*` | Greylisted or throttled | retry, then unknown |
| `2.*` | Accepted | valid, unless catch-all |

**Failure stage matters too.** Outlook and Yahoo reject at `MAIL FROM`, before
the address is ever sent — so nothing was learned about the mailbox. Any
verdict other than `unknown` there would be fabricated. The result carries
`stage` and `reachedRcpt` so this stays visible.

### Measured provider behaviour

Probed live on 2026-09-23 from a residential IP with no PTR record:

| Provider | Failed at | Reply | Meaning |
|---|---|---|---|
| Gmail | RCPT | `550 5.1.1 account does not exist` | honest answer |
| Zoho | RCPT | `550 5.1.1 User does not exist` | honest answer |
| Proton | RCPT | `550 5.1.1 Address does not exist` | honest answer |
| iCloud | RCPT | `550 5.7.1 listed in Spamhaus SBL` | our IP blocked |
| Outlook | MAIL FROM | `550 5.7.1 blocked using Spamhaus` | our IP blocked |
| Yahoo / AOL | MAIL FROM | `550 5.7.25 reverse DNS failed` | no PTR record |

Gmail, Zoho and Proton answer honestly from any IP. The other three refuse the
*connection*, not the address — which is an infrastructure problem, not a code
problem. To unlock them you need:

1. **Forward-confirmed reverse DNS** — a PTR record for your IP whose hostname
   resolves back to that same IP, with `SMTP_HELO` set to match it.
2. **An IP not on Spamhaus PBL/SBL** — every residential IP is on the PBL by
   definition, so this means a VPS with a clean static address.
3. **Low, steady volume per destination** — cache by domain and throttle.

Get those right and roughly 50% provider coverage becomes roughly 90%.

### What these checks can and cannot tell you

- **Gmail does answer honestly** — the widely repeated claim that it accepts
  every address to defeat probing is wrong, and was verified false against
  live servers. So do Zoho and Proton. Outlook, Yahoo, AOL and iCloud refuse
  the connection instead, which is an IP reputation problem, not a lie.
- **Catch-all domains** accept everything, so check 8 exists to flag when
  check 7's answer is meaningless.
- **Greylisting** returns a temporary `4xx` to unknown senders. The probe
  retries once from the same IP, which is why a check can take a few seconds.
- **Your IP reputation is the accuracy ceiling.** Probing heavily from one
  address leads to greylisting and then blocking — after which results get
  worse, not better. Commercial APIs solve this with hundreds of rotating IPs.

The only method that proves a mailbox exists is sending a real confirmation
email and having someone click the link.

---

## Theming

Light and dark are both supported. The page follows the operating system
preference until the toggle in the header is used; from then on the explicit
choice is stored in `localStorage` and wins in both directions. Clearing that
key returns the page to following the system.

The theme is applied by an inline script in `<head>` before first paint, so
there is no flash of the wrong colours on load.

Every colour is a CSS variable on `:root`. Dark values are declared twice — once
under `prefers-color-scheme: dark` (scoped to `:root:not([data-theme="light"])`)
and once under `:root[data-theme="dark"]` — so the toggle overrides the system
in either direction. To restyle the app, change the variables at the top of
`public/style.css` and nothing else.

## Project layout

```
server.js              Express app, API routes, rate limiting
lib/
  validator.js         Check orchestration, verdict and scoring
  dns-check.js         MX and A lookups, resolver failover, provider detection
  disposable.js        Blocklist: network refresh, disk cache, offline fallback
  typo.js              Damerau-Levenshtein domain suggestions
  normalize.js         Gmail dot/+tag canonicalisation
  domain-intel.js      SPF, DMARC and RDAP registration age
  smtp.js              RCPT TO probe, catch-all canaries, greylist retry, stages
  smtp-codes.js        Enhanced status code classification (the accuracy core)
  cache.js             TTL cache
  queue.js             Background job queue with per-domain throttling
test/
  classify.test.mjs    Classifier and normalisation tests (npm test)
public/
  index.html           Single page: single check and bulk check
  style.css            Design tokens and layout
  app.js              Rendering and API calls
data/                  Downloaded blocklist cache (gitignored)
```

---

## Notes on the implementation

**Caching by domain.** DNS results are cached for six hours keyed on the
domain, so a list of 500 Gmail addresses does one lookup, not 500.

**The blocklist refreshes itself.** A hardcoded list is stale within weeks.
The community list (100k+ domains) is fetched on boot and daily thereafter,
cached to `data/`, with a small bundled fallback if the network is unavailable.
A download that returns fewer than 1,000 domains is rejected as truncated.

**DNS failure is not a verdict.** If every resolver is unreachable, the result
is `unknown`, not `invalid`. Reporting a working address as dead because your
own DNS broke is the worst failure mode this tool has.

**Internationalised domains** are converted to punycode before validation, so
`müller.de` is treated the same as `xn--mller-kva.de`.

**SMTP inputs are sanitised.** Addresses containing CR, LF, or angle brackets
are rejected before reaching a socket, so nothing can smuggle a second command
into the SMTP conversation.

---

## Deploying

Checks 1–6 run anywhere Node runs, including every free tier.

For deep checks, the common split is:

- Static frontend on a CDN host (Cloudflare Pages, Netlify) — free and fast
- API on a small VPS with port 25 open — around $3–6/month

If the VPS is down, the free checks still work.

## Adding a paid verification API

If you later want mailbox-level accuracy without running your own SMTP prober,
`lib/smtp.js` exposes a single function — `verifyMailbox(email, mxHosts)` —
that returns `{ status, catchAll, detail }`. Swap its body for a call to
MillionVerifier, ZeroBounce, or similar and nothing else in the codebase
changes.

At the time of writing, per-check pricing runs roughly $0.0015–$0.008
depending on provider and volume.

---

## Hardening

Five security headers are set on every response, written out rather than
pulling in `helmet` — being explicit shows exactly what is allowed:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` — the page cannot be framed |
| `Referrer-Policy` | `no-referrer` — the checked address is in the URL |
| `Permissions-Policy` | geolocation, mic, camera, payment all off |
| `Content-Security-Policy` | self only, plus Google Fonts |

`Referrer-Policy` matters here specifically: results live at `?email=...`, so
without it every outbound link would leak someone's address.

**Errors.** An unknown `/api/*` path answers with JSON, not an HTML error
page. Malformed JSON returns 400 and an oversized body 413, both in the format
matching the route.

**Graceful shutdown.** SIGTERM and SIGINT stop accepting connections, let
in-flight checks finish, then exit - with a 10 second cap so a slow SMTP probe
cannot hang a restart. A second signal exits immediately. This matters under
systemd; note that Windows does not deliver POSIX signals, so it is a no-op
during local development there.

**robots.txt** disallows `/?email=` and `/api/` — result URLs contain a real
address and should never be indexed.

---

## Interface notes

**Shareable results.** Every check updates the URL to `?email=...`, and opening
such a link runs the check automatically. Copy the address bar to share a result.

**Copy button.** The icon beside the score copies a plain-text summary of every
check row — useful for pasting into a ticket or a message.

**Score caption.** The ring shows confidence that the address is safe to send
to, with a word under it (high / good / low / very low) and the full meaning on
hover. It is a ranking signal, not a probability.

**Staged progress.** A deep check takes 1–2 seconds, so the input shows what it
is doing ("Looking up the domain…", "Asking the mail server about the mailbox…").
The timings are fixed to the real order of work; the server sends no progress
events.

**Recent checks.** The last 8 addresses are kept in `localStorage`, colour-coded
by verdict, and clicking one re-runs it. Nothing leaves the browser; **Clear**
removes them.

**Bulk filters.** The four summary tiles are buttons — click one to show only
that verdict, click again to clear. Rows show score, provider and the first
problem found.
