/* ============================================================
   Create user / user management.
   Owner: sees and manages everyone, can create resellers.
   Reseller: sees and manages only the users they created.
   Relies on $, esc, icon, toast, confirmDialog (app/analytics).
   ============================================================ */
let usersCache = [];
let myRole = 'user';
let canMakeResellers = false;

const genUsername = () => {
  const words = ['swift', 'blue', 'nova', 'pixel', 'tiger', 'orbit', 'cedar', 'lumen', 'echo', 'river', 'maple', 'comet'];
  const [a, b] = crypto.getRandomValues(new Uint32Array(2));
  return `${words[a % words.length]}${1000 + (b % 9000)}`;
};
const genPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  return [...crypto.getRandomValues(new Uint32Array(12))].map(n => chars[n % chars.length]).join('');
};
const ago = (iso) => {
  if (!iso) return 'Never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
const ROLE_LABEL = { owner: 'Owner', reseller: 'Partner', user: 'Client' };

// Generate buttons (form and edit dialog).
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-gen]');
  if (!b) return;
  const input = document.getElementById(b.dataset.target);
  input.value = b.dataset.gen === 'user' ? genUsername() : genPassword();
  input.dispatchEvent(new Event('input'));
});

async function copyText(text, label) {
  if (!text) return toast(`Nothing to copy yet`, 'warn');
  try { await navigator.clipboard.writeText(text); toast(`${label} copied`); }
  catch { toast('Copy blocked by the browser', 'warn'); }
}
// Copy buttons: data-copy="<input id>", or data-copy-login for username + password.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy], [data-copy-login]');
  if (!b) return;
  if (b.dataset.copyLogin !== undefined) {
    return copyText(`${b.dataset.name ? 'Client Name - ' + b.dataset.name + '\n' : ''}Portal Link - https://mailfinderpro.xyz/\nUsername - ${b.dataset.user}\nPassword - ${b.dataset.pass}`, 'Login details');
  }
  const input = document.getElementById(b.dataset.copy);
  copyText(input?.value, input?.id?.toLowerCase().includes('user') ? 'Username' : 'Password');
});

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

/* ------------------------------ list ------------------------------ */
async function renderUsersView() {
  const list = $('#userList');
  try {
    const data = await api('GET', '/api/users');
    usersCache = data.users;
    myRole = data.me;
    canMakeResellers = !!data.canCreateResellers;
  } catch (err) {
    list.innerHTML = `<p class="muted pad">${esc(err.message)}</p>`;
    return;
  }
  $('#ufResellerWrap').hidden = !canMakeResellers;
  syncSubToggle();
  $('#usersSub').textContent = myRole === 'owner'
    ? 'Create logins, resellers and manage everyone who uses this app.'
    : 'Create logins for your clients. You only see the users you created.';
  $('#usersListTitle').textContent = myRole === 'owner' ? 'All users' : 'My users';
  drawUsers();
}

let seededOpen = false;
let defaultOpen = true;
// Which half of the table is on screen. Direct is the default: most accounts
// have no partners at all, and a single flat list of your own clients is what
// that case actually is - the group chrome around one group said nothing.
const SCOPE_KEY = 'users.scope';
let scope = (() => {
  try { return localStorage.getItem(SCOPE_KEY) === 'partner' ? 'partner' : 'direct'; }
  catch { return 'direct'; }
})();

// The markup ships with My user marked active. On a reload the stored scope
// may be Partner, so the pills are re-synced on every draw rather than only
// on click - otherwise the highlight and the list disagreed after a refresh.
function paintScope(active) {
  for (const b of document.querySelectorAll('#uScope .ftab')) {
    const on = b.dataset.scope === active;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  }
}

function setScope(next) {
  scope = next;
  try { localStorage.setItem(SCOPE_KEY, next); } catch { /* private mode */ }
  drawUsers();
}

$('#uScope')?.addEventListener('click', (e) => {
  const b = e.target.closest('.ftab');
  if (b) setScope(b.dataset.scope);
});

const sorted0 = (rows) => sortUsers(rows, $('#uSort')?.value || 'name');

