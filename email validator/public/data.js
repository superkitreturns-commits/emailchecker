/* ============================================================
   All data: every check, stored in IndexedDB so it survives refreshes
   and can hold far more than localStorage. Filter by date, status and
   text; group by day; download or delete what is shown.
   Relies on $, esc, icon, svg, ICONS, VERDICT_ORDER, VERDICT_LABEL,
   renderCheckList, TECH_ONLY, confirmDialog, toast, pager (app/analytics).
   ============================================================ */

/* ------------------------------ storage ------------------------------ */
const DB_NAME = 'email-validator';
const STORE = 'results';
let dbPromise = null;

function openDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('This browser has no IndexedDB'));
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      store.createIndex('at', 'at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(out?.result ?? out);
    tx.onerror = () => reject(tx.error);
  });
}
const dbAll = () => dbTx('readonly', s => s.getAll());
const dbAdd = (rows) => dbTx('readwrite', s => rows.forEach(r => s.add(r)));
const dbDelete = (ids) => dbTx('readwrite', s => ids.forEach(id => s.delete(id)));

const toRecord = (r, source, list, at) => ({
  email: r.email,
  verdict: r.verdict,
  score: r.score ?? 0,
  suggestion: r.suggestion || '',
  reason: r.suggestion
    ? `Possible typo → ${r.suggestion}`
    : (r.checks?.find(c => (c.status === 'fail' || c.status === 'warn') && !TECH_ONLY.includes(c.id))?.detail || ''),
  domain: r.meta?.domain || (r.email.split('@')[1] || '').toLowerCase(),
  provider: r.meta?.provider || '',
  checks: r.checks || [],
  source,
  list: list || (source === 'bulk' ? 'Pasted list' : 'Single check'),
  at
});

// Save every check: wrap the logger that app.js already calls.
const baseLog = window.logResults;
window.logResults = (results, source, fileName) => {
  baseLog?.(results, source, fileName);
  const at = Date.now();
  dbAdd(results.map(r => toRecord(r, source, fileName, at)))
    .then(() => { cache = null; if (!$('[data-view="data"]').hidden) renderDataView(); })
    .catch(err => console.warn('Could not save results:', err));
};

// One-time import of checks made before this store existed.
async function migrateOldLog() {
  try {
    if (localStorage.getItem('data-migrated')) return;
    const old = JSON.parse(localStorage.getItem('check-log') || '[]');
    if (old.length) {
      await dbAdd(old.map(o => ({
        email: o.email, verdict: o.verdict, score: o.score ?? 0, suggestion: '',
        reason: o.reason || '', domain: o.domain || '', provider: o.provider || '',
        checks: [], source: o.source || 'single',
        list: o.source === 'bulk' ? 'Pasted list' : 'Single check', at: o.at
      })));
    }
    localStorage.setItem('data-migrated', '1');
  } catch (err) { console.warn('Migration skipped:', err); }
}

/* ------------------------------ settings ------------------------------ */
const SETTINGS_KEY = 'data-settings';
const COLUMNS = [['time', 'Time'], ['details', 'Details'], ['source', 'Source'], ['score', 'Score']];
const DEFAULT_SETTINGS = {
  statuses: { valid: true, risky: true, unknown: true, invalid: true },
  columns: { time: true, details: true, source: true, score: true },
  format: 'csv',
  hideDuplicates: false,
  range: 'today',
  per: 50
};
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      ...DEFAULT_SETTINGS, ...saved,
      statuses: { ...DEFAULT_SETTINGS.statuses, ...saved.statuses },
      columns: { ...DEFAULT_SETTINGS.columns, ...saved.columns }
    };
  } catch { return structuredClone(DEFAULT_SETTINGS); }
}
let settings = loadSettings();
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ } };
// The Check emails page's download uses the same format choice.
window.getDownloadFormat = () => settings.format;

/* ------------------------------ state ------------------------------ */
let cache = null;          // all records, newest first
const view = {
  range: settings.range, from: '', to: '',
  status: 'all', query: '', latestOnly: settings.hideDuplicates,
  page: 1, per: settings.per
};
const shownStatuses = () => VERDICT_ORDER.filter(k => settings.statuses[k]);

