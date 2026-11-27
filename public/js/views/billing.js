import { INVOICE_DUE_DAYS, formatBrl, formatPercentBp, formatRate, monthLabel, planSummary } from '/shared/billing.js';
import { get } from '../api.js';
import { h } from '../dom.js';
import { formatCurrency } from '../format.js';
import { badge, emptyState } from '../ui.js';
import { pageHeader } from './layout.js';

/**
 * Plano e cobrança da própria conta (só leitura, tudo em REAL): o plano combinado, o mês em andamento, as FATURAS (o que há para pagar), os meses fechados e os
 * pagamentos. O gasto em outras moedas (dólar, euro…) é convertido para real pela cotação; o extrato mostra o valor original e a cotação usada. O gasto vem
 * do que o sistema guardou por hora; não muda se uma Business Center for removida.
 */
const dateOnly = (text) => new Date(`${text}T12:00:00Z`).toLocaleDateString('pt-BR');
const card = (label, value, hint, tone) => h('div', { class: `kpi kpi--static${tone ? ` kpi--${tone}` : ''}` }, h('span', { class: 'kpi__label' }, label), h('strong', { class: 'kpi__value' }, value), h('span', { class: 'kpi__hint muted' }, hint ?? ''));
const table = (head, rows) => h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' }, h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows)));

export const INVOICE_STATUS = Object.freeze({
  paid: ['Paga', 'success'],
  open: ['Em aberto', 'warning'],
  partial: ['Paga em parte', 'warning'],
  overdue: ['Vencida', 'danger'],
});

/** Período coberto por uma fatura: "novembro de 2026" ou "novembro de 2026 a janeiro de 2027". */
export const invoicePeriod = (invoice) => (invoice.periodFrom === invoice.periodTo ? monthLabel(invoice.periodFrom) : `${monthLabel(invoice.periodFrom)} a ${monthLabel(invoice.periodTo)}`);

/** "US$ 96,00 × R$ 5,4321": de onde veio o gasto em outra moeda (o real não precisa de explicação). */
export const breakdownLines = (entry) => (entry.breakdown ?? [])
  .filter((b) => b.currency !== 'BRL')
  .map((b) => h('span', { class: 'acc-id', title: 'Gasto na moeda da conta × cotação para real' }, `${formatCurrency(b.spend, b.currency)} × ${formatRate(b.rate)}`));

export const unconvertedNote = (entry, text) => (entry.unconverted?.length ? h('span', { class: 'acc-id', title: text }, `sem cotação: ${entry.unconverted.map((u) => u.currency).join(', ')}`) : null);

