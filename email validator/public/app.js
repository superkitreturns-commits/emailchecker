/* Email Validator — frontend */

const $ = (sel) => document.querySelector(sel);

/* ------------------------------ icons ------------------------------ */
const ICONS = {
  valid:   '<path d="M20 6L9 17l-5-5"/>',
  risky:   '<path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/>',
  invalid: '<path d="M18 6L6 18M6 6l12 12"/>',
  unknown: '<path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3m.1 4h.01"/><circle cx="12" cy="12" r="10"/>',
  pass:    '<path d="M20 6L9 17l-5-5"/>',
  warn:    '<path d="M12 8v5m0 3h.01"/>',
  fail:    '<path d="M18 6L6 18M6 6l12 12"/>',
  skip:    '<path d="M5 12h14"/>',
  info:    '<path d="M12 16v-5m0-3h.01"/>'
};

const svg = (path, cls = '') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const TITLES = {
  valid:   'Valid address',
  risky:   'Risky address',
  invalid: 'Invalid address',
  unknown: 'Cannot confirm'
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

/* ------------------------------ theme ------------------------------- */
/* No stored choice means "follow the system". The first toggle press
   resolves that to whichever theme is currently showing, then flips it. */
const systemPrefersDark = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches;

const currentTheme = () =>
  document.documentElement.getAttribute('data-theme')
  || (systemPrefersDark() ? 'dark' : 'light');

$('#themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  const root = document.documentElement;

  root.classList.add('theme-anim');
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }

  setTimeout(() => root.classList.remove('theme-anim'), 320);
});

/* Follow the OS while the user has not made an explicit choice. */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* ignore */ }
  if (!saved) document.documentElement.removeAttribute('data-theme');
});

/* ---------------------------- check display ---------------------------- */
// Users need to know "can I email this?", so the details lead with the four
// checks that answer it, plus anything that went wrong. The rest (DNS, SPF,
// domain age…) sits behind "technical details".
const KEY_CHECKS = ['smtp', 'catchall', 'disposable', 'role'];
const TECH_ONLY = ['auth', 'age'];   // never a reason on their own to distrust an address

function friendlyCheck(c) {
  if (c.id === 'auth') {
    return { ...c, label: 'Domain security', status: 'skip', raw: c.detail,
      detail: c.status === 'pass' ? 'Strong (SPF & DMARC)' : 'Basic' };
  }
  if (c.id === 'smtp' && c.status === 'skip' && /ECONN|ETIMEDOUT|EHOSTUNREACH|port 25|SMTP conversation|Conversation ended|GREETING|MAILFROM|refused our/i.test(c.detail)) {
    return { ...c, raw: c.detail, detail: "Couldn't reach the mail server, so the mailbox wasn't checked" };
  }
  if (c.id === 'age' && c.status === 'skip') return { ...c, raw: c.detail, detail: 'Age unknown' };
  return c;
}

function splitChecks(checks) {
  const byId = (id) => checks.find(c => c.id === id);
  const main = KEY_CHECKS.map(byId).filter(Boolean);
  checks.forEach(c => {
    if (KEY_CHECKS.includes(c.id) || TECH_ONLY.includes(c.id)) return;
    if (c.status === 'fail' || c.status === 'warn') main.push(c);
  });
  const tech = checks.filter(c => !main.includes(c));
  return { main: main.map(friendlyCheck), tech: tech.map(friendlyCheck) };
}

/** Render a check list with the technical rows folded away. rowFn draws one check. */
function renderCheckList(checks, rowFn) {
  const { main, tech } = splitChecks(checks);
  return `
    <div class="ck-main">${main.map(rowFn).join('')}</div>
    ${tech.length ? `
    <details class="ck-tech">
      <summary>Technical details <span>${tech.length}</span></summary>
      <div class="ck-tech-body">${tech.map(rowFn).join('')}</div>
    </details>` : ''}`;
}

/* ------------------------------ session ------------------------------ */
// Any API call that comes back 401 means the session ended: go to the login page.
const _fetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _fetch(...args);
  const url = String(args[0]?.url || args[0]);
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    location.replace('/login');
  }
  return res;
};

// Credits: 1 credit = 1 email check, sold at $0.10 per 1,000.
const PRICE_PER_1000 = 0.10;
window.PRICE_PER_1000 = PRICE_PER_1000;
function showCredits(credits) {
  window.applyCreditLock?.();
  const box = $('#spCredits'), val = $('#spCreditsVal');
  if (!box) return;
  if (credits === null || credits === undefined) {
    val.textContent = 'Unlimited credits';
    box.classList.remove('is-low', 'is-empty');
  } else {
    val.textContent = `${credits.toLocaleString()} credit${credits === 1 ? '' : 's'}`;
    box.classList.toggle('is-empty', credits === 0);
    box.classList.toggle('is-low', credits > 0 && credits < 100);
  }
}
window.refreshCredits = async () => {
  try {
    const res = await _fetch('/api/auth/me');
    if (res.ok) { const { user } = await res.json(); window.currentUser = user; showCredits(user.credits); }
  } catch {}
};

(async function loadUser() {
  try {
    const res = await _fetch('/api/auth/me');
    if (!res.ok) return location.replace('/login');
    const { user } = await res.json();
    $('#userAv').textContent = (user.name || user.email)[0].toUpperCase();
    // Top: client name (falls back to the username). Bottom: username, hidden if it would just repeat.
    const clientName = user.name && user.name !== user.email ? user.name : user.email;
    $('#userName').textContent = clientName;
    $('#userPopEmail').textContent = user.email;
    $('#userPopEmail').hidden = clientName === user.email;
    $('#userMenu').hidden = false;
    window.currentUser = user;
    showCredits(user.credits);
    const navUsers = $('#navUsers');
    const manager = user.role === 'owner' || user.role === 'reseller';
    if (navUsers) navUsers.hidden = !manager;
    if (location.hash === '#users' && !manager) location.hash = '#verify';
  } catch { /* offline: leave the menu hidden */ }
})();

