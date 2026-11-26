import { BILLING_TYPES, HISTORY_FILTERS, HISTORY_RANGES, signOf, typeLabel } from '/shared/balance-history.js';
import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { alertBox, badge, button, emptyState, openModal, spinner } from '../../ui.js';
import { money } from './list.js';

/** "2026-11-20 10:00:00" → "20/11/2026 10:00". Troca só o texto (sem criar Date), então o horário nunca "anda" por causa do fuso do navegador. */
export function formatStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(text ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : '—';
}

/** Valor com sinal: depósitos em verde (+), saídas em vermelho (−), neutro sem sinal. O TikTok manda o valor positivo; quem diz se entra ou sai é o tipo. */
function amountCell(t) {
  const sign = signOf(t.amountType);
  const text = money(Math.abs(t.amount), t.currency);
  return h('span', { class: `bal-tx bal-tx--${sign > 0 ? 'in' : sign < 0 ? 'out' : 'neutral'}` }, sign > 0 ? '+ ' : sign < 0 ? '− ' : '', text);
}

/**
 * Janela com o histórico de depósitos de UMA Business Center ou de UMA conta de anúncio.
 *  - `kind`: 'bc' | 'account'; `connectionId` e (`bcId` | `advertiserId`) dizem qual; o servidor confere que são do usuário.
 *  - Filtros: só depósitos (padrão) ou todas as movimentações; últimos 90 dias, 6 ou 12 meses. "Carregar mais" traz a próxima página.
 * Todo texto entra como nó de texto (nunca HTML).
 */
export function openHistoryDialog({ kind, connectionId, bcId = null, advertiserId = null, name, id }) {
  const st = { filter: 'deposits', range: 90, items: [], page: 0, totalNumber: 0, totalPages: 1, loading: false, error: null };
  let loadId = 0;

  const filterBar = h('div', { class: 'bal-hist__filters' });
  const list = h('div', { class: 'bal-hist__list', 'aria-live': 'polite' });
  const footer = h('div', { class: 'bal-hist__footer' });

  const params = (page) => {
    const q = new URLSearchParams({ kind, connectionId: String(connectionId), range: String(st.range), filter: st.filter, page: String(page) });
    if (kind === 'bc') q.set('bcId', bcId);
    else q.set('advertiserId', advertiserId);
    return q;
  };

  async function load({ more = false } = {}) {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    if (!more) {
      st.items = [];
      st.page = 0;
    }
    draw();
    try {
      const data = await get(`/tiktok/balance/history?${params(st.page + 1)}`);
      if (current !== loadId) return;
      st.items = more ? [...st.items, ...data.transactions] : data.transactions;
      Object.assign(st, { page: data.page, totalNumber: data.totalNumber, totalPages: data.totalPages });
    } catch (err) {
      if (current === loadId) st.error = err.message || 'Não foi possível carregar o histórico.';
    } finally {
      if (current === loadId) {
        st.loading = false;
        draw();
      }
    }
  }

  function drawFilters() {
    const range = h('select', { class: 'input input--filter', 'aria-label': 'Período', onChange: (e) => { st.range = Number(e.target.value); load(); } }, HISTORY_RANGES.map(([days, label]) => h('option', { value: String(days) }, label)));
    range.value = String(st.range);
    setChildren(filterBar,
      h('div', { class: 'bal-chips', role: 'group', 'aria-label': 'Tipo de movimentação' }, HISTORY_FILTERS.map(([key, label]) =>
        h('button', { type: 'button', class: `bal-chip${st.filter === key ? ' is-on' : ''}`, 'aria-pressed': String(st.filter === key), onClick: () => { if (st.filter === key) return; st.filter = key; drawFilters(); load(); } }, label))),
      range);
  }

  function draw() {
    if (st.error) {
      setChildren(list, alertBox(st.error, 'warning'));
      setChildren(footer, button('Tentar de novo', { onClick: () => load({ more: st.page > 0 }) }));
      return;
    }
    if (st.loading && !st.items.length) {
      setChildren(list, spinner());
      setChildren(footer);
      return;
    }
    if (!st.items.length) {
      const rangeLabel = HISTORY_RANGES.find(([d]) => d === st.range)?.[1] ?? 'este período';
      setChildren(list, emptyState({
        title: st.filter === 'deposits' ? 'Nenhum depósito neste período' : 'Nenhuma movimentação neste período',
        text: st.filter === 'deposits' ? `Não há depósitos em "${rangeLabel}". Veja "Todas as movimentações" ou escolha um período maior.` : 'Escolha um período maior para ver movimentações mais antigas.',
      }));
      setChildren(footer);
      return;
    }
    setChildren(list, h('div', { class: 'table-wrap' }, h('table', { class: 'table table--stack bal-hist__table' },
      h('thead', null, h('tr', null, ['Data', 'Movimentação', 'Valor'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, st.items.map((t) => h('tr', null,
        h('td', { 'data-label': 'Data', class: 'bal-hist__date', title: t.timezone ? `Fuso: ${t.timezone}` : undefined }, formatStamp(t.createdAt)),
        h('td', { 'data-label': 'Movimentação' }, h('span', { class: 'cell-strong' }, typeLabel(t.type)), t.billingType === 'CREDIT' ? badge(BILLING_TYPES.CREDIT, 'neutral') : null, t.invoiceSerial ? h('span', { class: 'acc-id' }, `Fatura ${t.invoiceSerial}`) : null),
        h('td', { 'data-label': 'Valor', class: 'num' }, amountCell(t))))))));
    const more = st.page < st.totalPages;
    setChildren(footer,
      h('span', { class: 'muted' }, `Mostrando ${st.items.length} de ${st.totalNumber} ${st.totalNumber === 1 ? 'movimentação' : 'movimentações'}`),
      more ? button(st.loading ? 'Carregando…' : 'Carregar mais', { disabled: st.loading, onClick: () => load({ more: true }) }) : null);
  }

  const modal = openModal({
    title: 'Histórico de depósitos',
    size: 'wide',
    body: h('div', { class: 'modal__body bal-hist' },
      h('p', { class: 'bal-hist__who' }, h('strong', null, name), id ? h('span', { class: 'acc-id' }, `ID ${id}`) : null),
      filterBar,
      list,
      footer,
      kind === 'account' ? h('p', { class: 'muted bal-hist__note' }, 'Mostra as movimentações desta conta de anúncio. Se a Business Center usa portfólio de pagamento, as de contas compartilhadas por outra BC não aparecem.') : null,
      h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() }))),
  });
  drawFilters();
  load();
  return modal;
}
