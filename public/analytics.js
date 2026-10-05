/* ============================================================
   Sidebar views: dashboard, upload data, analysis.
   Everything is derived from a local log of checks (this browser only).
   Relies on $, esc, VERDICT_ORDER, VERDICT_LABEL from app.js.
   ============================================================ */

const LOG_KEY = 'check-log';
const UPLOADS_KEY = 'upload-log';
const LOG_MAX = 5000;

const readJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } };
const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } };

const reasonOf = (r) => r.suggestion
  ? `Possible typo → ${r.suggestion}`
  : (r.primaryIssue || '');

/* Called by app.js after every single or bulk check. */
window.logResults = (results, source, fileName) => {
  const at = Date.now();
  const rows = results.map(r => ({
    email: r.email,
    verdict: r.verdict,
    score: r.score,
    domain: r.meta?.domain || (r.email.split('@')[1] || '').toLowerCase(),
    provider: r.meta?.provider || '',
    reason: reasonOf(r),
    source,
    at
  }));
  writeJson(LOG_KEY, [...rows, ...readJson(LOG_KEY)].slice(0, LOG_MAX));

  if (source === 'bulk') {
    const summary = Object.fromEntries(VERDICT_ORDER.map(k => [k, 0]));
    results.forEach(r => { summary[r.verdict] = (summary[r.verdict] || 0) + 1; });
    const uploads = readJson(UPLOADS_KEY);
    uploads.unshift({ name: fileName || 'Pasted list', at, total: results.length, summary });
    writeJson(UPLOADS_KEY, uploads.slice(0, 50));
  }
  refreshNavNote();
};

/* ------------------------------ router ------------------------------ */
const VIEWS = ['dashboard', 'verify', 'running', 'upload', 'analysis', 'data', 'users', 'ip-server'];

// Views live at /verify, /users and so on. The hash form stayed in old links
// and bookmarks, so it is translated to the path once on arrival.
const viewPath = (name) => '/' + name;
function currentView() {
  const fromPath = location.pathname.replace(/^\/+|\/+$/g, '');
  if (VIEWS.includes(fromPath)) return fromPath;
  const fromHash = location.hash.slice(1);
  return VIEWS.includes(fromHash) ? fromHash : 'verify';
}
// Pushes a view onto the history stack and renders it. `replace` is for
// redirects, which should not leave a back-button trap behind.
function go(name, { replace = false } = {}) {
  const url = viewPath(name) + location.search;
  history[replace ? 'replaceState' : 'pushState'](null, '', url);
  showView();
}
window.go = go;

function showView() {
  let name = currentView();
  // The Create user page is for the owner and resellers only.
  if (name === 'users' && window.currentUser && !['owner', 'reseller'].includes(window.currentUser.role)) {
    name = 'verify';
    history.replaceState(null, '', viewPath('verify') + location.search);
  }
  // IP Server is owner-only - no reseller, no user, no exceptions. Guard
  // only once the role is actually known: on a hard refresh this runs before
  // /api/auth/me resolves, and gating on an unknown role bounced the owner
  // to /verify before their own role ever loaded.
  if (name === 'ip-server' && window.currentUser && window.currentUser.role !== 'owner') {
    name = 'verify';
    history.replaceState(null, '', viewPath('verify') + location.search);
  }
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('.nav-item').forEach(a =>
    a.classList.toggle('is-active', a.dataset.view === name));
  if (name === 'dashboard') renderDashboard();
  if (name === 'running') window.renderRunningView?.();
  if (name === 'upload') renderUploads();
  if (name === 'analysis') renderAnalysis();
  if (name === 'data') window.renderDataView?.();
  if (name === 'users') window.renderUsersView?.();
  if (name === 'ip-server') window.renderVastView?.();
}
window.addEventListener('popstate', showView);
// A hash link from an older bookmark still works: rewrite it to the path.
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (VIEWS.includes(name)) return go(name, { replace: true });
  showView();
});
// Keep in-app nav on the SPA instead of letting the browser reload the page.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  go(a.dataset.view);
});