$('#signOut').addEventListener('click', async () => {
  try { await _fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.replace('/login');
});

/* ------------------------------ dialogs ------------------------------ */
// In-app replacements for confirm() and a small toast, styled to match the UI.
function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', tone = 'danger' }) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mTitle" aria-describedby="mMsg">
        <span class="modal-icon m-${tone}" aria-hidden="true">
          ${tone === 'danger'
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></svg>'}
        </span>
        <h2 class="modal-title" id="mTitle">${esc(title)}</h2>
        <p class="modal-msg" id="mMsg">${esc(message)}</p>
        <div class="modal-actions">
          <button type="button" class="tbtn modal-cancel">${esc(cancelText)}</button>
          <button type="button" class="tbtn modal-ok ${tone === 'danger' ? 'tbtn-solid-danger' : 'tbtn-primary'}">${esc(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('is-open'));

    const cancelBtn = wrap.querySelector('.modal-cancel');
    const okBtn = wrap.querySelector('.modal-ok');
    // Destructive actions start on Cancel so a stray Enter can't delete anything.
    (tone === 'danger' ? cancelBtn : okBtn).focus();

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      wrap.classList.remove('is-open');
      setTimeout(() => wrap.remove(), 160);
      prevFocus?.focus?.();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      if (e.key === 'Tab') {   // keep focus inside the dialog
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    cancelBtn.addEventListener('click', () => close(false));
    okBtn.addEventListener('click', () => close(true));
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(false); });
  });
}

