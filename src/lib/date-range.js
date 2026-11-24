import { localParts, previousDate } from './timezone.js';

/**
 * Períodos do Gerenciador. Cada conta de anúncio usa o PRÓPRIO fuso para saber o que é "hoje" (o TikTok interpreta as datas do relatório no
 * fuso da conta). `resolveRange` devolve { from, to } (YYYY-MM-DD, extremos incluídos) ou lança `null` se o período for inválido.
 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Data civil real no formato YYYY-MM-DD (rejeita 2026-02-30) ou null. */
export function parseDate(value) {
  const m = DATE_RE.exec(String(value ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? String(value) : null;
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
export const rangeDays = daysBetween;

/**
 * @param {string} preset today|yesterday|last7|last14|last30|thisMonth|lastMonth|custom
 * @param {{ timeZone?: string|null, now?: Date, from?: string, to?: string }} options `from`/`to` só valem em "custom"
 */
export function resolveRange(preset, { timeZone = null, now = new Date(), from = null, to = null } = {}) {
  if (preset === 'custom') {
    const a = parseDate(from);
    const b = parseDate(to);
    return a && b && a <= b ? { from: a, to: b } : null;
  }
  const today = localParts(now, timeZone).date;
  switch (preset) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = previousDate(today); return { from: y, to: y }; }
    case 'last7': return { from: previousDate(today, 6), to: today };
    case 'last14': return { from: previousDate(today, 13), to: today };
    case 'last30': return { from: previousDate(today, 29), to: today };
    case 'thisMonth': return { from: `${today.slice(0, 8)}01`, to: today };
    case 'lastMonth': {
      const firstThis = `${today.slice(0, 8)}01`;
      const lastPrev = previousDate(firstThis);
      return { from: `${lastPrev.slice(0, 8)}01`, to: lastPrev };
    }
    default: return null;
  }
}
