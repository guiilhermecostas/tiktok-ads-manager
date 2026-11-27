import { LOCK_KINDS, PLAN_EFFECTIVE, chargeFor, formatBrl, formatPercentBp, formatRate, monthLabel, planSummary, validateInvoicePayInput, validatePaymentInput, validatePlanInput, validateRateInput } from '/shared/billing.js';
import { del, get, post, put } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, toast } from '../ui.js';
import { adminNav } from './admin-nav.js';
import { INVOICE_STATUS, breakdownLines, invoicePeriod, unconvertedNote } from './billing.js';
import { pageHeader } from './layout.js';

/**
 * Administração → Assinaturas (tudo em REAL): o plano de cada pessoa (mensalidade + % do gasto, negociável), o gasto do mês, as FATURAS (marcar como paga quando o
 * cliente pagou por fora), registrar pagamentos avulsos, ver o extrato, as BCs bloqueadas por débito e as cotações para converter outras moedas em real
 * (automáticas, ou fixadas à mão). Todo texto entra como nó de texto.
 */
const whenText = (iso) => new Date(iso).toLocaleDateString('pt-BR');
const dateOnly = (text) => new Date(`${text}T12:00:00Z`).toLocaleDateString('pt-BR');

export async function adminBillingView() {
  const container = h('div');
  let data = null;

  async function load() {
    data = await get('/admin/billing');
    const { locks } = await get('/admin/billing/locks');
    setChildren(container, draw(locks));
  }
  async function reload() {
    try {
      await load();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- diálogos ----------
  function formDialog({ title, fields, submitLabel, hint, preview, onSubmit }) {
    const error = h('div', { 'aria-live': 'polite' });
    const submit = button(submitLabel, { variant: 'primary', type: 'submit' });
    const previewBox = preview ? h('p', { class: 'billing-preview muted' }) : null;
    const modal = openModal({
      title,
      body: h('form', {
        class: 'form modal__body',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          setChildren(error);
          submit.disabled = true;
          try {
            await onSubmit();
            modal.close();
          } catch (err) {
            setChildren(error, alertBox(err.message));
            submit.disabled = false;
          }
        },
      }, error, fields.map((f) => f.element), hint ? h('p', { class: 'field__hint' }, hint) : null, previewBox,
      h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit)),
    });
    if (preview) {
      const paint = () => { previewBox.textContent = preview(); };
      for (const f of fields) f.control.addEventListener('input', paint);
      paint();
    }
    fields[0].control.focus();
    return modal;
  }

  function planDialog(user) {
    const fee = field('Mensalidade (R$)', { type: 'text', inputmode: 'decimal', value: user.plan ? String(user.plan.monthlyFeeCents / 100).replace('.', ',') : '0', autocomplete: 'off' });
    const percent = field('Percentual do gasto em anúncios (%)', { type: 'text', inputmode: 'decimal', value: user.plan ? String(user.plan.percentBp / 100).replace('.', ',') : '0', autocomplete: 'off' });
    const effective = field('Vale a partir de', { as: 'select', options: Object.entries(PLAN_EFFECTIVE) });
    const note = field('Observação (opcional)', { type: 'text', maxlength: 200, placeholder: 'Ex.: acordo fechado em novembro' });
    formDialog({
      title: `Plano de ${user.name}`,
      fields: [fee, percent, effective, note],
      submitLabel: 'Salvar plano',
      hint: 'Tudo em reais. "Este mês" vale o mês inteiro (inclusive o que já foi gasto); "Próximo mês" não muda o mês atual.',
      preview: () => {
        const parsed = validatePlanInput({ monthlyFee: fee.control.value, percent: percent.control.value, effective: effective.control.value }).value;
        if (!parsed) return 'Confira a mensalidade e o percentual.';
        const example = chargeFor({ spendCents: 100000, monthlyFeeCents: parsed.monthlyFeeCents, percentBp: parsed.percentBp });
        return `${planSummary(parsed)}. Exemplo: gastando ${formatBrl(100000)} (em reais) no mês, a cobrança é ${formatBrl(example.totalCents)}.`;
      },
      onSubmit: async () => {
        const { errors } = validatePlanInput({ monthlyFee: fee.control.value, percent: percent.control.value, effective: effective.control.value, note: note.control.value });
        if (errors.length) throw new Error(errors[0].message);
        await put(`/admin/billing/users/${user.id}/plan`, { monthlyFee: fee.control.value, percent: percent.control.value, effective: effective.control.value, note: note.control.value });
        toast(`Plano de ${user.name} salvo.`);
        await reload();
      },
    });
  }

  function paymentDialog(user) {
    const amount = field('Valor recebido (R$)', { type: 'text', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
    const paidAt = field('Data do pagamento', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const note = field('Observação (opcional)', { type: 'text', maxlength: 200, placeholder: 'Ex.: PIX, transferência' });
    formDialog({
      title: `Pagamento avulso de ${user.name}`,
      fields: [amount, paidAt, note],
      submitLabel: 'Registrar pagamento',
      hint: `Para quitar uma fatura, use "Faturas" e "Marcar como paga". Este pagamento avulso abate o saldo (e quita as faturas da mais antiga para a mais nova). Em aberto agora: ${formatBrl(user.debtCents)}. Pagamentos não podem ser apagados; ficam no extrato e no registro de ações.`,
      onSubmit: async () => {
        const raw = { amount: amount.control.value, paidAt: paidAt.control.value, note: note.control.value };
        const { errors } = validatePaymentInput(raw);
        if (errors.length) throw new Error(errors[0].message);
        const result = await post(`/admin/billing/users/${user.id}/payments`, raw);
        toast(result.debtCents === 0 ? 'Pagamento registrado. Nada em aberto.' : `Pagamento registrado. Em aberto: ${formatBrl(result.debtCents)}.`);
        await reload();
      },
    });
  }

  /** Tabela de faturas (somente leitura) para o extrato. */
  function invoicesTable(list) {
    if (!list.length) return h('p', { class: 'muted' }, 'Nenhuma fatura emitida ainda.');
    return h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, ['Fatura', 'Período', 'Valor', 'Vencimento', 'Situação'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, [...list].reverse().map((i) => {
        const [label, tone] = INVOICE_STATUS[i.status] ?? [i.status, 'neutral'];
        return h('tr', null, h('td', null, `Nº ${i.id}`), h('td', null, invoicePeriod(i)), h('td', { class: 'num' }, formatBrl(i.amountCents)), h('td', null, dateOnly(i.dueDate)), h('td', null, badge(label, tone)));
      }))));
  }

  /** Pop-up "Faturas" da pessoa: marcar a fatura mais antiga em aberto como paga (o cliente pagou por fora) ou registrar um pagamento avulso. */
  async function invoicesDialog(user) {
    let detail;
    try {
      detail = await get(`/admin/billing/users/${user.id}`);
    } catch (err) {
      return toast(err.message, 'danger');
    }
    const firstOpen = detail.invoices.find((i) => i.status !== 'paid') ?? null;
    const rows = detail.invoices.length
      ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Fatura', 'Período', 'Valor', 'Vencimento', 'Situação', ''].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, [...detail.invoices].reverse().map((i) => {
          const [label, tone] = INVOICE_STATUS[i.status] ?? [i.status, 'neutral'];
          const canPay = firstOpen?.id === i.id;
          return h('tr', null,
            h('td', null, `Nº ${i.id}`), h('td', null, invoicePeriod(i)),
            h('td', { class: 'num' }, formatBrl(i.amountCents), i.paidCents > 0 && i.status !== 'paid' ? h('span', { class: 'acc-id' }, `pago ${formatBrl(i.paidCents)} · falta ${formatBrl(i.remainingCents)}`) : null),
            h('td', null, dateOnly(i.dueDate)), h('td', null, badge(label, tone)),
            h('td', null, i.status === 'paid' ? '—' : button('Marcar como paga', { small: true, variant: canPay ? 'primary' : 'secondary', disabled: !canPay, ariaLabel: `Marcar a fatura nº ${i.id} como paga`, onClick: () => { modal.close(); payInvoiceDialog(user, i); } })));
        }))))
      : h('p', { class: 'muted' }, 'Nenhuma fatura emitida ainda. Ela é emitida quando um mês fecha e o acumulado chega a R$ 50,00.');
    const modal = openModal({
      title: `Faturas de ${user.name}`,
      size: 'wide',
      body: h('div', { class: 'modal__body billing-statement' },
        h('p', { class: 'muted' }, `A pagar em faturas: ${formatBrl(detail.openInvoicesCents)} · Acumulando (ainda sem fatura): ${formatBrl(detail.accruedCents)}. As faturas são quitadas da mais antiga para a mais nova; por isso só a mais antiga em aberto pode ser marcada.`),
        rows,
        h('div', { class: 'modal__footer' }, button('Pagamento avulso', { onClick: () => { modal.close(); paymentDialog(user); } }), button('Fechar', { variant: 'primary', onClick: () => modal.close() }))),
    });
    return undefined;
  }

  function payInvoiceDialog(user, invoice) {
    const paidAt = field('Data do pagamento', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const note = field('Observação (opcional)', { type: 'text', maxlength: 200, placeholder: 'Ex.: PIX recebido, pagou por fora' });
    formDialog({
      title: `Marcar a fatura nº ${invoice.id} como paga`,
      fields: [paidAt, note],
      submitLabel: `Marcar como paga (${formatBrl(invoice.remainingCents)})`,
      hint: `Registra o pagamento de ${formatBrl(invoice.remainingCents)} (o que falta desta fatura) para ${user.name}. Fica no extrato e no registro de ações e não pode ser apagado.`,
      onSubmit: async () => {
        const raw = { paidAt: paidAt.control.value, note: note.control.value };
        const { errors } = validateInvoicePayInput(raw);
        if (errors.length) throw new Error(errors[0].message);
        const result = await post(`/admin/billing/users/${user.id}/invoices/${invoice.id}/pay`, raw);
        toast(`Fatura nº ${invoice.id} paga.${result.debtCents === 0 ? ' Nada em aberto.' : ''}`);
        await reload();
        invoicesDialog(user);
      },
    });
  }

  async function statementDialog(user) {
    let detail;
    try {
      detail = await get(`/admin/billing/users/${user.id}`);
    } catch (err) {
      return toast(err.message, 'danger');
    }
    const months = detail.months.length
      ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Mês', 'Gasto', 'Mensalidade', '% do gasto', 'Total', 'Situação'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, detail.months.map((e) => h('tr', null,
          h('td', null, monthLabel(e.period)),
          h('td', { class: 'num' }, formatBrl(e.spendCents), ...breakdownLines(e), e.unconverted.length ? h('span', { class: 'acc-id' }, `+ sem cotação: ${e.unconverted.map((u) => `${u.currency} ${u.spend}`).join(', ')}`) : null),
          h('td', { class: 'num' }, formatBrl(e.monthlyFeeCents)),
          h('td', { class: 'num' }, `${formatPercentBp(e.percentBp)} = ${formatBrl(e.percentFeeCents)}`),
          h('td', { class: 'num' }, h('strong', null, formatBrl(e.totalCents))),
          h('td', null, e.closed ? badge('Fechado', 'neutral') : badge('Em andamento', 'warning')))))))
      : h('p', { class: 'muted' }, 'Sem plano definido: nada é cobrado.');
    const payments = detail.payments.length
      ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Data', 'Valor', 'Observação', 'Registrado por'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, detail.payments.map((p) => h('tr', null, h('td', null, dateOnly(p.paidAt)), h('td', { class: 'num' }, formatBrl(p.amountCents)), h('td', null, p.note ?? '—'), h('td', { class: 'muted' }, p.registeredByName ?? '—'))))))
      : h('p', { class: 'muted' }, 'Nenhum pagamento registrado.');
    openModal({
      title: `Extrato de ${user.name}`,
      size: 'wide',
      body: h('div', { class: 'modal__body billing-statement' },
        h('p', null, h('strong', null, planSummary(detail.plan)), detail.nextPlan ? ` · a partir de ${monthLabel(detail.nextPlan.effectiveMonth)}: ${planSummary(detail.nextPlan)}` : ''),
        h('p', { class: 'muted' }, `Cobrado: ${formatBrl(detail.chargedCents)} · Pago: ${formatBrl(detail.paidCents)} · ${detail.balanceCents < 0 ? `Crédito: ${formatBrl(-detail.balanceCents)}` : `Em aberto: ${formatBrl(detail.debtCents)}`}`),
        h('h3', { class: 'form-section__title' }, 'Faturas'), invoicesTable(detail.invoices),
        h('h3', { class: 'form-section__title' }, 'Meses'), months,
        h('h3', { class: 'form-section__title' }, 'Pagamentos'), payments),
    });
    return undefined;
  }

  async function releaseLock(lock) {
    const ok = await confirmDialog({ title: 'Liberar bloqueio', message: `Liberar ${lock.kind === 'bc' ? 'a BC' : 'a conta'} ${lock.value}? Qualquer pessoa poderá conectá-la, mesmo com a dívida de ${lock.ownerName} em aberto.`, confirmLabel: 'Liberar', danger: true });
    if (!ok) return;
    try {
      await post(`/admin/billing/locks/${lock.id}/release`);
      toast('Bloqueio liberado.');
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- desenho ----------
  const card = (label, value, hint, tone) => h('div', { class: `kpi kpi--static${tone ? ` kpi--${tone}` : ''}` }, h('span', { class: 'kpi__label' }, label), h('strong', { class: 'kpi__value' }, value), h('span', { class: 'kpi__hint muted' }, hint ?? ''));

  function usersTable() {
    if (!data.users.length) return h('div', { class: 'card' }, emptyState({ title: 'Nenhuma conta ainda', text: 'Quando houver contas aprovadas, o plano de cada uma é definido aqui.' }));
    return h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
      h('thead', null, h('tr', null, ['Pessoa', 'Plano', 'Gasto no mês', 'Cobrança do mês', 'Faturas a pagar', 'Em aberto', 'Bloqueios', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, data.users.map((u) => h('tr', null,
        h('td', { 'data-label': 'Pessoa' }, h('span', { class: 'cell-strong' }, u.name), h('span', { class: 'acc-id' }, u.email), u.status === 'blocked' ? badge('Bloqueada', 'danger') : null),
        h('td', { 'data-label': 'Plano' }, planSummary(u.plan), u.nextPlan ? h('span', { class: 'acc-id' }, `Depois: ${planSummary(u.nextPlan)}`) : null),
        h('td', { 'data-label': 'Gasto no mês', class: 'num' }, formatBrl(u.monthSpendCents), unconvertedNote(u, 'Gasto em outra moeda sem cotação: não entra na cobrança')),
        h('td', { 'data-label': 'Cobrança do mês', class: 'num' }, formatBrl(u.monthChargeCents)),
        h('td', { 'data-label': 'Faturas a pagar', class: `num${u.openInvoicesCents > 0 ? ' billing-debt' : ''}` }, formatBrl(u.openInvoicesCents), u.openInvoices ? h('span', { class: 'acc-id' }, `${u.openInvoices} ${u.openInvoices === 1 ? 'fatura' : 'faturas'}`) : null),
        h('td', { 'data-label': 'Em aberto', class: `num${u.debtCents > 0 ? ' billing-debt' : ''}` }, formatBrl(u.debtCents)),
        h('td', { 'data-label': 'Bloqueios', class: 'num' }, u.locks ? badge(String(u.locks), 'danger') : '—'),
        h('td', { 'data-label': 'Ações' }, h('div', { class: 'cell-actions' },
          button('Plano', { small: true, variant: 'primary', onClick: () => planDialog(u) }),
          button('Faturas', { small: true, onClick: () => invoicesDialog(u) }),
          button('Extrato', { small: true, onClick: () => statementDialog(u) }))))))));
  }

  function locksSection(locks) {
    return h('section', { class: 'billing-section' },
      h('h2', { class: 'form-section__title' }, 'BCs e contas bloqueadas por débito'),
      h('p', { class: 'muted' }, 'Quando alguém remove a Business Center com dívida em aberto, ela (e as contas dela) não pode ser conectada por outra pessoa. O bloqueio cai sozinho quando a dívida é paga, ou se você liberar aqui.'),
      locks.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['O que', 'ID', 'Dívida da dona', 'Desde', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, locks.map((l) => h('tr', null,
            h('td', { 'data-label': 'O que' }, LOCK_KINDS[l.kind]),
            h('td', { 'data-label': 'ID' }, h('span', { class: 'acc-id' }, l.value)),
            h('td', { 'data-label': 'Dívida da dona' }, h('span', { class: 'cell-strong' }, l.ownerName), h('span', { class: 'acc-id' }, `${formatBrl(l.debtCentsAtLock)} quando removeu`)),
            h('td', { 'data-label': 'Desde', class: 'muted' }, whenText(l.createdAt)),
            h('td', { 'data-label': 'Ações' }, button('Liberar', { small: true, variant: 'danger-ghost', onClick: () => releaseLock(l) })))))))
        : h('div', { class: 'card' }, emptyState({ title: 'Nenhum bloqueio', text: 'Nenhuma BC foi removida com dívida em aberto.' })));
  }

  async function refreshRates(trigger) {
    trigger.disabled = true;
    try {
      const { result } = await post('/admin/billing/rates/refresh');
      toast(result.updated ? `Cotações atualizadas (${result.updated}).` : 'Cotações já estavam em dia.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    await reload();
  }

  async function clearRate(rate) {
    const ok = await confirmDialog({ title: 'Voltar para a cotação automática', message: `Remover a cotação fixada de ${rate.currency}? A cotação automática volta no próximo ciclo (ou clicando em "Atualizar cotações agora").`, confirmLabel: 'Remover cotação fixada' });
    if (!ok) return;
    try {
      await del(`/admin/billing/rates/${rate.currency}`);
      toast(`Cotação de ${rate.currency} removida.`);
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function ratesSection() {
    const currency = field('Moeda', { type: 'text', maxlength: 3, placeholder: 'USD', autocomplete: 'off' });
    currency.control.style.textTransform = 'uppercase';
    const rate = field('1 unidade vale (R$)', { type: 'text', inputmode: 'decimal', placeholder: '5,43', autocomplete: 'off' });
    const error = h('div', { 'aria-live': 'polite' });
    async function onSubmit(event) {
      event.preventDefault();
      setChildren(error);
      const code = currency.control.value.trim().toUpperCase();
      const { errors } = validateRateInput(code, { brlPerUnit: rate.control.value });
      if (errors.length) return setChildren(error, alertBox(errors[0].message));
      try {
        await put(`/admin/billing/rates/${code}`, { brlPerUnit: rate.control.value });
        toast(`Cotação de ${code} fixada.`);
        await reload();
      } catch (err) {
        setChildren(error, alertBox(err.message));
      }
      return undefined;
    }
    const fx = data.fx;
    const refresh = button('Atualizar cotações agora', { small: true, disabled: !fx.enabled, onClick: (event) => refreshRates(event.currentTarget) });
    const statusText = !fx.enabled
      ? 'Atualização automática desligada neste servidor: só valem as cotações fixadas à mão.'
      : fx.lastError
        ? `Última tentativa falhou (${fx.lastError}). As cotações guardadas continuam valendo.`
        : fx.lastOkAt ? `Atualizadas automaticamente em ${new Date(fx.lastOkAt).toLocaleString('pt-BR')}.` : 'Atualizadas sozinhas a cada 6 horas (ainda não houve atualização desde que o servidor ligou).';
    return h('section', { class: 'billing-section' },
      h('h2', { class: 'form-section__title' }, 'Câmbio (outras moedas para reais)'),
      h('p', { class: 'muted' }, 'A cobrança é sempre em reais. O gasto das contas em outra moeda (dólar, euro…) é convertido pela cotação abaixo: o mês em andamento usa a cotação de agora e, ao fechar, a cotação daquele momento fica guardada. As cotações vêm de uma fonte pública (sem enviar nenhum dado seu); você pode fixar uma à mão e ela nunca é sobrescrita. Sem cotação, o gasto naquela moeda não entra na conta e é avisado.'),
      h('p', { class: `billing-fx ${fx.lastError ? 'billing-fx--error' : ''}`, role: 'status' }, statusText, ' ', refresh),
      data.rates.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Moeda', 'Vale em reais', 'Origem', 'Atualizada em', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, data.rates.map((r) => h('tr', null,
            h('td', { 'data-label': 'Moeda' }, h('strong', null, r.currency)),
            h('td', { 'data-label': 'Vale em reais', class: 'num' }, `1 ${r.currency} = ${formatRate(r.brlPerUnit)}`),
            h('td', { 'data-label': 'Origem' }, r.source === 'manual' ? badge('Fixada à mão', 'warning') : badge('Automática', 'success')),
            h('td', { 'data-label': 'Atualizada em', class: 'muted' }, whenText(r.updatedAt)),
            h('td', { 'data-label': 'Ações' }, r.source === 'manual' ? button('Voltar para automática', { small: true, variant: 'danger-ghost', onClick: () => clearRate(r) }) : null))))))
        : h('div', { class: 'card' }, emptyState({ title: 'Nenhuma cotação ainda', text: 'Clique em "Atualizar cotações agora" para buscar, ou fixe uma à mão abaixo.' })),
      h('h3', { class: 'form-section__title' }, 'Fixar uma cotação à mão'),
      h('form', { class: 'card card--pad billing-rate-form', novalidate: true, onSubmit }, error, h('div', { class: 'billing-rate-form__row' }, currency.element, rate.element, button('Fixar cotação', { variant: 'primary', type: 'submit' }))));
  }

  function draw(locks) {
    const t = data.totals;
    return h('div', null,
      pageHeader('Administração', 'Planos, cobrança em reais, faturas, câmbio e bloqueios de BC com débito.'),
      adminNav('/admin/billing'),
      h('div', { class: 'kpis', role: 'group', 'aria-label': 'Resumo da cobrança' },
        card('Com plano', String(t.billed), `de ${data.users.length} ${data.users.length === 1 ? 'conta' : 'contas'}`),
        card(`Cobrança de ${monthLabel(data.currentMonth)}`, formatBrl(t.monthChargeCents), 'mensalidades + % do gasto até agora'),
        card('Faturas a pagar', formatBrl(t.openInvoicesCents), 'emitidas e ainda não pagas', t.openInvoicesCents > 0 ? 'warn' : null),
        card('Em aberto', formatBrl(t.debtCents), 'cobrado e ainda não pago (inclui o mês em andamento)', t.debtCents > 0 ? 'warn' : null),
        card('Bloqueios', String(locks.length), 'BCs e contas bloqueadas')),
      usersTable(), locksSection(locks), ratesSection());
  }

  await load();
  return { element: container };
}