const DAY = 86400000;
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const RANGES_ORDER = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', '7 days'], ['30', '30 days'], ['all', 'All time'], ['custom', 'Custom']];
const RANGE_LABEL = Object.fromEntries(RANGES_ORDER);

function rangeBounds() {
  const today = startOfDay(Date.now());
  switch (view.range) {
    case 'today': return [today, Infinity];
    case 'yesterday': return [today - DAY, today];
    case '7': return [today - 6 * DAY, Infinity];
    case '30': return [today - 29 * DAY, Infinity];
    case 'custom': {
      const from = view.from ? new Date(view.from + 'T00:00').getTime() : 0;
      const to = view.to ? new Date(view.to + 'T00:00').getTime() + DAY : Infinity;
      return [from, to];
    }
    default: return [0, Infinity];
  }
}

/** Records in the date range (+ search, + latest-only), before the status filter. */
function inScope() {
  const [from, to] = rangeBounds();
  let rows = cache.filter(r => r.at >= from && r.at < to && settings.statuses[r.verdict] !== false);
  if (view.query) {
    const q = view.query;
    rows = rows.filter(r => r.email.toLowerCase().includes(q) || (r.list || '').toLowerCase().includes(q));
  }
  if (view.latestOnly) {
    const seen = new Set();
    rows = rows.filter(r => !seen.has(r.email) && seen.add(r.email));
  }
  return rows;
}
const filtered = () => inScope().filter(r => view.status === 'all' || r.verdict === view.status);