function toast(message, tone = 'ok') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const t = document.createElement('div');
  t.className = `toast t-${tone}`;
  t.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg><span>${esc(message)}</span>`;
  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('is-in'));
  setTimeout(() => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 250); }, 2600);
}

/* ------------------------------ mode ------------------------------ */
// One input box: the number of addresses decides single vs bulk.
const setMode = (mode) => { $('#workspace').dataset.tab = mode; };

/* ---------------------------- single check ---------------------------- */
const form = $('#singleForm');
const input = $('#emailInput');
const checkBtn = $('#checkBtn');
const slot = $('#resultSlot');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSingle(input.value.trim());
});

/* Staged hints. The server sends no progress, so these are timed to the
   real order of work - it stops the 1-2s deep check feeling frozen. */
const STAGES = [
  [0,    'Checking format…'],
  [250,  'Looking up the domain…'],
  [600,  'Finding mail servers…'],
  [1100, 'Asking the mail server about the mailbox…'],
  [3000, 'Still waiting on the mail server…']
];

const hintEl = $('#stageHint');
let stageTimers = [];

// The current step is shown on the "checking" row inside the results table.
let currentStage = STAGES[0][1];
function startStages() {
  stopStages();
  stageTimers = STAGES.map(([delay, text]) =>
    setTimeout(() => {
      currentStage = text;
      bulkSlot.querySelectorAll('.live-stage').forEach(el => {
        el.textContent = text;
        el.style.animation = 'none'; el.getBoundingClientRect(); el.style.animation = '';
      });
    }, delay));
}

function stopStages() {
  stageTimers.forEach(clearTimeout);
  stageTimers = [];
  currentStage = STAGES[0][1];
  hintEl.hidden = true;
}

async function runSingle(email) {
  if (!email) {
    bulkInput.focus();
    return;
  }

  // Single checks use the same results table as bulk, with one row.
  setMode('bulk');
  if (parseList(bulkInput.value).length <= 1) { bulkInput.value = email; updateCount(); }
  bulkQuery = '';
  const live = {
    results: [], total: 1, done: 0, progress: 0, running: true, filter: 'all',
    pending: [email], stages: true,
    summary: Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]))
  };
  wireBulk(live);
  checkBtn.classList.add('is-loading');
  checkBtn.disabled = true;
  bulkBtn.classList.add('is-loading');
  bulkBtn.disabled = true;
  slot.innerHTML = '';
  startStages();


  try {
    const res = await fetch('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();

    if (!res.ok) {
      bulkSlot.innerHTML = errorBox(data.detail || data.error || 'Something went wrong');
      return;
    }
    data._new = true;
    live.results = [data];
    live.summary[data.verdict] = 1;
    live.done = 1; live.progress = 100; live.running = false;
    wireBulk(live);
    data._new = false;
    // One result: open its details straight away.
    const row = bulkSlot.querySelector('.row-item > .row');
    if (row) { row.setAttribute('aria-expanded', 'true'); row.nextElementSibling.hidden = false; }
    rememberCheck(data);
    window.logResults?.([data], 'single');
    window.refreshCredits?.();
  } catch {
    bulkSlot.innerHTML = errorBox('Could not reach the server. Is it still running?');
  } finally {
    stopStages();
    checkBtn.classList.remove('is-loading');
    checkBtn.disabled = false;
    bulkBtn.classList.remove('is-loading');
    bulkBtn.disabled = false;
    applyCreditLock();
  }
}

/* ------------------------------ history ------------------------------ */
const HISTORY_KEY = 'recent-checks';
const HISTORY_MAX = 8;

const readHistory = () => {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
};

function rememberCheck(r) {
  try {
    const list = readHistory().filter(h => h.email !== r.email);
    list.unshift({ email: r.email, verdict: r.verdict });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
  } catch { /* private mode */ }
  renderHistory();
}

function renderHistory() {
  const list = readHistory();
  const box = $('#history');
  if (!box) return;
  if (!list.length) { box.hidden = true; return; }

  box.hidden = false;
  $('#historyItems').innerHTML = list.map(h => `
    <button type="button" class="history-chip b-${h.verdict}" data-email="${esc(h.email)}"
            title="Check ${esc(h.email)} again">${esc(h.email)}</button>`).join('');

  $('#historyItems').querySelectorAll('[data-email]').forEach(btn => {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.email;
      runSingle(btn.dataset.email);
    });
  });
}

$('#historyClear')?.addEventListener('click', () => {
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  renderHistory();
});

function errorBox(msg) {
  return `<div class="error-box">${svg(ICONS.invalid)}<span>${esc(msg)}</span></div>`;
}

function renderResult(r) {
  const R = 21;
  const circumference = 2 * Math.PI * R;
  const offset = circumference * (1 - r.score / 100);

  const suggestion = r.suggestion ? `
    <div class="suggest">
      ${svg(ICONS.warn)}
      <span>Did you mean <strong>${esc(r.suggestion)}</strong>?</span>
      <button type="button" data-suggest="${esc(r.suggestion)}">Use this</button>
    </div>` : '';

  const reason = explainUncertainty(r);
  const note = reason ? `
    <div class="note">
      ${svg(ICONS.unknown)}
      <span>${esc(reason)}</span>
    </div>` : '';

  let n = 0;
  const checks = renderCheckList(r.checks, c => `
        <div class="check c-${c.status}" style="animation-delay:${n++ * 40}ms"${c.raw ? ` title="${esc(c.raw)}"` : ''}>
          <span class="check-icon">${svg(ICONS[c.status] || ICONS.skip)}</span>
          <span class="check-label">${esc(c.label)}</span>
          <span class="check-detail">${esc(c.detail)}</span>
        </div>`);

  const chips = [];
  if (r.meta.provider) chips.push(`<span class="chip"><b>${esc(r.meta.provider)}</b></span>`);
  if (r.meta.mx?.length) chips.push(`<span class="chip">MX <b>${r.meta.mx.length}</b></span>`);

  const intel = r.meta.intel;
  if (intel) {
    chips.push(intel.spf.present
      ? `<span class="chip">SPF <b>${esc(intel.spf.policy)}</b></span>`
      : `<span class="chip chip-warn">No SPF</span>`);
    chips.push(intel.dmarc.present
      ? `<span class="chip">DMARC <b>p=${esc(intel.dmarc.policy)}</b></span>`
      : `<span class="chip chip-warn">No DMARC</span>`);
    if (intel.age.known) {
      const days = intel.age.ageDays;
      const y = days / 365;
      // Floor rather than round, so the chip never reads older than the row.
      const years = y < 10 ? (Math.floor(y * 10) / 10).toFixed(1) : Math.floor(y);
      const label = y >= 1
        ? `${years} yr · ${days.toLocaleString()} d`
        : `${days.toLocaleString()} d`;
      chips.push(`<span class="chip${intel.ageRisk ? ' chip-warn' : ''}">Domain <b>${label}</b></span>`);
    }
  }

  if (r.meta.free) chips.push(`<span class="chip">Free provider</span>`);
  if (r.meta.role) chips.push(`<span class="chip">Role account</span>`);
  if (r.meta.disposable) chips.push(`<span class="chip chip-warn">Disposable</span>`);
  chips.push(`<span class="chip">${r.tookMs < 1 ? '<1' : r.tookMs} ms</span>`);

  return `
  <div class="card v-${r.verdict}">
    <div class="verdict">
      <span class="verdict-icon">${svg(ICONS[r.verdict])}</span>
      <span class="verdict-copy">
        <div class="verdict-title">${TITLES[r.verdict]}</div>
        <div class="verdict-email">${esc(r.email)}</div>
      </span>
      <button type="button" class="icon-btn" id="copyBtn" title="Copy result">
        ${svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>')}
      </button>
      <span class="score" title="${esc(scoreMeaning(r.score))}">
        <svg viewBox="0 0 50 50">
          <circle class="score-track" cx="25" cy="25" r="${R}" fill="none" stroke-width="5"/>
          <circle class="score-fill"  cx="25" cy="25" r="${R}" fill="none" stroke-width="5"
                  stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
        </svg>
        <span class="score-num">${r.score}</span>
        <span class="score-cap">${scoreLabel(r.score)}</span>
      </span>
    </div>
    ${suggestion}
    ${note}
    <div class="checks">${checks}</div>
    <div class="meta">${chips.join('')}</div>
  </div>`;
}

/**
 * Say plainly why a result is not a confident yes. Every competitor hides
 * this behind a green tick; being explicit about what we could not determine
 * is the whole point of the tool.
 */
function explainUncertainty(r) {
  const s = r.meta.smtp?.status;

  if (s === 'catch-all') {
    return 'This domain accepts mail for every address, so no tool can confirm '
         + 'whether this specific mailbox exists. Treat it as unproven, not as valid.';
  }
  if (s === 'blocked') {
    return 'The mail server refused our IP instead of answering about the mailbox. '
         + 'That is not evidence the address is bad — it simply could not be checked.';
  }
  if (s === 'greylisted') {
    const base = 'The mail server deferred us (greylisting). The address is still unconfirmed; ';
    // Only say a retry is running when one genuinely was queued.
    if (!r.meta.smtp?.retryScheduled) {
      return base + 'checking again in a few minutes usually resolves it.';
    }
    const mins = Math.max(1, Math.round((r.meta.smtp.retryInMs || 0) / 60000));
    return base + `we are retrying in the background in about ${mins} minute`
         + `${mins === 1 ? '' : 's'} — check this address again after that for the real answer.`;
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

/** Plain-text summary for the copy button. */
function resultToText(r) {
  const lines = [
    `Email:   ${r.email}`,
    `Verdict: ${r.verdict.toUpperCase()} (${r.score}/100)`,
    ''
  ];
  for (const c of r.checks) {
    const mark = { pass: '[ok]', warn: '[!]', fail: '[x]', skip: '[-]', info: '[i]' }[c.status] || '[-]';
    lines.push(`${mark} ${c.label}: ${c.detail}`);
  }
  if (r.suggestion) lines.push('', `Did you mean: ${r.suggestion}`);
  return lines.join('\n');
}

/* Animate the ring after paint so the transition actually runs. */
function wireResultCard(data) {
  requestAnimationFrame(() => {
    const fill = slot.querySelector('.score-fill');
    if (fill) {
      const total = parseFloat(fill.getAttribute('stroke-dasharray'));
      const num = parseInt(slot.querySelector('.score-num').textContent, 10);
      fill.style.strokeDashoffset = total * (1 - num / 100);
    }
  });

  const btn = slot.querySelector('[data-suggest]');
  if (btn) {
    btn.addEventListener('click', () => {
      input.value = btn.dataset.suggest;
      runSingle(btn.dataset.suggest);
    });
  }

  const copy = slot.querySelector('#copyBtn');
  if (copy && data) {
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(resultToText(data));
        copy.classList.add('is-done');
        setTimeout(() => copy.classList.remove('is-done'), 1400);
      } catch {
        copy.title = 'Clipboard blocked by the browser';
      }
    });
  }
}

/* ----------------------------- bulk check ----------------------------- */
const bulkInput = $('#bulkInput');
const bulkBtn = $('#bulkBtn');
const bulkCount = $('#bulkCount');
const bulkSlot = $('#bulkSlot');
const csvInput = $('#csvInput');

const parseList = (text) => [...new Set(
  text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
)];

function updateCount() {
  const n = parseList(bulkInput.value).length;
  bulkCount.textContent = n === 0 ? 'No addresses yet'
    : n === 1 ? '1 address · single'
    : `${n.toLocaleString()} addresses · bulk`;
  bulkCount.dataset.mode = n === 0 ? 'none' : n === 1 ? 'single' : 'bulk';
  bulkBtn.querySelector('.btn-label').textContent = n > 1 ? `Check ${n}` : 'Check';
  applyCreditLock(n);
}

/** Block the Check button when the user cannot pay for the addresses in the box. */
function applyCreditLock(n = parseList(bulkInput.value).length) {
  const credits = window.currentUser?.credits;          // null/undefined = owner or not loaded yet
  const note = $('#creditNote');
  let blocked = false, text = '';
  if (credits === 0) { blocked = true; text = 'No credits remaining. Top up to keep checking emails.'; }
  else if (typeof credits === 'number' && n > credits) {
    blocked = true;
    text = `This needs ${n.toLocaleString()} credits but you have ${credits.toLocaleString()}. Remove ${(n - credits).toLocaleString()} address${n - credits === 1 ? '' : 'es'} or get more credits.`;
  }
  bulkBtn.classList.toggle('is-blocked', blocked);
  if (!bulkBtn.classList.contains('is-loading')) bulkBtn.disabled = blocked;
  if (blocked) bulkBtn.querySelector('.btn-label').textContent = credits === 0 ? 'No credits' : 'Not enough credits';
  if (note) { note.textContent = text; note.hidden = !blocked; }
}
window.applyCreditLock = applyCreditLock;
// Enter adds a new line; Cmd/Ctrl+Enter runs the check.
bulkInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  if (!bulkBtn.disabled) bulkBtn.click();
});
bulkInput.addEventListener('input', updateCount);
updateCount();
$('#kbdRun')?.addEventListener('click', () => { if (!bulkBtn.disabled) bulkBtn.click(); });
$('#clearInput')?.addEventListener('click', () => {
  bulkInput.value = '';
  updateCount();
  bulkInput.focus();
});

csvInput.addEventListener('change', async () => {
  const file = csvInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  // Pull anything that looks like an address out of the file.
  window.pendingUploadName = file.name;
  const found = text.match(/[^\s,;"']+@[^\s,;"']+/g) || [];
  bulkInput.value = [...new Set(found)].join('\n');
  updateCount();
  csvInput.value = '';
});

bulkBtn.addEventListener('click', async () => {
  const emails = parseList(bulkInput.value);
  if (!emails.length) {
    bulkInput.focus();
    return;
  }
  if (emails.length === 1) {
    input.value = emails[0];
    runSingle(emails[0]);
    return;
  }
  setMode('bulk');

  bulkBtn.classList.add('is-loading');
  bulkBtn.disabled = true;

  try {
    const res = await fetch('/api/validate/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails })
    });
    const job = await res.json();

    if (!res.ok) {
      bulkSlot.innerHTML = errorBox(job.detail || job.error || 'Something went wrong');
      return;
    }

    // The job runs in the background; poll it and show each result as it lands.
    bulkQuery = '';
    const data = await runLiveJob(job.id, emails);
    if (!data) return;
    window.logResults?.(data.results, 'bulk', window.pendingUploadName);
    window.refreshCredits?.();
    window.pendingUploadName = null;
  } catch (err) {
    bulkSlot.innerHTML = errorBox(err.message || 'Could not reach the server.');
  } finally {
    bulkBtn.classList.remove('is-loading');
    bulkBtn.disabled = false;
    applyCreditLock();
  }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Show the results table straight away (all counts 0), then add each
 * finished address one by one as the server reports it.
 */
async function runLiveJob(id, emails) {
  const total = emails.length;
  const live = {
    results: [], total, done: 0, progress: 0, running: true, filter: 'all', pending: emails,
    summary: Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]))
  };
  wireBulk(live);

  let since = 0;
  for (;;) {
    const res = await fetch(`/api/jobs/${id}?since=${since}`);
    if (res.status === 404) throw new Error('Job expired before it finished');
    const job = await res.json();

    if (job.state === 'failed') {
      bulkSlot.innerHTML = errorBox(job.error || 'The job failed');
      return null;
    }

    // Results that finished since the last poll (or, at the end, any we missed).
    let fresh = job.items || [];
    if (job.state === 'done') {
      const have = new Set(live.results.map(r => r.email));
      fresh = job.results.filter(r => !have.has(r.email));
    }
    since = job.next ?? since;

    // Reveal one at a time; big batches go faster so long lists keep up.
    const gap = fresh.length ? Math.max(15, Math.min(140, 900 / fresh.length)) : 0;
    for (const r of fresh) {
      r._new = true;
      live.results.push(r);
      live.summary[r.verdict] = (live.summary[r.verdict] || 0) + 1;
      live.done = live.results.length;
      live.progress = Math.round((live.done / total) * 100);
      if (!liveAppend(live, r)) wireBulk(live, live.filter);
      r._new = false;
      if (gap) await sleep(gap);
    }

    if (job.state === 'done') break;
    // Only redraw when something visible changed; idle polls used to restart every animation.
    if (!fresh.length && job.progress > live.progress) {
      live.done = Math.max(live.done, job.done);
      live.progress = job.progress;
      const bar = bulkSlot.querySelector('.live-track i');
      if (bar) { bar.style.width = `${live.progress}%`; bulkSlot.querySelector('.live-pct').textContent = `${live.progress}%`; }
      else wireBulk(live, live.filter);
    }
    await sleep(total > 500 ? 1200 : 450);
  }

  live.running = false;
  if (!live.userPaged) live.page = 1;   // finished list is sorted worst-first: start at the top
  live._resorted = true;
  wireBulk(live, live.filter);
  live._resorted = false;
  return live;
}

/** Poll a queued job to completion, rendering progress as it goes. */
async function pollJob(id) {
  for (;;) {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.status === 404) throw new Error('Job expired before it finished');
    const job = await res.json();

    if (job.state === 'done' || job.state === 'failed') return job;

    bulkSlot.innerHTML = renderProgress(job);
    // Poll faster on small jobs, slower on long ones.
    await new Promise(r => setTimeout(r, job.total > 500 ? 1500 : 600));
  }
}

function renderProgress(job) {
  return `
    <div class="card progress-card">
      <div class="progress-head">
        <span class="progress-title">Checking ${job.total} address${job.total === 1 ? '' : 'es'}</span>
        <span class="progress-count">${job.done} / ${job.total}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${job.progress}%"></div>
      </div>
      <div class="progress-legend">
        <span class="b-valid">${job.summary.valid} valid</span>
        <span class="b-risky">${job.summary.risky} risky</span>
        <span class="b-unknown">${job.summary.unknown} unknown</span>
        <span class="b-invalid">${job.summary.invalid} invalid</span>
      </div>
    </div>`;
}

const VERDICT_ORDER = ['valid', 'risky', 'unknown', 'invalid'];
const VERDICT_LABEL = { valid: 'Valid', risky: 'Risky', unknown: 'Unknown', invalid: 'Invalid' };

function renderBulkFooter(data) {
  const res = data.results || [];
  const avg = res.length ? Math.round(res.reduce((a, r) => a + (r.score || 0), 0) / res.length) : 0;
  const domains = new Set(res.map(r => (r.email.split('@')[1] || '').toLowerCase())).size;
  const validPct = res.length ? Math.round(((data.summary.valid || 0) / res.length) * 100) : 0;
  const item = (label, value) => `<div class="bf-item"><span>${label}</span><strong>${value}</strong></div>`;
  return `
    <div class="bulk-footer">
      ${item('Checked', data.running ? `${res.length} / ${data.total}` : res.length.toLocaleString())}
      ${item('Deliverable', `${validPct}%`)}
      ${item('Avg. score', avg)}
      ${item('Domains', domains)}
    </div>`;
}

/** One result row (plus its hidden detail panel). */
function bulkRowHtml(r) {
    const note = r.suggestion
      ? `→ ${r.suggestion}`
      : (r.checks.find(c => (c.status === 'fail' || c.status === 'warn') && !TECH_ONLY.includes(c.id))?.detail || '');
    const detail = renderCheckList(r.checks, c => `
          <div class="rd-check c-${c.status}"${c.raw ? ` title="${esc(c.raw)}"` : ''}>
            <span class="check-icon">${svg(ICONS[c.status] || ICONS.skip)}</span>
            <span class="rd-label">${esc(c.label)}</span>
            <span class="rd-text">${esc(c.detail)}</span>
          </div>`);
    return `
      <div class="row-item${r._new ? ' row-new' : ''}" data-q="${esc(r.email.toLowerCase())}">
      <div class="row v-${r.verdict}" role="button" tabindex="0" aria-expanded="false" title="Show all checks">
        <span class="row-avatar" aria-hidden="true">${esc((r.email[0] || '?').toUpperCase())}</span>
        <span class="row-main">
          <span class="row-email">${esc(r.email)}</span>
          ${r.meta?.provider ? `<span class="row-provider">${esc(r.meta.provider)}</span>` : ''}
        </span>
        <span class="row-note" title="${esc(note)}">${esc(note) || '<span class="row-ok">No issues found</span>'}</span>
        <span class="row-score" title="${esc(scoreMeaning(r.score))}">
          <span class="score-bar"><i style="width:${Math.max(0, Math.min(100, r.score))}%"></i></span>
          <span class="row-score-num">${r.score}</span>
        </span>
        <span class="badge b-${r.verdict}">${VERDICT_LABEL[r.verdict] || r.verdict}</span>
        <span class="row-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
      </div>
      <div class="row-detail" hidden>${detail}</div>
      </div>`;
}

/** In-flight rows during a live run: the addresses being checked, or skeletons. */
function liveRowsHtml(data) {
  // While running: placeholder rows for what is still in flight.
  const doneSet = new Set(data.results.map(r => r.email));
  const waiting = data.running && data.pending ? data.pending.filter(e => !doneSet.has(e)).slice(0, 3) : [];
  const checkingRows = waiting.map((e, i) => `
      <div class="row row-checking" aria-live="polite">
        <span class="row-avatar" aria-hidden="true">${esc((e[0] || '?').toUpperCase())}</span>
        <span class="row-main"><span class="row-email">${esc(e)}</span></span>
        <span class="row-note"><span class="${data.stages ? 'live-stage' : ''}">${esc(data.stages ? currentStage : i === 0 ? 'Checking…' : 'Waiting in queue…')}</span></span>
        <span class="row-score"><span class="score-bar is-loading"><i></i></span></span>
        <span class="badge b-checking"><span class="mini-spin" aria-hidden="true"></span>Checking</span>
        <span></span>
      </div>`).join('');
  const pending = data.running && !data.pending ? Math.min(3, data.total - data.results.length) : 0;
  return checkingRows + Array.from({ length: pending }, () => `
      <div class="row row-skel" aria-hidden="true">
        <span class="skel skel-av"></span>
        <span class="skel skel-line"></span>
        <span class="skel skel-line short"></span>
        <span class="skel skel-line tiny"></span>
        <span class="skel skel-pill"></span>
        <span></span>
      </div>`).join('');
}

function renderBulk(data, filter = 'all') {
  const dotCls = { valid: 'dot-valid', risky: 'dot-risky', unknown: 'dot-unknown', invalid: 'dot-invalid' };
  const stats = ['all', ...VERDICT_ORDER].map(k => {
    const n = k === 'all' ? data.results.length : (data.summary[k] || 0);
    const label = k === 'all' ? 'All' : VERDICT_LABEL[k];
    return `
    <button type="button" class="ftab${filter === k ? ' is-active' : ''}${n ? '' : ' is-zero'}"
            data-filter="${k}" aria-pressed="${filter === k}">
      ${k === 'all' ? '' : `<i class="${dotCls[k]}"></i>`}${label}<span class="ftab-n">${n}</span>
    </button>`;
  }).join('');

  // Worst results first, so problems surface at the top.
  const rank = { invalid: 0, risky: 1, unknown: 2, valid: 3 };
  const shown = [...data.results]
    .filter(r => filter === 'all' || r.verdict === filter)
    .sort((a, b) => data.running ? 0 : rank[a.verdict] - rank[b.verdict]);

  // Search, then cut the current page.
  const matched = bulkQuery ? shown.filter(r => r.email.toLowerCase().includes(bulkQuery)) : shown;
  const per = data.perPage || 25;
  const pages = Math.max(1, Math.ceil(matched.length / per));
  if (data.running && !data.userPaged) data.page = pages;   // follow the newest rows live
  data.page = Math.min(Math.max(1, data.page || 1), pages);
  const pageItems = matched.slice((data.page - 1) * per, data.page * per);

  const perSelect = `
    <label class="per">Rows
      <select id="perPage" aria-label="Rows per page">
        ${[10, 25, 50, 100, 250, 500, 5000, 10000].map(n => `<option value="${n}"${n === per ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>`;
  let pagerHtml = '';
  if (matched.length > 10) {
    pagerHtml = pages > 1
      ? pager(data.page, pages, matched.length, per).replace('<div class="pager-btns">', `${perSelect}<div class="pager-btns">`)
      : `<div class="pager"><span class="pager-info">Showing <b>1–${matched.length}</b> of <b>${matched.length}</b></span>${perSelect}</div>`;
  }

  const rows = pageItems.map(bulkRowHtml).join('') || (data.running ? '' : !data.results.length
    ? '<div class="row row-empty">No results yet. Enter addresses on the left and press Check.</div>'
    : '<div class="row row-empty">No results in this group</div>');

  const skeletons = liveRowsHtml(data);

  const heading = data.running
    ? `Checking… ${data.results.length} / ${data.total}`
    : bulkQuery
    ? `${matched.length} match${matched.length === 1 ? '' : 'es'} of ${shown.length}`
    : filter === 'all'
    ? `${data.results.length} result${data.results.length === 1 ? '' : 's'}`
    : `${shown.length} ${VERDICT_LABEL[filter].toLowerCase()} of ${data.results.length}`;
  const scope = filter === 'all' ? 'all' : VERDICT_LABEL[filter].toLowerCase();

  return `
    <div class="table-card">
      <div class="table-head">
        <h2 id="bulkHeading">${heading}</h2>
        <label class="fsearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" id="bulkSearch" placeholder="Search email or domain" value="${esc(bulkQuery)}" aria-label="Search results" ${data.running ? 'disabled' : ''}>
        </label>
        <div class="table-actions">
          <button class="tbtn" id="expandAll" type="button" title="Expand or collapse every row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 15l5 5 5-5M7 9l5-5 5 5"/></svg>Expand</button>
          <button class="tbtn tbtn-danger" id="deleteBtn" type="button" ${matched.length && !data.running ? '' : 'disabled'} title="Remove the ${scope} results shown from this list">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>Delete</button>
          <button class="tbtn tbtn-primary" id="exportBtn" type="button" ${matched.length && !data.running ? '' : 'disabled'} title="Download the ${scope} results shown as CSV">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1"/></svg>Download ${filter === 'all' ? 'all' : scope}</button>
        </div>
      </div>
      <div class="ftabs" role="toolbar" aria-label="Filter by status">${stats}</div>
      ${data.running ? `
      <div class="live-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${data.progress}">
        <div class="live-track"><i style="width:${data.progress}%"></i></div>
        <span class="live-pct">${data.progress}%</span>
      </div>` : ''}
      <div class="row row-headings" aria-hidden="true">
        <span></span><span>Email</span><span>Details</span><span>Score</span><span>Status</span><span></span>
      </div>
      <div class="table-scroll${data._resorted ? ' is-resorted' : ''}">${rows}${skeletons}</div>
      ${pagerHtml}
    </div>
    ${renderBulkFooter(data)}`;
}

let bulkQuery = '';

/** Rows currently visible: status filter + search text. */
const visibleResults = (data, filter) => data.results.filter(r =>
  (filter === 'all' || r.verdict === filter) &&
  (!bulkQuery || r.email.toLowerCase().includes(bulkQuery)));

function recountBulk(data) {
  data.summary = Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]));
  data.results.forEach(r => { data.summary[r.verdict]++; });
  data.total = data.results.length;
}

