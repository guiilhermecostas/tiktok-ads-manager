import { STATUS_FILTERS, countBySituation, filterRows, sortRows, sumByCurrency } from '/shared/balance-list.js';
import { TRANSFER_TYPES, transferEligibility } from '/shared/balance-transfer.js';
import { get } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { alertBox, badge, button, emptyState, spinner, toast } from '../../ui.js';
import { openTransferDialog } from '../balance-transfer.js';
import { pageHeader } from '../layout.js';
import { openHistoryDialog } from './history-dialog.js';
import { balanceTable, money } from './list.js';

/**
 * Saldo: duas abas SEPARADAS e em lista compacta. "Business Centers" mostra só BCs; "Contas de anúncio" mostra só contas (uma BC sem saldo pode ter
 * contas com saldo e vice-versa, então nada é misturado). Cada linha: nome · ID · saldo · total gasto · botão do histórico de depósitos.
 * O saldo vem na hora; o total gasto (mais pesado) carrega em seguida, sem travar a lista. Todo texto entra como nó de texto.
 */

const AUTO_REFRESH_MS = 60 * 1000; // o servidor guarda o saldo por 1 minuto: atualizar mais rápido só devolveria o mesmo valor
const SPEND_REFRESH_EVERY = 5; // o gasto é refeito a cada 5 minutos (o servidor guarda por 10)
const timeText = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function balanceLayout({ active, counts, children }) {
  const tab = (path, text, count) => h('a', { href: path, 'data-link': '', class: `tab${path === active ? ' is-active' : ''}`, 'aria-current': path === active ? 'page' : null }, text, count === null ? null : h('span', { class: 'tab__count' }, String(count)));
  return h(
    'div',
    { class: 'reports balance' },
    pageHeader('Saldo', 'Saldo e total gasto de cada Business Center e de cada conta de anúncio, direto do TikTok.'),
    h('nav', { class: 'tabs tabs--hub tabs--left', 'aria-label': 'Seções de Saldo' }, tab('/balance', 'Business Centers', counts?.bcs ?? null), tab('/balance/accounts', 'Contas de anúncio', counts?.accounts ?? null)),
    ...children,
  );
}

const TRANSFER_STATUS = { success: ['Concluída', 'success'], pending: ['Em andamento', 'warning'], failed: ['Não concluída', 'danger'], unknown: ['Sem confirmação', 'warning'] };