function dayLabel(t) {
  const d = startOfDay(t), today = startOfDay(Date.now());
  const date = new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  if (d === today) return `Today · ${date}`;
  if (d === today - DAY) return `Yesterday · ${date}`;
  return date;
}
const timeOf = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/* ------------------------------ render ------------------------------ */
async function renderDataView() {
  const body = $('#dataBody');
  if (!cache) {
    try {
      await migrateOldLog();
      cache = (await dbAll()).sort((a, b) => b.at - a.at);
    } catch (err) {
      body.innerHTML = `<div class="up-alert"><span>Saved data is unavailable in this browser: ${esc(err.message)}</span></div>`;
      return;
    }
  }

  const scope = inScope();
  const counts = Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]));
  scope.forEach(r => { counts[r.verdict] = (counts[r.verdict] || 0) + 1; });
  if (view.status !== 'all' && !settings.statuses[view.status]) view.status = 'all';
  const rows = filtered();

  const pages = Math.max(1, Math.ceil(rows.length / view.per));
  view.page = Math.min(Math.max(1, view.page), pages);
  const pageRows = rows.slice((view.page - 1) * view.per, view.page * view.per);

  // Group the page by day.
  const groups = [];
  pageRows.forEach(r => {
    const key = startOfDay(r.at);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) groups.push(g = { key, label: dayLabel(r.at), rows: [] });
    g.rows.push(r);
  });
  const dayTotals = {};
  rows.forEach(r => { const k = startOfDay(r.at); dayTotals[k] = (dayTotals[k] || 0) + 1; });

  const scopeLabel = view.status === 'all' ? 'all' : VERDICT_LABEL[view.status].toLowerCase();
  const validPct = scope.length ? Math.round((counts.valid / scope.length) * 100) : 0;

  body.innerHTML = `
    <div class="panel-card data-card ${COLUMNS.filter(([k]) => !settings.columns[k]).map(([k]) => `hide-${k}`).join(' ')}" style="--dcols:${[
      settings.columns.time && '70px', 'minmax(170px, 1.3fr)', settings.columns.details && 'minmax(0, 1.8fr)',
      settings.columns.source && 'minmax(90px, .8fr)', settings.columns.score && '100px', '80px', '18px'
    ].filter(Boolean).join(' ')}">
      <div class="data-bar">
        <div class="range" role="tablist" aria-label="Date range">
          ${RANGES_ORDER.map(([k, label]) => `
            <button type="button" class="range-btn${view.range === k ? ' is-active' : ''}" data-range="${k}">${label}</button>`).join('')}
        </div>
        ${view.range === 'custom' ? `
          <div class="date-pick">
            <input type="date" id="dFrom" value="${view.from}" aria-label="From date">
            <span>to</span>
            <input type="date" id="dTo" value="${view.to}" aria-label="To date">
          </div>` : ''}
      </div>

      <div class="data-bar">
        <label class="fsearch">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
          <input type="search" id="dSearch" placeholder="Search email, domain or list name" value="${esc(view.query)}" aria-label="Search saved data">
        </label>
        <label class="switch" title="Show each email address once, using its most recent check. Older repeats are hidden, not deleted.">
          <input type="checkbox" id="dLatest" ${view.latestOnly ? 'checked' : ''}>
          <span class="switch-ui" aria-hidden="true"></span>
          Hide duplicates
        </label>
        <div class="table-actions">
          <button class="tbtn tbtn-danger" id="dDelete" type="button" ${rows.length ? '' : 'disabled'}>
            ${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>')}Delete</button>
          <button class="tbtn tbtn-primary" id="dDownload" type="button" ${rows.length ? '' : 'disabled'}>
            ${icon('<path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M4 18v1a2 2 0 002 2h12a2 2 0 002-2v-1"/>')}Download ${scopeLabel} <span class="fmt-tag">.${settings.format}</span></button>
        </div>
      </div>

      <div class="ftabs" role="toolbar" aria-label="Filter by status">
        ${['all', ...shownStatuses()].map(k => {
          const n = k === 'all' ? scope.length : counts[k];
          return `
          <button type="button" class="ftab${view.status === k ? ' is-active' : ''}${n ? '' : ' is-zero'}" data-status="${k}" aria-pressed="${view.status === k}">
            ${k === 'all' ? '' : `<i class="dot-${k}"></i>`}${k === 'all' ? 'All' : VERDICT_LABEL[k]}<span class="ftab-n">${n.toLocaleString()}</span>
          </button>`;
        }).join('')}
        <span class="data-rate">${scope.length ? `<b>${validPct}%</b> valid in this period` : ''}</span>
      </div>

      ${rows.length ? `
      <div class="drow drow-head" aria-hidden="true">
        <span>Time</span><span>Email</span><span>Details</span><span>Source</span><span>Score</span><span>Status</span><span></span>
      </div>
      <div class="data-list">
        ${groups.map(g => `
          <div class="day-head"><span>${esc(g.label)}</span><em>${dayTotals[g.key].toLocaleString()} check${dayTotals[g.key] === 1 ? '' : 's'}</em></div>
          ${g.rows.map(dataRowHtml).join('')}`).join('')}
      </div>
      ${pages > 1 ? pager(view.page, pages, rows.length, view.per) : ''}`
      : `<div class="up-empty">${icon('<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>')}
          <p>${cache.length ? 'Nothing matches these filters' : 'No saved data yet'}</p>
          <span>${cache.length ? 'Try another date range or status.' : 'Every check you run is saved here automatically.'}</span></div>`}
    </div>`;

  wireDataView(rows);
}

function dataRowHtml(r) {
  const detail = r.checks?.length
    ? renderCheckList(r.checks, c => `
        <div class="rd-check c-${c.status}"${c.raw ? ` title="${esc(c.raw)}"` : ''}>
          <span class="check-icon">${svg(ICONS[c.status] || ICONS.skip)}</span>
          <span class="rd-label">${esc(c.label)}</span>
          <span class="rd-text">${esc(c.detail)}</span>
        </div>`)
    : '<p class="muted">Detailed checks were not stored for this older entry.</p>';
  return `
    <div class="row-item">
      <div class="drow v-${r.verdict}" role="button" tabindex="0" aria-expanded="false" data-id="${r.id}">
        <span class="d-time">${timeOf(r.at)}</span>
        <span class="row-main">
          <span class="row-email">${esc(r.email)}</span>
          ${r.provider ? `<span class="row-provider">${esc(r.provider)}</span>` : ''}
        </span>
        <span class="row-note" title="${esc(r.reason)}">${esc(r.reason) || '<span class="row-ok">No issues found</span>'}</span>
        <span class="d-src" title="${esc(r.list)}">${r.source === 'bulk' ? icon('<path d="M4 6h16M4 12h16M4 18h10"/>') : icon('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 7l10 7 10-7"/>')}<span>${esc(r.list)}</span></span>
        <span class="row-score"><span class="score-bar"><i style="width:${Math.max(0, Math.min(100, r.score))}%"></i></span><span class="row-score-num">${r.score}</span></span>
        <span class="badge b-${r.verdict}">${VERDICT_LABEL[r.verdict] || r.verdict}</span>
        <span class="row-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>
      </div>
      <div class="row-detail" hidden>${detail}</div>
    </div>`;
}

