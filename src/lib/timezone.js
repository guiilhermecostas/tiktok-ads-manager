/**
 * Conversões de fuso horário com a Intl (sem biblioteca). Os relatórios por hora do TikTok vêm no fuso da CONTA de anúncio
 * ("2026-11-23 14:00:00" = 14h no fuso da conta); o sistema guarda tudo em UTC e deixa o navegador mostrar no horário de quem olha.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Fuso válido ou 'UTC' (conta sem fuso informado ou valor estranho nunca derruba a coleta). */
export function safeTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone || 'UTC' });
    return timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Partes de um instante no fuso: { date: 'YYYY-MM-DD', hour: 0-23 }. */
export function localParts(instant, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Diferença (ms) entre o relógio local do fuso e o UTC em um instante: positiva a leste de Greenwich. */
function offsetMs(instantMs, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(instantMs))
      .map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, Number(p.month) - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instantMs / 1000) * 1000;
}

/**
 * "2026-11-23 14:00:00" (hora local no fuso) -> Date em UTC, ou null se o texto não tiver a forma esperada.
 * Trata horário de verão: o deslocamento é conferido de novo no instante já corrigido.
 */
export function zonedToUtc(local, timeZone) {
  const m = LOCAL_RE.exec(String(local ?? ''));
  if (!m) return null;
  const zone = safeTimeZone(timeZone);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (Number.isNaN(wall)) return null;
  let guess = wall - offsetMs(wall, zone);
  guess = wall - offsetMs(guess, zone);
  return new Date(guess);
}

/** A data civil anterior ('YYYY-MM-DD' -> 'YYYY-MM-DD'), sem depender de fuso. */
export function previousDate(date, days = 1) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}
