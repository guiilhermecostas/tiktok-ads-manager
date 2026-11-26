import { formatPercentBp, formatUsd, monthLabel, planSummary } from '/shared/billing.js';
import { get } from '../api.js';
import { h } from '../dom.js';
import { badge, emptyState } from '../ui.js';
import { pageHeader } from './layout.js';

/**
 * Plano e cobrança da própria conta (só leitura, tudo em dólar): o plano combinado, o mês em andamento, os meses fechados, os pagamentos e o que está
 * em aberto. O gasto vem do que o sistema guardou por hora; não muda se uma Business Center for removida.
 */
const dateOnly = (text) => new Date(`${text}T12:00:00Z`).toLocaleDateString('pt-BR');
const card = (label, value, hint, tone) => h('div', { class: `kpi kpi--static${tone ? ` kpi--${tone}` : ''}` }, h('span', { class: 'kpi__label' }, label), h('strong', { class: 'kpi__value' }, value), h('span', { class: 'kpi__hint muted' }, hint ?? ''));

export async function billingView() {
  const data = await get('/billing/me');
  if (!data.plan && !data.nextPlan) {
    return { element: h('div', null, pageHeader('Plano e cobrança', 'O seu plano e o que está em aberto.'), h('div', { class: 'card' }, emptyState({ title: 'Nenhum plano definido ainda', text: 'O administrador ainda não configurou o seu plano. Quando ele definir, a mensalidade, o percentual e o gasto do mês aparecem aqui.' }))) };
  }
  const current = data.months.find((m) => m.period === data.currentMonth) ?? null;
  const owes = data.balanceCents > 0;
  const cards = [
    card('Seu plano', planSummary(data.plan), data.nextPlan ? `A partir de ${monthLabel(data.nextPlan.effectiveMonth)}: ${planSummary(data.nextPlan)}` : 'valores em dólar (US$)'),
    card(`Gasto em ${monthLabel(data.currentMonth)}`, formatUsd(current?.spendCents ?? 0), 'somando as suas contas de anúncio'),
    card('Cobrança do mês', formatUsd(current?.totalCents ?? 0), current ? `${formatUsd(current.monthlyFeeCents)} + ${formatPercentBp(current.percentBp)} do gasto` : ''),
    card(owes ? 'Em aberto' : data.balanceCents < 0 ? 'Crédito' : 'Em aberto', formatUsd(Math.abs(data.balanceCents)), owes ? 'cobrado e ainda não pago' : data.balanceCents < 0 ? 'pago a mais, abate das próximas cobranças' : 'tudo pago', owes ? 'warn' : null),
  ];
  const months = h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
    h('thead', null, h('tr', null, ['Mês', 'Gasto', 'Mensalidade', '% do gasto', 'Total', 'Situação'].map((t) => h('th', { scope: 'col' }, t)))),
    h('tbody', null, data.months.map((e) => h('tr', null,
      h('td', { 'data-label': 'Mês' }, monthLabel(e.period)),
      h('td', { 'data-label': 'Gasto', class: 'num' }, formatUsd(e.spendCents), e.unconverted.length ? h('span', { class: 'acc-id', title: 'Gasto em outra moeda ainda sem cotação: o administrador acerta' }, 'há gasto em outra moeda a converter') : null),
      h('td', { 'data-label': 'Mensalidade', class: 'num' }, formatUsd(e.monthlyFeeCents)),
      h('td', { 'data-label': '% do gasto', class: 'num' }, `${formatPercentBp(e.percentBp)} = ${formatUsd(e.percentFeeCents)}`),
      h('td', { 'data-label': 'Total', class: 'num' }, h('strong', null, formatUsd(e.totalCents))),
      h('td', { 'data-label': 'Situação' }, e.closed ? badge('Fechado', 'neutral') : badge('Em andamento', 'warning')))))));
  const payments = data.payments.length
    ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
      h('thead', null, h('tr', null, ['Data', 'Valor', 'Observação'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, data.payments.map((p) => h('tr', null, h('td', { 'data-label': 'Data' }, dateOnly(p.paidAt)), h('td', { 'data-label': 'Valor', class: 'num' }, formatUsd(p.amountCents)), h('td', { 'data-label': 'Observação' }, p.note ?? '—'))))))
    : h('p', { class: 'muted' }, 'Nenhum pagamento registrado ainda.');
  return {
    element: h('div', { class: 'billing' },
      pageHeader('Plano e cobrança', 'O seu plano combinado, o gasto do mês e o que está em aberto. Tudo em dólar (US$).'),
      h('div', { class: 'kpis', role: 'group', 'aria-label': 'Resumo' }, cards),
      owes ? h('p', { class: 'alert alert--warning', role: 'status' }, 'Há valor em aberto. Se você remover uma Business Center com dívida pendente, ela fica bloqueada para outras contas até a regularização.') : null,
      h('section', { class: 'billing-section' }, h('h2', { class: 'form-section__title' }, 'Meses'), months),
      h('section', { class: 'billing-section' }, h('h2', { class: 'form-section__title' }, 'Pagamentos'), payments),
      h('p', { class: 'hub__note' }, 'O mês vai do dia 1 ao último dia em horário UTC e fecha 2 dias depois de acabar (o TikTok ainda ajusta os números das últimas horas). O gasto é guardado hora a hora: remover uma Business Center não apaga nem reduz o que já foi gasto.')),
  };
}
