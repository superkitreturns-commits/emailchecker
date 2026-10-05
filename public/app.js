/* 3S Email Validator — frontend */

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
  valid:   'Safe to send',
  risky:   'Send with caution',
  invalid: 'Do not send',
  unknown: 'Could not be verified'
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

/* Sidebar hide/unhide */
(() => {
  const shell = document.querySelector('.shell');
  const btn = document.getElementById('sidebarToggle');
  if (!shell || !btn) return;
  try { if (localStorage.getItem('sb') === 'c') shell.classList.add('sb-collapsed'); } catch {}
  btn.addEventListener('click', () => {
    const c = shell.classList.toggle('sb-collapsed');
    try { localStorage.setItem('sb', c ? 'c' : 'o'); } catch {}
  });
})();

/* Follow the OS while the user has not made an explicit choice. */
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* ignore */ }
  if (!saved) document.documentElement.removeAttribute('data-theme');
});

/* ---------------------------- check display ---------------------------- */
// Which rows lead, which copy a technical row is replaced with, and what the
// score means are all decided on the server (lib/present.js). Every check
// arrives already worded and tagged with its tier, so this file only draws.

/** Render a check list with the technical rows folded away. rowFn draws one check. */
function renderCheckList(checks, rowFn) {
  const main = checks.filter(c => c.tier !== 'tech');
  const tech = checks.filter(c => c.tier === 'tech');
  return `
    <div class="ck-main">${main.map(rowFn).join('')}</div>
    ${tech.length ? `
    <details class="ck-tech">
      <summary>Full technical report <span>${tech.length}</span></summary>
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
    // Everything this app keeps on the device - the IndexedDB result store,
    // the check and upload logs, the recent-checks strip - is keyed by
    // browser, not by account. Signing in as someone else on the same machine
    // therefore showed them the previous user's validated addresses. Wipe the
    // local stores whenever the account changes.
    purgeLocalDataIfDifferentUser(user.id);
    showCredits(user.credits);
    const navUsers = $('#navUsers');
    const manager = user.role === 'owner' || user.role === 'reseller';
    if (navUsers) navUsers.hidden = !manager;
    if (location.pathname.replace(/\/+$/, '') === '/users' && !manager) window.go?.('verify', { replace: true });
    const navVast = $('#navVast');
    const isOwner = user.role === 'owner';
    if (navVast) navVast.hidden = !isOwner;
    if (location.pathname.replace(/\/+$/, '') === '/ip-server' && !isOwner) window.go?.('verify', { replace: true });
  } catch { /* offline: leave the menu hidden */ }
})();