export async function billingView() {
  const data = await get('/billing/me');
  if (!data.plan && !data.nextPlan) {
    return { element: h('div', null, pageHeader('Plano e cobrança', 'O seu plano e o que está em aberto.'), h('div', { class: 'card' }, emptyState({ title: 'Nenhum plano definido ainda', text: 'O administrador ainda não configurou o seu plano. Quando ele definir, a mensalidade, o percentual e o gasto do mês aparecem aqui.' }))) };
  }
  const current = data.months.find((m) => m.period === data.currentMonth) ?? null;
  const owesInvoices = data.openInvoicesCents > 0;
  const cards = [
    card('Seu plano', planSummary(data.plan), data.nextPlan ? `A partir de ${monthLabel(data.nextPlan.effectiveMonth)}: ${planSummary(data.nextPlan)}` : 'valores em reais (R$)'),
    card(`Gasto em ${monthLabel(data.currentMonth)}`, formatBrl(current?.spendCents ?? 0), 'somando as suas contas de anúncio, em reais'),
    card('Cobrança do mês', formatBrl(current?.totalCents ?? 0), current ? `${formatBrl(current.monthlyFeeCents)} + ${formatPercentBp(current.percentBp)} do gasto` : ''),
    card('Faturas a pagar', formatBrl(data.openInvoicesCents), owesInvoices ? 'faturas emitidas e ainda não pagas' : 'nenhuma fatura em aberto', owesInvoices ? 'warn' : null),
    card('Acumulando', formatBrl(data.accruedCents), `vira fatura quando o mês fecha e o total chega a ${formatBrl(data.invoiceMinCents)}`),
  ];

  const invoices = data.invoices.length
    ? table(['Fatura', 'Período', 'Valor', 'Vencimento', 'Situação'], [...data.invoices].reverse().map((i) => {
      const [label, tone] = INVOICE_STATUS[i.status] ?? [i.status, 'neutral'];
      return h('tr', null,
        h('td', { 'data-label': 'Fatura' }, `Nº ${i.id}`),
        h('td', { 'data-label': 'Período' }, invoicePeriod(i)),
        h('td', { 'data-label': 'Valor', class: 'num' }, h('strong', null, formatBrl(i.amountCents)), i.paidCents > 0 && i.status !== 'paid' ? h('span', { class: 'acc-id' }, `pago ${formatBrl(i.paidCents)} · falta ${formatBrl(i.remainingCents)}`) : null),
        h('td', { 'data-label': 'Vencimento' }, dateOnly(i.dueDate)),
        h('td', { 'data-label': 'Situação' }, badge(label, tone)));
    }))
    : h('div', { class: 'card' }, emptyState({ title: 'Nenhuma fatura ainda', text: `A fatura é emitida quando um mês fecha e o total cobrado chega a ${formatBrl(data.invoiceMinCents)}. Abaixo disso, o valor fica acumulando e entra na fatura seguinte.` }));

  const months = table(['Mês', 'Gasto (em reais)', 'Mensalidade', '% do gasto', 'Total', 'Situação'], data.months.map((e) => h('tr', null,
    h('td', { 'data-label': 'Mês' }, monthLabel(e.period)),
    h('td', { 'data-label': 'Gasto (em reais)', class: 'num' }, formatBrl(e.spendCents), ...breakdownLines(e), unconvertedNote(e, 'Gasto em moeda sem cotação ainda: o administrador acerta')),
    h('td', { 'data-label': 'Mensalidade', class: 'num' }, formatBrl(e.monthlyFeeCents)),
    h('td', { 'data-label': '% do gasto', class: 'num' }, `${formatPercentBp(e.percentBp)} = ${formatBrl(e.percentFeeCents)}`),
    h('td', { 'data-label': 'Total', class: 'num' }, h('strong', null, formatBrl(e.totalCents))),
    h('td', { 'data-label': 'Situação' }, e.closed ? badge('Fechado', 'neutral') : badge('Em andamento', 'warning')))));

  const payments = data.payments.length
    ? table(['Data', 'Valor', 'Observação'], data.payments.map((p) => h('tr', null, h('td', { 'data-label': 'Data' }, dateOnly(p.paidAt)), h('td', { 'data-label': 'Valor', class: 'num' }, formatBrl(p.amountCents)), h('td', { 'data-label': 'Observação' }, p.note ?? '—'))))
    : h('p', { class: 'muted' }, 'Nenhum pagamento registrado ainda.');

  return {
    element: h('div', { class: 'billing' },
      pageHeader('Plano e cobrança', 'O seu plano combinado, o gasto do mês e as faturas. Tudo em reais (R$).'),
      h('div', { class: 'kpis', role: 'group', 'aria-label': 'Resumo' }, cards),
      owesInvoices ? h('p', { class: 'alert alert--warning', role: 'status' }, `Você tem ${formatBrl(data.openInvoicesCents)} em faturas para pagar. Cada fatura vence ${INVOICE_DUE_DAYS} dias depois de emitida; assim que o pagamento for confirmado, ela aparece como paga aqui. Se você remover uma Business Center com dívida pendente, ela fica bloqueada para outras contas até a regularização.`) : null,
      h('section', { class: 'billing-section' }, h('h2', { class: 'form-section__title' }, 'Faturas'), invoices),
      h('section', { class: 'billing-section' }, h('h2', { class: 'form-section__title' }, 'Meses'), months),
      h('section', { class: 'billing-section' }, h('h2', { class: 'form-section__title' }, 'Pagamentos'), payments),
      h('p', { class: 'hub__note' }, `O mês vai do dia 1 ao último dia em horário UTC e fecha 2 dias depois de acabar (o TikTok ainda ajusta os números das últimas horas). A fatura só é emitida quando o total dos meses fechados chega a ${formatBrl(data.invoiceMinCents)}; abaixo disso o valor passa para a fatura seguinte. Contas de anúncio em outra moeda (dólar, euro…) têm o gasto convertido para real: o mês em andamento usa a cotação de hoje e, ao fechar, a cotação daquele momento fica guardada. O gasto é guardado hora a hora: remover uma Business Center não apaga nem reduz o que já foi gasto.`)),
  };
}
