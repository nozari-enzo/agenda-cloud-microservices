// Datas são tratadas como horário local do estabelecimento, no formato "YYYY-MM-DDTHH:MM".
// Igual em todos os serviços (cópia intencional, ver observability.js).
const TIMEZONE = process.env.APP_TIMEZONE || 'America/Sao_Paulo';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function nowLocal() {
  // sv-SE formata como "YYYY-MM-DD HH:MM:SS"
  return new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE }).replace(' ', 'T').slice(0, 16);
}

function addMinutes(dateTime, minutes) {
  const d = new Date(`${dateTime}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

function minutesOfDay(dateTime) {
  const [h, m] = dateTime.slice(11, 16).split(':').map(Number);
  return h * 60 + m;
}

function formatHour(totalMinutes) {
  const h = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const m = String(totalMinutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function formatBr(dateTime) {
  const [date, hour] = dateTime.split('T');
  const [y, mo, d] = date.split('-');
  return `${d}/${mo}/${y} às ${hour}`;
}

// Faz o driver pg devolver TIMESTAMP (sem fuso) como texto "YYYY-MM-DDTHH:MM".
function configurePgTimestamps(types) {
  types.setTypeParser(1114, (value) => value.replace(' ', 'T').slice(0, 16));
}

module.exports = {
  DATE_RE, DATETIME_RE, nowLocal, addMinutes, minutesOfDay, formatHour, formatBr, configurePgTimestamps,
};
