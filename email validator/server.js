import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { validateEmail } from './lib/validator.js';
import { DisposableList } from './lib/disposable.js';
import { smtpEnabled } from './lib/smtp.js';
import { dnsCacheSize } from './lib/dns-check.js';
import { greylistPendingSize, greylistResolvedSize } from './lib/greylist.js';
import { JobQueue } from './lib/queue.js';
import { initTlds, tldCount, tldSource } from './lib/tlds.js';
import { warmup as warmRdap } from './lib/domain-intel.js';
import { Auth, AuthError, COOKIE, publicUser, readCookie, sessionCookie, clearCookie } from './lib/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const BULK_LIMIT = Number(process.env.BULK_LIMIT || 5000);
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 60);

const app = express();
app.disable('x-powered-by');
// Only trust X-Forwarded-For behind a real proxy; otherwise anyone could fake
// their IP and dodge the rate limit and the login lockout.
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

// ---- Security headers --------------------------------------------------
// Written out rather than pulling in helmet: five headers is not worth a
// dependency, and being explicit shows exactly what is allowed.
app.use((_req, res, next) => {
  res.set({
    // Stop browsers guessing content types.
    'X-Content-Type-Options': 'nosniff',
    // No one should be able to frame this and trick users into clicking.
    'X-Frame-Options': 'DENY',
    // Do not leak the checked address in a Referer header - it is in the URL.
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      // 'unsafe-inline' is needed for the pre-paint theme script and the
      // inline <style>; there is no user-supplied script anywhere.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com',
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'"
    ].join('; ')
  });
  next();
});

app.use(express.json({ limit: '2mb' }));

// ---- Shared disposable blocklist -------------------------------------
const disposable = new DisposableList({ dataDir: join(__dirname, 'data') });
await disposable.init();

// ---- Real TLD list (stops valid TLDs being "corrected") ---------------
await initTlds({ dataDir: join(__dirname, 'data') });

// Pull the RDAP bootstrap now so the first request does not race it.
warmRdap();

// ---- Rate limiting ----------------------------------------------------
// Fixed window per IP. Swap for Redis when you run more than one process.
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, rec] of hits) if (rec.start < cutoff) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function rateLimit(cost = 1) {
  return (req, res, next) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || now - rec.start > RATE_WINDOW_MS) {
      rec = { start: now, count: 0 };
      hits.set(ip, rec);
    }
    rec.count += cost;
    if (rec.count > RATE_MAX) {
      const retryAfter = Math.ceil((rec.start + RATE_WINDOW_MS - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({
        error: 'Too many requests',
        detail: `Limit is ${RATE_MAX} checks per minute. Try again in ${retryAfter}s.`
      });
    }
    res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_MAX - rec.count)));
    next();
  };
}

// ---- Accounts --------------------------------------------------------
const auth = new Auth({ dataDir: join(__dirname, 'data') });
await auth.init();

// Attach the signed-in user (if any) to every request.
app.use((req, _res, next) => {
  req.user = auth.userForToken(readCookie(req, COOKIE));
  next();
});

// State-changing requests must come from this site. JSON bodies already need a
// CORS preflight cross-site; this also rejects a foreign Origin outright.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.get('host')) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }
  next();
});

const requireUser = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'Please sign in', signIn: '/login' });

const authRoute = (fn) => async (req, res) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof AuthError) return res.status(err.status).json({ error: err.message });
    console.error('auth failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// No public sign-up: the owner creates accounts with `npm run add-user`.

app.post('/api/auth/login', authRoute(async (req, res) => {
  const { email, password, remember } = req.body || {};
  const key = `${req.ip}|${String(email || '').toLowerCase()}`;
  const wait = auth.checkThrottle(key);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
  }
  const user = await auth.verify(email, password);
  if (!user) {
    auth.recordFailure(key);
    // One message for both cases, so the form does not reveal which emails have accounts.
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  auth.clearFailures(key);
  auth.track(user, { login: true });
  const { token, maxAge } = await auth.createSession(user, remember);
  res.set('Set-Cookie', sessionCookie(req, token, maxAge));
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', authRoute(async (req, res) => {
  await auth.destroySession(readCookie(req, COOKIE));
  res.set('Set-Cookie', clearCookie());
  res.json({ ok: true });
}));

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  const me = auth.users.find(u => u.id === req.user.id) || req.user;
  res.json({ user: { ...publicUser(me), role: auth.roleOf(me), credits: auth.creditsOf(me), canCreateResellers: auth.canMakeResellers(me) } });
});