function drawUsers() {
  // Until the first explicit expand/collapse, every group starts open. Seeding
  // only '__self' left each partner block shut, so the users under it were
  // invisible until the block was clicked - the list looked empty.
  if (!seededOpen) {
    seededOpen = true;
    try { defaultOpen = localStorage.getItem(OPEN_KEY) === null; } catch { defaultOpen = true; }
  }
  const q = $('#uSearch').value.trim().toLowerCase();
  // Your own account is not something you manage from this table - every
  // action on it is blocked anyway - so it only added an empty group above
  // the users you actually administer.
  // Owner accounts are not manageable from this table - every action on them
  // is refused and they render as "Protected" - so they are left out entirely.
  // There can be more than one, which is why filtering only the signed-in
  // account still left a group heading with nothing actionable under it.
  const managed = usersCache.filter(u => u.role !== 'owner');
  const rows = managed.filter(u => !q || `${u.name} ${u.username} ${u.createdBy?.name || ''}`.toLowerCase().includes(q));
  const list = $('#userList');
  if (!managed.length) {
    list.innerHTML = `<div class="up-empty">${icon('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0114 0"/><path d="M19 8v6M22 11h-6"/>')}<p>No users yet</p><span>Users you create appear here with their activity.</span></div>`;
    return;
  }
  // A partner, and anyone a partner created, belongs to the Partner tab. What
  // is left is your own direct clients.
  const partnerIds = new Set(managed.filter(u => u.role === 'reseller').map(u => u.id));
  // A partner you created belongs on both tabs, and for different reasons: on
  // My user because you created it and manage its balance, on Partner because
  // it heads a group of its own clients. So the split is by creator, not by
  // role - My user is everything a partner did not create.
  const isPartnerSide = (u) => u.role === 'reseller' || partnerIds.has(u.createdBy?.id);
  const isDirectSide = (u) => !partnerIds.has(u.createdBy?.id);
  const nDirect = managed.filter(isDirectSide).length;
  const nPartner = managed.filter(isPartnerSide).length;
  const setCount = (id, n) => { const el = $(id); if (el) el.textContent = n.toLocaleString(); };
  setCount('#uScopeNDirect', nDirect);
  setCount('#uScopeNPartner', nPartner);
  const scopeEl = $('#uScope');
  if (scopeEl) scopeEl.hidden = !nPartner;

  // With no partners there is nothing to switch to, so the Direct list stands
  // on its own rather than being hidden behind a tab that cannot be left.
  const view = !nPartner ? 'direct' : scope;
  paintScope(view);
  const scoped = sorted0(rows).filter(view === 'partner' ? isPartnerSide : isDirectSide);

  const sorted = scoped;
  const groups = groupByCreator(sorted);
  // Direct clients are a flat list: they are all yours, so a single group
  // heading above them carried no information.
  const grouped = view === 'partner' && groups.length > 0;
  const showBy = myRole === 'owner' && !grouped;

  const headHtml = `
    <div class="u-row u-head${showBy ? ' with-by' : ''}">
      <span></span><span>Client</span><span class="h-pw">Password</span><span class="h-role">Role</span>${showBy ? '<span class="h-by">Created by</span>' : ''}<span class="h-credits">Credits</span><span class="h-num">Checks</span><span class="h-date">Last active</span><span class="u-head-act">Actions</span>
    </div>
`;

  const rowHtml = (u) => `
    <div class="u-row is-clickable${showBy ? ' with-by' : ''}${u.disabled ? ' is-disabled' : ''}" data-id="${u.id}" tabindex="0" role="button" aria-label="View ${esc(u.name)}">
      <span class="user-av">${esc((u.name || u.username)[0].toUpperCase())}</span>
      <span class="u-main u-selectable"><strong>${esc(u.name && u.name !== u.username ? u.name : u.username)}</strong>${u.name && u.name !== u.username ? `<span>@${esc(u.username)}</span>` : ''}</span>
      <span class="u-pw">${u.password
        ? `<code class="u-pw-val u-selectable" data-pw="${esc(u.password)}">••••••••</code>
           <button type="button" class="u-mini" data-act="showpw" title="Show password" aria-label="Show password">${icon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>')}</button>
           <button type="button" class="u-mini" data-act="copypw" title="Copy username & password" aria-label="Copy login">${icon('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>')}</button>`
        : `<span class="u-pw-none" title="${u.role === 'owner' ? 'Owner passwords are never shown' : 'Set a new password to be able to view it'}">—</span>`}</span>
      <span class="u-role-cell"><span class="u-role r-${u.role}"${u.canCreateResellers ? ' title="Can create their own partners"' : ''}>${ROLE_LABEL[u.role]}${u.canCreateResellers ? '<i aria-label="can invite partners">+</i>' : ''}</span>${u.disabled ? '<span class="u-role r-off">Disabled</span>' : ''}</span>
      ${showBy ? `<span class="u-by">${u.createdBy ? esc(u.createdBy.name) : '—'}</span>` : ''}
      <span class="u-credits${u.credits === null ? ' is-inf' : u.credits === 0 ? ' is-empty' : u.credits < 100 ? ' is-low' : ''}"${u.credits !== null && u.credits < 100 ? ' title="Running low"' : ''}>${u.credits === null ? '∞' : u.credits.toLocaleString()}</span>
      <span class="u-num" title="${u.logins} sign-in${u.logins === 1 ? '' : 's'}">${u.checks.toLocaleString()}</span>
      <span class="u-date" title="Last sign-in: ${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}">${ago(u.lastActiveAt)}</span>
      <span class="u-actions">
        ${u.role === 'owner' ? '<span class="u-locked">Protected</span>'
          : u.manageable === false ? '<span class="u-locked">View only</span>' : `
        <button type="button" class="u-act u-act-credit" data-act="credits" title="Add or remove credits for this user">${icon('<path d="M12 5v14M5 12h14"/>')}<span>Add credits</span></button>
        <button type="button" class="u-act" data-act="edit" title="Edit">${icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>')}<span>Edit</span></button>
        <button type="button" class="u-act" data-act="reset" title="Reset password">${icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 118 0v4"/>')}<span>Password</span></button>
        <button type="button" class="u-act" data-act="toggle" title="${u.disabled ? 'Enable' : 'Disable'} user">${u.disabled
          ? icon('<path d="M20 6L9 17l-5-5"/>') + '<span>Enable</span>'
          : icon('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>') + '<span>Disable</span>'}</button>
        <button type="button" class="u-act danger" data-act="delete" title="Delete user" aria-label="Delete ${esc(u.name)}">${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>')}<span>Delete</span></button>`}
      </span>
    </div>`;

  // A search is a request to see matches, not to go hunting through collapsed
  // groups, so searching expands everything for as long as the query lasts.
  const openAll = Boolean(q);

  // Counted over every managed user, not the active tab. These are workspace
  // totals, so they stay put while you switch between Direct and Partner;
  // scoping them made the bar jump to zeroes on Direct.
  const counted = rows;
  const totals = {
    users: counted.length,
    credits: counted.filter(u => u.credits !== null).reduce((t, u) => t + (u.credits || 0), 0),
    checks: counted.reduce((t, u) => t + (u.checks || 0), 0),
    resellers: counted.filter(u => u.role === 'reseller').length
  };
  // The same four tiles on both tabs: a column that appears and disappears
  // between them reads as a layout glitch, not as a scope change.
  const summary = `
    <div class="u-summary">
      <div><span>Users</span><strong>${totals.users.toLocaleString()}</strong></div>
      <div><span>Partners</span><strong>${totals.resellers.toLocaleString()}</strong></div>
      <div><span>Credits in circulation</span><strong>${totals.credits.toLocaleString()}</strong></div>
      <div><span>Checks run</span><strong>${totals.checks.toLocaleString()}</strong></div>
    </div>`;

  const anyOpen = !grouped || openAll || defaultOpen || groups.some(g => isGroupOpen(g.id));

  list.innerHTML = sorted.length
    ? summary + headHtml + (grouped
        ? groups.map(g => {
            const open = openAll || defaultOpen || isGroupOpen(g.id);
            return `
            <div class="u-group${open ? ' is-open' : ''}" data-owner="${g.id || ''}"
                 role="button" tabindex="0" aria-expanded="${open}"
                 aria-label="${open ? 'Collapse' : 'Expand'} ${esc(g.label)}">
              <span class="u-group-caret">${icon('<path d="M9 6l6 6-6 6"/>')}</span>
              <span class="u-group-av">${esc(g.label[0].toUpperCase())}</span>
              <span class="u-group-name">${esc(g.label)}</span>
              <span class="u-group-role">${g.role}</span>
              ${g.users.some(x => x.credits === null)
                ? '<span class="u-group-sum is-inf">&infin; unlimited</span>'
                : `<span class="u-group-sum">${g.users.reduce((t, x) => t + (x.credits || 0), 0).toLocaleString()}<i>credits</i></span>`}
              <span class="u-group-count">${g.users.length}<i>${g.users.length === 1 ? 'client' : 'clients'}</i></span>
            </div>
            <div class="u-group-body"${open ? '' : ' hidden'} data-body="${g.id || ''}">
              ${g.users.length ? g.users.map(rowHtml).join('')
                : '<p class="u-group-empty">No clients yet.</p>'}
            </div>`;
          }).join('')
        : groups.map(g => (g.self ? rowHtml(g.self) : '') + g.users.map(rowHtml).join('')).join(''))
    : q
      ? `<div class="up-empty up-empty-sm">${icon('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>')}<p>No users match &ldquo;${esc(q)}&rdquo;</p><span>Try a different name, username or reseller.</span></div>`
      : `<div class="up-empty up-empty-sm">${icon('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0114 0"/>')}<p>No ${view === 'partner' ? 'partners' : 'direct clients'} yet</p><span>${view === 'partner' ? 'Accounts you mark as a partner appear here with their own clients.' : 'Users you create appear here.'}</span></div>`;

  const toggle = $('#uToggleAll');
  if (toggle) {
    const heads = [...list.querySelectorAll('.u-group')];
    const allOpen = heads.length > 0 && heads.every(h => h.classList.contains('is-open'));
    // Always on screen so the toolbar does not reflow between tabs; there is
    // nothing to expand on Direct, so it is disabled there rather than removed.
    toggle.hidden = false;
    toggle.disabled = !grouped;
    toggle.textContent = allOpen ? 'Collapse all' : 'Expand all';
    toggle.setAttribute('aria-expanded', String(allOpen));
  }
}

/**
 * Order users inside a group. Sorting the whole flat list would destroy the
 * parent-above-child grouping that makes this view readable, so the chosen
 * order is applied within each creator's block instead.
 */
function sortUsers(rows, mode) {
  const num = (v) => (v === null ? Infinity : (v || 0));   // owner = unlimited
  const time = (v) => (v ? new Date(v).getTime() : 0);
  const by = {
    name: (a, b) => (a.name || a.username).localeCompare(b.name || b.username),
    credits: (a, b) => num(b.credits) - num(a.credits),
    checks: (a, b) => (b.checks || 0) - (a.checks || 0),
    active: (a, b) => time(b.lastActiveAt) - time(a.lastActiveAt),
    created: (a, b) => time(b.createdAt) - time(a.createdAt)
  };
  return [...rows].sort(by[mode] || by.name);
}

/* Which creator groups are expanded. Kept per browser so the shape of the list
   survives a reload and a re-render after an edit. */
const OPEN_KEY = 'users-open-groups';
let openGroups = null;
function loadOpenGroups() {
  if (openGroups) return openGroups;
  try { openGroups = new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); }
  catch { openGroups = new Set(); }
  return openGroups;
}
// The first group is your own account: open by default so the list is not
// entirely blank on a fresh browser.
const isGroupOpen = (id) => loadOpenGroups().has(id || '__self');
function toggleGroup(id) {
  const key = id || '__self';
  const set = loadOpenGroups();
  // The first explicit toggle ends the open-by-default state; without this a
  // collapse would be overridden on the very next render.
  if (defaultOpen) { defaultOpen = false; for (const g of document.querySelectorAll('#userList .u-group')) set.add(g.dataset.owner || '__self'); }
  if (set.has(key)) set.delete(key); else set.add(key);
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
}

/**
 * Bucket users under the account that created them, ordered as a tree: your
 * own row first, then the accounts you created, then each reseller's own
 * users directly beneath the reseller's row.
 *
 * Reading order is the point. A flat list sorted by name forces you to match
 * a "Created by" value against a row somewhere else in the table; parent above
 * child answers it by position instead.
 */
function groupByCreator(rows) {
  // A partner is a heading, not a row. Listing them inside their creator's
  // group as well put the same account on screen twice - once as a client of
  // yours and again as the title of its own block - which is what made
  // "Your direct clients" look like it was showing partners.
  const isPartner = (u) => u.role === 'reseller';

  // An owner-created account belongs in the unkeyed "Your direct clients"
  // block. Keying it by the owner's id instead built a second group that
  // label() also titles "Your direct clients", so the heading appeared twice.
  const isOwner = (id) => !!id && usersCache.find(x => x.id === id)?.role === 'owner';
  const groupKey = (u) => {
    const key = u.createdBy?.id || '';
    return isOwner(key) ? '' : key;
  };

  const byId = new Map();
  const ensure = (key) => {
    if (!byId.has(key)) byId.set(key, { id: key, users: [], self: null });
    return byId.get(key);
  };
  for (const u of rows) {
    if (isPartner(u)) {
      // Give every partner its own block, even an empty one, so a partner you
      // just created does not disappear until they add their first client.
      // The partner is also kept as `self`: the heading carries no buttons, so
      // without a row of its own there was no way to credit, edit or disable
      // the partner account itself.
      ensure(u.id).self = u;
      continue;
    }
    ensure(groupKey(u)).users.push(u);
  }

  // A group is named and badged after the account that created it, looked up
  // in the full cache: u.createdBy carries no role, and the creator may be
  // filtered out of `rows` by the current search.
  const label = (key) => {
    const creator = key ? usersCache.find(x => x.id === key) : null;
    const role = creator ? creator.role : 'owner';
    // Accounts you created yourself are headed neutrally. Naming the owner
    // here served no purpose - you know who you are - and it put the owner's
    // identity on screen for no reason.
    if (!key || role === 'owner') return { label: 'Your direct clients', role: 'Direct' };
    return {
      label: creator ? (creator.name || creator.username)
        : (rows.find(r => r.createdBy?.id === key)?.createdBy?.name || 'Unknown'),
      role: 'Partner'
    };
  };

  // Walk parents before children so a reseller's users sit under the row that
  // introduced them, rather than in name order somewhere further down.
  const ordered = [];
  const seen = new Set();
  const take = (key) => {
    if (seen.has(key) || !byId.has(key)) return;
    seen.add(key);
    const g = byId.get(key);
    ordered.push({ ...g, ...label(key) });
    // Each partner created by this group heads the block that follows it.
    for (const p of rows) {
      if (isPartner(p) && groupKey(p) === key) take(p.id);
    }
  };

  // Roots first: a group whose creator is not itself listed here sits at the
  // top of the tree. Owner accounts are filtered out of the table, so their
  // group has no parent row above it and would otherwise land last.
  const isRoot = (key) => !key || !rows.some(r => r.id === key);
  // The direct-clients block comes first even when it is currently empty.
  ensure('');
  for (const key of byId.keys()) if (isRoot(key)) take(key);
  for (const key of byId.keys()) take(key);
  // The unkeyed block is ensured up front so it leads the list, but on the
  // Partner tab it has nothing in it and would render as an empty heading.
  return ordered.filter(g => g.id !== '' || g.users.length);
}

$('#uSearch').addEventListener('input', drawUsers);
$('#uSort')?.addEventListener('change', drawUsers);

$('#uToggleAll')?.addEventListener('click', () => {
  const heads = [...document.querySelectorAll('#userList .u-group')];
  if (!heads.length) return;
  // "Expand all" while any group is shut, otherwise collapse everything.
  const expand = heads.some(h => !h.classList.contains('is-open'));
  defaultOpen = false;
  const set = loadOpenGroups();
  for (const h of heads) {
    const key = h.dataset.owner || '__self';
    if (expand) set.add(key); else set.delete(key);
  }
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* private mode */ }
  drawUsers();
});

$('#userList').addEventListener('click', (e) => {
  const head = e.target.closest('.u-group');
  if (!head) return;
  toggleGroup(head.dataset.owner);
  drawUsers();
});

$('#userList').addEventListener('keydown', (e) => {
  const head = e.target.closest('.u-group');
  if (head && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    toggleGroup(head.dataset.owner);
    drawUsers();
    return;
  }
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.u-row.is-clickable');
  if (!row || e.target.closest('[data-act]')) return;
  e.preventDefault();
  const u = usersCache.find(x => x.id === row.dataset.id);
  if (u) openUserDetail(u);
});

/* ------------------------------ row actions ------------------------------ */
let openMenu = null;
const closeMenu = () => { openMenu?.remove(); openMenu = null; };
document.addEventListener('click', (e) => { if (!e.target.closest('.u-menu, [data-act="more"]')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// A drag across a row is a text selection, not a request to open the row.
let downAt = null;
$('#userList').addEventListener('mousedown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });

$('#userList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) {
    // Clicking the row itself opens the full view. Buttons are handled below
    // and stop here, so the action icons keep working.
    const row = e.target.closest('.u-row:not(.u-head)');
    if (!row?.dataset.id) return;
    const dragged = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
    if (dragged || String(getSelection()).trim()) return;
    if (e.target.closest('.u-selectable')) return;
    const target = usersCache.find(x => x.id === row.dataset.id);
    if (target) openUserDetail(target);
    return;
  }
  const u = usersCache.find(x => x.id === btn.closest('.u-row').dataset.id);
  if (btn.dataset.act === 'showpw') {
    const code = btn.parentElement.querySelector('.u-pw-val');
    const shown = code.textContent !== '••••••••';
    code.textContent = shown ? '••••••••' : code.dataset.pw;
    btn.title = shown ? 'Show password' : 'Hide password';
    btn.classList.toggle('is-on', !shown);
    return;
  }
  if (btn.dataset.act === 'copypw') return copyText(`${u.name && u.name !== u.username ? 'Client Name - ' + u.name + '\n' : ''}Portal Link - https://mailfinderpro.xyz/\nUsername - ${u.username}\nPassword - ${u.password}`, 'Login details');
  if (btn.dataset.act === 'edit') return openEdit(u);
  if (btn.dataset.act === 'reset') return resetPassword(u);
  if (btn.dataset.act === 'credits') return openCredits(u);
  if (btn.dataset.act === 'toggle') return toggleUser(u);
  if (btn.dataset.act === 'delete') return deleteUser(u);
  if (btn.dataset.act === 'more') {
    if (openMenu) return closeMenu();
    openMenu = document.createElement('div');
    openMenu.className = 'u-menu';
    openMenu.setAttribute('role', 'menu');
    openMenu.innerHTML = `
      <button type="button" role="menuitem" data-m="edit">${icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>')}Edit details</button>
      <button type="button" role="menuitem" data-m="reset">${icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 118 0v4"/>')}Reset password</button>
      <button type="button" role="menuitem" data-m="toggle">${u.disabled
        ? icon('<path d="M20 6L9 17l-5-5"/>') + 'Enable user'
        : icon('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>') + 'Disable user'}</button>
      <button type="button" role="menuitem" data-m="delete" class="danger">${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>')}Delete user</button>`;
    btn.closest('.u-actions').appendChild(openMenu);
    openMenu.querySelector('button').focus();
    openMenu.addEventListener('click', (ev) => {
      const m = ev.target.closest('[data-m]')?.dataset.m;
      closeMenu();
      if (m === 'edit') openEdit(u);
      if (m === 'reset') resetPassword(u);
      if (m === 'toggle') toggleUser(u);
      if (m === 'delete') deleteUser(u);
    });
  }
});

async function toggleUser(u) {
  if (!u.disabled) {
    const ok = await confirmDialog({
      title: `Disable ${u.name}?`,
      message: 'They are signed out now and cannot sign in until you enable them again. Their data is kept.',
      confirmText: 'Disable', tone: 'info'
    });
    if (!ok) return;
  }
  try {
    await api('PATCH', `/api/users/${u.id}`, { disabled: !u.disabled });
    toast(`${u.name} ${u.disabled ? 'enabled' : 'disabled'}`);
    renderUsersView();
  } catch (err) { toast(err.message, 'warn'); }
}

async function deleteUser(u) {
  const ok = await confirmDialog({
    title: `Delete ${u.name}?`,
    message: `@${u.username} will be permanently removed and signed out.${u.role === 'reseller' ? ' Users they created will move to you.' : ''} This cannot be undone.`,
    confirmText: 'Delete user'
  });
  if (!ok) return;
  try {
    await api('DELETE', `/api/users/${u.id}`);
    await window.refreshCredits?.();
    toast(`${u.name} deleted`);
    renderUsersView();
  } catch (err) { toast(err.message, 'warn'); }
}

function resetPassword(u) { openEdit(u, { focusPassword: true, fillPassword: true }); }

/* ------------------------------ credits dialog ------------------------------ */

/* ---------------------------- user detail view ---------------------------- */
/**
 * Everything known about one account in a single panel: its own numbers, and -
 * when it is a reseller - the users it created, what it handed out to them and
 * what they have left. The table row can only show a handful of columns, and
 * the ones that answer "how is this reseller actually doing" are the first to
 * be dropped on a narrow screen.
 */
function openUserDetail(u) {
  const prevFocus = document.activeElement;

  // Direct = accounts this user created. Downstream = everything below them,
  // which is what a reseller-of-resellers actually controls.
  const direct = usersCache.filter(x => x.createdBy?.id === u.id);
  const all = [];
  const walk = (id, depth) => {
    for (const c of usersCache.filter(x => x.createdBy?.id === id)) {
      all.push({ ...c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(u.id, 0);

  const sum = (list, key) => list.reduce((t, x) => t + (x[key] || 0), 0);
  const heldDownstream = sum(all.filter(x => x.credits !== null), 'credits');
  const checksDownstream = sum(all, 'checks');
  const activeCount = all.filter(x => !x.disabled).length;
  const isReseller = u.role === 'reseller' || direct.length > 0;

  const stat = (label, value, note = '') =>
    `<div class="ud-stat"><span>${label}</span><strong>${value}</strong>${note ? `<em>${note}</em>` : ''}</div>`;

  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal settings ud-modal" role="dialog" aria-modal="true" aria-labelledby="udTitle">
      <div class="settings-head">
        <h2 class="modal-title" id="udTitle">
          <span class="ud-av">${esc((u.name || u.username)[0].toUpperCase())}</span>
          ${esc(u.name)}
          <span class="u-role r-${u.role}">${ROLE_LABEL[u.role]}</span>
          ${u.disabled ? '<span class="u-role r-off">Disabled</span>' : ''}
        </h2>
        <button type="button" class="icon-x" data-close aria-label="Close">${icon('<path d="M18 6L6 18M6 6l12 12"/>')}</button>
      </div>
      <div class="settings-body ud-body">
        <div class="ud-grid">
          ${stat('Credits', u.credits === null ? '&infin;' : u.credits.toLocaleString(), u.credits === null ? 'unlimited' : '1 credit = 1 check')}
          ${stat('Checks run', u.checks.toLocaleString())}
          ${stat('Sign-ins', u.logins.toLocaleString())}
          ${stat('Last active', ago(u.lastActiveAt))}
        </div>

        <dl class="ud-meta">
          <div><dt>Username</dt><dd><code>${esc(u.username)}</code></dd></div>
          <div><dt>Created by</dt><dd>${u.createdBy ? esc(u.createdBy.name) : '&mdash;'}</dd></div>
          <div><dt>Created</dt><dd>${u.createdAt ? new Date(u.createdAt).toLocaleString() : '&mdash;'}</dd></div>
          <div><dt>Last sign-in</dt><dd>${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</dd></div>
        </dl>

        ${isReseller ? `
        <h3 class="ud-h">Their network</h3>
        <div class="ud-grid">
          ${stat('Direct users', direct.length.toLocaleString(), 'created by them')}
          ${stat('All downstream', all.length.toLocaleString(), 'including sub-resellers')}
          ${stat('Active', activeCount.toLocaleString(), `${all.length - activeCount} disabled`)}
          ${stat('Credits held below', heldDownstream.toLocaleString(), 'unspent by their users')}
          ${stat('Checks below', checksDownstream.toLocaleString(), 'run by their users')}
        </div>
        ${all.length ? `
        <h3 class="ud-h">All users under ${esc(u.name)}</h3>
        <div class="ud-list">
          <div class="ud-lrow ud-lhead"><span>User</span><span>Role</span><span>Credits</span><span>Checks</span><span>Last active</span></div>
          ${all.map(c => `
            <div class="ud-lrow${c.disabled ? ' is-off' : ''}" style="--d:${c.depth}"
                 data-drill="${c.id}" role="button" tabindex="0"
                 aria-label="Open ${esc(c.name)}">
              <span class="ud-lname">
                <b>${esc(c.name)}${c.disabled ? '<span class="ud-off">disabled</span>' : ''}</b>
                <em>@${esc(c.username)}</em>
              </span>
              <span><span class="u-role r-${c.role}">${ROLE_LABEL[c.role]}</span></span>
              <span class="ud-num${c.credits === 0 ? ' is-empty' : ''}">${c.credits === null ? '&infin;' : c.credits.toLocaleString()}</span>
              <span class="ud-num">${c.checks.toLocaleString()}</span>
              <span class="ud-ago">${ago(c.lastActiveAt)}</span>
              <span class="ud-go">${icon('<path d="M9 6l6 6-6 6"/>')}</span>
            </div>`).join('')}
          <div class="ud-lrow ud-lfoot">
            <span>Total</span>
            <span></span>
            <span class="ud-num">${all.filter(c => c.credits !== null).reduce((t, c) => t + (c.credits || 0), 0).toLocaleString()}</span>
            <span class="ud-num">${checksDownstream.toLocaleString()}</span>
            <span></span><span></span>
          </div>
        </div>` : '<p class="muted">They have not created any users yet.</p>'}` : ''}
      </div>
      <div class="modal-actions settings-actions">
        <span style="flex:1"></span>
        <button type="button" class="tbtn" data-close>Close</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  wrap.querySelector('[data-close]').focus();

  const close = () => {
    wrap.classList.remove('is-open');
    setTimeout(() => wrap.remove(), 160);
    document.removeEventListener('keydown', onKey);
    prevFocus?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const drill = (row) => {
    const next = usersCache.find(x => x.id === row.dataset.drill);
    if (!next) return;
    close();
    setTimeout(() => openUserDetail(next), 120);
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) return close();
    const row = e.target.closest('[data-drill]');
    if (row) drill(row);
  });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-drill]');
    if (!row) return;
    e.preventDefault();
    drill(row);
  });
}

function openCredits(u) {
  const prevFocus = document.activeElement;
  const mine = window.currentUser?.credits;           // null = owner, unlimited
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="cTitle">
      <div class="settings-head">
        <h2 class="modal-title" id="cTitle">Credits for ${esc(u.name)}</h2>
        <button type="button" class="icon-x" data-close aria-label="Close">${icon('<path d="M18 6L6 18M6 6l12 12"/>')}</button>
      </div>
      <form class="settings-body uf-body" id="creditForm" novalidate>
        <div class="c-balance">
          <span>Current balance</span>
          <strong>${u.credits.toLocaleString()} credits</strong>
          <em>1 credit = 1 email check</em>
        </div>
        <div class="seg c-mode">
          <label class="seg-opt"><input type="radio" name="cmode" value="add" checked><span><b>Add</b></span></label>
          <label class="seg-opt"><input type="radio" name="cmode" value="remove"><span><b>Remove</b></span></label>
        </div>
        <label class="uf-fld">Amount
          <input id="cAmount" type="number" min="1" step="100" placeholder="e.g. 1000" inputmode="numeric">
        </label>
        <div class="c-quick">${[1000, 5000, 10000, 50000].map(n => `<button type="button" class="tbtn tbtn-sm" data-q="${n}">+${n.toLocaleString()}</button>`).join('')}</div>
        <p class="c-preview" id="cPreview">Enter an amount.</p>
        ${mine !== null && mine !== undefined ? `<p class="uf-hint">Credits you give come from your balance: <b>${mine.toLocaleString()}</b> available.</p>` : ''}
        <p class="uf-msg" id="cMsg" role="alert" hidden></p>
      </form>
      <div class="modal-actions settings-actions">
        <span style="flex:1"></span>
        <button type="button" class="tbtn" data-close>Cancel</button>
        <button type="submit" form="creditForm" class="tbtn tbtn-primary" id="cSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  const amountIn = wrap.querySelector('#cAmount');
  amountIn.focus();

  const mode = () => wrap.querySelector('input[name="cmode"]:checked').value;
  const update = () => {
    const n = Math.trunc(Number(amountIn.value) || 0);
    const next = mode() === 'add' ? u.credits + n : u.credits - n;
    wrap.querySelector('#cPreview').innerHTML = n > 0
      ? `${mode() === 'add' ? 'Add' : 'Remove'} <b>${n.toLocaleString()}</b> credits → new balance <b>${Math.max(0, next).toLocaleString()}</b>`
      : 'Enter an amount.';
    wrap.querySelector('#cSave').textContent = mode() === 'add' ? 'Add credits' : 'Remove credits';
  };
  amountIn.addEventListener('input', update);
  wrap.querySelectorAll('input[name="cmode"]').forEach(r => r.addEventListener('change', update));
  wrap.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => {
    amountIn.value = (Math.trunc(Number(amountIn.value) || 0)) + Number(b.dataset.q);
    update();
  }));
  update();

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

  wrap.querySelector('#creditForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = Math.trunc(Number(amountIn.value) || 0);
    const msg = wrap.querySelector('#cMsg');
    if (n <= 0) { msg.textContent = 'Enter a number of credits.'; msg.className = 'uf-msg m-bad'; msg.hidden = false; return; }
    try {
      const data = await api('POST', `/api/users/${u.id}/credits`, { amount: mode() === 'add' ? n : -n });
      close();
      toast(`${mode() === 'add' ? 'Added' : 'Removed'} ${n.toLocaleString()} credits · ${data.user.name} now has ${data.user.credits.toLocaleString()}`);
      window.refreshCredits?.();
      renderUsersView();
    } catch (err) { msg.textContent = err.message; msg.className = 'uf-msg m-bad'; msg.hidden = false; }
  });
}

/* ------------------------------ edit dialog ------------------------------ */
function openEdit(u, { focusPassword = false, fillPassword = false } = {}) {
  const prevFocus = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="eTitle">
      <div class="settings-head">
        <h2 class="modal-title" id="eTitle">Edit ${esc(u.name)}</h2>
        <button type="button" class="icon-x" data-close aria-label="Close">${icon('<path d="M18 6L6 18M6 6l12 12"/>')}</button>
      </div>
      <form class="settings-body uf-body" id="editForm" novalidate>
        <label class="uf-fld">Client name
          <input id="eName" type="text" maxlength="80" value="${esc(u.name)}">
        </label>
        <label class="uf-fld">Username
          <input type="text" value="${esc(u.username)}" disabled>
        </label>
        <label class="uf-fld">New password <span class="uf-hint">Leave empty to keep the current one</span>
          <span class="uf-pw">
            <input id="ePass" type="text" placeholder="At least 8 characters" value="${fillPassword ? genPassword() : ''}" autocomplete="new-password">
            <button type="button" class="tbtn tbtn-sm gen-btn" data-gen="pass" data-target="ePass" title="Generate password" aria-label="Generate password"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 11-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
            <button type="button" class="tbtn tbtn-sm" data-copy="ePass" title="Copy password">Copy</button>
          </span>
        </label>
        ${canMakeResellers ? `
        <label class="switch uf-reseller">
          <input type="checkbox" id="eReseller" ${u.role === 'reseller' ? 'checked' : ''}>
          <span class="switch-ui" aria-hidden="true"></span>
          <span><b>Reseller</b><em>Can create and manage their own users</em></span>
        </label>` : ''}
        ${myRole === 'owner' ? `
        <label class="switch uf-reseller" id="eSubWrap" ${u.role === 'reseller' ? '' : 'hidden'}>
          <input type="checkbox" id="eSubRes" ${u.canCreateResellers ? 'checked' : ''}>
          <span class="switch-ui" aria-hidden="true"></span>
          <span><b>Can create resellers</b><em>This reseller can make their own resellers</em></span>
        </label>` : ''}
        <label class="switch uf-reseller">
          <input type="checkbox" id="eActive" ${u.disabled ? '' : 'checked'}>
          <span class="switch-ui" aria-hidden="true"></span>
          <span><b>Active</b><em>Turn off to block sign-in</em></span>
        </label>
        <div class="u-stats">
          <div><span>Checks</span><strong>${u.checks.toLocaleString()}</strong></div>
          <div><span>Sign-ins</span><strong>${u.logins}</strong></div>
          <div><span>Last active</span><strong>${ago(u.lastActiveAt)}</strong></div>
        </div>
        <p class="uf-msg" id="eMsg" role="alert" hidden></p>
      </form>
      <div class="modal-actions settings-actions">
        <span style="flex:1"></span>
        <button type="button" class="tbtn" data-close>Cancel</button>
        <button type="submit" form="editForm" class="tbtn tbtn-primary">Save changes</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  (focusPassword ? wrap.querySelector('#ePass') : wrap.querySelector('#eName')).focus();
  const eRes = wrap.querySelector('#eReseller'), eSub = wrap.querySelector('#eSubWrap');
  if (eRes && eSub) eRes.addEventListener('change', () => {
    eSub.hidden = !eRes.checked;
    if (!eRes.checked) wrap.querySelector('#eSubRes').checked = false;
  });

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

  wrap.querySelector('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = wrap.querySelector('#eMsg');
    const password = wrap.querySelector('#ePass').value;
    if (password && password.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; msg.className = 'uf-msg m-bad'; msg.hidden = false; return; }
    const body = { name: wrap.querySelector('#eName').value.trim(), disabled: !wrap.querySelector('#eActive').checked };
    if (password) body.password = password;
    const rs = wrap.querySelector('#eReseller');
    if (rs) body.reseller = rs.checked;
    const sub = wrap.querySelector('#eSubRes');
    if (sub) body.canCreateResellers = !!(rs?.checked && sub.checked);
    try {
      await api('PATCH', `/api/users/${u.id}`, body);
      close();
      toast(password ? `Saved. New password for @${u.username} is set.` : 'Changes saved');
      renderUsersView();
    } catch (err) { msg.textContent = err.message; msg.className = 'uf-msg m-bad'; msg.hidden = false; }
  });
}

