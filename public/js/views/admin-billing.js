import { LOCK_KINDS, PLAN_EFFECTIVE, chargeFor, formatPercentBp, formatUsd, monthLabel, planSummary, validatePaymentInput, validatePlanInput, validateRateInput } from '/shared/billing.js';
import { get, post, put } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, toast } from '../ui.js';
import { adminNav } from './admin-nav.js';
import { pageHeader } from './layout.js';

/**
 * Administração → Assinaturas (tudo em DÓLAR): o plano de cada pessoa (mensalidade + % do gasto, negociável), o gasto do mês, o que está em aberto,
 * registrar pagamentos, ver o extrato, as BCs bloqueadas por débito e as cotações para converter outras moedas. Todo texto entra como nó de texto.
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
    const fee = field('Mensalidade (US$)', { type: 'text', inputmode: 'decimal', value: user.plan ? String(user.plan.monthlyFeeCents / 100).replace('.', ',') : '0', autocomplete: 'off' });
    const percent = field('Percentual do gasto em anúncios (%)', { type: 'text', inputmode: 'decimal', value: user.plan ? String(user.plan.percentBp / 100).replace('.', ',') : '0', autocomplete: 'off' });
    const effective = field('Vale a partir de', { as: 'select', options: Object.entries(PLAN_EFFECTIVE) });
    const note = field('Observação (opcional)', { type: 'text', maxlength: 200, placeholder: 'Ex.: acordo fechado em novembro' });
    formDialog({
      title: `Plano de ${user.name}`,
      fields: [fee, percent, effective, note],
      submitLabel: 'Salvar plano',
      hint: 'Tudo em dólar. "Este mês" vale o mês inteiro (inclusive o que já foi gasto); "Próximo mês" não muda o mês atual.',
      preview: () => {
        const parsed = validatePlanInput({ monthlyFee: fee.control.value, percent: percent.control.value, effective: effective.control.value }).value;
        if (!parsed) return 'Confira a mensalidade e o percentual.';
        const example = chargeFor({ spendCents: 100000, monthlyFeeCents: parsed.monthlyFeeCents, percentBp: parsed.percentBp });
        return `${planSummary(parsed)}. Exemplo: gastando ${formatUsd(100000)} no mês, a cobrança é ${formatUsd(example.totalCents)}.`;
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
    const amount = field('Valor recebido (US$)', { type: 'text', inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off' });
    const paidAt = field('Data do pagamento', { type: 'date', value: new Date().toISOString().slice(0, 10) });
    const note = field('Observação (opcional)', { type: 'text', maxlength: 200, placeholder: 'Ex.: transferência, USDT, PIX convertido' });
    formDialog({
      title: `Registrar pagamento de ${user.name}`,
      fields: [amount, paidAt, note],
      submitLabel: 'Registrar pagamento',
      hint: `Em aberto agora: ${formatUsd(user.debtCents)}. Pagamentos não podem ser apagados; ficam no extrato e no registro de ações.`,
      onSubmit: async () => {
        const raw = { amount: amount.control.value, paidAt: paidAt.control.value, note: note.control.value };
        const { errors } = validatePaymentInput(raw);
        if (errors.length) throw new Error(errors[0].message);
        const result = await post(`/admin/billing/users/${user.id}/payments`, raw);
        toast(result.debtCents === 0 ? 'Pagamento registrado. Nada em aberto.' : `Pagamento registrado. Em aberto: ${formatUsd(result.debtCents)}.`);
        await reload();
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
          h('td', { class: 'num' }, formatUsd(e.spendCents), e.unconverted.length ? h('span', { class: 'acc-id' }, `+ não convertido: ${e.unconverted.map((u) => `${u.currency} ${u.spend}`).join(', ')}`) : null),
          h('td', { class: 'num' }, formatUsd(e.monthlyFeeCents)),
          h('td', { class: 'num' }, `${formatPercentBp(e.percentBp)} = ${formatUsd(e.percentFeeCents)}`),
          h('td', { class: 'num' }, h('strong', null, formatUsd(e.totalCents))),
          h('td', null, e.closed ? badge('Fechado', 'neutral') : badge('Em andamento', 'warning')))))))
      : h('p', { class: 'muted' }, 'Sem plano definido: nada é cobrado.');
    const payments = detail.payments.length
      ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ['Data', 'Valor', 'Observação', 'Registrado por'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', null, detail.payments.map((p) => h('tr', null, h('td', null, dateOnly(p.paidAt)), h('td', { class: 'num' }, formatUsd(p.amountCents)), h('td', null, p.note ?? '—'), h('td', { class: 'muted' }, p.registeredByName ?? '—'))))))
      : h('p', { class: 'muted' }, 'Nenhum pagamento registrado.');
    openModal({
      title: `Extrato de ${user.name}`,
      size: 'lg',
      body: h('div', { class: 'modal__body billing-statement' },
        h('p', null, h('strong', null, planSummary(detail.plan)), detail.nextPlan ? ` · a partir de ${monthLabel(detail.nextPlan.effectiveMonth)}: ${planSummary(detail.nextPlan)}` : ''),
        h('p', { class: 'muted' }, `Cobrado: ${formatUsd(detail.chargedCents)} · Pago: ${formatUsd(detail.paidCents)} · ${detail.balanceCents < 0 ? `Crédito: ${formatUsd(-detail.balanceCents)}` : `Em aberto: ${formatUsd(detail.debtCents)}`}`),
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
      h('thead', null, h('tr', null, ['Pessoa', 'Plano', 'Gasto no mês', 'Cobrança do mês', 'Em aberto', 'Bloqueios', ''].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', null, data.users.map((u) => h('tr', null,
        h('td', { 'data-label': 'Pessoa' }, h('span', { class: 'cell-strong' }, u.name), h('span', { class: 'acc-id' }, u.email), u.status === 'blocked' ? badge('Bloqueada', 'danger') : null),
        h('td', { 'data-label': 'Plano' }, planSummary(u.plan), u.nextPlan ? h('span', { class: 'acc-id' }, `Depois: ${planSummary(u.nextPlan)}`) : null),
        h('td', { 'data-label': 'Gasto no mês', class: 'num' }, formatUsd(u.monthSpendCents), u.unconverted.length ? h('span', { class: 'acc-id', title: 'Gasto em outra moeda sem cotação cadastrada: não entra na cobrança' }, `não convertido: ${u.unconverted.map((x) => x.currency).join(', ')}`) : null),
        h('td', { 'data-label': 'Cobrança do mês', class: 'num' }, formatUsd(u.monthChargeCents)),
        h('td', { 'data-label': 'Em aberto', class: `num${u.debtCents > 0 ? ' billing-debt' : ''}` }, formatUsd(u.debtCents)),
        h('td', { 'data-label': 'Bloqueios', class: 'num' }, u.locks ? badge(String(u.locks), 'danger') : '—'),
        h('td', { 'data-label': 'Ações' }, h('div', { class: 'cell-actions' },
          button('Plano', { small: true, variant: 'primary', onClick: () => planDialog(u) }),
          button('Pagamento', { small: true, onClick: () => paymentDialog(u) }),
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
            h('td', { 'data-label': 'Dívida da dona' }, h('span', { class: 'cell-strong' }, l.ownerName), h('span', { class: 'acc-id' }, `${formatUsd(l.debtCentsAtLock)} quando removeu`)),
            h('td', { 'data-label': 'Desde', class: 'muted' }, whenText(l.createdAt)),
            h('td', { 'data-label': 'Ações' }, button('Liberar', { small: true, variant: 'danger-ghost', onClick: () => releaseLock(l) })))))))
        : h('div', { class: 'card' }, emptyState({ title: 'Nenhum bloqueio', text: 'Nenhuma BC foi removida com dívida em aberto.' })));
  }

  function ratesSection() {
    const currency = field('Moeda', { type: 'text', maxlength: 3, placeholder: 'BRL', autocomplete: 'off' });
    currency.control.style.textTransform = 'uppercase';
    const rate = field('1 unidade vale (US$)', { type: 'text', inputmode: 'decimal', placeholder: '0,18', autocomplete: 'off' });
    const error = h('div', { 'aria-live': 'polite' });
    async function onSubmit(event) {
      event.preventDefault();
      setChildren(error);
      const code = currency.control.value.trim().toUpperCase();
      const { errors } = validateRateInput(code, { usdPerUnit: rate.control.value });
      if (errors.length) return setChildren(error, alertBox(errors[0].message));
      try {
        await put(`/admin/billing/rates/${code}`, { usdPerUnit: rate.control.value });
        toast(`Cotação de ${code} salva.`);
        await reload();
      } catch (err) {
        setChildren(error, alertBox(err.message));
      }
      return undefined;
    }
    return h('section', { class: 'billing-section' },
      h('h2', { class: 'form-section__title' }, 'Cotações (outras moedas para dólar)'),
      h('p', { class: 'muted' }, 'A cobrança é sempre em dólar. Contas de anúncio em outra moeda só entram na conta com uma cotação cadastrada aqui (o dólar vale 1).'),
      data.rates.length ? h('p', { class: 'billing-rates' }, data.rates.map((r) => badge(`1 ${r.currency} = US$ ${r.usdPerUnit}`, 'neutral'))) : null,
      h('form', { class: 'card card--pad billing-rate-form', novalidate: true, onSubmit }, error, h('div', { class: 'billing-rate-form__row' }, currency.element, rate.element, button('Salvar cotação', { variant: 'primary', type: 'submit' }))));
  }

  function draw(locks) {
    const t = data.totals;
    return h('div', null,
      pageHeader('Administração', 'Planos, cobrança em dólar, pagamentos e bloqueios de BC com débito.'),
      adminNav('/admin/billing'),
      h('div', { class: 'kpis', role: 'group', 'aria-label': 'Resumo da cobrança' },
        card('Com plano', String(t.billed), `de ${data.users.length} ${data.users.length === 1 ? 'conta' : 'contas'}`),
        card(`Cobrança de ${monthLabel(data.currentMonth)}`, formatUsd(t.monthChargeCents), 'mensalidades + % do gasto até agora'),
        card('Em aberto', formatUsd(t.debtCents), 'cobrado e ainda não pago', t.debtCents > 0 ? 'warn' : null),
        card('Bloqueios', String(locks.length), 'BCs e contas bloqueadas')),
      usersTable(), locksSection(locks), ratesSection());
  }

  await load();
  return { element: container };
}
