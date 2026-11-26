#!/usr/bin/env node
// Gera tráfego realista na aplicação para alimentar métricas, logs e dashboards.
// Uso: node scripts/gerar-trafego.mjs [--url http://localhost:8080] [--minutos 3] [--concorrencia 5]
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => (cur.startsWith('--') ? [...acc, [cur.slice(2), arr[i + 1]]] : acc), []),
);
const BASE = (args.url || 'http://localhost:8080').replace(/\/$/, '');
const MINUTES = Number(args.minutos || 3);
const CONCURRENCY = Number(args.concorrencia || 5);
const deadline = Date.now() + MINUTES * 60_000;

const stats = { ok: 0, clientError: 0, serverError: 0, networkError: 0, bookings: 0, cancels: 0 };
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', token, body } = {}) {
  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status >= 500) stats.serverError++;
    else if (res.status >= 400) stats.clientError++;
    else stats.ok++;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  } catch {
    stats.networkError++;
    return { status: 0, data: null };
  }
}

function futureDate(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toLocaleDateString('sv-SE');
}

async function virtualUser(n) {
  const email = `cliente.${Date.now()}.${n}@teste.local`;
  const reg = await call('/auth/register', { method: 'POST', body: { name: `Cliente ${n}`, email, password: 'senha123' } });
  const token = reg.data?.token;
  if (!token) return;

  while (Date.now() < deadline) {
    const [services, professionals] = await Promise.all([call('/catalog/services'), call('/catalog/professionals')]);
    if (!Array.isArray(services.data) || !Array.isArray(professionals.data)) { await sleep(1000); continue; }

    const service = pick(services.data);
    const professional = pick(professionals.data);
    const date = futureDate(1 + Math.floor(Math.random() * 14));
    const q = new URLSearchParams({ date, serviceId: service.id, professionalId: professional.id });
    const avail = await call(`/bookings/availability?${q}`, { token });

    if (avail.data?.slots?.length && Math.random() < 0.6) {
      const startAt = `${date}T${pick(avail.data.slots)}`;
      const created = await call('/bookings/', { method: 'POST', token, body: { serviceId: service.id, professionalId: professional.id, startAt } });
      if (created.status === 201) {
        stats.bookings++;
        if (Math.random() < 0.25) {
          await call(`/bookings/${created.data.id}/cancel`, { method: 'PATCH', token });
          stats.cancels++;
        }
      }
    }

    await call('/bookings/me', { token });
    // Alguns erros de propósito para aparecerem nos dashboards (401 e 404).
    if (Math.random() < 0.05) await call('/bookings/me');
    if (Math.random() < 0.05) await call('/catalog/services/99999');
    if (Math.random() < 0.03) await call('/auth/login', { method: 'POST', body: { email, password: 'senha-errada' } });

    await sleep(200 + Math.random() * 800);
  }
}

console.log(`Gerando tráfego em ${BASE} por ${MINUTES} min com ${CONCURRENCY} usuários simultâneos...`);
const ticker = setInterval(() => console.log(JSON.stringify(stats)), 10_000);
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => virtualUser(i + 1)));
clearInterval(ticker);
console.log('Concluído:', JSON.stringify(stats));
