/* ============================================================
   Login page: live validation showcase + sign in / create account.
   ============================================================ */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------ theme ------------------------------ */
$('#themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('theme', next); } catch {}
});

/* ------------------------------ showcase stream ------------------------------ */
// A looping demo of what the product does: each card is "checked", then accepted or rejected.
const DEMO = [
  { email: 'anna@northwind.com',   verdict: 'valid',   note: 'Mailbox exists' },
  { email: 'temp4821@mailinator.com', verdict: 'invalid', note: 'Throwaway address' },
  { email: 'james@gmial.com',      verdict: 'fixed',   note: 'Did you mean gmail.com?' },
  { email: 'sofia@brightlabs.io',  verdict: 'valid',   note: 'Mailbox exists' },
  { email: 'sales@@acme',          verdict: 'invalid', note: 'Not a valid format' },
  { email: 'info@catchall.dev',    verdict: 'risky',   note: 'Accepts any address' },
  { email: 'li.wei@outlook.com',   verdict: 'valid',   note: 'Mailbox exists' },
  { email: 'noreply@oldcorp.biz',  verdict: 'invalid', note: 'Domain has no mail server' },
  { email: 'maria@yahooo.com',     verdict: 'fixed',   note: 'Did you mean yahoo.com?' },
  { email: 'ops@helix.app',        verdict: 'valid',   note: 'Mailbox exists' }
];
const LABEL = { valid: 'Accepted', invalid: 'Rejected', risky: 'Risky', fixed: 'Typo' };
const ICON = {
  valid:   '<path d="M20 6L9 17l-5-5"/>',
  invalid: '<path d="M18 6L6 18M6 6l12 12"/>',
  risky:   '<path d="M12 8v5m0 3h.01"/>',
  fixed:   '<path d="M4 20h4L19 9l-4-4L4 16v4z"/>'
};
const stream = $('#stream');
const stats = { valid: 1284, invalid: 312, fixed: 57 };
const MAX_CARDS = 4;
let demoIdx = 0;