function wireDataView(rows) {
  const body = $('#dataBody');
  const rerender = (patch) => { Object.assign(view, patch); renderDataView(); };

  body.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => rerender({ range: b.dataset.range, page: 1 })));
  body.querySelectorAll('[data-status]').forEach(b => b.addEventListener('click', () => rerender({ status: b.dataset.status, page: 1 })));
  body.querySelector('#dLatest').addEventListener('change', e => rerender({ latestOnly: e.target.checked, page: 1 }));
  body.querySelector('#dFrom')?.addEventListener('change', e => rerender({ from: e.target.value, page: 1 }));
  body.querySelector('#dTo')?.addEventListener('change', e => rerender({ to: e.target.value, page: 1 }));

  const search = body.querySelector('#dSearch');
  search.addEventListener('input', () => {
    view.query = search.value.trim().toLowerCase(); view.page = 1;
    renderDataView().then(() => {
      const again = $('#dSearch');
      again.focus(); again.setSelectionRange(again.value.length, again.value.length);
    });
  });

  body.querySelectorAll('.pg[data-page]').forEach(b => b.addEventListener('click', () => {
    rerender({ page: Number(b.dataset.page) });
    $('[data-view="data"]').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));

  body.querySelectorAll('.drow[data-id]').forEach(row => {
    const toggle = () => {
      const open = row.getAttribute('aria-expanded') !== 'true';
      row.setAttribute('aria-expanded', String(open));
      row.nextElementSibling.hidden = !open;
    };
    row.addEventListener('click', toggle);
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });

  body.querySelector('#dDownload')?.addEventListener('click', () => downloadRecords(rows));

  body.querySelector('#dDelete')?.addEventListener('click', async () => {
    const n = rows.length;
    const what = view.status === 'all' ? '' : ` ${VERDICT_LABEL[view.status].toLowerCase()}`;
    const ok = await confirmDialog({
      title: `Delete ${n.toLocaleString()}${what} saved result${n === 1 ? '' : 's'}?`,
      message: `This permanently removes the entries shown for ${RANGE_LABEL[view.range].toLowerCase()} from this browser. It cannot be undone.`,
      confirmText: 'Delete'
    });
    if (!ok) return;
    await dbDelete(rows.map(r => r.id));
    const gone = new Set(rows.map(r => r.id));
    cache = cache.filter(r => !gone.has(r.id));
    renderDataView();
    toast(`Deleted ${n.toLocaleString()} result${n === 1 ? '' : 's'}`);
  });
}

