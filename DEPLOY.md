# Deploying with mailbox verification

Checks 1–8 run anywhere Node runs, including every free tier. This guide is
about unlocking checks 9–10 — the SMTP mailbox probe — which is the difference
between verifying **three** major providers and verifying **seven**.

Measured from a residential IP, before any of this:

| Provider | Result |
|---|---|
| Gmail / Workspace, Zoho, Proton | ✅ answers honestly |
| Outlook, Yahoo, AOL, iCloud | ⛔ refuses the connection |

Those four are not hiding the mailbox — they are refusing **your IP**. Three
things fix that, and none of them are code.

---

## 1. A host with outbound port 25

| Host | Port 25 | Notes |
|---|---|---|
| OVH, RackNerd, Contabo | open by default | Contabo throttles to ~25/min |
| Render (paid) | open | no ticket needed, ~$7/mo |
| Vultr, DigitalOcean, Linode | ticket required | usually approved in a day |
| Hetzner | verify first | policy reports conflict |
| Vercel, Netlify, Cloudflare, Railway, Fly, AWS, GCP, Azure | blocked | not workable |

Budget ~$5/month. You need a **static IPv4** address you control.

> Ports 587 and 465 cannot substitute. Those are authenticated *submission*
> ports that only talk to your own provider. Verification needs a
> direct-to-MX conversation on port 25.

Confirm it works before going further:

```bash
nc -vz gmail-smtp-in.l.google.com 25
```

---

## 2. Forward-confirmed reverse DNS (FCrDNS)

This is what Yahoo and AOL check. Without it they reject you at `MAIL FROM`
with `550 5.7.25 Forward-confirmed reverse DNS failed` — before your address
is ever sent.

You need **both** directions to agree:

1. **Forward** — an A record pointing at your IP. Add at your DNS host:
   ```
   mx.yourdomain.com.   A   203.0.113.10
   ```

2. **Reverse** — a PTR record pointing back. This is set in your **VPS
   provider's control panel**, not your DNS host. Look for "rDNS" or "Reverse
   DNS" on the server's network settings.
   ```
   203.0.113.10  ->  mx.yourdomain.com
   ```

Verify they match:

```bash
dig +short mx.yourdomain.com          # must print 203.0.113.10
dig +short -x 203.0.113.10            # must print mx.yourdomain.com.
```

If either is empty or they disagree, FCrDNS fails and Yahoo will keep
rejecting you.

Then point the validator at that hostname:

```bash
SMTP_HELO=mx.yourdomain.com
```

**The EHLO name must equal the PTR hostname.** A mismatch is one of the
clearest spam signals there is.

---

## 3. An IP that is not on Spamhaus

This is what Outlook and iCloud check. Every residential IP is on the Spamhaus
PBL by definition, which is why a home connection can never verify them.

Check a fresh VPS IP **before** you commit to it:

- <https://check.spamhaus.org/>
- <https://multirbl.valli.org/>

A clean IP on a reputable provider normally passes. If the IP arrives already
listed, ask support for a different one — that is a routine request.

Adding SPF for the probe domain helps your standing, even though you never
send mail:

```
yourdomain.com.   TXT   "v=spf1 ip4:203.0.113.10 -all"
```

---

## Keeping the IP clean

Reputation is the accuracy ceiling. Once an IP is greylisted or listed, results
get **worse**, not slower — so the defaults are conservative:

| Setting | Default | Why |
|---|---|---|
| `PER_DOMAIN_GAP_MS` | `350` | spaces probes to one provider apart |
| `BULK_CONCURRENCY` | `8` | total workers, across all domains |
| `SMTP_CANARIES` | `2` | catch-all probes; more risks anti-harvesting limits |

Do not raise these to make bulk jobs finish faster. DNS and catch-all results
are already cached per domain, which is where the real speed comes from.

---

## Split deployment: app on Railway, probe on a VPS

You do not have to put the whole app on the VPS. Only the SMTP probe needs
port 25; everything else — the UI, logins, credits, bulk queue — is ordinary
web traffic. So run two processes from this same repo:

| | Runs | Needs |
|---|---|---|
| **Web app** (Railway) | `npm start` | nothing special |
| **Worker** (VPS) | `npm run worker` | outbound port 25, PTR, clean IP |

The app calls the worker over HTTPS and gets back the same result it would
have computed locally. If the worker is down or the key is wrong, the mailbox
check reports `unknown` and the address is never wrongly marked invalid.

**On the VPS** — everything in sections 1–3 above still applies to this box,
since it is the one talking to mail servers:

```bash
SMTP_CHECK=true
SMTP_WORKER_KEY=<long random string>
SMTP_HELO=mx.yourdomain.com     # must match the VPS PTR record
WORKER_PORT=3001
WORKER_CONCURRENCY=20
```

```bash
npm run worker
```

Put it behind the same nginx TLS block as below (proxy to `3001`), so the key
never crosses the internet in the clear. The worker serves only
`POST /api/worker/verify` and `GET /api/health` — no UI, no accounts, no data.

**On Railway** — leave `SMTP_CHECK` unset, and point it at the VPS:

```bash
SMTP_WORKER_URL=https://probe.yourdomain.com
SMTP_WORKER_KEY=<the same string>
TRUST_PROXY=true
```

Confirm the wiring: `GET /api/health` on the app should report
`"smtpWorker": "https://probe.yourdomain.com"` and `"smtpChecks": true`.

> Railway's filesystem is ephemeral. `data/users.json`, `sessions.json` and
> `secret.key` are wiped on every redeploy. Mount a volume at `/data` and set
> `DATA_DIR=/data` to preserve accounts, sessions, credits, and bulk progress.
> Run one web app instance: this file storage does not support multiple replicas.

---

## Running it

```bash
git clone <your repo> && cd email-validator
npm install --omit=dev
cp .env.example .env
```

Edit `.env`:

```bash
PORT=3000
SMTP_CHECK=true
SMTP_HELO=mx.yourdomain.com     # must match your PTR record
NODE_ENV=production
```

### systemd unit

`/etc/systemd/system/email-validator.service`:

```ini
[Unit]
Description=3S Email Validator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=validator
WorkingDirectory=/opt/email-validator
ExecStart=/usr/bin/node --env-file-if-exists=.env server.js
Restart=always
RestartSec=5

# Hardening: the process only needs to read its own directory and talk out.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/email-validator/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin validator
sudo chown -R validator:validator /opt/email-validator
sudo systemctl enable --now email-validator
sudo journalctl -u email-validator -f
```

### Reverse proxy

Run Node behind nginx or Caddy for TLS. Caddy is two lines:

```
validator.yourdomain.com {
    reverse_proxy localhost:3000
}
```

The app sets `trust proxy`, so rate limiting sees the real client IP through
`X-Forwarded-For`.

---

## Verifying the deployment

```bash
curl -s localhost:3000/api/health
```

Then probe one address at each provider that was previously blocked:

```bash
for d in outlook.com yahoo.com icloud.com aol.com; do
  curl -s -X POST localhost:3000/api/validate \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"zzq9x7k3m2@$d\"}" |
    grep -o '"verdict":"[a-z-]*"'
done
```

**Before:** every one returns `unknown` (blocked).
**After:** they should return `invalid` — the server answered honestly that
the random mailbox does not exist. That is the signal everything worked.

If one still says `unknown`, read the detail field: it names the stage and the
enhanced status code, which tells you whether it is PTR (`5.7.25`) or a
blocklist (`5.7.1`).

---

## What this does not fix

- **Catch-all domains** (~15–28% of business domains) stay unknowable. No IP
  reputation changes that; the server genuinely accepts every address.
- **Greylisting** still needs a real 30–60s retry to resolve fully. The inline
  retry is deliberately short so HTTP requests stay responsive; a queued bulk
  job is the right place to raise `SMTP_GREYLIST_DELAY`.
- **Sending volume.** This tool never sends mail, but receiving servers cannot
  tell the difference. Treat the IP like a sending IP: warm it up gradually
  rather than running 50,000 checks on day one.