// ---- Users: owner manages everyone, a reseller only their own users -----
const requireManager = (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please sign in' })
  : auth.canManageUsers(req.user) ? next()
  : res.status(403).json({ error: 'You do not have access to user management' });

const userView = (u, actor) => {
  const creator = u.createdBy && auth.users.find(x => x.id === u.createdBy);
  return {
    id: u.id, username: u.email, name: u.name, role: auth.roleOf(u),
    disabled: !!u.disabled, createdAt: u.createdAt, credits: auth.creditsOf(u),
    canCreateResellers: auth.roleOf(u) === 'reseller' && !!u.canCreateResellers,
    createdBy: creator ? { id: creator.id, name: creator.name, username: creator.email } : null,
    checks: u.checks || 0, logins: u.logins || 0,
    lastLoginAt: u.lastLoginAt || null, lastActiveAt: u.lastActiveAt || null,
    // Only whoever manages this user may see the password; owners' passwords are never shown.
    password: actor && auth.canEdit(actor, u) ? auth.decrypt(u.pwEnc) : null
  };
};

app.get('/api/users', requireManager, authRoute(async (req, res) => {
  await auth.locked(() => auth.reload());
  const meNow = auth.users.find(u => u.id === req.user.id) || req.user;
  res.json({ me: auth.roleOf(req.user), canCreateResellers: auth.canMakeResellers(meNow), users: auth.visibleTo(req.user).map(u => userView(u, req.user)) });
}));

app.post('/api/users', requireManager, authRoute(async (req, res) => {
  const { name, username, password, reseller, credits, canCreateResellers } = req.body || {};
  const actorNow = auth.users.find(u => u.id === req.user.id) || req.user;
  if (reseller && !auth.canMakeResellers(actorNow)) throw new AuthError(403, 'You cannot create resellers');
  if (canCreateResellers && auth.roleOf(actorNow) !== 'owner') throw new AuthError(403, 'Only the owner can let a reseller create resellers');
  const start = Math.max(0, Math.trunc(Number(credits) || 0));
  // Check the reseller can afford the starting credits before creating anything.
  const meNow = auth.users.find(u => u.id === req.user.id) || req.user;
  if (start && !auth.isOwner(meNow) && (meNow.credits || 0) < start) {
    throw new AuthError(402, `You only have ${(meNow.credits || 0).toLocaleString()} credits to give`);
  }
  let user = await auth.signup({
    name: String(name || ''), username: String(username || ''), password,
    role: reseller ? 'reseller' : 'user', createdBy: req.user.id,
    canCreateResellers: !!(reseller && canCreateResellers)
  });
  if (start) user = await auth.transferCredits(req.user, user.id, start);
  res.status(201).json({ user: userView(user, req.user) });
}));

app.patch('/api/users/:id', requireManager, authRoute(async (req, res) => {
  const user = await auth.updateUser(req.user, req.params.id, req.body || {});
  res.json({ user: userView(user, req.user) });
}));

app.post('/api/users/:id/credits', requireManager, authRoute(async (req, res) => {
  const user = await auth.transferCredits(req.user, req.params.id, req.body?.amount);
  res.json({ user: userView(user, req.user), myCredits: auth.creditsOf(auth.users.find(u => u.id === req.user.id)) });
}));

app.delete('/api/users/:id', requireManager, authRoute(async (req, res) => {
  await auth.deleteUser(req.user, req.params.id);
  res.json({ ok: true });
}));

// ---- API ---------------------------------------------------------------

app.post('/api/validate', requireUser, rateLimit(1), async (req, res) => {
  const email = req.body?.email;
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'Provide an "email" string' });
  }
  if (email.length > 320) {
    return res.status(400).json({ error: 'Address is too long' });
  }
  try {
    await auth.charge(req.user, 1);
  } catch (err) {
    return res.status(err.status || 402).json({ error: err.message, credits: auth.creditsOf(req.user) });
  }
  try {
    const result = await validateEmail(email, { disposable });
    auth.track(req.user, { checks: 1 });
    res.json(result);
  } catch (err) {
    console.error('validate failed:', err);
    await auth.refund(req.user, 1).catch(() => {});
    res.status(500).json({ error: 'Validation failed' });
  }
});