$('#signOut').addEventListener('click', async () => {
  try { await _fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  // Leave nothing behind on a shared machine.
  for (const key of [HISTORY_KEY, 'check-log', 'upload-log', 'data-settings', 'data-migrated', LOCAL_OWNER_KEY]) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
  try { indexedDB.deleteDatabase('email-validator'); } catch { /* unsupported */ }
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
const LOCAL_OWNER_KEY = 'local-data-owner';

/**
 * Drop every device-local store when the signed-in account differs from the
 * one the data was written for. Results are always re-fetchable from the
 * server, so discarding them costs nothing and leaking them costs a lot.
 */
function purgeLocalDataIfDifferentUser(userId) {
  let previous = null;
  try { previous = localStorage.getItem(LOCAL_OWNER_KEY); } catch { return; }
  if (previous === userId) return;

  for (const key of [HISTORY_KEY, 'check-log', 'upload-log', 'data-settings', 'data-migrated']) {
    try { localStorage.removeItem(key); } catch { /* private mode */ }
  }
  try { indexedDB.deleteDatabase('email-validator'); } catch { /* unsupported */ }
  try { localStorage.setItem(LOCAL_OWNER_KEY, userId); } catch { /* private mode */ }

  // A store opened before the switch still holds the old rows in memory.
  if (previous !== null) location.reload();
}
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

  const reason = r.uncertainty;
  const note = reason ? `
    <div class="note">
      ${svg(ICONS.unknown)}
      <span>${esc(reason)}</span>
    </div>` : '';

  let n = 0;
  const checks = renderCheckList(r.checks, c => `
        <div class="check c-${c.status}" style="animation-delay:${n++ * 40}ms">
          <span class="check-icon">${svg(ICONS[c.status] || ICONS.skip)}</span>
          <span class="check-label">${esc(c.label)}</span>
          <span class="check-detail">${esc(c.detail)}</span>
        </div>`);

  const chips = [];
  if (r.meta.provider) chips.push(`<span class="chip"><b>${esc(r.meta.provider)}</b></span>`);
  if (r.meta.mxCount) chips.push(`<span class="chip">MX <b>${r.meta.mxCount}</b></span>`);

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
      <span class="score" title="${esc(r.scoreMeaning)}">
        <svg viewBox="0 0 50 50">
          <circle class="score-track" cx="25" cy="25" r="${R}" fill="none" stroke-width="5"/>
          <circle class="score-fill"  cx="25" cy="25" r="${R}" fill="none" stroke-width="5"
                  stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
        </svg>
        <span class="score-num">${r.score}</span>
        <span class="score-cap">${r.scoreLabel}</span>
      </span>
    </div>
    ${suggestion}
    ${note}
    <div class="checks">${checks}</div>
    <div class="meta">${chips.join('')}</div>
  </div>`;
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

const splitList = (text) =>
  text.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

const parseList = (text) => [...new Set(splitList(text))];

const dupeNote = $('#dupeNote');

function updateCount() {
  const raw = splitList(bulkInput.value);
  const n = new Set(raw).size;

  bulkCount.textContent = n === 0 ? 'No emails yet'
    : n === 1 ? '1 address · single'
    : `${n.toLocaleString()} emails · Results`;
  bulkCount.dataset.mode = n === 0 ? 'none' : n === 1 ? 'single' : 'bulk';
  bulkBtn.querySelector('.btn-label').textContent = n > 1 ? `Check ${n}` : 'Check';

  // Duplicates are dropped before anything is charged, so this is a saving,
  // not an error - but it has to be visible or the count looks wrong.
  const dupes = raw.length - n;
  if (dupeNote) {
    dupeNote.hidden = dupes === 0;
    dupeNote.textContent = dupes ? `${dupes.toLocaleString()} dupes removed` : '';
  }

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
$('#clearInput')?.addEventListener('click', () => {
  bulkInput.value = '';
  updateCount();
  bulkInput.focus();
});

/** Pull every address out of a dropped or picked file into the paste box. */
async function loadFileIntoBox(file) {
  if (!file) return;
  const text = await file.text();
  window.pendingUploadName = file.name;
  const found = text.match(/[^\s,;"']+@[^\s,;"']+/g) || [];
  // Left as found: updateCount reports how many duplicates the file had, and
  // they are removed at submit anyway. Stripping them here hid that count.
  bulkInput.value = found.join('\n');
  updateCount();
}

csvInput.addEventListener('change', async () => {
  await loadFileIntoBox(csvInput.files?.[0]);
  csvInput.value = '';
});

/* Dropping a file on the paste box is the obvious gesture, and it previously
 * made the browser navigate away from the app and show the file instead. */
const vxBox = bulkInput.closest('.vx-box') || bulkInput;
let vxDepth = 0;
// Permissive on purpose: the 'Files' type string is not reported consistently
// across browsers and drag sources, and gating dragover on it stopped the drop
// event firing at all.
const vxFiles = (e) => {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.files?.length) return true;
  if ([...(dt.types || [])].includes('Files')) return true;
  return [...(dt.items || [])].some(i => i.kind === 'file');
};

// Capture phase: a textarea handles dropped data itself and would insert the
// file name as text before a bubble-phase listener ever ran.
vxBox.addEventListener('dragenter', (e) => {
  if (!vxFiles(e)) return;
  e.preventDefault();
  vxDepth++;
  vxBox.classList.add('is-drop');
}, true);
vxBox.addEventListener('dragover', (e) => {
  // Always prevented: without this the browser refuses the drop outright.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}, true);
vxBox.addEventListener('dragleave', () => {
  vxDepth = Math.max(0, vxDepth - 1);
  if (!vxDepth) vxBox.classList.remove('is-drop');
}, true);
vxBox.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  vxDepth = 0;
  vxBox.classList.remove('is-drop');
  loadFileIntoBox(e.dataTransfer?.files?.[0]);
}, true);

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
  // Say the real number before spending the round trip. The server enforces
  // the cap regardless; this just replaces a bare rejection with a count.
  if (bulkLimit && emails.length > bulkLimit) {
    setMode('bulk');
    bulkSlot.innerHTML = errorBox(
      `${emails.length.toLocaleString()} addresses is over the ${bulkLimit.toLocaleString()} limit `
      + `for one batch. Split the file and run the parts separately.`
    );
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

    // Surface it in the nav straight away rather than waiting for the next tick.
    window.hasActiveJobs = true;
    window.renderRunningView?.();

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
async function runLiveJob(id, emails, { attaching = false } = {}) {
  const total = emails.length;
  // Whether the next batch of results is history rather than live progress.
  let backlog = attaching;
  const live = {
    results: [], total, done: 0, progress: 0, running: true, filter: 'all', pending: emails,
    jobId: id,
    summary: Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]))
  };
  wireBulk(live);

  let since = 0;
  let lastPhaseKey = '';
  for (;;) {
    const res = await fetch(`/api/jobs/${id}?since=${since}`);
    if (res.status === 404) throw new Error('Job expired before it finished');
    const job = await res.json();

    if (job.state === 'failed') {
      bulkSlot.innerHTML = errorBox(job.error || 'The job failed');
      return null;
    }

    // Carry the server's phase so the UI can say "rechecking N deferred
    // addresses" instead of sitting at a silent 100% while the re-check pass runs.
    live.phase = job.phase || null;

    // A cancelled job is finished: it keeps the results it did get, and the
    // addresses it never reached were already refunded by the cancel route.
    const ended = job.state === 'done' || job.state === 'cancelled';

    // Results that finished since the last poll (or, at the end, any we missed).
    let fresh = job.items || [];
    if (ended) {
      const have = new Set(live.results.map(r => r.email));
      fresh = job.results.filter(r => !have.has(r.email));
    }
    since = job.next ?? since;

    // Catching up on a job that was already running: drop its backlog in as
    // one paint. Revealing it row by row replayed minutes of finished work as
    // a counter ticking up from zero, which read as a glitch rather than as
    // progress - the addresses were checked long ago.
    if (backlog && fresh.length) {
      for (const r of fresh) {
        live.results.push(r);
        live.summary[r.verdict] = (live.summary[r.verdict] || 0) + 1;
      }
      live.done = live.results.length;
      live.progress = Math.round((live.done / total) * 100);
      wireBulk(live, live.filter);
      fresh = [];
    }
    backlog = false;

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

    if (ended) break;
    // Only redraw when something visible changed; idle polls used to restart every animation.
    if (!fresh.length && job.progress > live.progress) {
      live.done = Math.max(live.done, job.done);
      live.progress = job.progress;
      const bar = bulkSlot.querySelector('.live-track i');
      if (bar) { bar.style.width = `${live.progress}%`; bulkSlot.querySelector('.live-pct').textContent = `${live.progress}%`; }
      else wireBulk(live, live.filter);
    }
    // The re-check pass sends no new rows and never moves progress past 100,
    // so without this the heading and the leftover in-flight rows would sit
    // frozen the whole time. Repaint when the phase label changes.
    const phaseKey = live.phase ? `${live.phase.stage}:${live.phase.round}:${live.phase.pending}` : '';
    if (!fresh.length && phaseKey !== lastPhaseKey) {
      lastPhaseKey = phaseKey;
      wireBulk(live, live.filter);
    }
    await sleep(total > 500 ? 1200 : 450);
  }

  live.running = false;
  // The list keeps its order and its page now that finishing no longer
  // re-sorts it, so landing back on page 1 would be the view moving by itself.
  wireBulk(live, live.filter);
  return live;
}

/** Poll a queued job to completion, rendering progress as it goes. */
async function pollJob(id) {
  for (;;) {
    const res = await fetch(`/api/jobs/${id}`);
    if (res.status === 404) throw new Error('Job expired before it finished');
    const job = await res.json();

    if (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled') return job;

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
      : r.primaryIssue;
    const detail = renderCheckList(r.checks, c => `
          <div class="rd-check c-${c.status}">
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
        <span class="row-score" title="${esc(r.scoreMeaning)}">
          <span class="score-bar"><i style="width:${Math.max(0, Math.min(100, r.score))}%"></i></span>
          <span class="row-score-num">${r.score}</span>
        </span>
        <span class="badge b-${r.verdict}">${VERDICT_LABEL[r.verdict] || r.verdict}</span>
        <span class="row-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
      </div>
      <div class="row-detail" hidden>${detail}</div>
      </div>`;
}

/** Heading text during a live run: main-pass count, then the re-check phase. */
function liveHeading(data) {
  if (data.phase?.stage === 'recheck') {
    const n = data.phase.pending || 0;
    return `Rechecking ${n} deferred address${n === 1 ? '' : 'es'}…`;
  }
  if (data.results.length >= data.total) return 'Finishing up…';
  return `Checking… ${data.results.length} / ${data.total}`;
}

/** In-flight rows during a live run: the addresses being checked, or skeletons. */
function liveRowsHtml(data) {
  // Once every address has a first result the main pass is over: what remains
  // is the deferred re-check, which happens in place (no new rows). Showing
  // "Checking…/Waiting in queue…" placeholders then is what made a finished
  // pass look stuck at 100%.
  if (data.results.length >= data.total) return '';
  // While running: placeholder rows for what is still in flight.
  const doneSet = new Set(data.results.map(r => r.email.toLowerCase()));
  const waiting = data.running && data.pending ? data.pending.filter(e => !doneSet.has(e.toLowerCase())).slice(0, 3) : [];
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

  // Arrival order, always. Re-sorting worst-first the moment a run finished
  // made the whole table rearrange itself under the pointer - rows the user
  // was reading jumped somewhere else. The status tabs already answer "show
  // me the bad ones", so the list itself stays where the user last saw it.
  const shown = data.results.filter(r => filter === 'all' || r.verdict === filter);

  // Search, then cut the current page.
  const matched = bulkQuery ? shown.filter(r => r.email.toLowerCase().includes(bulkQuery)) : shown;
  const per = data.perPage || 25;
  const pages = Math.max(1, Math.ceil(matched.length / per));
  // Follow the newest rows live, but only on All. Dragging the page around
  // under someone who has filtered to one status is not "following", it is
  // the view moving on its own.
  if (data.running && !data.userPaged && filter === 'all') data.page = pages;
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
    ? liveHeading(data)
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
          ${data.running && data.jobId ? `
          <button class="tbtn tbtn-danger" id="stopJobBtn" type="button" title="Stop checking. Addresses already checked are kept, the rest are refunded">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop</button>` : ''}
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
      <div class="table-scroll">${rows}${skeletons}</div>
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
  const doneSet = new Set(data.results.map(x => x.email.toLowerCase()));
  scroll.querySelectorAll('.row-checking').forEach(row => {
    if (doneSet.has(row.querySelector('.row-email')?.textContent?.toLowerCase())) row.remove();
  });
  const wanted = data.pending ? data.pending.filter(e => !doneSet.has(e.toLowerCase())).slice(0, 3) : [];
  const have = [...scroll.querySelectorAll('.row-checking .row-email')].map(e => e.textContent);
  if (wanted.length !== have.length || wanted.some((e, i) => e !== have[i])) {
    scroll.querySelectorAll('.row-checking, .row-skel').forEach(el => el.remove());
    scroll.insertAdjacentHTML('beforeend', liveRowsHtml(data));
  }

  // 3. numbers, in place
  const set = (sel, text) => { const el = bulkSlot.querySelector(sel); if (el && el.textContent !== text) el.textContent = text; };
  set('#bulkHeading', liveHeading(data));
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

/**
 * Re-render on filter change and re-attach the buttons.
 *
 * The filter defaults to whatever is already selected, not to 'all': a live
 * run redraws this table constantly, and a bare wireBulk(data) used to throw
 * the user back to All every time one of those redraws happened. Only a click
 * on a tab changes it now - a fresh results object still starts on 'all'
 * because that is what it is created with.
 */
function wireBulk(data, filter = data.filter || 'all') {
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
    // Stay on the tab the delete was made from. Snapping back to All here was
    // the one place a click somewhere else moved the selection for the user.
    wireBulk(data, filter);
    toast(`Deleted ${noun}`);
  });

  bulkSlot.querySelector('#stopJobBtn')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const res = await fetch(`/api/jobs/${data.jobId}/cancel`, { method: 'POST' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || 'Could not stop the job');
      // The poll loop sees state 'cancelled' and finishes the table on its own.
      toast(out.refunding
        ? `Stopped. Refunding about ${out.refunding.toLocaleString()} unchecked address${out.refunding === 1 ? '' : 'es'}`
        : 'Stopped');
      refreshCreditsWhenRefundLands();
    } catch (err) {
      toast(err.message, 'warn');
      btn.disabled = false;
    }
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

let bulkLimit = 0;

/* ---- Running view -------------------------------------------------------
 * Jobs live on the server, so this is the one place that shows what is
 * actually in flight - including batches started in a tab that is now closed.
 * ------------------------------------------------------------------------ */

const AGO = (ts) => {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/**
 * Rough time-remaining line, measured from how fast this job has actually gone
 * rather than from any configured rate: the real pace depends on how much of
 * the list shares one provider, which only the run itself reveals.
 *
 * Shown as a range, because a point estimate on a job this variable would be
 * wrong often enough to be worth less than no number at all.
 */
function etaLine(job) {
  // The deferred re-check pass waits minutes on purpose, with every address
  // already done. Without this the row sat at "100% · Almost ready" for up to
  // seven silent minutes and looked stuck.
  if (job.phase?.stage === 'recheck') {
    const n = job.phase.pending;
    return `Re-checking ${n} address${n === 1 ? '' : 'es'} the server asked us to retry · round ${job.phase.round}`;
  }
  const elapsed = (Date.now() - job.createdAt) / 1000;
  // Under a handful of results the rate is mostly noise.
  if (job.done < 5 || elapsed < 3) return 'Hold on, almost there…';

  const perAddress = elapsed / job.done;
  const left = Math.max(0, job.total - job.done) * perAddress;
  if (left < 45) return 'Almost ready don’t go anywhere.';

  const lo = Math.max(1, Math.floor(left * 0.8 / 60));
  const hi = Math.max(lo + 1, Math.ceil(left * 1.3 / 60));

  if (hi >= 90) {
    const h = (m) => Math.max(1, Math.round(m / 60));
    return `Sit back this one takes a while · about ${h(lo)}–${h(hi)} hrs to go`;
  }
  if (hi <= 3)  return `Take a quick break · about ${lo}–${hi} min to go`;
  if (hi <= 15) return `Go grab a coffee · about ${lo}–${hi} min to go`;
  if (hi <= 45) return `Go take a break · come back in ${lo}–${hi} min`;
  return `This one’s a lunch break · about ${lo}–${hi} min to go`;
}

/**
 * The refund for a stopped batch is settled server-side once the probes still
 * in flight land, which is seconds after the click. Refresh now for the common
 * case and again shortly, so the balance on screen ends up correct without the
 * button having to wait for it.
 */
function refreshCreditsWhenRefundLands() {
  window.refreshCredits?.();
  setTimeout(() => window.refreshCredits?.(), 4000);
}

/** How long a finished job actually took, so the row still says something. */
function jobDuration(job) {
  const ms = (job.finishedAt || Date.now()) - job.createdAt;
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Progress ring. Reads at a glance from across the desk; the bar did not. */
function jrRing(pct, done, total) {
  const R = 26, C = 2 * Math.PI * R;
  return `<div class="jr-ring">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle class="jr-ring-bg" cx="32" cy="32" r="${R}"/>
      <circle class="jr-ring-fg" cx="32" cy="32" r="${R}"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - pct / 100)).toFixed(1)}"/>
    </svg>
    <span class="jr-ring-pct">${pct}<i>%</i></span>
  </div>`;
}

/** Done-state mark: a solid tick instead of an empty ring at 100%. */
function jrDoneMark(failed) {
  const path = failed ? 'M15 9l-6 6M9 9l6 6' : 'M20 6L9 17l-5-5';
  return `<div class="jr-mark ${failed ? 'is-failed' : 'is-done'}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>
  </div>`;
}

function runningRow(job) {
  const live = job.state === 'running' || job.state === 'queued';
  const failed = job.state === 'failed';
  const stopped = job.state === 'cancelled';

  // Counts are shown while running too - watching valid/invalid tick upward is
  // the thing worth looking at, and a bare percentage says nothing about
  // whether the list is any good.
  const counts = VERDICT_ORDER
    .filter(k => (job.summary?.[k] ?? 0) > 0)
    .map(k => `<span class="jr-count v-${k}"><i></i>${job.summary[k].toLocaleString()}<em>${k}</em></span>`)
    .join('');

  const status = live
    ? `<span class="jr-state is-live"><i></i>${
        job.state === 'queued' ? 'Queued'
        : job.phase?.stage === 'recheck' ? 'Re-checking'
        : 'Running'}</span>`
    : failed
      ? '<span class="jr-state is-failed">Failed</span>'
      : stopped
        ? '<span class="jr-state is-done">Stopped</span>'
        : '<span class="jr-state is-done">Complete</span>';

  return `<article class="jr ${live ? 'is-live' : ''}">
    ${live ? jrRing(job.progress, job.done, job.total) : jrDoneMark(failed)}

    <div class="jr-body">
      <div class="jr-head">
        <span class="jr-title">${live
          ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()}`
          : `${job.total.toLocaleString()} addresses`}</span>
        ${status}
        <span class="jr-dot"></span>
        <span class="jr-ago">${AGO(job.createdAt)}</span>
      </div>
      ${live ? `<div class="jr-bar"><i style="width:${job.progress}%"></i></div>` : ''}

      <div class="jr-foot">
        <div class="jr-counts">
          ${counts || `<span class="jr-muted">${live ? 'Starting up…' : 'No results'}</span>`}
        </div>
        <span class="jr-eta">${live ? etaLine(job)
          : stopped ? `Stopped · ${job.done.toLocaleString()} of ${job.total.toLocaleString()} checked, rest refunded`
          : `All done · ${jobDuration(job)}`}</span>
      </div>
    </div>

    <div class="jr-actions">
      <button class="jr-btn ${live ? 'is-live' : ''}" data-open="${esc(job.id)}">
        ${live ? 'Watch' : 'View results'}
      </button>
      ${live ? `<button class="jr-btn jr-cancel" data-stop="${esc(job.id)}"
        title="Stop this batch - checked addresses are kept, the rest refunded">Cancel</button>`
        : `<button class="jr-x" data-drop="${esc(job.id)}"
        title="Remove from this list" aria-label="Remove from this list">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`}
    </div>
  </article>`;
}