function refreshNavNote() {
  const n = readJson(LOG_KEY).length;
  const note = $('#navNote');
  if (!note) return;
  note.textContent = n ? `${n.toLocaleString()} check${n === 1 ? '' : 's'} in this browser` : 'No checks yet';
}

/* ------------------------------ helpers ------------------------------ */
const pct = (a, b) => b ? Math.round((a / b) * 100) : 0;
const countBy = (rows, key) => rows.reduce((m, r) => (m[r[key]] = (m[r[key]] || 0) + 1, m), {});
const timeAgo = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const emptyState = (title, text) => `
  <div class="empty-block">
    <p>${title}</p><span>${text}</span>
    <a class="btn-primary btn-link" href="/verify" data-view="verify">Run a check</a>
  </div>`;

function donut(summary, total) {
  const r = 52, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = VERDICT_ORDER.map(k => {
    const len = total ? (summary[k] || 0) / total * c : 0;
    const arc = `<circle r="${r}" cx="64" cy="64" fill="none" class="arc-${k}" stroke-width="16"
      stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}"/>`;
    offset += len;
    return arc;
  }).join('');
  return `
    <div class="donut">
      <svg viewBox="0 0 128 128" aria-hidden="true">
        <circle r="${r}" cx="64" cy="64" fill="none" class="arc-track" stroke-width="16"/>
        <g transform="rotate(-90 64 64)">${arcs}</g>
      </svg>
      <div class="donut-center"><strong>${total.toLocaleString()}</strong><span>checked</span></div>
    </div>`;
}

const legend = (summary, total) => `
  <ul class="legend">
    ${VERDICT_ORDER.map(k => `
      <li><i class="dot-${k}"></i>${VERDICT_LABEL[k]}
        <b>${(summary[k] || 0).toLocaleString()}</b><em>${pct(summary[k] || 0, total)}%</em></li>`).join('')}
  </ul>`;

const barList = (entries, total, cls = '') => `
  <ul class="bar-list ${cls}">
    ${entries.map(([label, n, extra]) => `
      <li>
        <div class="bar-row"><span class="bar-label" title="${esc(label)}">${esc(label)}</span>
          <span class="bar-val">${n.toLocaleString()}${extra ? ` <em>${extra}</em>` : ''}</span></div>
        <div class="bar-track"><i style="width:${pct(n, total)}%"></i></div>
      </li>`).join('')}
  </ul>`;

/* ------------------------------ dashboard ------------------------------ */
const DASH_ICONS = {
  total:   '<path d="M4 6h16M4 12h16M4 18h10"/>',
  valid:   '<path d="M20 6L9 17l-5-5"/>',
  risky:   '<path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/>',
  invalid: '<path d="M18 6L6 18M6 6l12 12"/>'
};
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

function healthLabel(score) {
  if (score >= 80) return ['Excellent', 'valid'];
  if (score >= 60) return ['Good', 'valid'];
  if (score >= 40) return ['Fair', 'risky'];
  return ['Poor', 'invalid'];
}

function gauge(score) {
  // Semicircle gauge, 0-100.
  const r = 70, c = Math.PI * r, len = Math.max(0, Math.min(100, score)) / 100 * c;
  const [, tone] = healthLabel(score);
  return `
    <svg class="gauge" viewBox="0 0 180 100" aria-hidden="true">
      <path d="M20 90 A70 70 0 0 1 160 90" fill="none" class="arc-track" stroke-width="14" stroke-linecap="round"/>
      <path d="M20 90 A70 70 0 0 1 160 90" fill="none" class="arc-${tone}" stroke-width="14" stroke-linecap="round"
            stroke-dasharray="${len} ${c}"/>
    </svg>`;
}