function toggleRow(row, open = row.getAttribute('aria-expanded') !== 'true') {
  row.setAttribute('aria-expanded', String(open));
  row.nextElementSibling.hidden = !open;
}
function wireRow(row) {
  row.addEventListener('click', () => toggleRow(row));
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRow(row); }
  });
}

/**
 * Live update without a redraw: add one finished row and refresh the numbers in
 * place, leaving every existing row (hover, selection, open details) untouched.
 * Returns false when a full redraw is needed instead (paging, filters, search).
 */
function liveAppend(data, r) {
  const scroll = bulkSlot.querySelector('.table-scroll');
  if (!scroll || bulkQuery) return false;
  const per = data.perPage || 25;
  const pages = Math.max(1, Math.ceil(
    data.results.filter(x => data.filter === 'all' || x.verdict === data.filter).length / per));
  const onLastPage = (data.page || 1) === pages;
  const pageHasRoom = scroll.querySelectorAll('.row-item').length < per;
  const showsHere = data.filter === 'all' || data.filter === r.verdict;
  // A new page would start, or a pager must appear: let the full render handle it.
  if (showsHere && (!onLastPage || !pageHasRoom)) return false;
  if (!bulkSlot.querySelector('.pager') && data.results.length > 10 && showsHere) return false;

  // 1. the new row, just above the in-flight rows
  if (showsHere) {
    scroll.querySelector('.row-empty')?.remove();
    const tmp = document.createElement('div');
    tmp.innerHTML = bulkRowHtml(r).trim();
    const item = tmp.firstElementChild;
    const firstLive = scroll.querySelector('.row-checking, .row-skel');
    scroll.insertBefore(item, firstLive);
    wireRow(item.querySelector('.row'));
    setTimeout(() => item.classList.remove('row-new'), 1200);
  }

  // 2. in-flight rows: drop the finished one, keep the rest (their animations keep running)
  const doneSet = new Set(data.results.map(x => x.email));
  scroll.querySelectorAll('.row-checking').forEach(row => {
    if (doneSet.has(row.querySelector('.row-email')?.textContent)) row.remove();
  });
  const wanted = data.pending ? data.pending.filter(e => !doneSet.has(e)).slice(0, 3) : [];
  const have = [...scroll.querySelectorAll('.row-checking .row-email')].map(e => e.textContent);
  if (wanted.length !== have.length || wanted.some((e, i) => e !== have[i])) {
    scroll.querySelectorAll('.row-checking, .row-skel').forEach(el => el.remove());
    scroll.insertAdjacentHTML('beforeend', liveRowsHtml(data));
  }

  // 3. numbers, in place
  const set = (sel, text) => { const el = bulkSlot.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
  set('#bulkHeading', `Checking… ${data.results.length} / ${data.total}`);
  set('.ftab[data-filter="all"] .ftab-n', String(data.results.length));
  VERDICT_ORDER.forEach(k => {
    const btn = bulkSlot.querySelector(`.ftab[data-filter="${k}"]`);
    if (!btn) return;
    const n = data.summary[k] || 0;
    const num = btn.querySelector('.ftab-n');
    if (num.textContent !== String(n)) { num.textContent = String(n); num.classList.remove('bump'); num.getBoundingClientRect(); num.classList.add('bump'); }
    btn.classList.toggle('is-zero', !n);
  });
  const bar = bulkSlot.querySelector('.live-track i');
  if (bar) bar.style.width = `${data.progress}%`;
  set('.live-pct', `${data.progress}%`);
  bulkSlot.querySelector('.live-progress')?.setAttribute('aria-valuenow', data.progress);
  const foot = bulkSlot.querySelector('.bulk-footer');
  if (foot) {
    const tmp = document.createElement('div');
    tmp.innerHTML = renderBulkFooter(data).trim();
    foot.querySelectorAll('.bf-item strong').forEach((el, i) => {
      const next = tmp.querySelectorAll('.bf-item strong')[i]?.textContent;
      if (next != null && el.textContent !== next) el.textContent = next;
    });
  }
  return true;
}

/** Re-render on filter change and re-attach the buttons. */
function wireBulk(data, filter = 'all') {
  data.filter = filter;
  // Keep expanded rows open across live re-renders.
  const openRows = new Set([...bulkSlot.querySelectorAll('.row[aria-expanded="true"]')]
    .map(r => r.parentElement.dataset.q));
  const prevBar = bulkSlot.querySelector('.live-track i');
  const prevPct = prevBar ? (parseFloat(prevBar.style.width) || 0) : null;

  // Looping animations take their phase from one clock, so redraws don't restart them.
  bulkSlot.style.setProperty('--clock', `-${Math.round(performance.now())}ms`);
  bulkSlot.innerHTML = renderBulk(data, filter);

  // The progress bar is a new element after a redraw: start it where the old one was, then slide.
  const bar = bulkSlot.querySelector('.live-track i');
  if (bar && prevPct !== null) {
    const target = bar.style.width;
    bar.style.transition = 'none';
    bar.style.width = `${prevPct}%`;
    bar.getBoundingClientRect();
    bar.style.transition = '';
    bar.style.width = target;
  }
  openRows.forEach(q => {
    const row = bulkSlot.querySelector(`.row-item[data-q="${CSS.escape(q)}"] > .row`);
    if (row) { row.setAttribute('aria-expanded', 'true'); row.nextElementSibling.hidden = false; }
  });

  bulkSlot.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => { data.page = 1; data.userPaged = true; wireBulk(data, btn.dataset.filter); });
  });

  // Search re-renders (so paging stays correct) and puts the caret back.
  const search = bulkSlot.querySelector('#bulkSearch');
  search.addEventListener('input', () => {
    bulkQuery = search.value.trim().toLowerCase();
    data.page = 1;
    wireBulk(data, filter);
    const again = bulkSlot.querySelector('#bulkSearch');
    again.focus();
    again.setSelectionRange(again.value.length, again.value.length);
  });

  // Paging.
  const toTop = () => bulkSlot.closest('.log-body')?.scrollTo({ top: 0, behavior: 'smooth' });
  bulkSlot.querySelectorAll('.pg[data-page]').forEach(btn => btn.addEventListener('click', () => {
    data.page = Number(btn.dataset.page); data.userPaged = true;
    wireBulk(data, filter); toTop();
  }));
  bulkSlot.querySelector('#perPage')?.addEventListener('change', (e) => {
    data.perPage = Number(e.target.value); data.page = 1; data.userPaged = true;
    wireBulk(data, filter); toTop();
  });

  bulkSlot.querySelector('#exportBtn').addEventListener('click', () =>
    exportCsv(visibleResults(data, filter), filter));

  bulkSlot.querySelector('#deleteBtn').addEventListener('click', async () => {
    const doomed = new Set(visibleResults(data, filter));
    if (!doomed.size) return;
    const what = filter === 'all' ? '' : ` ${VERDICT_LABEL[filter].toLowerCase()}`;
    const noun = `${doomed.size}${what} result${doomed.size === 1 ? '' : 's'}`;
    const ok = await confirmDialog({
      title: `Delete ${noun}?`,
      message: 'They will be removed from this results list. Your dashboard history is not affected.',
      confirmText: 'Delete'
    });
    if (!ok) return;
    data.results = data.results.filter(r => !doomed.has(r));
    recountBulk(data);
    bulkQuery = '';
    wireBulk(data, 'all');
    toast(`Deleted ${noun}`);
  });

  // Click (or Enter/Space) a row to open its full check list.
  bulkSlot.querySelectorAll('.row-item > .row').forEach(wireRow);
  const expandBtn = bulkSlot.querySelector('#expandAll');
  expandBtn?.addEventListener('click', () => {
    const rowsEls = [...bulkSlot.querySelectorAll('.row-item > .row')];
    const open = rowsEls.some(r => r.getAttribute('aria-expanded') !== 'true');
    rowsEls.forEach(r => toggleRow(r, open));
    expandBtn.lastChild.textContent = open ? 'Collapse' : 'Expand';
  });
}

function exportCsv(results, tag = 'all') {
  // Just the addresses, one per line, each once.
  const body = [...new Set(results.map(r => r.email))].join('\n') + '\n';
  const txt = window.getDownloadFormat?.() === 'txt';
  const blob = new Blob([body], { type: `${txt ? 'text/plain' : 'text/csv'};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `email-${tag}-${new Date().toISOString().slice(0, 10)}.${txt ? 'txt' : 'csv'}`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------ startup ------------------------------ */
renderHistory();

// Start with the empty results table (all counts 0) rather than a blank panel.
wireBulk({
  results: [], total: 0, running: false, filter: 'all',
  summary: Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]))
});

// A ?email=... link pre-fills and runs the check, so a result can be shared.
const fromUrl = new URLSearchParams(location.search).get('email');
if (fromUrl && fromUrl.trim()) {
  history.replaceState(null, '', location.pathname + location.hash);  // keep the URL clean
  input.value = fromUrl.trim();
  runSingle(fromUrl.trim());
} else {
  bulkInput.focus();
}
