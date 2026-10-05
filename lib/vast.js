/**
 * Minimal vast.ai REST client.
 *
 * Only what the admin panel needs: find the cheapest rentable GPU offer with a
 * directly-mappable port, rent it and boot the SMTP worker on it, check its
 * status, and destroy it. No SDK dependency - vast.ai's API is small enough
 * to call directly with fetch.
 */
const API = 'https://console.vast.ai/api/v0';

// Rental defaults. The worker is a few MB of JS plus express - the disk is for
// the image, not for data, so 8GB is plenty. Reliability and duration are the
// two filters that actually matter: a host at 11% reliability or one that only
// offers a 1h rental will drop the box mid-run, which costs a rental and sends
// every address in flight back as "unknown".
// 8GB was sized for a few MB of JS plus express. Chromium and its apt
// dependencies add roughly 1-2GB, so the floor goes up when we install one -
// a box that runs out of disk mid-install fails in a way that is tedious to
// diagnose from a boot log.
const DISK_GB = Number(process.env.VAST_DISK_GB || 12);
const MIN_RELIABILITY = Number(process.env.VAST_MIN_RELIABILITY || 0.95);
// vast.ai reports max rental duration in days; 1h offers are 0.0417.
const MIN_DURATION_DAYS = Number(process.env.VAST_MIN_DURATION_DAYS || 1);

/**
 * Ceiling on metered bandwidth, in dollars per TB, each way.
 *
 * The hourly price is only half of what a box costs: vast.ai bills transfer
 * separately, so an offer can advertise a very low $/hr and make it back on
 * traffic. This job moves almost nothing - an SMTP probe is a few KB, and a
 * whole 100k run is well under a gigabyte - so in practice transfer is a
 * rounding error next to the rental, and the going rate is a fraction of a
 * cent per TB either way.
 *
 * The cap exists for the outlier rather than the average: it refuses the box
 * that charges dollars per TB, while leaving every normally-priced offer
 * eligible.
 *
 * Setting it to 0 does work - some hosts do include transfer - but it is a bad
 * trade here, and worth spelling out because it looks like the careful choice.
 * Measured: the cheapest offer with free transfer was $0.1023/hr against
 * $0.0296/hr for the cheapest overall, so insisting on free transfer costs
 * about $0.07 an hour to avoid a charge that, on under a gigabyte a run, comes
 * to small fractions of a cent. The hourly rate is the bill; transfer is noise.
 */
const MAX_INET_COST = Number(process.env.VAST_MAX_INET_COST_PER_TB || 1);

/**
 * Whether a rented box installs Chromium at boot so it can take Yahoo too.
 *
 * On by default: without it the Yahoo family is stuck on the single OVH IP at
 * 1200ms apiece, which dominates the clock on any large list however many
 * boxes are rented. Set VAST_INSTALL_BROWSER=off to go back to SMTP-only
 * boxes that boot a few minutes faster.
 */
const BROWSERS = String(process.env.VAST_INSTALL_BROWSER || 'on').toLowerCase() !== 'off';

const key = () => String(process.env.VAST_API_KEY || '').trim();

export const vastEnabled = () => Boolean(key());

async function call(path, { method = 'GET', body } = {}) {
  if (!key()) throw new Error('VAST_API_KEY is not set');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.msg || data.error || `vast.ai ${method} ${path} failed (${res.status})`);
  }
  return data;
}

/**
 * The cheapest verified, rentable, on-demand offer that can forward a port
 * directly to the host. GPU compute is unused - this only needs a reachable
 * IP with port 25 outbound, so price is the only thing that matters, and the
 * search is pinned to single-GPU machines so it can never pay for silicon it
 * will leave completely idle.
 */