export function balanceScreen(tabName) {
  const isBc = tabName === 'bc';
  const state = { q: '', status: '', sort: 'balance', dir: 'desc', data: null, spend: null, spendLoading: false, spendError: null, transfers: null };
  const content = h('div', { class: 'reports__content' }, spinner());
  const filtersBar = h('div', { class: 'reports__filters' });
  const updatedAt = h('span', { class: 'muted balance__updated', role: 'status' });
  let shell;
  let loadId = 0;
  let spendId = 0;
  let ticks = 0;

  const rowsOf = () => (isBc ? state.data.bcs : state.data.accounts);
  const idOf = (row) => (isBc ? row.bcId : row.advertiserId);
  const nameOf = (row) => (isBc ? (row.name || row.connectionName) : row.name);
  const bcOf = (row) => state.data.bcs.find((b) => b.connectionId === row.connectionId && b.bcId === row.bcId) ?? null;

  /** Total gasto de uma linha: { state: 'loading' | 'ok' | 'error', parts, error, failed }. */
  function spendFor(row) {
    if (!state.spend) return state.spendLoading || !state.spendError ? { state: 'loading' } : { state: 'error', error: state.spendError };
    if (isBc) {
      const found = state.spend.bcs[row.key];
      return found ? { state: 'ok', parts: found.totals, failed: found.failed } : { state: 'ok', parts: [], failed: 0 };
    }
    const found = state.spend.accounts[row.key];
    if (!found) return { state: 'error', error: 'O gasto desta conta ainda não foi consultado.' };
    return found.error ? { state: 'error', error: found.error } : { state: 'ok', parts: [{ currency: found.currency, spend: found.spend }], failed: 0 };
  }
  /** Número usado só para ordenar por gasto (null = ainda sem valor: vai para o fim). */
  const spendNumber = (row) => {
    const s = spendFor(row);
    return s.state === 'ok' ? (s.parts[0]?.spend ?? 0) : null;
  };

  // ---------- dados ----------
  async function load({ fresh = false } = {}) {
    const current = ++loadId;
    content.classList.add('is-loading');
    try {
      const data = await get(`/tiktok/balance${fresh ? '?refresh=1' : ''}`);
      if (current !== loadId) return false;
      state.data = data;
      redrawShell();
      drawFilters();
      drawContent();
      loadSpend({ fresh });
      return true;
    } catch (err) {
      if (current !== loadId) return false;
      setChildren(content, alertBox(err.message || 'Não foi possível consultar o saldo.'), h('p', null, button('Tentar de novo', { onClick: () => load() })));
      return false;
    } finally {
      if (current === loadId) content.classList.remove('is-loading');
    }
  }

  /** O total gasto vem de outra consulta (mais pesada): a lista aparece primeiro e os valores entram quando chegam. */
  async function loadSpend({ fresh = false } = {}) {
    const current = ++spendId;
    state.spendLoading = true;
    state.spendError = null;
    if (state.data) drawContent();
    try {
      const data = await get(`/tiktok/balance/spend${fresh ? '?refresh=1' : ''}`);
      if (current !== spendId) return;
      state.spend = data;
    } catch (err) {
      if (current === spendId) state.spendError = err.message || 'Não foi possível consultar o total gasto.';
    } finally {
      if (current === spendId) {
        state.spendLoading = false;
        if (state.data) drawContent();
      }
    }
  }

  /** Atualização automática: em silêncio (sem apagar a tela, sem mexer no que a pessoa está digitando) e só com a aba visível. */
  async function refreshQuietly() {
    if (document.hidden || content.classList.contains('is-loading') || document.querySelector('.modal, dialog[open]')) return;
    const current = ++loadId;
    try {
      const data = await get('/tiktok/balance');
      if (current !== loadId) return;
      state.data = data;
      updatedAt.textContent = `Atualizado às ${timeText(data.fetchedAt)}`;
      drawContent();
    } catch {
      // falhou em segundo plano: a tela continua com o último saldo (o botão "Atualizar agora" mostra o erro)
    }
    ticks += 1;
    if (ticks % SPEND_REFRESH_EVERY === 0) loadSpend();
  }

  function redrawShell() {
    const counts = { bcs: state.data.bcs.length, accounts: state.data.accounts.length };
    const next = balanceLayout({ active: isBc ? '/balance' : '/balance/accounts', counts, children: [filtersBar, content] });
    shell.replaceWith(next);
    shell = next;
  }

  // ---------- barra: busca, atualizar ----------
  function drawFilters() {
    const search = h('input', {
      class: 'input toolbar__search', type: 'search', maxlength: 100, value: state.q, 'aria-label': 'Buscar',
      placeholder: isBc ? 'Buscar por nome ou ID da BC…' : 'Buscar por nome ou ID da conta…',
      onInput: (e) => { state.q = e.target.value; drawContent(); },
    });
    updatedAt.textContent = state.data ? `Atualizado às ${timeText(state.data.fetchedAt)}` : '';
    const refresh = button([icon('chart', 14), ' Atualizar agora'], { small: true, onClick: async (e) => {
      const trigger = e.currentTarget;
      trigger.disabled = true;
      if (await load({ fresh: true })) toast('Saldo atualizado.');
      else trigger.disabled = false;
    } });
    refresh.classList.add('reports__refresh');
    setChildren(filtersBar, search, state.data ? updatedAt : null, refresh);
  }

  // ---------- resumo: situação (filtro) e totais ----------
  function summaryBar(rows) {
    const counts = countBySituation(rows);
    const chips = STATUS_FILTERS.map(([key, label]) => {
      const n = key ? counts[key] : rows.length;
      const on = state.status === key;
      return h('button', { type: 'button', class: `bal-chip bal-chip--${key || 'all'}${on ? ' is-on' : ''}`, 'aria-pressed': String(on), onClick: () => { state.status = key; drawContent(); } }, label, h('span', { class: 'bal-chip__n' }, String(n)));
    });
    const balanceTotals = state.data.totals.map((t) => ({ currency: t.currency, value: isBc ? t.bc : t.accounts })).filter((t) => t.value > 0 || state.data.totals.length === 1);
    const spendTotals = state.spend ? sumByCurrency(isBc ? Object.values(state.spend.bcs).flatMap((b) => b.totals.map((t) => ({ currency: t.currency, value: t.spend }))) : Object.values(state.spend.accounts).filter((a) => !a.error).map((a) => ({ currency: a.currency, value: a.spend }))) : null;
    // mode: 'ok' (mostra o valor), 'loading' (reticências) ou 'error' ("—": nunca um zero inventado quando a consulta falhou)
    const pill = (label, items, mode) => h('div', { class: 'bal-total' }, h('span', { class: 'bal-total__label' }, label), h('strong', { class: 'bal-total__value' }, mode === 'loading' ? '···' : mode === 'error' ? '—' : items.length ? items.map((t) => money(t.value, t.currency)).join(' + ') : money(0, undefined)));
    return h('div', { class: 'bal-bar' },
      h('div', { class: 'bal-chips', role: 'group', 'aria-label': 'Filtrar por saldo' }, chips),
      h('div', { class: 'bal-totals' }, pill('Saldo total', balanceTotals, 'ok'), pill('Gasto total', spendTotals ?? [], spendTotals ? 'ok' : state.spendError ? 'error' : 'loading')));
  }

  // ---------- transferência de saldo (BC ↔ conta), só na aba de contas ----------
  function transferButton(row) {
    if (!state.data.canTransfer) return null;
    const eligibility = transferEligibility(row, bcOf(row));
    if (!eligibility.ok) {
      // Sem o botão a pessoa acha que "não funciona": ele fica, apagado, e ao clicar mostra o MOTIVO.
      const blocked = button('Transferir', { small: true, ariaLabel: `Transferir saldo da conta ${row.name}: indisponível. ${eligibility.reason}`, onClick: () => toast(`Sem transferência por aqui: ${eligibility.reason}`, 'danger') });
      blocked.classList.add('is-blocked');
      blocked.setAttribute('aria-disabled', 'true');
      blocked.title = eligibility.reason;
      return blocked;
    }
    return button('Transferir', { small: true, ariaLabel: `Transferir saldo da conta ${row.name}`, onClick: () => openTransferDialog({ account: row, bc: bcOf(row), onDone: () => { load({ fresh: true }); loadTransfers(); } }) });
  }

  async function loadTransfers() {
    try {
      state.transfers = (await get('/tiktok/balance/transfers')).transfers;
    } catch {
      state.transfers = null; // o histórico é um extra: se falhar, a tela segue
    }
    if (state.data) drawContent();
  }

  function transferHistory() {
    const list = state.transfers;
    if (!list || (!list.length && !state.data.canTransfer)) return null;
    return h('section', { class: 'balance__history' },
      h('h3', { class: 'form-section__title' }, 'Últimas transferências'),
      list.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Quando', 'Transferência', 'Valor', 'Resultado'].map((c) => h('th', { scope: 'col' }, c)))),
          h('tbody', null, list.map((t) => {
            const [label, tone] = TRANSFER_STATUS[t.status] ?? [t.status, 'neutral'];
            const when = new Date(t.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            return h('tr', null,
              h('td', { 'data-label': 'Quando', class: 'muted' }, when),
              h('td', { 'data-label': 'Transferência' }, h('span', { class: 'cell-strong' }, TRANSFER_TYPES[t.direction]?.label ?? t.direction), h('span', { class: 'acc-id' }, t.advertiserName || t.advertiserId)),
              h('td', { 'data-label': 'Valor', class: 'num' }, money(t.amount, t.currency)),
              h('td', { 'data-label': 'Resultado' }, badge(label, tone), t.error ? h('span', { class: 'acc-id' }, t.error) : null));
          }))))
        : h('p', { class: 'muted' }, 'Nenhuma transferência feita por aqui ainda.'));
  }

  // ---------- lista ----------
  function setSort(key) {
    if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
    else {
      state.sort = key;
      state.dir = key === 'name' ? 'asc' : 'desc';
    }
    drawContent();
  }

  const view = () => (isBc
    ? { nameLabel: 'Business Center', name: nameOf, id: idOf, spend: spendFor, historyLabel: (r) => `Ver histórico de depósitos da Business Center ${nameOf(r)}`, onHistory: (r) => openHistoryDialog({ kind: 'bc', connectionId: r.connectionId, bcId: r.bcId, name: nameOf(r), id: r.bcId }) }
    : { nameLabel: 'Conta de anúncio', name: nameOf, id: idOf, spend: spendFor, extra: transferButton, historyLabel: (r) => `Ver histórico de depósitos da conta ${nameOf(r)}`, onHistory: (r) => openHistoryDialog({ kind: 'account', connectionId: r.connectionId, advertiserId: r.advertiserId, name: nameOf(r), id: r.advertiserId }) });

  function drawContent() {
    const data = state.data;
    if (!data) return;
    if (!data.bcs.length && !data.accounts.length) {
      setChildren(content, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Conecte uma Business Center para ver o saldo dela e das contas de anúncio aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
      return;
    }
    const all = rowsOf();
    const rows = sortRows(filterRows(all, { status: state.status, q: state.q }, idOf), state.sort, state.dir, spendNumber);
    const s = data.summary;
    const notes = !isBc && (s.accountsOnBudget || s.accountsSharedPortfolio)
      ? h('p', { class: 'hub__note' }, [
        s.accountsSharedPortfolio ? `${s.accountsSharedPortfolio} conta(s) dividem o saldo de um portfólio de pagamento: o valor entra UMA vez na soma. ` : '',
        s.accountsOnBudget ? `${s.accountsOnBudget} conta(s) gastam do saldo da BC dentro de um orçamento: o valor mostrado é o orçamento restante e não entra na soma.` : '',
      ].join(''))
      : null;
    setChildren(content,
      summaryBar(all),
      state.spendError && !state.spend ? alertBox(`Total gasto indisponível: ${state.spendError}`, 'warning') : null,
      balanceTable({ rows, sort: state.sort, dir: state.dir, onSort: setSort, view: view(), emptyText: all.length ? `Nenhuma ${isBc ? 'Business Center' : 'conta'} com esses filtros.` : 'Nada para mostrar.' }),
      notes,
      isBc ? null : transferHistory(),
      h('p', { class: 'hub__note' }, 'O saldo vem direto do TikTok e se atualiza sozinho a cada minuto. O total gasto é o acumulado desde sempre (a Business Center soma o das contas dela).'));
  }

  shell = balanceLayout({ active: isBc ? '/balance' : '/balance/accounts', counts: null, children: [filtersBar, content] });
  drawFilters();
  load();
  if (!isBc) loadTransfers();
  // Atualiza sozinha enquanto a tela está aberta; ao sair da tela (o elemento deixa a página) o relógio para.
  const timer = setInterval(() => {
    if (!shell.isConnected) return clearInterval(timer); // a tela já foi trocada (o 1º minuto é bem mais que o tempo de montar a tela)
    if (document.hidden) return null;
    if (!isBc) loadTransfers();
    return refreshQuietly();
  }, AUTO_REFRESH_MS);
  return { element: shell };
}