/** Empty state, matching the cards it stands in for. */
function jrEmpty(title, note) {
  return `<div class="jr-empty">
    <span class="jr-empty-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
    </span>
    <strong>${title}</strong>
    <span>${note}</span>
  </div>`;
}

/** Which day a job started, relative to the user's own midnight. */
function dayBucket(ts) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  if (ts >= today) return 'today';
  if (ts >= today - 86400000) return 'yesterday';
  return 'older';
}

const JR_RANGES = [
  ['all', 'All'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['older', 'Older']
];
let jrRange = 'all';

window.renderRunningView = async function renderRunningView() {
  const host = $('#runningList');
  if (!host) return;
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) { host.innerHTML = errorBox('Could not load jobs.'); return; }
    const { jobs = [] } = await res.json();

    const active = jobs.filter(j => j.state === 'running' || j.state === 'queued').length;
    window.hasActiveJobs = active > 0;
    const badge = $('#runningBadge');
    if (badge) { badge.textContent = active || ''; badge.hidden = !active; }

    // Called on startup too, to fill the badge. Rebuilding the list while the
    // view is hidden only races the render the router does when it opens.
    if ($('[data-view="running"]')?.hidden) return;

    const tally = { all: jobs.length, today: 0, yesterday: 0, older: 0 };
    for (const j of jobs) tally[dayBucket(j.createdAt)]++;

    // An empty range is still offered, so the filter row does not change shape
    // as jobs age out from under the pointer.
    const finished = jobs.filter(j => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled').length;
    const filters = `<div class="jr-filters">${JR_RANGES
      .map(([k, label]) => `<button class="jr-filter${jrRange === k ? ' is-on' : ''}"
        data-range="${k}"${tally[k] ? '' : ' disabled'}>${label}<span>${tally[k]}</span></button>`)
      .join('')}
      ${finished ? `<button class="jr-filter jr-clear" id="jrClear">Clear finished</button>` : ''}
    </div>`;

    const shown = jrRange === 'all'
      ? jobs
      : jobs.filter(j => dayBucket(j.createdAt) === jrRange);

    host.innerHTML = filters + (jobs.length
      ? (shown.length
        ? shown.map(runningRow).join('')
        : jrEmpty('Nothing here',
            `No batches were started ${JR_RANGES.find(r => r[0] === jrRange)[1].toLowerCase()}.`))
      : jrEmpty('No batches yet',
          'Paste a list on Check emails and every batch you run will appear here.'));

    host.querySelectorAll('[data-range]').forEach(btn => {
      btn.addEventListener('click', () => {
        jrRange = btn.dataset.range;
        window.renderRunningView();
      });
    });

    host.querySelectorAll('[data-stop]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const res = await fetch(`/api/jobs/${btn.dataset.stop}/cancel`, { method: 'POST' });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || 'Could not stop that batch');
          toast(out.refunding
            ? `Stopped. Refunding about ${out.refunding.toLocaleString()} unchecked address${out.refunding === 1 ? '' : 'es'}`
            : 'Stopped');
          refreshCreditsWhenRefundLands();
        } catch (err) {
          toast(err.message, 'warn');
          btn.disabled = false;
        }
        window.renderRunningView();
      });
    });

    host.querySelectorAll('[data-drop]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/jobs/${btn.dataset.drop}`, { method: 'DELETE' });
        window.renderRunningView();
      });
    });

    host.querySelector('#jrClear')?.addEventListener('click', async () => {
      // Running batches are deliberately left behind by the server.
      const ok = await confirmDialog({
        title: `Clear ${finished.toLocaleString()} finished batch${finished === 1 ? '' : 'es'}?`,
        message: 'This only clears the list. Results you already saved or downloaded are not affected, and anything still running keeps going.',
        confirmText: 'Clear'
      });
      if (!ok) return;
      await fetch('/api/jobs', { method: 'DELETE' });
      window.renderRunningView();
    });

    host.querySelectorAll('[data-open]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.open;
        const job = jobs.find(j => j.id === id);
        window.go?.('verify');
        setMode('bulk');
        bulkQuery = '';
        if (job.state === 'running' || job.state === 'queued') {
          const data = await runLiveJob(id, new Array(job.total).fill(''), { attaching: true });
          if (data) window.refreshCredits?.();
        } else {
          showFinishedJob(id);
        }
      });
    });

  } catch {
    host.innerHTML = errorBox('Could not reach the server.');
  }
};

