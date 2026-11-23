/**
 * Regras puras dos relatórios (sem DOM): variação em relação ao período anterior e as observações automáticas ("o que chama
 * atenção"). Fica em shared/ para o navegador usar e os testes cobrirem sem precisar de navegador.
 */

/** Variação percentual em relação ao período anterior (null quando não há base de comparação). */
export function percentChange(current, previous) {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Observações em linguagem simples sobre os números de UMA moeda.
 * `format.money(valor)` e `format.percent(valor)` formatam os textos (a tela injeta os formatadores do navegador).
 * Devolve [{ tone: 'info' | 'warn' | 'good', text }].
 */
export function buildInsights({ group, data, metricsCurrency, format }) {
  const notes = [];
  const t = group.totals;
  const days = group.daily;
  if (t.spend === 0) {
    notes.push({ tone: 'info', text: 'Nenhum gasto neste período. Se há campanhas ativas, confira se a conta e o período estão certos.' });
  } else {
    const best = days.reduce((a, d) => (d.spend > a.spend ? d : a), days[0]);
    notes.push({ tone: 'info', text: `Dia de maior gasto: ${shortDate(best.date)}, com ${format.money(best.spend)}.` });
    if (t.conversions === 0) notes.push({ tone: 'warn', text: 'Houve gasto, mas nenhuma conversão registrada. Vale conferir o pixel e o evento de conversão.' });
    const change = percentChange(t.spend, group.previous?.spend);
    if (change !== null && Math.abs(change) >= 10) notes.push({ tone: change > 0 ? 'warn' : 'info', text: `O gasto ${change > 0 ? 'subiu' : 'caiu'} ${format.percent(Math.abs(change))} em relação ao período anterior.` });
    const ctrChange = percentChange(t.ctr, group.previous?.ctr);
    if (ctrChange !== null && Math.abs(ctrChange) >= 15) notes.push({ tone: ctrChange > 0 ? 'good' : 'warn', text: `O CTR ${ctrChange > 0 ? 'melhorou' : 'piorou'} ${format.percent(Math.abs(ctrChange))} (${format.percent(t.ctr)} agora).` });
    const rows = data.accounts.filter((a) => (a.currency ?? 'UNKNOWN') === metricsCurrency);
    const top = rows[0];
    if (rows.length > 1 && top && top.totals.spend / t.spend >= 0.6) notes.push({ tone: 'info', text: `A conta "${top.name}" concentra ${format.percent((top.totals.spend / t.spend) * 100)} do gasto.` });
  }
  if (data.failed > 0) notes.push({ tone: 'warn', text: `${data.failed === 1 ? '1 conta não pôde' : `${data.failed} contas não puderam`} ser consultada(s) agora. Os números podem estar incompletos.` });
  if (data.analyzed < data.totalAdvertisers) notes.push({ tone: 'info', text: `Mostrando as primeiras ${data.analyzed} de ${data.totalAdvertisers} contas. Use o filtro de conta para ver uma específica.` });
  return notes;
}
