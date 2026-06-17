/* ══════════ STATE ══════════ */
const state = {
  accounts: [],
  currentPage: 'dashboard',
  detail: null,
  loginStep: 1,
  loginData: {},
};

/* ══════════ API ══════════ */
const API = '/api';

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || data.error || `HTTP ${r.status}`);
  return data;
}

const get  = (path)       => api('GET',    path);
const post = (path, body) => api('POST',   path, body);
const del  = (path)       => api('DELETE', path);

/* ══════════ TOAST ══════════ */
function toast(msg, type = 'info') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✕', info: 'ℹ', warn: '⚠' };
  el.innerHTML = `<span style="font-size:14px;font-weight:800;flex-shrink:0">${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  el.style.setProperty('--d', '3.5s');
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ══════════ SIDEBAR (mobile) ══════════ */
function toggleSidebar() {
  const s = document.getElementById('sidebar');
  const b = document.getElementById('sidebar-backdrop');
  const open = s.classList.toggle('open');
  b.classList.toggle('show', open);
  document.body.style.overflow = open ? 'hidden' : '';
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.remove('show');
  document.body.style.overflow = '';
}

/* ══════════ NAVIGATION ══════════ */
function navigate(page, data) {
  state.currentPage = page;
  if (data !== undefined) state.detail = data;

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item, .bnav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.page === page);
  });

  const target = document.getElementById(`page-${page}`);
  if (target) target.classList.add('active');

  const titles = {
    dashboard:   ['Accounts', 'Manage your Telegram accounts'],
    login:       ['Add Account', 'Authenticate a new account'],
    detail:      ['Account Detail', state.detail || ''],
    sendmsg:     ['Send Message', 'Send from any account'],
    joinchannel: ['Join Channel', 'Join with one or all accounts'],
  };
  const [title, sub] = titles[page] || ['', ''];
  document.getElementById('topbar-title').textContent = title;
  document.getElementById('topbar-sub').textContent   = sub;

  if (page === 'detail' && state.detail) loadDetail(state.detail);
  if (page === 'dashboard') loadAccounts();
  if (page === 'sendmsg' || page === 'joinchannel') populateAccountSelects();

  // Scroll to top
  const content = document.querySelector('.content');
  if (content) content.scrollTop = 0;
}

/* ══════════ ACCOUNTS ══════════ */
async function loadAccounts() {
  try {
    const accounts = await get('/telegram/accounts');
    state.accounts = accounts || [];
    renderAccounts(state.accounts);
    updateStats();
    populateAccountSelects();
    const badge = document.getElementById('acct-badge');
    if (badge) {
      badge.textContent = state.accounts.length || '';
      badge.style.display = state.accounts.length ? 'flex' : 'none';
    }
  } catch (e) {
    toast('Failed to load: ' + e.message, 'error');
  }
}

function updateStats() {
  document.getElementById('stat-total').textContent  = state.accounts.length;
  document.getElementById('stat-2fa').textContent    = state.accounts.filter(a => a.has2fa).length;
  document.getElementById('stat-active').textContent = state.accounts.length;
}

function renderAccounts(accounts) {
  const container = document.getElementById('accounts-grid');
  const q = (document.getElementById('search-input')?.value || '').toLowerCase();
  const filtered = accounts.filter(a =>
    a.phone.includes(q) ||
    (a.username  || '').toLowerCase().includes(q) ||
    (a.firstName || '').toLowerCase().includes(q)
  );

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="5"/><path d="M3 21a9 9 0 0118 0"/></svg>
        <h3>${accounts.length ? 'No matches' : 'No accounts yet'}</h3>
        <p>${accounts.length ? 'Try a different search' : 'Tap "Add" to get started'}</p>
      </div>`;
    return;
  }

  container.innerHTML = filtered.map(a => {
    const initials = ((a.firstName||'?')[0] + (a.lastName ? a.lastName[0] : '')).toUpperCase();
    return `
      <div class="account-card" onclick="navigate('detail','${esc(a.phone)}')">
        <div class="flex items-center gap-3">
          <div class="account-avatar">${initials}</div>
          <div class="account-info">
            <div class="account-name">${esc(a.firstName)} ${esc(a.lastName||'')}</div>
            <div class="account-phone">${esc(a.phone)}</div>
            <div class="account-badges mt-1">
              ${a.username ? `<span class="badge badge-blue">@${esc(a.username)}</span>` : ''}
              ${a.has2fa ? `<span class="badge badge-yellow">2FA ON</span>` : `<span class="badge badge-green">2FA OFF</span>`}
              <span class="badge badge-green">Active</span>
            </div>
          </div>
        </div>
      </div>`;
  }).join('');
}