function downloadRecords(rows) {
  // Just the addresses, one per line, each once.
  const emails = [...new Set(rows.map(r => r.email))];
  const txt = settings.format === 'txt';
  const blob = new Blob([emails.join('\n') + '\n'], { type: `${txt ? 'text/plain' : 'text/csv'};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const tag = [view.status === 'all' ? 'all' : view.status, view.range === 'all' ? '' : RANGE_LABEL[view.range].toLowerCase().replace(/\s+/g, '-')].filter(Boolean).join('-');
  a.href = url;
  a.download = `email-data-${tag}-${new Date().toISOString().slice(0, 10)}.${txt ? 'txt' : 'csv'}`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Downloaded ${emails.length.toLocaleString()} email${emails.length === 1 ? '' : 's'}`);
}

/* ------------------------------ settings dialog ------------------------------ */
function openSettings() {
  const prevFocus = document.activeElement;
  const draft = structuredClone(settings);
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  const check = (group, key, label, dot) => `
    <label class="opt">
      <input type="checkbox" data-group="${group}" data-key="${key}" ${draft[group][key] ? 'checked' : ''}>
      <span class="opt-box" aria-hidden="true"></span>
      ${dot ? `<i class="dot-${key}"></i>` : ''}${label}
    </label>`;
  const radio = (name, value, label, sub) => `
    <label class="seg-opt">
      <input type="radio" name="${name}" value="${value}" ${String(draft[name]) === String(value) ? 'checked' : ''}>
      <span><b>${label}</b>${sub ? `<em>${sub}</em>` : ''}</span>
    </label>`;

  wrap.innerHTML = `
    <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="sTitle">
      <div class="settings-head">
        <h2 class="modal-title" id="sTitle">All data settings</h2>
        <button type="button" class="icon-x" data-close aria-label="Close">${icon('<path d="M18 6L6 18M6 6l12 12"/>')}</button>
      </div>
      <div class="settings-body">
        <section>
          <h3>Show statuses</h3>
          <p>Unchecked statuses are hidden from the list, the counts and downloads.</p>
          <div class="opt-grid">${VERDICT_ORDER.map(k => check('statuses', k, VERDICT_LABEL[k], true)).join('')}</div>
        </section>
        <section>
          <h3>Show columns</h3>
          <div class="opt-grid">${COLUMNS.map(([k, l]) => check('columns', k, l)).join('')}</div>
        </section>
        <section>
          <h3>Download format</h3>
          <div class="seg">
            ${radio('format', 'csv', 'CSV', 'opens in Excel / Sheets')}
            ${radio('format', 'txt', 'TXT', 'plain text, one per line')}
          </div>
        </section>
        <section>
          <h3>Defaults</h3>
          <label class="switch">
            <input type="checkbox" id="sDup" ${draft.hideDuplicates ? 'checked' : ''}>
            <span class="switch-ui" aria-hidden="true"></span>
            Hide duplicates by default
          </label>
          <div class="settings-row">
            <label>Open on
              <select id="sRange">${RANGES_ORDER.filter(([k]) => k !== 'custom').map(([k, l]) =>
                `<option value="${k}"${draft.range === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
            </label>
            <label>Rows per page
              <select id="sPer">${[25, 50, 100, 200].map(n =>
                `<option value="${n}"${draft.per === n ? ' selected' : ''}>${n}</option>`).join('')}</select>
            </label>
          </div>
        </section>
      </div>
      <div class="modal-actions settings-actions">
        <button type="button" class="tbtn" id="sReset">Reset to defaults</button>
        <span style="flex:1"></span>
        <button type="button" class="tbtn" data-close>Cancel</button>
        <button type="button" class="tbtn tbtn-primary" id="sSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  wrap.querySelector('.icon-x').focus();

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.classList.remove('is-open');
    setTimeout(() => wrap.remove(), 160);
    prevFocus?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  wrap.querySelector('#sReset').addEventListener('click', () => {
    settings = structuredClone(DEFAULT_SETTINGS);
    close(); applySettings(); toast('Settings reset');
  });
  wrap.querySelector('#sSave').addEventListener('click', () => {
    const statuses = {}, columns = {};
    wrap.querySelectorAll('[data-group="statuses"]').forEach(i => { statuses[i.dataset.key] = i.checked; });
    wrap.querySelectorAll('[data-group="columns"]').forEach(i => { columns[i.dataset.key] = i.checked; });
    if (!Object.values(statuses).some(Boolean)) { toast('Keep at least one status visible', 'warn'); return; }
    settings = {
      statuses, columns,
      format: wrap.querySelector('input[name="format"]:checked').value,
      hideDuplicates: wrap.querySelector('#sDup').checked,
      range: wrap.querySelector('#sRange').value,
      per: Number(wrap.querySelector('#sPer').value)
    };
    close(); applySettings(); toast('Settings saved');
  });
}

function applySettings() {
  saveSettings();
  Object.assign(view, { range: settings.range, latestOnly: settings.hideDuplicates, per: settings.per, page: 1 });
  renderDataView();
}

$('#dataSettings').addEventListener('click', openSettings);

window.renderDataView = renderDataView;
// If the page was opened straight on #data, the router ran before this file loaded.
if (location.hash === '#data') renderDataView();
