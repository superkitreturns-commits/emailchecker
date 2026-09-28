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
const ROLE_LABEL = { owner: 'Owner', reseller: 'Reseller', user: 'User' };

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
    return copyText(`Username: ${b.dataset.user}\nPassword: ${b.dataset.pass}`, 'Login details');
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

function drawUsers() {
  const q = $('#uSearch').value.trim().toLowerCase();
  const rows = usersCache.filter(u => !q || `${u.name} ${u.username} ${u.createdBy?.name || ''}`.toLowerCase().includes(q));
  const list = $('#userList');
  if (!usersCache.length) {
    list.innerHTML = `<div class="up-empty">${icon('<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0114 0"/><path d="M19 8v6M22 11h-6"/>')}<p>No users yet</p><span>Users you create appear here with their activity.</span></div>`;
    return;
  }
  list.innerHTML = `
    <div class="u-row u-head${myRole === 'owner' ? ' with-by' : ''}">
      <span></span><span>Client</span><span class="h-pw">Password</span><span>Role</span>${myRole === 'owner' ? '<span class="h-by">Created by</span>' : ''}<span>Credits</span><span class="h-num">Checks</span><span class="h-date">Last active</span><span class="u-head-act">Actions</span>
    </div>
    ${rows.map(u => `
    <div class="u-row${myRole === 'owner' ? ' with-by' : ''}${u.disabled ? ' is-disabled' : ''}" data-id="${u.id}">
      <span class="user-av">${esc((u.name || u.username)[0].toUpperCase())}</span>
      <span class="u-main"><strong>${esc(u.name && u.name !== u.username ? u.name : u.username)}</strong>${u.name && u.name !== u.username ? `<span>@${esc(u.username)}</span>` : ''}</span>
      <span class="u-pw">${u.password
        ? `<code class="u-pw-val" data-pw="${esc(u.password)}">••••••••</code>
           <button type="button" class="u-mini" data-act="showpw" title="Show password" aria-label="Show password">${icon('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>')}</button>
           <button type="button" class="u-mini" data-act="copypw" title="Copy username & password" aria-label="Copy login">${icon('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>')}</button>`
        : `<span class="u-pw-none" title="${u.role === 'owner' ? 'Owner passwords are never shown' : 'Set a new password to be able to view it'}">—</span>`}</span>
      <span><span class="u-role r-${u.role}"${u.canCreateResellers ? ' title="Can create resellers"' : ''}>${ROLE_LABEL[u.role]}${u.canCreateResellers ? ' +' : ''}</span>${u.disabled ? '<span class="u-role r-off">Disabled</span>' : ''}</span>
      ${myRole === 'owner' ? `<span class="u-by">${u.createdBy ? esc(u.createdBy.name) : '—'}</span>` : ''}
      <span class="u-credits${u.credits === 0 ? ' is-empty' : ''}">${u.credits === null ? '∞' : u.credits.toLocaleString()}</span>
      <span class="u-num" title="${u.logins} sign-in${u.logins === 1 ? '' : 's'}">${u.checks.toLocaleString()}</span>
      <span class="u-date" title="Last sign-in: ${u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}">${ago(u.lastActiveAt)}</span>
      <span class="u-actions">
        ${u.role === 'owner' ? '<span class="u-locked">Protected</span>' : `
        <button type="button" class="u-act u-act-credit" data-act="credits" title="Add or remove credits">${icon('<path d="M12 5v14M5 12h14"/>')}<span>Credits</span></button>
        <button type="button" class="u-act" data-act="edit" title="Edit">${icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>')}<span>Edit</span></button>
        <button type="button" class="u-act" data-act="reset" title="Reset password">${icon('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 118 0v4"/>')}<span>Password</span></button>
        <button type="button" class="u-act" data-act="toggle" title="${u.disabled ? 'Enable' : 'Disable'} user">${u.disabled
          ? icon('<path d="M20 6L9 17l-5-5"/>') + '<span>Enable</span>'
          : icon('<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>') + '<span>Disable</span>'}</button>
        <button type="button" class="u-act danger" data-act="delete" title="Delete user" aria-label="Delete ${esc(u.name)}">${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>')}</button>`}
      </span>
    </div>`).join('') || '<p class="muted pad">No users match your search.</p>'}`;
}

$('#uSearch').addEventListener('input', drawUsers);

/* ------------------------------ row actions ------------------------------ */
let openMenu = null;
const closeMenu = () => { openMenu?.remove(); openMenu = null; };
document.addEventListener('click', (e) => { if (!e.target.closest('.u-menu, [data-act="more"]')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

$('#userList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const u = usersCache.find(x => x.id === btn.closest('.u-row').dataset.id);
  if (btn.dataset.act === 'showpw') {
    const code = btn.parentElement.querySelector('.u-pw-val');
    const shown = code.textContent !== '••••••••';
    code.textContent = shown ? '••••••••' : code.dataset.pw;
    btn.title = shown ? 'Show password' : 'Hide password';
    btn.classList.toggle('is-on', !shown);
    return;
  }
  if (btn.dataset.act === 'copypw') return copyText(`Username: ${u.username}\nPassword: ${u.password}`, 'Login details');
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
    toast(`${u.name} deleted`);
    renderUsersView();
  } catch (err) { toast(err.message, 'warn'); }
}

function resetPassword(u) { openEdit(u, { focusPassword: true, fillPassword: true }); }

/* ------------------------------ credits dialog ------------------------------ */
const money = (credits) => `$${((credits / 1000) * (window.PRICE_PER_1000 || 0.1)).toFixed(credits < 10000 ? 3 : 2)}`;

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
          <em>worth ${money(u.credits)} · 1 credit = 1 email check</em>
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
        <span class="muted">$0.10 per 1,000 credits</span>
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
      ? `${mode() === 'add' ? 'Add' : 'Remove'} <b>${n.toLocaleString()}</b> credits (${money(n)}) → new balance <b>${Math.max(0, next).toLocaleString()}</b>`
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
      <button type="button" class="tbtn tbtn-sm uf-copy-login" data-copy-login data-user="${esc(data.user.username)}" data-pass="${esc(password)}">Copy username & password</button>`;
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
if (location.hash === '#users') renderUsersView();