function renderStats(animate) {
  const set = (id, n) => {
    const el = $(id);
    el.textContent = n.toLocaleString();
    if (animate) { el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick'); }
  };
  set('#statValid', stats.valid);
  set('#statRejected', stats.invalid);
  set('#statFixed', stats.fixed);
}

function nextCard() {
  const d = DEMO[demoIdx++ % DEMO.length];
  const card = document.createElement('div');
  card.className = 'sc is-checking';
  card.innerHTML = `
    <span class="sc-av">${esc(d.email[0].toUpperCase())}</span>
    <span class="sc-main">
      <span class="sc-email">${esc(d.email)}</span>
      <span class="sc-note"><span class="sc-scan">Checking…</span><span class="sc-res">${esc(d.note)}</span></span>
    </span>
    <span class="sc-pill p-${d.verdict}">
      <span class="sc-spin"></span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICON[d.verdict]}</svg>
      <b>${LABEL[d.verdict]}</b>
    </span>
    <span class="sc-bar"><i></i></span>`;
  stream.prepend(card);

  // Keep the stack short: fade out the oldest.
  const cards = stream.querySelectorAll('.sc');
  if (cards.length > MAX_CARDS) {
    const old = cards[cards.length - 1];
    old.classList.add('is-leaving');
    setTimeout(() => old.remove(), 520);
  }

  setTimeout(() => {
    card.classList.remove('is-checking');
    card.classList.add(`is-${d.verdict}`);
    if (d.verdict === 'valid') stats.valid++;
    else if (d.verdict === 'fixed') stats.fixed++;
    else if (d.verdict === 'invalid') stats.invalid++;
    renderStats(true);
  }, reduceMotion ? 0 : 1100);
}

renderStats(false);
if (reduceMotion) { for (let i = 0; i < MAX_CARDS; i++) nextCard(); }
else {
  nextCard();
  setInterval(() => { if (!document.hidden) nextCard(); }, 2100);
}

/* ------------------------------ form ------------------------------ */
const form = $('#authForm');
const emailIn = $('#email'), pwIn = $('#password');
const alertEl = $('#authAlert');
const submit = $('#authSubmit');

/* ---- live email check: the product, on its own login ---- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const COMMON = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me', 'aol.com', 'live.com'];
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function typoFix(email) {
  const [local, domain] = email.toLowerCase().split('@');
  if (!domain || COMMON.includes(domain)) return null;
  const best = COMMON.map(c => [c, lev(domain, c)]).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] > 0 && best[1] <= 2 ? `${local}@${best[0]}` : null;
}

function setHint(el, html, tone = '') {
  el.innerHTML = html;
  el.className = `fld-hint${tone ? ' h-' + tone : ''}`;
}

let emailTimer;
function checkEmail(final = false) {
  const field = $('#emailField');
  const v = emailIn.value.trim();
  field.classList.remove('is-ok', 'is-bad', 'is-warn');
  if (!v) { setHint($('#emailHint'), ''); return false; }
  // A plain username (no @) is fine too.
  if (!v.includes('@') && /^[A-Za-z0-9._-]{3,32}$/.test(v)) { field.classList.add('is-ok'); setHint($('#emailHint'), ''); return true; }
  if (!EMAIL_RE.test(v)) {
    if (final || v.includes('@')) {
      field.classList.add('is-bad');
      setHint($('#emailHint'), 'Enter a valid email or username', 'bad');
    } else setHint($('#emailHint'), '');
    return false;
  }
  const fix = typoFix(v);
  if (fix) {
    field.classList.add('is-warn');
    setHint($('#emailHint'), `Did you mean <button type="button" class="link-btn" id="useFix">${esc(fix)}</button>?`, 'warn');
    $('#useFix').addEventListener('click', () => { emailIn.value = fix; checkEmail(true); pwIn.focus(); });
    return true;
  }
  field.classList.add('is-ok');
  setHint($('#emailHint'), '');
  return true;
}
emailIn.addEventListener('input', () => { clearTimeout(emailTimer); emailTimer = setTimeout(() => checkEmail(false), 350); hideAlert(); });
emailIn.addEventListener('blur', () => checkEmail(true));

/* ---- password ---- */
$('#pwToggle').addEventListener('click', () => {
  const show = pwIn.type === 'password';
  pwIn.type = show ? 'text' : 'password';
  $('#pwToggle').setAttribute('aria-pressed', String(show));
  $('#pwToggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  pwIn.focus();
});

pwIn.addEventListener('input', hideAlert);

$('#forgotBtn').addEventListener('click', () =>
  showAlert('Ask the owner to reset your password.', 'info'));

/* ---- alerts ---- */
function showAlert(msg, tone = 'bad') {
  alertEl.textContent = msg;
  alertEl.className = `auth-alert a-${tone}`;
  alertEl.hidden = false;
  if (tone === 'bad') {
    const card = document.querySelector('.auth-card');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  }
}
function hideAlert() { alertEl.hidden = true; }

/* ---- submit ---- */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert();
  const emailOk = checkEmail(true);
  if (!emailOk) { emailIn.focus(); return showAlert('Enter your email or username.'); }
  if (!pwIn.value) { pwIn.focus(); return showAlert('Enter your password.'); }

  submit.classList.add('is-loading');
  submit.disabled = true;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: emailIn.value.trim(),
        password: pwIn.value,
        remember: $('#remember').checked
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

    submit.classList.remove('is-loading');
    submit.classList.add('is-done');
    $('#submitLabel').textContent = 'Signed in';
    setTimeout(() => location.replace('/'), reduceMotion ? 0 : 700);
  } catch (err) {
    submit.classList.remove('is-loading');
    submit.disabled = false;
    showAlert(err.message);
    if (/email or password/i.test(err.message)) { pwIn.select(); }
  }
});