export async function cheapestOffer() {
  const data = await call('/bundles/', {
    method: 'POST',
    body: {
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      type: 'ondemand',
      direct_port_count: { gte: 1 },
      // Exactly one GPU. The GPU is never used at all - this box only needs a
      // reachable IP with outbound port 25 - so a multi-GPU machine is pure
      // cost with nothing to show for it, and the cheapest-per-hour search can
      // land on one when a big box is underpriced that minute.
      num_gpus: { eq: 1 },
      // Refuse a box that would make its money back on metered transfer.
      inet_up_cost: { lte: MAX_INET_COST },
      inet_down_cost: { lte: MAX_INET_COST },
      reliability2: { gte: MIN_RELIABILITY },
      duration: { gte: MIN_DURATION_DAYS },
      order: [['dph_total', 'asc']],
      limit: 1
    }
  });
  const offer = data.offers?.[0];
  if (!offer) {
    throw new Error(`No vast.ai offer matches: verified, port-forwarding, single-GPU, transfer <= $${MAX_INET_COST}/TB, reliability >= ${Math.round(MIN_RELIABILITY * 100)}%, rentable for >= ${MIN_DURATION_DAYS}d. Loosen VAST_MIN_RELIABILITY, VAST_MIN_DURATION_DAYS or VAST_MAX_INET_COST_PER_TB`);
  }
  return offer;
}

/**
 * The current rentable offer for one pinned id, which may be either kind of id
 * vast.ai shows on an instance:
 *
 *   machine_id - ONE physical box. This is what "I want that exact machine
 *                again" means: same CPU, same disk, same IP range, same
 *                outbound port 25 behaviour, same standing with Yahoo.
 *   host_id    - the PROVIDER, who often owns dozens of machines. Pinning one
 *                only says "rent from this seller", and which box you get is
 *                still whichever they happen to have free.
 *
 * Both are tried, machine first, because the owner pins an id after finding a
 * box that worked and the exact box is the stronger of the two wishes. Trying
 * machine_id only as a host_id - which is what this did before - silently
 * matched nothing and fell through to the cheapest offer anywhere on vast.ai,
 * so a careful pin quietly did nothing at all.
 *
 * Both are stable across searches, unlike an individual offer/ask id, which is
 * a snapshot that can expire or be rented by someone else between one search
 * and the next.
 */
export async function offerByHost(pinnedId) {
  const id = Number(pinnedId);
  const base = {
    rentable: { eq: true },
    rented: { eq: false },
    type: 'ondemand',
    // Same single-GPU rule as the cheapest search: a pinned host can offer
    // several machine sizes, and the GPU count is irrelevant to this job.
    num_gpus: { eq: 1 },
    // Same transfer-price ceiling as the cheapest search: a pinned box is
    // still worth refusing if its bandwidth is priced like a trap.
    inet_up_cost: { lte: MAX_INET_COST },
    inet_down_cost: { lte: MAX_INET_COST },
    duration: { gte: MIN_DURATION_DAYS },
    limit: 1
  };

  for (const field of ['machine_id', 'host_id']) {
    let data;
    try {
      data = await call('/bundles/', { method: 'POST', body: { ...base, [field]: { eq: id } } });
    } catch {
      continue;   // a field this API version rejects is not a reason to give up on the other
    }
    const offer = data.offers?.[0];
    if (offer) return offer;
  }

  throw new Error(`#${pinnedId} has no rentable single-GPU offer right now - as a machine id it may be rented out or offline, and as a host id that seller may have nothing free`);
}

/**
 * Rent an offer and boot the SMTP worker on it. The instance has no copy of
 * this repo - its onstart script pulls the handful of worker files straight
 * from this app's own /internal/worker-bundle endpoint (gated by the same
 * SMTP_WORKER_KEY) rather than needing a git remote or registry. The image
 * itself already has Node and npm, so boot does not install Node - a
 * debian-slim image has no curl by default, and re-installing Node on top of
 * an image that already has it only adds a step that can fail and abort the
 * whole chain before the worker ever starts.
 *
 * It DOES install a browser, because the Yahoo family (yahoo/aol/att/verizon)
 * cannot be settled over SMTP and needs Chromium driven by patchright. That
 * step is the slow and fragile one - a few hundred MB plus apt libraries - so
 * it is deliberately the LAST thing before the worker starts and is allowed to
 * fail without taking the box down: a box with port 25 and no browser is still
 * worth every non-Yahoo address on it. The worker launches Chromium once at
 * startup and reports the result as `chromium` on /api/health, which is what
 * the app routes Yahoo on - so a half-installed browser is detected rather
 * than assumed either way.
 */