/** Render a job that already completed: one fetch, no polling. */
async function showFinishedJob(id) {
  const res = await fetch(`/api/jobs/${id}`);
  if (!res.ok) {
    bulkSlot.innerHTML = errorBox('Those results have expired.');
    return;
  }
  const job = await res.json();
  const results = job.results || [];
  wireBulk({
    results, total: results.length, done: results.length, progress: 100,
    running: false, filter: 'all', page: 1, summary: job.summary
  });
  window.logResults?.(results, 'bulk', null);
}

/** Learn the server's batch cap so the count check can name the real number. */
async function loadBulkLimit() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) return;
    const { bulkLimit: limit } = await res.json();
    if (limit) bulkLimit = limit;
  } catch { /* the pre-check is a convenience; the server enforces the cap */ }
}

loadBulkLimit();
window.renderRunningView?.();

/* The nav count has to stay current from anywhere in the app, not just while
 * the Running view is open - it is the only signal that work is in flight.
 * Polling therefore runs everywhere, but only while something is actually
 * moving, or while the user is looking at the list. An idle app makes no
 * requests at all. */
setInterval(() => {
  const onRunning = !$('[data-view="running"]')?.hidden;
  if (window.hasActiveJobs || onRunning) window.renderRunningView?.();
}, 4000);

// A ?email=... link pre-fills and runs the check, so a result can be shared.
const fromUrl = new URLSearchParams(location.search).get('email');
if (fromUrl && fromUrl.trim()) {
  history.replaceState(null, '', location.pathname + location.hash);  // keep the URL clean
  input.value = fromUrl.trim();
  runSingle(fromUrl.trim());
} else {
  bulkInput.focus();
}
