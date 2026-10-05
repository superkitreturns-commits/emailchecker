/* ============================================================
   IP Server (owner only). Rent a cheap instance, point SMTP
   checks at it once it boots, deactivate or destroy it when done.
   Relies on $, esc, icon, toast, confirmDialog (app/analytics).
   ============================================================ */

async function vapi(method, url, body) {
  const res = await fetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const STATE_LABEL = {
  booting: 'Booting', loading: 'Booting', running: 'Running', active: 'Running',
  attached: 'Attached', unknown: 'Unknown', exited: 'Stopped', stopped: 'Stopped',
  'port25-blocked': 'Cannot send mail'
};
const STOPPED_STATES = new Set(['stopped', 'exited']);

/**
 * Whether the box is CHECKING is decided by the live pool, never by the stored
 * state string. Two writers share that string - the pool marks it 'active',
 * and a status refresh overwrites it with vast.ai's own 'running' - so a row
 * read from it flipped between the two and claimed idle boxes were checking.
 */
function vastRow(inst, isActive) {
  const ready = Boolean(inst.ip && inst.port);
  const stopped = STOPPED_STATES.has(inst.state);
  const label = isActive
    ? 'Active (checking emails)'
    : (STATE_LABEL[inst.state] || inst.state || 'Unknown');
  return `
    <div class="vast-row" data-id="${esc(inst.id)}">
      <span class="u-main"><strong>#${esc(inst.id)}</strong>${inst.gpuName ? `<span>${esc(inst.gpuName)}</span>` : ''}</span>
      <span class="u-role-cell"><span class="u-role ${isActive ? 'r-owner' : stopped ? 'r-off' : 'r-user'}">${label}</span></span>
      <span class="u-num">${inst.dph != null ? `$${Number(inst.dph).toFixed(3)}/hr` : '—'}</span>
      <span class="u-date">${ready && !stopped ? `${esc(inst.ip)}:${esc(String(inst.port))}` : stopped ? 'stopped' : 'not reachable yet'}</span>
      <span class="u-actions">
        <button type="button" class="u-act" data-act="refresh" title="Refresh status">${icon('<path d="M21 12a9 9 0 11-2.64-6.36"/><path d="M21 3v6h-6"/>')}<span>Refresh</span></button>
        ${isActive
          ? `<button type="button" class="u-act" data-act="deactivate" title="Stop sending checks to this box (the others keep checking)">${icon('<path d="M18 6L6 18M6 6l12 12"/>')}<span>Deactivate</span></button>`
          : `<button type="button" class="u-act u-act-credit" data-act="activate" title="Send SMTP checks to this instance" ${ready && !stopped ? '' : 'disabled'}>${icon('<path d="M20 6L9 17l-5-5"/>')}<span>Activate</span></button>`}
        ${stopped
          ? `<button type="button" class="u-act" data-act="start" title="Resume billing and boot the worker again">${icon('<path d="M5 3l14 9-14 9V3z"/>')}<span>Start</span></button>`
          : `<button type="button" class="u-act" data-act="stop" title="Pause compute billing without losing the instance">${icon('<rect x="6" y="6" width="12" height="12"/>')}<span>Stop</span></button>`}
        <button type="button" class="u-act danger" data-act="destroy" title="Destroy this instance">${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>')}<span>Destroy</span></button>
      </span>
    </div>`;
}

async function renderVastView() {
  const body = $('#vastBody');
  body.innerHTML = `<p class="muted pad">Loading…</p>`;
  let data, summary;
  try {
    [data, summary] = await Promise.all([
      vapi('GET', '/api/admin/vast'),
      vapi('GET', '/api/admin/vast/summary')
    ]);
  } catch (err) { body.innerHTML = `<p class="muted pad">${esc(err.message)}</p>`; return; }

  const headHtml = `
    <div class="vast-row vast-head">
      <span>Instance</span><span>Status</span><span>Cost</span><span>Address</span><span class="vast-head-act">Actions</span>
    </div>`;

  const statusLine = data.enabled
    ? `<span class="u-role r-owner">IP Server connected</span>`
    : `<span class="u-role r-off">VAST_API_KEY not set</span>`;
  // Names every box carrying checks, not just the first: the pool is what sets
  // the probe rate, so "running on #X" alone hid the other boxes being paid for.
  const activeList = data.activeWorkerIds || [];
  const activeLine = activeList.length
    ? `Checks are running on ${activeList.length} IP Server${activeList.length > 1 ? 's' : ''}: ${activeList.map(id => `#${esc(id)}`).join(', ')}`
    : `Checks are running on the default OVH worker${data.ovhUrl ? '' : ' (not configured)'}`;

  const fmtMin = (m) => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;

  // The live pool: the only trustworthy answer to "is this box checking?".
  const activeIds = new Set(data.activeWorkerIds || []);
  // Offer Activate for a box that is NOT already in the pool, so the button
  // keeps adding boxes instead of re-activating the one already serving.
  const readyInstance = data.instances.find(i => i.ip && i.port && !STOPPED_STATES.has(i.state) && !activeIds.has(i.id))
    || data.instances.find(i => i.ip && i.port && !STOPPED_STATES.has(i.state));
  // Whatever is burning money right now, so Stop is reachable without having
  // to find the row: the active instance first, else any one still running.
  const runningInstance = data.instances.find(i => i.id === data.activeInstanceId && !STOPPED_STATES.has(i.state))
    || data.instances.find(i => !STOPPED_STATES.has(i.state));
  const canEnable = Boolean(readyInstance || data.activeInstanceId);
  const toggleOn = Boolean(data.useIpServer);

  body.innerHTML = `
    <div class="panel-card" style="margin-bottom:16px">
      <div class="panel-card-head">
        <h3>Status</h3>
        ${statusLine}
      </div>
      <div class="uf-body" style="padding:0 20px 20px">
        <label class="switch uf-reseller" style="margin-bottom:12px">
          <input type="checkbox" id="vastMasterToggle" ${toggleOn ? 'checked' : ''}>
          <span class="switch-ui" aria-hidden="true"></span>
          <span><b>Use IP Server for checks</b><em>On = IP Server · Off = default OVH worker${toggleOn && !canEnable ? ' · launch or attach an instance to actually route traffic' : ''}</em></span>
        </label>
        <p class="muted">${activeLine}</p>
        ${data.activeInstanceId ? `<p class="muted" id="vastLiveLine" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="log-dot" aria-hidden="true"></span> Checking live: <strong id="vastLiveCount">…</strong> emails so far
          <span id="vastLiveLast"></span>
          <span id="vastPort25" class="p25 is-testing" title="Whether this box can open outbound connections on port 25">Port 25: testing…</span>
        </p>` : ''}
        <div id="vastPort25Grid" class="p25-grid" aria-label="Outbound port 25 reachability by provider"></div>
        <p class="muted" id="vastPort25Line"></p>
        <div class="u-summary">
          <div><span>Today</span><strong>${fmtMin(summary.today.minutes)}</strong></div>
          <div><span>Today's cost</span><strong>$${summary.today.costUsd.toFixed(2)}</strong></div>
          <div><span>All-time runtime</span><strong>${fmtMin(summary.total.minutes)}</strong></div>
          <div><span>All-time cost</span><strong>$${summary.total.costUsd.toFixed(2)}</strong></div>
        </div>
        <form id="vastPreferredForm" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:14px">
          <label class="uf-fld" style="flex:1;min-width:200px">Pin host IDs (in priority order) <span class="uf-hint">Optional - one "Host: NNNNN" per line. Tries them top to bottom, then falls back to cheapest. Leave empty to always auto-pick cheapest.</span>
            <textarea id="vastPreferredId" rows="3" placeholder="e.g.\n394586\n269961" style="resize:vertical;font-family:inherit">${esc((data.preferredHostIds || []).join('\n'))}</textarea>
          </label>
          <button type="submit" class="tbtn">Save</button>
        </form>
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
          <button type="button" class="btn-primary" id="vastLaunch" ${data.enabled ? '' : 'disabled'}>${(data.preferredHostIds && data.preferredHostIds.length) ? `Launch from host #${esc(data.preferredHostIds[0])}` : 'Launch cheapest instance'}</button>
          <button type="button" class="tbtn" id="vastActivateBtn" ${readyInstance ? '' : 'disabled'}>Activate${readyInstance ? ` #${esc(readyInstance.id)}` : ''}</button>
          <button type="button" class="tbtn" id="vastDeactivateBtn" ${data.activeInstanceId ? '' : 'disabled'}>Deactivate</button>
          <button type="button" class="tbtn" id="vastStopBtn" ${runningInstance ? '' : 'disabled'} title="Pause compute billing without losing the instance">Stop${runningInstance ? ` #${esc(runningInstance.id)}` : ''}</button>
          <button type="button" class="tbtn tbtn-danger" id="vastDestroyBtn" ${runningInstance ? '' : 'disabled'} title="Destroy the instance and stop billing for good">Destroy${runningInstance ? ` #${esc(runningInstance.id)}` : ''}</button>
          <button type="button" class="tbtn" id="vastPort25Btn" title="Dial the big mail providers on port 25 from whichever box is serving checks">Test port 25</button>
        </div>
      </div>
    </div>

    <div class="panel-card">
      <div class="panel-card-head"><h3>Instances</h3></div>
      <div id="vastList">
        ${data.instances.length
          ? headHtml + data.instances.map(i => vastRow(i, activeIds.has(i.id))).join('')
          : `<p class="muted pad">No instances yet. Launch one above, or attach one you already created elsewhere.</p>`}
      </div>
    </div>`;

  $('#vastMasterToggle')?.addEventListener('change', async (e) => {
    const toggle = e.target;
    const wantOn = toggle.checked;
    toggle.disabled = true;
    try {
      await vapi('POST', '/api/admin/vast/use', { on: wantOn });
    } catch (err) {
      toast(err.message, 'warn');
      toggle.checked = !wantOn;
      toggle.disabled = false;
      return;
    }
    if (!wantOn) {
      try { await vapi('POST', '/api/admin/vast/deactivate'); } catch {}
      toast('Checks switched back to the OVH worker');
      return renderVastView();
    }
    const target = readyInstance || data.instances.find(i => activeIds.has(i.id));
    if (target) {
      if (!activeIds.has(target.id)) {
        try { await vapi('POST', `/api/admin/vast/${target.id}/activate`); }
        catch (err) { toast(err.message, 'warn'); }
      }
      toast('Checks now run on the IP Server');
      return renderVastView();
    }
    // Switching the toggle on does NOT rent anything. It arms the auto-rent:
    // the next run big enough to cross the threshold is what rents a box, and
    // checks move to it once its worker answers. Renting here meant flipping
    // the switch started billing immediately with no work to do.
    toast('IP Server armed - the next big run will rent a box automatically');
    renderVastView();
  });

  $('#vastPreferredForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const hostIds = $('#vastPreferredId').value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    try {
      const { preferredHostIds } = await vapi('POST', '/api/admin/vast/preferred-host', { hostIds });
      const saved = preferredHostIds || [];
      toast(saved.length ? `Will try hosts ${saved.map(h => `#${h}`).join(', ')} in order, then cheapest` : 'Back to auto-picking the cheapest offer');
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); }
  });

  $('#vastActivateBtn')?.addEventListener('click', async () => {
    if (!readyInstance) return;
    try {
      await vapi('POST', `/api/admin/vast/${readyInstance.id}/activate`);
      toast(`Instance #${readyInstance.id} activated`);
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); }
  });

  $('#vastDeactivateBtn')?.addEventListener('click', async () => {
    try {
      await vapi('POST', '/api/admin/vast/deactivate');
      toast('Deactivated');
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); }
  });

  // Shared by the Test button and the 2s live poll, so both paint the same way.
  const paintPort25 = (v, note) => {
    const grid = $('#vastPort25Grid');
    if (grid) {
      grid.innerHTML = (v?.targets || []).map(t => `
        <span class="p25-cell ${t.ok ? 'is-ok' : 'is-bad'}" title="${esc(t.host)} — ${esc(t.detail || '')}">
          <b>${esc(t.name)}</b>${t.ok ? 'pass' : 'fail'}
        </span>`).join('');
    }
    const line = $('#vastPort25Line');
    if (line) {
      line.textContent = v == null ? ''
        : v.ok ? `Port 25 open${note ? ` on ${note}` : ''} · ${v.detail || ''}`
        : `Port 25 BLOCKED${note ? ` on ${note}` : ''} · ${v.detail || ''}`;
      line.style.color = v == null ? '' : v.ok ? 'var(--ok, #34d399)' : 'var(--bad, #f87171)';
    }
  };

  window.__paintPort25 = paintPort25;

  $('#vastPort25Btn')?.addEventListener('click', async () => {
    const btn = $('#vastPort25Btn');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Testing…';
    try {
      const out = await vapi('POST', '/api/admin/vast/port25-test');
      paintPort25(out, out.which);
      toast(out.ok ? `Port 25 open on ${out.which} · ${out.detail}` : `Port 25 BLOCKED on ${out.which}`, out.ok ? undefined : 'warn');
    } catch (err) { toast(err.message, 'warn'); }
    finally { btn.disabled = false; btn.textContent = label; }
  });

  $('#vastStopBtn')?.addEventListener('click', async () => {
    if (!runningInstance) return;
    const btn = $('#vastStopBtn');
    btn.disabled = true;
    try {
      await vapi('POST', `/api/admin/vast/${runningInstance.id}/stop`);
      toast(`Instance #${runningInstance.id} stopped - checks are back on OVH`);
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); btn.disabled = false; }
  });

  $('#vastDestroyBtn')?.addEventListener('click', async () => {
    if (!runningInstance) return;
    const ok = await confirmDialog({
      title: `Destroy instance #${runningInstance.id}?`,
      message: 'This stops billing immediately and cannot be undone.',
      confirmText: 'Destroy'
    });
    if (!ok) return;
    const btn = $('#vastDestroyBtn');
    btn.disabled = true;
    try {
      await vapi('DELETE', `/api/admin/vast/${runningInstance.id}`);
      toast(`Instance #${runningInstance.id} destroyed`);
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); btn.disabled = false; }
  });

  $('#vastLaunch')?.addEventListener('click', async () => {
    const btn = $('#vastLaunch');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Renting…';
    try {
      const { instance } = await vapi('POST', '/api/admin/vast/launch');
      toast('Instance launching. Waiting for it to boot, then switching checks to it automatically');
      renderVastView();
      waitThenActivate(instance.id);
    } catch (err) { toast(err.message, 'warn'); btn.disabled = false; btn.textContent = label; }
  });

  $('#vastAttachForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('#vastAttachId').value.trim();
    if (!id) return;
    try {
      await vapi('POST', '/api/admin/vast/attach', { instanceId: id });
      toast(`Instance #${id} attached`);
      $('#vastAttachId').value = '';
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); }
  });

  $('#vastList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.vast-row').dataset.id;
    const act = btn.dataset.act;
    try {
      if (act === 'refresh') {
        const r = await vapi('GET', `/api/admin/vast/${id}`);
        if (r.removed) toast(`Instance #${id} no longer exists on vast.ai - removed`, 'warn');
      }
      if (act === 'activate') await vapi('POST', `/api/admin/vast/${id}/activate`);
      // Per-row: drops just this box, so the rest of the pool keeps checking.
      if (act === 'deactivate') await vapi('POST', `/api/admin/vast/${id}/deactivate`);
      if (act === 'stop') await vapi('POST', `/api/admin/vast/${id}/stop`);
      if (act === 'start') await vapi('POST', `/api/admin/vast/${id}/start`);
      if (act === 'destroy') {
        const ok = await confirmDialog({
          title: `Destroy instance #${id}?`,
          message: 'This stops billing immediately and cannot be undone.',
          confirmText: 'Destroy'
        });
        if (!ok) return;
        await vapi('DELETE', `/api/admin/vast/${id}`);
      }
      renderVastView();
    } catch (err) { toast(err.message, 'warn'); }
  });

  startLivePolling(data.activeInstanceId);
}