function renderDashboard() {
  const log = readJson(LOG_KEY);
  const body = $('#dashBody');

  // The button lives in the view header, outside the body this function
  // rewrites, so its visibility is set rather than rendered.
  const clearBtn = $('#dashClear');
  if (clearBtn) clearBtn.hidden = !log.length;

  if (!log.length) {
    body.innerHTML = emptyState('No data yet', 'Your stats appear here once you check some addresses.');
    return;
  }
  const total = log.length;
  const s = countBy(log, 'verdict');
  const avg = Math.round(log.reduce((a, r) => a + (r.score || 0), 0) / total);
  const domains = new Set(log.map(r => r.domain)).size;
  const [health, tone] = healthLabel(avg);

  // Last 14 days of activity.
  const DAYS = 14;
  const days = [...Array(DAYS)].map((_, i) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (DAYS - 1 - i));
    return { start: d.getTime(), d, n: 0 };
  });
  log.forEach(r => {
    for (let i = days.length - 1; i >= 0; i--) if (r.at >= days[i].start) { days[i].n++; break; }
  });
  const maxDay = Math.max(1, ...days.map(d => d.n));
  const weekN = days.slice(-7).reduce((a, d) => a + d.n, 0);
  const prevN = days.slice(0, 7).reduce((a, d) => a + d.n, 0);
  const todayN = days[days.length - 1].n;

  const issues = Object.entries(countBy(log.filter(r => r.reason), 'reason'))
    .sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxIssue = Math.max(1, ...issues.map(i => i[1]));

  const kpi = (key, label, value, share, sub) => `
    <div class="kpi2 k-${key}">
      <div class="kpi2-top">
        <span class="kpi2-icon">${icon(DASH_ICONS[key])}</span>
        <span class="kpi2-label">${label}</span>
      </div>
      <strong class="kpi2-value">${value}</strong>
      <div class="kpi2-bar"><i style="width:${share}%"></i></div>
      <span class="kpi2-sub">${sub}</span>
    </div>`;

  // Latest check per address, so repeats don't crowd the table.
  const seen = new Set();
  const recent = log.filter(r => !seen.has(r.email) && seen.add(r.email)).slice(0, 7);

  body.innerHTML = `
    <div class="kpi2-grid">
      ${kpi('total', 'Total checked', total.toLocaleString(), 100, `${domains} domain${domains === 1 ? '' : 's'} · ${todayN} today`)}
      ${kpi('valid', 'Deliverable', `${pct(s.valid || 0, total)}%`, pct(s.valid || 0, total), `${(s.valid || 0).toLocaleString()} safe to send`)}
      ${kpi('risky', 'Risky', `${pct(s.risky || 0, total)}%`, pct(s.risky || 0, total), `${(s.risky || 0).toLocaleString()} need a look`)}
      ${kpi('invalid', 'Invalid', `${pct(s.invalid || 0, total)}%`, pct(s.invalid || 0, total), `${(s.invalid || 0).toLocaleString()} will bounce`)}
    </div>

    <div class="dash2-grid">
      <div class="panel-card health-card">
        <div class="panel-card-head"><h3>List health</h3><span class="muted">avg. score</span></div>
        <div class="health-body">
          <div class="gauge-wrap">${gauge(avg)}
            <div class="gauge-center"><strong>${avg}</strong><span class="tone-${tone}">${health}</span></div>
          </div>
          <p class="health-note">${tone === 'valid'
            ? 'Most of your addresses look safe to send to.'
            : tone === 'risky'
              ? 'A good share of addresses could not be confirmed or look risky. Review them before sending.'
              : 'Many addresses are likely to bounce. Clean the list before sending.'}</p>
        </div>
      </div>

      <div class="panel-card activity-card">
        <div class="panel-card-head">
          <h3>Activity</h3>
          <span class="muted">${weekN.toLocaleString()} this week${prevN ? ` · ${weekN >= prevN ? '▲' : '▼'} ${Math.abs(pct(weekN - prevN, prevN))}% vs last week` : ''}</span>
        </div>
        <div class="bars14">
          ${days.map((d, i) => `
            <div class="b14${i === DAYS - 1 ? ' is-today' : ''}" title="${d.d.toLocaleDateString()} · ${d.n} check${d.n === 1 ? '' : 's'}">
              <div class="b14-col"><i style="height:${d.n ? Math.max(4, (d.n / maxDay) * 100) : 0}%"></i></div>
              <span>${i % 2 === (DAYS - 1) % 2 ? d.d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : ''}</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-card-head"><h3>Verdict breakdown</h3></div>
        <div class="donut-wrap">${donut(s, total)}${legend(s, total)}</div>
      </div>

      <div class="panel-card">
        <div class="panel-card-head"><h3>Top issues</h3><a class="link" href="/analysis" data-view="analysis">Analysis →</a></div>
        ${issues.length ? `<ul class="issues">
          ${issues.map(([k, n]) => `
            <li><span class="issue-label" title="${esc(k)}">${esc(k)}</span>
              <span class="issue-bar"><i style="width:${(n / maxIssue) * 100}%"></i></span>
              <b>${n}</b></li>`).join('')}
        </ul>` : '<p class="muted pad">No problems found so far.</p>'}
      </div>
    </div>

    <div class="panel-card">
      <div class="panel-card-head"><h3>Recent checks</h3><a class="link" href="/verify" data-view="verify">Check more →</a></div>
      <div class="recent">
        ${recent.map(r => `
          <div class="recent-row">
            <span class="row-avatar" aria-hidden="true">${esc((r.email[0] || '?').toUpperCase())}</span>
            <span class="recent-main">
              <span class="mini-email">${esc(r.email)}</span>
              <span class="recent-sub">${esc(r.reason || r.provider || 'No issues found')}</span>
            </span>
            <span class="recent-score v-${r.verdict}"><span class="score-bar"><i style="width:${r.score || 0}%"></i></span><b>${r.score ?? '–'}</b></span>
            <span class="recent-time">${r.source === 'bulk' ? 'Bulk' : 'Single'} · ${timeAgo(r.at)}</span>
            <span class="badge b-${r.verdict}">${VERDICT_LABEL[r.verdict] || r.verdict}</span>
          </div>`).join('')}
      </div>
    </div>`;

}

/* ------------------------------ upload ------------------------------ */
const MAX_UPLOAD = 5 * 1024 * 1024;
let staged = null;   // file read and parsed, waiting for the user to start

const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;
const fileIcon = icon('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/>');

async function handleFile(file) {
  if (!file) return;
  if (file.size > MAX_UPLOAD) {
    staged = { error: `${file.name} is ${fmtSize(file.size)}. The limit is 5 MB.` };
    return renderPreview();
  }
  const text = await file.text();
  const raw = (text.match(/[^\s,;"'<>]+@[^\s,;"'<>]+/g) || []).map(e => e.toLowerCase());
  const emails = [...new Set(raw)];
  staged = emails.length
    ? { name: file.name, size: file.size, emails, dupes: raw.length - emails.length }
    : { error: `No email addresses were found in ${file.name}.` };
  renderPreview();
}

function renderPreview() {
  const box = $('#uploadPreview');
  if (!staged) { box.innerHTML = ''; return; }
  if (staged.error) {
    box.innerHTML = `
      <div class="up-alert">${icon('<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>')}
        <span>${esc(staged.error)}</span>
        <button type="button" class="tbtn tbtn-sm" id="dismissPreview">Dismiss</button></div>`;
    $('#dismissPreview').addEventListener('click', () => { staged = null; renderPreview(); });
    return;
  }
  const domains = new Set(staged.emails.map(e => e.split('@')[1])).size;
  const sample = staged.emails.slice(0, 6);
  box.innerHTML = `
    <div class="panel-card up-preview">
      <div class="up-file">
        <span class="up-file-icon">${fileIcon}</span>
        <span class="up-file-main">
          <strong>${esc(staged.name)}</strong>
          <span>${staged.emails.length.toLocaleString()} addresses · ${domains.toLocaleString()} domains${
            staged.dupes ? ` · <b class="up-dupes">${staged.dupes.toLocaleString()} dupes removed</b>` : ''
          } · ${fmtSize(staged.size)}</span>
        </span>
        <button type="button" class="tbtn tbtn-sm" id="removeStaged">Remove</button>
        <button type="button" class="btn-primary up-go" id="startStaged">Check ${staged.emails.length.toLocaleString()} address${staged.emails.length === 1 ? '' : 'es'}</button>
      </div>
      <div class="up-sample-list">
        <ul>${sample.map(e => `<li>${esc(e)}</li>`).join('')}</ul>
        ${staged.emails.length > sample.length ? `<span class="muted">+${(staged.emails.length - sample.length).toLocaleString()} more</span>` : ''}
      </div>
    </div>`;
  $('#removeStaged').addEventListener('click', () => { staged = null; renderPreview(); });
  $('#startStaged').addEventListener('click', () => {
    const { name, emails } = staged;
    staged = null; renderPreview();
    window.pendingUploadName = name;
    bulkInput.value = emails.join('\n');
    bulkInput.dispatchEvent(new Event('input'));
    go('verify');
    bulkBtn.click();
  });
}

const UPLOADS_PER_PAGE = 5;
let uploadPage = 1;

function pager(page, pages, total, per) {
  if (pages <= 1) return '';
  // Page numbers with ellipses: 1 … 4 5 6 … 12
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - page) <= 1) nums.push(i);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  const from = (page - 1) * per + 1, to = Math.min(total, page * per);
  return `
    <div class="pager">
      <span class="pager-info">Showing <b>${from}–${to}</b> of <b>${total}</b></span>
      <div class="pager-btns">
        <button type="button" class="pg" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''} aria-label="Previous page">
          ${icon('<path d="M15 18l-6-6 6-6"/>')}</button>
        ${nums.map(n => n === '…'
          ? '<span class="pg-gap">…</span>'
          : `<button type="button" class="pg${n === page ? ' is-active' : ''}" data-page="${n}" ${n === page ? 'aria-current="page"' : ''}>${n}</button>`).join('')}
        <button type="button" class="pg" data-page="${page + 1}" ${page === pages ? 'disabled' : ''} aria-label="Next page">
          ${icon('<path d="M9 18l6-6-6-6"/>')}</button>
      </div>
    </div>`;
}

function renderUploads() {
  renderPreview();
  const list = readJson(UPLOADS_KEY);
  $('#clearUploads').hidden = !list.length;

  if (!list.length) {
    $('#uploadStats').innerHTML = '';
    $('#uploadList').innerHTML = `
      <div class="up-empty">${fileIcon}<p>No uploads yet</p><span>Files you upload and lists you bulk-check show up here.</span></div>`;
    return;
  }
  const addrs = list.reduce((a, u) => a + u.total, 0);
  const valid = list.reduce((a, u) => a + (u.summary.valid || 0), 0);
  const bad = list.reduce((a, u) => a + (u.summary.invalid || 0), 0);
  $('#uploadStats').innerHTML = `
    <div class="up-stats">
      <div><span>Lists</span><strong>${list.length}</strong></div>
      <div><span>Addresses</span><strong>${addrs.toLocaleString()}</strong></div>
      <div><span>Valid</span><strong class="tone-valid">${pct(valid, addrs)}%</strong></div>
      <div><span>Invalid</span><strong class="tone-invalid">${pct(bad, addrs)}%</strong></div>
    </div>`;

  const pages = Math.ceil(list.length / UPLOADS_PER_PAGE);
  uploadPage = Math.min(Math.max(1, uploadPage), pages);
  const pageItems = list.slice((uploadPage - 1) * UPLOADS_PER_PAGE, uploadPage * UPLOADS_PER_PAGE);

  $('#uploadList').innerHTML = `
    <div class="up-row up-head"><span></span><span>List</span><span>Results</span><span>Status mix</span><span>Valid</span></div>
    ${pageItems.map(u => {
      const isFile = u.name !== 'Pasted list';
      return `
      <div class="up-row">
        <span class="up-file-icon ${isFile ? '' : 'is-paste'}">${isFile ? fileIcon : icon('<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h2"/>')}</span>
        <span class="up-main"><strong>${esc(u.name)}</strong><span>${u.total.toLocaleString()} addresses · ${timeAgo(u.at)}</span></span>
        <span class="up-counts">${VERDICT_ORDER.filter(k => u.summary[k]).map(k =>
          `<span class="up-count"><i class="dot-${k}"></i>${u.summary[k]}</span>`).join('')}</span>
        ${stackBar(u.summary, u.total)}
        <span class="up-valid">${pct(u.summary.valid || 0, u.total)}%</span>
      </div>`;
    }).join('')}
    ${pager(uploadPage, pages, list.length, UPLOADS_PER_PAGE)}`;

  $('#uploadList').querySelectorAll('.pg[data-page]').forEach(btn =>
    btn.addEventListener('click', () => { uploadPage = Number(btn.dataset.page); renderUploads(); }));
}

const dz = $('#dropzone');
const uploadView = document.querySelector('[data-view="upload"]');

$('#uploadFile').addEventListener('change', (e) => { handleFile(e.target.files?.[0]); e.target.value = ''; });

/* A file dropped anywhere outside the zone is a navigation as far as the
 * browser is concerned - it replaces the page with the file. Swallowing it at
 * the window makes a near miss do nothing instead of destroying the session. */
['dragover', 'drop'].forEach(ev =>
  window.addEventListener(ev, (e) => { e.preventDefault(); }, false));

/* dragleave fires every time the pointer crosses onto a child element, so a
 * plain toggle flickers the highlight off while the file is still held over
 * the zone. Counting enters and leaves keeps it steady. */
let dragDepth = 0;
const setOver = (on) => dz.classList.toggle('is-over', on);

/* Deliberately permissive. The 'Files' type string is not reported
 * consistently across browsers and drag sources, and gating dragover on it
 * meant the drop event never fired at all. Highlighting on a stray text drag
 * is a far smaller problem than a dead dropzone, and the drop handler checks
 * for a real file before doing anything. */
const isFileDrag = (e) => {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.files?.length) return true;
  if ([...(dt.types || [])].includes('Files')) return true;
  return [...(dt.items || [])].some(i => i.kind === 'file');
};

// The whole Upload view is a target, not just the dashed box: aiming at a
// small rectangle was the thing that actually kept failing.
const target = uploadView || dz;

// Capture phase: the zone is a <label> wrapping a file input, and its own
// default handling runs before anything listening on the way back up.
target.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  setOver(true);
}, true);
target.addEventListener('dragover', (e) => {
  // Always prevented: without this the browser refuses the drop outright.
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}, true);
target.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setOver(false);
}, true);
target.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  dragDepth = 0;
  setOver(false);
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
}, true);

$('#sampleCsv').addEventListener('click', () => {
  const csv = 'name,email,company\nAda Lovelace,ada@example.com,Analytical Engines\nAlan Turing,alan@example.org,Bletchley\nGrace Hopper,grace@example.net,Navy\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'sample-emails.csv'; a.click();
  URL.revokeObjectURL(url);
});

$('#clearUploads').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Clear upload history?',
    message: 'This removes the list of past uploads. Your checks on the dashboard stay.',
    confirmText: 'Clear history'
  });
  if (!ok) return;
  writeJson(UPLOADS_KEY, []);
  renderUploads();
  toast('Upload history cleared');
});

/* ------------------------------ analysis ------------------------------ */
let analysisRange = 'all';
// An array keeps the order: object keys like '7' would be sorted first.
const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', '7 days'], ['30', '30 days'], ['all', 'All time']];

const stackBar = (counts, total) => `
  <span class="stack-bar">${VERDICT_ORDER.map(k =>
    counts[k] ? `<i class="dot-${k}" style="width:${(counts[k] / total) * 100}%" title="${VERDICT_LABEL[k]}: ${counts[k]}"></i>` : '').join('')}</span>`;

function renderAnalysis() {
  const all = readJson(LOG_KEY);
  const body = $('#analysisBody');
  if (!all.length) {
    body.innerHTML = emptyState('Nothing to analyse yet', 'Check a few addresses and the breakdown appears here.');
    return;
  }
  const DAY_MS = 86400000;
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const t0 = midnight.getTime();
  const [from, to] = {
    today: [t0, Infinity],
    yesterday: [t0 - DAY_MS, t0],
    '7': [t0 - 6 * DAY_MS, Infinity],
    '30': [t0 - 29 * DAY_MS, Infinity],
    all: [0, Infinity]
  }[analysisRange];
  const log = all.filter(r => r.at >= from && r.at < to);

  const rangeBar = `
    <div class="range" role="tablist" aria-label="Time range">
      ${RANGES.map(([k, label]) => `
        <button type="button" class="range-btn${analysisRange === k ? ' is-active' : ''}" data-range="${k}">${label}</button>`).join('')}
    </div>`;

  if (!log.length) {
    body.innerHTML = rangeBar + emptyState('No checks in this period', 'Pick a longer range or run some new checks.');
    wireRange();
    return;
  }

  const total = log.length;
  const s = countBy(log, 'verdict');

  // Per-domain verdict counts.
  const byDomain = {};
  // Only real-looking domains; malformed input like "bad@@x" would add noise.
  log.filter(r => /^[^@\s]+\.[a-z]{2,}$/i.test(r.domain || '')).forEach(r => {
    const d = byDomain[r.domain] ||= { n: 0, valid: 0, risky: 0, unknown: 0, invalid: 0, score: 0 };
    d.n++; d[r.verdict]++; d.score += r.score || 0;
  });
  const domainList = Object.entries(byDomain).sort((a, b) => b[1].n - a[1].n);
  const domains = domainList.slice(0, 8);

  const issues = Object.entries(countBy(log.filter(r => r.reason), 'reason')).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const providers = Object.entries(countBy(log.filter(r => r.provider), 'provider')).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const withProblem = log.filter(r => r.verdict === 'risky' || r.verdict === 'invalid').length;

  // Plain-English insights.
  const multi = domainList.filter(([, d]) => d.n >= 2);
  const best = [...multi].sort((a, b) => (b[1].score / b[1].n) - (a[1].score / a[1].n))[0];
  const worst = [...multi].sort((a, b) => (a[1].score / a[1].n) - (b[1].score / b[1].n))[0];
  const insight = (tone, iconPath, title, text) => `
    <div class="insight i-${tone}">
      <span class="insight-icon">${icon(iconPath)}</span>
      <div><span class="insight-title">${title}</span><p>${text}</p></div>
    </div>`;
  const insights = [
    insight(withProblem / total > .3 ? 'invalid' : 'valid', DASH_ICONS.risky, 'Problem addresses',
      `<b>${pct(withProblem, total)}%</b> of checks were risky or invalid (${withProblem} of ${total}).`),
    issues.length
      ? insight('risky', '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>', 'Most common issue',
          `<b>${esc(issues[0][0])}</b>, ${issues[0][1]} time${issues[0][1] === 1 ? '' : 's'} (${pct(issues[0][1], total)}%).`)
      : insight('valid', DASH_ICONS.valid, 'Most common issue', 'No problems found in this period.'),
    worst && best && worst[0] !== best[0]
      ? insight('total', '<path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/><circle cx="12" cy="12" r="9"/>', 'Domains',
          `Healthiest: <b>${esc(best[0])}</b> (avg ${Math.round(best[1].score / best[1].n)}). Weakest: <b>${esc(worst[0])}</b> (avg ${Math.round(worst[1].score / worst[1].n)}).`)
      : insight('total', '<path d="M3 12h18M12 3a15 15 0 010 18M12 3a15 15 0 000 18"/><circle cx="12" cy="12" r="9"/>', 'Domains',
          `${domainList.length} different domain${domainList.length === 1 ? '' : 's'} checked.`)
  ].join('');

  // Score distribution.
  const buckets = [0, 0, 0, 0, 0];
  log.forEach(r => { buckets[Math.min(4, Math.floor((r.score || 0) / 20))]++; });
  const maxB = Math.max(1, ...buckets);
  const bucketLabel = ['0–19', '20–39', '40–59', '60–79', '80–100'];
  const bucketName = ['Bad', 'Poor', 'Fair', 'Good', 'Great'];

  const shareList = (entries, cls, avatar) => `
    <ul class="share-list ${cls}">
      ${entries.map(([label, n]) => `
        <li>
          ${avatar ? `<span class="share-av">${esc(label[0] || '?')}</span>` : ''}
          <span class="share-label" title="${esc(label)}">${esc(label)}</span>
          <span class="share-bar"><i style="width:${pct(n, entries[0][1])}%"></i></span>
          <span class="share-n">${n}</span>
          <span class="share-pct">${pct(n, total)}%</span>
        </li>`).join('')}
    </ul>`;

  body.innerHTML = `
    ${rangeBar}
    <div class="insights">${insights}</div>

    <div class="an-grid">
      <div class="panel-card">
        <div class="panel-card-head"><h3>Verdicts</h3><span class="muted">${total.toLocaleString()} checks</span></div>
        <div class="donut-wrap">${donut(s, total)}${legend(s, total)}</div>
      </div>
      <div class="panel-card">
        <div class="panel-card-head"><h3>Score distribution</h3><span class="muted">how many addresses per score band</span></div>
        <div class="dist">
          ${buckets.map((n, i) => `
            <div class="dist-col" title="${n} address${n === 1 ? '' : 'es'} scored ${bucketLabel[i]}">
              <span class="dist-n">${n}</span>
              <div class="dist-bar b${i}"><i style="height:${n ? Math.max(4, (n / maxB) * 100) : 0}%"></i></div>
              <span class="dist-name">${bucketName[i]}</span>
              <span class="dist-range">${bucketLabel[i]}</span>
            </div>`).join('')}
        </div>
      </div>

      <div class="panel-card">
        <div class="panel-card-head"><h3>Top issues</h3><span class="muted">share of all checks</span></div>
        ${issues.length ? shareList(issues, 'share-warn', false) : '<p class="muted pad">No problems detected in this period.</p>'}
      </div>
      <div class="panel-card">
        <div class="panel-card-head"><h3>Mail providers</h3><span class="muted">where the inboxes live</span></div>
        ${providers.length ? shareList(providers, '', true) : '<p class="muted pad">No provider data yet.</p>'}
      </div>
    </div>

    <div class="panel-card">
      <div class="panel-card-head"><h3>Top domains</h3>
        <span class="an-legend">${VERDICT_ORDER.map(k => `<span><i class="dot-${k}"></i>${VERDICT_LABEL[k]}</span>`).join('')}</span>
      </div>
      <div class="dom-table">
        <div class="dom-row dom-head"><span>Domain</span><span>Checks</span><span>Status mix</span><span>Avg. score</span></div>
        ${domains.map(([d, v]) => {
          const avg = Math.round(v.score / v.n);
          const tone = avg >= 60 ? 'valid' : avg >= 40 ? 'risky' : 'invalid';
          return `
          <div class="dom-row">
            <span class="dom-name"><span class="share-av">${esc((d[0] || '?').toUpperCase())}</span><span title="${esc(d)}">${esc(d)}</span></span>
            <span class="dom-n">${v.n.toLocaleString()}</span>
            ${stackBar(v, v.n)}
            <span class="dom-score tone-${tone}">${avg}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  wireRange();
}

function wireRange() {
  $('#analysisBody').querySelectorAll('[data-range]').forEach(btn =>
    btn.addEventListener('click', () => { analysisRange = btn.dataset.range; renderAnalysis(); }));
}

/* Dashboard stats come from the same local log the Analysis page clears, so
 * this clears both and leaves the server-side job list alone. */
$('#dashClear')?.addEventListener('click', async () => {
  const n = readJson(LOG_KEY).length;
  const ok = await confirmDialog({
    title: `Clear ${n.toLocaleString()} saved check${n === 1 ? '' : 's'}?`,
    message: 'This permanently removes the stats stored in this browser. Batches on the Running page are not affected.',
    confirmText: 'Clear stats'
  });
  if (!ok) return;
  writeJson(LOG_KEY, []);
  writeJson(UPLOADS_KEY, []);
  refreshNavNote();
  renderDashboard();
  toast('Stats cleared');
});

$('#clearData').addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: 'Clear all data?',
    message: 'This permanently removes every stored check and your upload history from this browser. It cannot be undone.',
    confirmText: 'Clear data'
  });
  if (!ok) return;
  writeJson(LOG_KEY, []); writeJson(UPLOADS_KEY, []);
  refreshNavNote(); renderAnalysis();
  toast('All data cleared');
});

/* ------------------------------ startup ------------------------------ */
refreshNavNote();
showView();
