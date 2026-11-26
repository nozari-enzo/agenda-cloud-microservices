// Frontend da Agenda Fácil: SPA em JavaScript puro que conversa com o API Gateway (/api).
const API = '/api';
const state = {
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  services: [],
  professionals: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDateTime = (dt) => {
  const [d, h] = dt.split('T');
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y} ${h}`;
};
const today = () => new Date().toLocaleDateString('sv-SE');

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401 && state.token) {
    logout();
    throw new Error('Sua sessão expirou. Entre novamente.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}

// ---------- Autenticação ----------
function setSession({ token, user }) {
  state.token = token;
  state.user = user;
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
  render();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  render();
}

$$('[data-auth]').forEach((btn) => btn.addEventListener('click', () => {
  $$('[data-auth]').forEach((b) => b.classList.toggle('active', b === btn));
  $('#login-form').classList.toggle('hidden', btn.dataset.auth !== 'login');
  $('#register-form').classList.toggle('hidden', btn.dataset.auth !== 'register');
}));

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    setSession(await api('/auth/login', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }));
  } catch (err) { toast(err.message, true); }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    setSession(await api('/auth/register', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }));
    toast('Conta criada!');
  } catch (err) { toast(err.message, true); }
});

$('#logout').addEventListener('click', logout);

// ---------- Navegação ----------
const loaders = {
  book: loadCatalog,
  mine: loadMyBookings,
  day: loadDayBookings,
  catalog: loadCatalogAdmin,
  notifications: loadNotifications,
};

function showView(name) {
  $$('#main-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.dataset.panel !== name));
  loaders[name]().catch((err) => toast(err.message, true));
}

$$('#main-tabs .tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

function render() {
  const logged = Boolean(state.token);
  $('#auth-view').classList.toggle('hidden', logged);
  $('#app-view').classList.toggle('hidden', !logged);
  $('#user-box').classList.toggle('hidden', !logged);
  if (!logged) return;
  $('#user-name').textContent = state.user.name;
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', state.user.role !== 'admin'));
  showView('book');
}

// ---------- Agendar ----------
async function loadCatalog() {
  [state.services, state.professionals] = await Promise.all([api('/catalog/services'), api('/catalog/professionals')]);
  $('#book-service').innerHTML = state.services
    .map((s) => `<option value="${s.id}">${esc(s.name)} (${s.duration_min} min, ${money(s.price)})</option>`).join('');
  $('#book-professional').innerHTML = state.professionals
    .map((p) => `<option value="${p.id}">${esc(p.name)}${p.specialty ? ` (${esc(p.specialty)})` : ''}</option>`).join('');
  const dateInput = $('#book-date');
  dateInput.min = today();
  if (!dateInput.value) dateInput.value = today();
  await loadSlots();
}

async function loadSlots() {
  const serviceId = $('#book-service').value;
  const professionalId = $('#book-professional').value;
  const date = $('#book-date').value;
  const box = $('#slots');
  if (!serviceId || !professionalId || !date) return;
  box.innerHTML = '<p class="muted">Carregando...</p>';
  try {
    const q = new URLSearchParams({ serviceId, professionalId, date });
    const { slots } = await api(`/bookings/availability?${q}`);
    box.innerHTML = slots.length
      ? slots.map((h) => `<button class="slot" data-hour="${h}">${h}</button>`).join('')
      : '<p class="muted">Nenhum horário livre nesta data.</p>';
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

['#book-service', '#book-professional', '#book-date'].forEach((sel) => $(sel).addEventListener('change', loadSlots));

$('#slots').addEventListener('click', async (e) => {
  const hour = e.target.dataset?.hour;
  if (!hour) return;
  const service = state.services.find((s) => String(s.id) === $('#book-service').value);
  const professional = state.professionals.find((p) => String(p.id) === $('#book-professional').value);
  const startAt = `${$('#book-date').value}T${hour}`;
  if (!confirm(`Confirmar ${service.name} com ${professional.name} em ${fmtDateTime(startAt)}?`)) return;
  try {
    await api('/bookings/', { method: 'POST', body: { serviceId: service.id, professionalId: professional.id, startAt } });
    toast('Agendamento confirmado! Você vai receber a confirmação por e-mail.');
    await loadSlots();
  } catch (err) {
    toast(err.message, true);
    await loadSlots();
  }
});

// ---------- Listas de agendamentos ----------
function bookingRow(b, { showClient = false } = {}) {
  const statusLabel = b.status === 'confirmed' ? 'Confirmado' : 'Cancelado';
  const canCancel = b.status === 'confirmed';
  return `<div class="booking">
    <div>
      <div class="when">${fmtDateTime(b.start_at)} até ${b.end_at.slice(11)}</div>
      <div>${esc(b.service_name)} com ${esc(b.professional_name)} · ${money(b.price)}</div>
      ${showClient ? `<div class="muted">${esc(b.user_name)} · ${esc(b.user_email)}</div>` : ''}
    </div>
    <div>
      <span class="badge ${b.status}">${statusLabel}</span>
      ${canCancel ? `<button class="danger" data-cancel="${b.id}">Cancelar</button>` : ''}
    </div>
  </div>`;
}

async function loadMyBookings() {
  const list = await api('/bookings/me');
  $('#my-bookings').innerHTML = list.length
    ? list.map((b) => bookingRow(b)).join('')
    : '<p class="muted">Você ainda não tem agendamentos.</p>';
}

async function loadDayBookings() {
  const input = $('#day-date');
  if (!input.value) input.value = today();
  const list = await api(`/bookings/?date=${input.value}`);
  $('#day-bookings').innerHTML = list.length
    ? list.map((b) => bookingRow(b, { showClient: true })).join('')
    : '<p class="muted">Nenhum agendamento nesta data.</p>';
}
$('#day-date').addEventListener('change', () => loadDayBookings().catch((err) => toast(err.message, true)));

document.addEventListener('click', async (e) => {
  const id = e.target.dataset?.cancel;
  if (!id || !confirm('Cancelar este agendamento?')) return;
  try {
    await api(`/bookings/${id}/cancel`, { method: 'PATCH' });
    toast('Agendamento cancelado.');
    const active = $('#main-tabs .tab.active').dataset.view;
    await loaders[active]();
  } catch (err) { toast(err.message, true); }
});

// ---------- Administração ----------
async function loadCatalogAdmin() {
  const [services, professionals] = await Promise.all([api('/catalog/services'), api('/catalog/professionals')]);
  $('#catalog-services').innerHTML = services.map((s) => `<li>
      <span>${esc(s.name)} · ${s.duration_min} min · ${money(s.price)}</span>
      <button class="danger" data-remove-service="${s.id}">Remover</button></li>`).join('');
  $('#catalog-professionals').innerHTML = professionals.map((p) => `<li>
      <span>${esc(p.name)}${p.specialty ? ` · ${esc(p.specialty)}` : ''}</span>
      <button class="danger" data-remove-professional="${p.id}">Remover</button></li>`).join('');
}

$('#catalog-services').addEventListener('click', async (e) => {
  const id = e.target.dataset?.removeService;
  if (!id) return;
  try { await api(`/catalog/services/${id}`, { method: 'DELETE' }); await loadCatalogAdmin(); } catch (err) { toast(err.message, true); }
});
$('#catalog-professionals').addEventListener('click', async (e) => {
  const id = e.target.dataset?.removeProfessional;
  if (!id) return;
  try { await api(`/catalog/professionals/${id}`, { method: 'DELETE' }); await loadCatalogAdmin(); } catch (err) { toast(err.message, true); }
});

$('#service-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/catalog/services', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Serviço adicionado.');
    await loadCatalogAdmin();
  } catch (err) { toast(err.message, true); }
});

$('#professional-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/catalog/professionals', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    toast('Profissional adicionado.');
    await loadCatalogAdmin();
  } catch (err) { toast(err.message, true); }
});

async function loadNotifications() {
  const list = await api('/notifications/');
  const labels = { confirmation: 'Confirmação', cancellation: 'Cancelamento', reminder: 'Lembrete' };
  $('#notifications').innerHTML = list.length
    ? list.map((n) => `<div class="booking"><div>
        <div class="when">${labels[n.type] || n.type} · ${esc(n.recipient)}</div>
        <div>${esc(n.message)}</div>
        <div class="muted">${new Date(n.created_at).toLocaleString('pt-BR')}</div>
      </div></div>`).join('')
    : '<p class="muted">Nenhuma notificação enviada ainda.</p>';
}

render();