export async function createWorkerInstance(offerId, { workerKey, helo, bundleUrl }) {
  const onstart = [
    'mkdir -p /app && cd /app',
    'node -e \'' +
      'fetch(process.env.BUNDLE_URL,{headers:{"x-worker-key":process.env.SMTP_WORKER_KEY}})' +
      '.then(r=>r.json()).then(({files})=>{' +
      'const fs=require("fs"),path=require("path");' +
      'for(const f of files){fs.mkdirSync(path.dirname(f.path),{recursive:true});fs.writeFileSync(f.path,Buffer.from(f.content,"base64"));}' +
      '}).catch(e=>{console.error(e);process.exit(1)})' +
      '\' >>/tmp/boot.log 2>&1',
    'npm install --omit=dev >>/tmp/boot.log 2>&1',
    // The browser for the Yahoo-family probe, started in the BACKGROUND (&)
    // and deliberately NOT waited for.
    //
    // It is several hundred MB plus apt dependencies - minutes of work - while
    // the Yahoo family is only a part of a typical list. Running it inline put
    // every other provider behind it: the box sat with working outbound 25 and
    // nothing to do while Chrome downloaded, and on a short list the run
    // finished on OVH before the box served a single address.
    //
    // So the worker starts at once and serves SMTP from the first second. It
    // keeps re-testing for a browser as the install lands (testChromium in
    // worker.js) and flips `chromium` to true on /api/health when it does, at
    // which point the app starts routing Yahoo here too - watchForBrowser in
    // lib/vast-auto.js is already polling for exactly that.
    //
    // `chrome`, not just `chromium`: lib/yahoo-oracle.js launches with
    // channel:'chrome' (patchright's own guidance - real Chrome leaks far less
    // than the bundled build). Installing chromium alone left the box with a
    // browser the probe never asks for, so every Yahoo probe threw "browser not
    // found" while a plain launch test still passed. Chromium goes on too, as
    // the fallback YAHOO_ORACLE_CHANNEL=chromium wants.
    (BROWSERS
      // Wrapped in a subshell: the steps are joined with ' && ', and a bare
      // trailing '&' before '&&' is a bash syntax error that kills the whole
      // onstart script - the box then boots to nothing at all. '( ... & )' is
      // an ordinary command to the parser, so the chain stays valid while the
      // install still detaches.
      ? '( nohup npx --yes patchright install --with-deps chrome chromium >>/tmp/browser.log 2>&1 & )'
      : 'echo "browser install skipped (VAST_INSTALL_BROWSER=off)" >>/tmp/browser.log'),
    'SMTP_CHECK=true WORKER_PORT=3001 npm run worker >>/tmp/worker.log 2>&1'
  ].join(' && ');

  return call(`/asks/${offerId}/`, {
    method: 'PUT',
    body: {
      image: 'node:20-bookworm-slim',
      disk: DISK_GB,
      runtype: 'ssh_direct',
      env: {
        SMTP_WORKER_KEY: workerKey,
        SMTP_HELO: helo || '',
        BUNDLE_URL: bundleUrl,
        '-p 3001:3001': '1'
      },
      onstart
    }
  });
}

/** Thrown instead of returning null, so callers cannot mistake "gone" for "still booting". */
export class InstanceGoneError extends Error {}

export async function getInstance(id) {
  const data = await call(`/instances/${id}/`);
  // vast.ai answers an instance that was destroyed, reaped by the host, or
  // simply never existed the same way: {"instances": null}, not a 404.
  if (!data.instances) throw new InstanceGoneError(`Instance #${id} no longer exists on vast.ai`);
  return data.instances;
}

/** Pause or resume billing for compute without losing the instance (unlike destroy). */
export async function setInstanceState(id, state) {
  return call(`/instances/${id}/`, { method: 'PUT', body: { state } });
}

export async function destroyInstance(id) {
  return call(`/instances/${id}/`, { method: 'DELETE' });
}