/* ------------------------------ live polling ------------------------------ */
let liveTimer = null;
function stopLivePolling() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }

function startLivePolling(activeId) {
  stopLivePolling();
  if (!activeId) return;
  const tick = async () => {
    // Stop quietly once the owner has navigated away from this page.
    if (location.pathname.replace(/\/+$/, '') !== '/ip-server') return stopLivePolling();
    try {
      const live = await vapi('GET', '/api/admin/vast/live');
      if (live.activeInstanceId !== activeId) return stopLivePolling(); // deactivated/switched mid-poll
      const countEl = $('#vastLiveCount');
      const lastEl = $('#vastLiveLast');
      if (countEl) countEl.textContent = live.checked.toLocaleString();
      if (lastEl) lastEl.textContent = live.lastEmail ? `· last: ${live.lastEmail}` : '';

      // Port 25 is the whole reason this box was rented: a host that blocks it
      // answers /api/health normally and then turns every address into
      // "unknown", so say so loudly rather than letting the run look healthy.
      const v = live.port25;
      const p25 = $('#vastPort25');
      if (p25) {
        const state = v == null || v.ok == null ? 'testing' : v.ok ? 'ok' : 'bad';
        p25.className = `p25 is-${state}`;
        p25.textContent = state === 'testing' ? 'Port 25: testing…'
          : state === 'ok' ? `Port 25: open · ${v.detail || ''}`
          : 'Port 25: BLOCKED - this box cannot send, switch off the IP Server';
        if (v?.detail) p25.title = v.detail;
      }

      // One row per provider. A single refusal is that provider's opinion of
      // this IP, not a blocked port, so each is shown on its own rather than
      // collapsed into one verdict.
      if (v?.targets?.length) window.__paintPort25?.(v);
    } catch { /* a missed tick is not worth surfacing */ }
  };
  tick();
  liveTimer = setInterval(tick, 2000);
}

/**
 * Polls a freshly launched instance until it has a reachable address, then
 * activates it automatically - no manual "Activate" click needed after
 * "Launch". Gives up after 10 minutes rather than polling forever if the
 * instance never comes up (vast.ai reselects a host, boot script failed, etc).
 */
function waitThenActivate(id) {
  const deadline = Date.now() + 10 * 60 * 1000;
  const poll = async () => {
    if (location.pathname.replace(/\/+$/, '') !== '/ip-server') return; // owner left the page
    if (Date.now() > deadline) return toast(`Instance #${id} still isn't ready after 10 minutes. Activate it manually once it boots`, 'warn');
    try {
      const { instance, removed } = await vapi('GET', `/api/admin/vast/${id}`);
      if (removed) return; // gone before it ever came up - nothing to activate
      if (instance?.ip && instance?.port) {
        await vapi('POST', `/api/admin/vast/${id}/activate`);
        toast(`Instance #${id} is up, checks switched to it automatically`);
        return renderVastView();
      }
    } catch { /* keep polling through a transient error */ }
    setTimeout(poll, 5000);
  };
  setTimeout(poll, 5000);
}

window.renderVastView = renderVastView;
if (location.pathname.replace(/\/+$/, '') === '/ip-server') renderVastView();