function populateAccountSelects() {
  document.querySelectorAll('.account-select').forEach(sel => {
    const prev = sel.value;
    sel.innerHTML = `<option value="">-- Select Account --</option>` +
      state.accounts.map(a =>
        `<option value="${esc(a.phone)}">${esc(a.phone)}${a.firstName ? ' ('+esc(a.firstName)+')' : ''}</option>`
      ).join('');
    if (prev) sel.value = prev;
  });
}

/* ══════════ LOGIN ══════════ */
function setLoginStep(step) {
  state.loginStep = step;
  document.querySelectorAll('.login-step').forEach((el, i) => {
    el.style.display = (i + 1 === step) ? 'block' : 'none';
  });
  [1,2,3].forEach(n => {
    const el = document.getElementById(`step-${n}`);
    if (!el) return;
    el.classList.toggle('active', n === step);
    el.classList.toggle('done',   n < step);
  });
}

async function sendCode() {
  const phone = document.getElementById('login-phone').value.trim();
  if (!phone) return toast('Enter phone number', 'warn');
  const btn = document.getElementById('btn-send-code');
  setLoading(btn, true);
  try {
    const r = await post('/telegram/send-code', { phone });
    state.loginData = { phone, phoneCodeHash: r.phoneCodeHash, sessionId: r.sessionId };
    document.getElementById('login-phone-display').textContent = phone;
    setLoginStep(2);
    toast('Code sent to ' + phone, 'success');
    setTimeout(() => document.getElementById('login-code')?.focus(), 100);
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
  setLoading(btn, false);
}

async function signIn() {
  const code = document.getElementById('login-code').value.trim();
  if (!code) return toast('Enter the code', 'warn');
  const btn = document.getElementById('btn-sign-in');
  setLoading(btn, true);
  try {
    const r = await post('/telegram/sign-in', {
      phone: state.loginData.phone, code,
      phoneCodeHash: state.loginData.phoneCodeHash,
      sessionId: state.loginData.sessionId, password: null,
    });
    toast(`Logged in: ${r.firstName}`, 'success');
    resetLogin(); await loadAccounts(); navigate('dashboard');
  } catch (e) {
    if (e.message === '2FA_REQUIRED') {
      setLoginStep(3); toast('2FA password required', 'warn');
      setTimeout(() => document.getElementById('login-2fa')?.focus(), 100);
    } else { toast('Error: ' + e.message, 'error'); }
  }
  setLoading(btn, false);
}

async function signIn2fa() {
  const pw = document.getElementById('login-2fa').value.trim();
  if (!pw) return toast('Enter 2FA password', 'warn');
  const btn = document.getElementById('btn-sign-in-2fa');
  setLoading(btn, true);
  try {
    const r = await post('/telegram/sign-in', {
      phone: state.loginData.phone,
      code: document.getElementById('login-code').value.trim(),
      phoneCodeHash: state.loginData.phoneCodeHash,
      sessionId: state.loginData.sessionId, password: pw,
    });
    toast(`Logged in: ${r.firstName}`, 'success');
    resetLogin(); await loadAccounts(); navigate('dashboard');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

function resetLogin() {
  state.loginData = {};
  ['login-phone','login-code','login-2fa'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  setLoginStep(1);
}

/* ══════════ DETAIL ══════════ */
async function loadDetail(phone) {
  const acc = state.accounts.find(a => a.phone === phone);
  if (!acc) return;

  const initials = ((acc.firstName||'?')[0] + (acc.lastName ? acc.lastName[0] : '')).toUpperCase();
  document.getElementById('detail-avatar').textContent   = initials;
  document.getElementById('detail-name').textContent     = `${acc.firstName||''} ${acc.lastName||''}`.trim();
  document.getElementById('detail-phone').textContent    = acc.phone;
  document.getElementById('detail-username').textContent = acc.username ? '@'+acc.username : '';

  const badge = document.getElementById('detail-2fa-badge');
  badge.textContent  = acc.has2fa ? '2FA ON' : '2FA OFF';
  badge.className    = 'badge ' + (acc.has2fa ? 'badge-yellow' : 'badge-green');

  document.getElementById('disable-2fa-section').style.display = acc.has2fa ? 'block' : 'none';
  document.getElementById('no-2fa-msg').style.display          = acc.has2fa ? 'none'  : 'block';

  document.getElementById('login-code-result').innerHTML = '';
  document.getElementById('sessions-list').innerHTML     = '<div class="text-dim text-sm">Tap "Refresh" to load sessions</div>';
  document.getElementById('email-step2').style.display   = 'none';
  document.getElementById('email-input').value           = '';
  document.getElementById('email-code').value            = '';
}

async function disable2fa() {
  const btn = document.getElementById('btn-disable-2fa');
  setLoading(btn, true);
  try {
    const r = await post(`/telegram/accounts/${encodeURIComponent(state.detail)}/disable-2fa`, { password: '4735908767' });
    toast(r.message || '2FA disabled', 'success');
    const acc = state.accounts.find(a => a.phone === state.detail);
    if (acc) { acc.has2fa = false; loadDetail(state.detail); }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

async function getLoginCode() {
  const btn = document.getElementById('btn-get-code');
  setLoading(btn, true);
  try {
    const r = await get(`/telegram/accounts/${encodeURIComponent(state.detail)}/login-code`);
    const el = document.getElementById('login-code-result');
    if (r.found) {
      el.innerHTML = `
        <div class="code-box">
          <div>
            <div class="code-value">${esc(r.code)}</div>
            <div class="code-meta">From: Telegram · ${r.date ? new Date(r.date).toLocaleTimeString() : ''}</div>
          </div>
          <button class="btn btn-secondary btn-sm" onclick="copyText('${esc(r.code)}')">Copy</button>
        </div>`;
      toast('Code: ' + r.code, 'success');
    } else {
      el.innerHTML = `<div class="empty-state" style="padding:14px"><p>No recent code found</p></div>`;
      toast('No recent code found', 'warn');
    }
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

async function loadSessions() {
  const btn = document.getElementById('btn-load-sessions');
  setLoading(btn, true);
  try {
    const sessions = await get(`/telegram/accounts/${encodeURIComponent(state.detail)}/sessions`);
    renderSessions(sessions);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

function renderSessions(sessions) {
  const el = document.getElementById('sessions-list');
  if (!sessions || !sessions.length) {
    el.innerHTML = `<div class="empty-state" style="padding:14px"><p>No sessions found</p></div>`;
    return;
  }
  el.innerHTML = sessions.map(s => `
    <div class="session-item">
      <div class="session-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>
      </div>
      <div class="session-info flex-1">
        <div class="session-device">${esc(s.deviceModel)}${s.current ? ' <span class="session-current">CURRENT</span>' : ''}</div>
        <div class="session-meta">${esc(s.appName)} · ${esc(s.country)} · ${s.dateActive ? new Date(s.dateActive).toLocaleDateString() : ''}</div>
      </div>
      ${!s.current ? `<button class="btn btn-danger btn-sm" onclick="terminateSession('${esc(s.hash)}')">Kill</button>` : ''}
    </div>`).join('');
}

async function terminateSession(hash) {
  try {
    await post(`/telegram/accounts/${encodeURIComponent(state.detail)}/terminate-session`, { hash });
    toast('Session terminated', 'success');
    loadSessions();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function terminateAllSessions() {
  const btn = document.getElementById('btn-terminate-all');
  setLoading(btn, true);
  try {
    await post(`/telegram/accounts/${encodeURIComponent(state.detail)}/terminate-all-sessions`, {});
    toast('All other sessions terminated', 'success');
    loadSessions();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

async function logoutAccount() {
  if (!confirm(`Remove ${state.detail}?`)) return;
  try {
    await del(`/telegram/accounts/${encodeURIComponent(state.detail)}`);
    toast('Account removed', 'success');
    state.accounts = state.accounts.filter(a => a.phone !== state.detail);
    updateStats(); navigate('dashboard');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* ══════════ EMAIL ══════════ */
async function sendEmail() {
  const email = document.getElementById('email-input').value.trim();
  if (!email) return toast('Enter email address', 'warn');
  if (!email.includes('@')) return toast('Enter a valid email', 'warn');
  const btn = document.getElementById('btn-send-email');
  setLoading(btn, true);
  try {
    await post(`/telegram/accounts/${encodeURIComponent(state.detail)}/change-email`, { email });
    document.getElementById('email-step2').style.display = 'block';
    toast('Verification code sent to email', 'success');
    setTimeout(() => document.getElementById('email-code')?.focus(), 100);
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

async function verifyEmail() {
  const email = document.getElementById('email-input').value.trim();
  const code  = document.getElementById('email-code').value.trim();
  if (!code) return toast('Enter verification code', 'warn');
  const btn = document.getElementById('btn-verify-email');
  setLoading(btn, true);
  try {
    await post(`/telegram/accounts/${encodeURIComponent(state.detail)}/verify-email`, { email, code });
    toast('Email changed successfully!', 'success');
    document.getElementById('email-input').value          = '';
    document.getElementById('email-code').value           = '';
    document.getElementById('email-step2').style.display  = 'none';
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

/* ══════════ SEND MESSAGE ══════════ */
async function sendMessage() {
  const phone   = document.getElementById('msg-from').value;
  const username = document.getElementById('msg-to').value.trim();
  const message  = document.getElementById('msg-text').value.trim();
  if (!phone)    return toast('Select an account', 'warn');
  if (!username) return toast('Enter username or phone', 'warn');
  if (!message)  return toast('Enter message text', 'warn');
  const btn = document.getElementById('btn-send-msg');
  setLoading(btn, true);
  try {
    await post(`/telegram/accounts/${encodeURIComponent(phone)}/send-message`, { username, message });
    toast('Message sent!', 'success');
    document.getElementById('msg-text').value = '';
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

/* ══════════ JOIN CHANNEL ══════════ */
async function joinChannel() {
  const phone   = document.getElementById('join-from').value;
  const channel = document.getElementById('join-channel-input').value.trim();
  if (!phone)   return toast('Select an account', 'warn');
  if (!channel) return toast('Enter channel username', 'warn');
  const btn = document.getElementById('btn-join-channel');
  setLoading(btn, true);
  try {
    const r = await post(`/telegram/accounts/${encodeURIComponent(phone)}/join-channel`, { channel });
    toast(r.message || 'Joined!', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

async function joinAllChannels() {
  const channel = document.getElementById('join-all-channel').value.trim();
  if (!channel)             return toast('Enter channel username', 'warn');
  if (!state.accounts.length) return toast('No accounts logged in', 'warn');
  const btn = document.getElementById('btn-join-all');
  setLoading(btn, true);
  try {
    const r = await post('/telegram/join-all', { channel });
    const el = document.getElementById('join-all-results');
    const ok = r.results.filter(x => x.success).length;
    el.innerHTML = `
      <div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text-mid);margin-bottom:6px">
        RESULTS — ${ok}/${r.results.length} joined
      </div>
      <div class="result-list">
        ${r.results.map(x => `
          <div class="result-item ${x.success?'ok':'fail'}">
            <span style="color:${x.success?'var(--success)':'var(--danger)'};font-weight:800">${x.success?'✓':'✕'}</span>
            <span style="font-family:var(--mono);font-size:11px">${esc(x.phone)}</span>
            ${x.error ? `<span style="color:var(--text-dim);margin-left:auto;font-size:10px;text-align:right;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.error)}</span>` : ''}
          </div>`).join('')}
      </div>`;
    toast(`${ok}/${r.results.length} accounts joined`, ok === r.results.length ? 'success' : 'warn');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
  setLoading(btn, false);
}

/* ══════════ UTILS ══════════ */
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast('Copied!', 'success'));
}

function setLoading(btn, on) {
  if (!btn) return;
  if (on) {
    btn.dataset.origHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner"></span> Loading...`;
    btn.disabled = true;
  } else {
    if (btn.dataset.origHtml) btn.innerHTML = btn.dataset.origHtml;
    btn.disabled = false;
  }
}

/* ══════════ INIT ══════════ */
document.addEventListener('DOMContentLoaded', () => {
  // Enter keys for login
  document.getElementById('login-phone')?.addEventListener('keydown', e => { if(e.key==='Enter') sendCode(); });
  document.getElementById('login-code')?.addEventListener('keydown',  e => { if(e.key==='Enter') signIn(); });
  document.getElementById('login-2fa')?.addEventListener('keydown',   e => { if(e.key==='Enter') signIn2fa(); });
  document.getElementById('email-code')?.addEventListener('keydown',  e => { if(e.key==='Enter') verifyEmail(); });

  // Search
  document.getElementById('search-input')?.addEventListener('input', () => renderAccounts(state.accounts));

  // Swipe to close sidebar on mobile
  let touchStartX = 0;
  document.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  document.addEventListener('touchend', e => {
    const dx = touchStartX - e.changedTouches[0].clientX;
    if (dx > 60 && document.getElementById('sidebar').classList.contains('open')) closeSidebar();
  }, { passive: true });

  // Initial load
  loadAccounts();
  navigate('dashboard');
  setInterval(loadAccounts, 30000);
});