// Bulk is queued, not synchronous: a large list takes minutes and no proxy
// will hold a socket open that long. Returns a job id to poll.
const queue = new JobQueue((email) => validateEmail(email, { disposable }));

app.post('/api/validate/bulk', requireUser, rateLimit(5), async (req, res) => {
  const list = req.body?.emails;
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'Provide an "emails" array' });
  }
  if (list.length > BULK_LIMIT) {
    return res.status(400).json({
      error: `Maximum ${BULK_LIMIT} addresses per batch`,
      received: list.length
    });
  }

  const clean = list
    .filter(e => typeof e === 'string' && e.trim() && e.length <= 320)
    .map(e => e.trim());

  if (!clean.length) return res.status(400).json({ error: 'No usable addresses' });

  try {
    await auth.charge(req.user, clean.length);
  } catch (err) {
    return res.status(err.status || 402).json({ error: err.message, credits: auth.creditsOf(req.user) });
  }

  const job = queue.create(clean);
  job.userId = req.user.id;
  auth.track(req.user, { checks: clean.length });
  res.status(202).json(queue.view(job));
});

app.get('/api/jobs/:id', requireUser, (req, res) => {
  const job = queue.get(req.params.id);
  // Only the user who started a job can read it.
  if (!job || job.userId !== req.user.id) return res.status(404).json({ error: 'Job not found or expired' });
  res.json(queue.view(job, Math.max(0, parseInt(req.query.since, 10) || 0)));
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    smtpChecks: smtpEnabled(),
    disposableDomains: disposable.size,
    disposableSource: disposable.source,
    disposableUpdatedAt: disposable.updatedAt,
    dnsCacheEntries: dnsCacheSize(),
    greylistPending: greylistPendingSize(),
    greylistResolved: greylistResolvedSize(),
    knownTlds: tldCount(),
    tldSource: tldSource(),
    activeJobs: queue.size,
    uptimeSeconds: Math.round(process.uptime())
  });
});

// An unknown /api/* path must answer in JSON. Falling through to the static
// handler returned an HTML error page, which breaks any API client.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown endpoint', path: req.originalUrl });
});

// ---- Pages ---------------------------------------------------------------
// The app itself needs a session; the login page is the only public page.
app.get(['/', '/index.html'], (req, res, next) => {
  if (!req.user) return res.redirect(302, '/login');
  next();
});
app.get(['/login', '/login.html'], (req, res) => {
  if (req.user) return res.redirect(302, '/');
  res.sendFile(join(__dirname, 'public', 'login.html'));
});

// ---- Static frontend ----------------------------------------------------
app.use(express.static(join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

// ---- Errors -------------------------------------------------------------
// Express hands body-parser failures (malformed JSON, oversized payload) here.
app.use((err, req, res, _next) => {
  const apiRoute = req.path.startsWith('/api');
  if (err?.type === 'entity.too.large') {
    const msg = 'Request body is too large';
    return apiRoute ? res.status(413).json({ error: msg }) : res.status(413).send(msg);
  }
  if (err instanceof SyntaxError && 'body' in err) {
    const msg = 'Malformed JSON body';
    return apiRoute ? res.status(400).json({ error: msg }) : res.status(400).send(msg);
  }
  console.error('unhandled error:', err);
  return apiRoute
    ? res.status(500).json({ error: 'Internal error' })
    : res.status(500).send('Internal error');
});

const server = app.listen(PORT, () => {
  console.log(`\n  Email Validator running at http://localhost:${PORT}`);
  console.log(`  Disposable domains: ${disposable.size} (${disposable.source})`);
  console.log(`  Known TLDs:         ${tldCount()} (${tldSource()})`);
  console.log(`  SMTP deep checks:   ${smtpEnabled() ? 'ON' : 'off (set SMTP_CHECK=true)'}\n`);
});

// ---- Graceful shutdown --------------------------------------------------
// systemd sends SIGTERM on restart. Without this, in-flight checks and any
// running bulk job are killed mid-request.
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1); // second signal: stop waiting
    shuttingDown = true;
    console.log(`\n  ${signal} received, finishing in-flight requests…`);

    server.close(() => {
      console.log('  closed cleanly');
      process.exit(0);
    });

    // Do not hang forever on a slow SMTP probe.
    setTimeout(() => {
      console.log('  shutdown timed out, exiting');
      process.exit(1);
    }, 10000).unref();
  });
}