/* ------------------------------ create ------------------------------ */
// "Can create resellers" only appears for the owner, once Reseller is on.
function syncSubToggle() {
  const show = myRole === 'owner' && $('#ufReseller').checked;
  $('#ufSubResWrap').hidden = !show;
  if (!show) $('#ufSubRes').checked = false;
}
$('#ufReseller').addEventListener('change', syncSubToggle);

function ufMessage(text, tone) {
  const m = $('#ufMsg');
  m.textContent = text;
  m.className = `uf-msg m-${tone}`;
  m.hidden = !text;
}

$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#ufUser').value.trim().toLowerCase();
  const password = $('#ufPass').value;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) return ufMessage('Username must be 3–32 letters, numbers, dots, dashes or underscores.', 'bad');
  if (password.length < 8) return ufMessage('Password must be at least 8 characters.', 'bad');

  const btn = $('#ufSubmit');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/users', {
      name: $('#ufName').value.trim(), username, password,
      credits: Number($('#ufCredits').value) || 0,
      reseller: canMakeResellers && $('#ufReseller').checked,
      canCreateResellers: myRole === 'owner' && $('#ufReseller').checked && $('#ufSubRes').checked
    });
    // Show the new login so it can be shared; the password cannot be shown again later.
    const m = $('#ufMsg');
    m.className = 'uf-msg m-ok uf-created';
    m.hidden = false;
    m.innerHTML = `
      <span class="uc-title">✓ ${data.user.role === 'reseller' ? 'Reseller' : 'User'} created — save these details now</span>
      <span class="uc-cred"><em>Username</em><code>${esc(data.user.username)}</code></span>
      <span class="uc-cred"><em>Password</em><code>${esc(password)}</code></span>
      <button type="button" class="tbtn tbtn-sm uf-copy-login" data-copy-login data-name="${esc(data.user.name && data.user.name !== data.user.username ? data.user.name : '')}" data-user="${esc(data.user.username)}" data-pass="${esc(password)}">Copy username & password</button>`;
    $('#ufName').value = ''; $('#ufUser').value = ''; $('#ufPass').value = ''; $('#ufCredits').value = ''; $('#ufReseller').checked = false; syncSubToggle();
    window.refreshCredits?.();
    toast(`User @${data.user.username} created`);
    renderUsersView();
  } catch (err) {
    ufMessage(err.message, 'bad');
  } finally {
    btn.disabled = false;
  }
});

window.renderUsersView = renderUsersView;
if (location.pathname.replace(/\/+$/, '') === '/users') renderUsersView();
