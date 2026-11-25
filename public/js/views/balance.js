import { BUDGET_MODE_LABELS, PORTFOLIO_TYPE_LABELS } from '/shared/balance-fields.js';
import { TRANSFER_TYPES, transferEligibility } from '/shared/balance-transfer.js';
import { get } from '../api.js';
import { h, icon, setChildren } from '../dom.js';
import { formatCurrency } from '../format.js';
import { alertBox, badge, button, emptyState, spinner, toast } from '../ui.js';
import { currencyBadge } from './account-filter.js';
import { openTransferDialog } from './balance-transfer.js';
import { pageHeader } from './layout.js';

/**
 * Saldo: duas subabas SEPARADAS: "Business Centers" e "Contas de anúncio". Cada linha mostra o saldo disponível, a situação
 * (com saldo, sem saldo, sem informação) e, em "Detalhes", TODOS os valores que o TikTok devolveu. Uma BC sem saldo pode ter contas
 * com saldo (e vice-versa): as duas visões listam tudo, e cada conta diz se a BC dela tem saldo.
 * Todo texto (nomes, IDs, mensagens do TikTok) entra como nó de texto, nunca como HTML.
 */

const STATUS_FILTERS = [['', 'Todos'], ['with', 'Com saldo'], ['without', 'Sem saldo'], ['unknown', 'Sem informação']];
const money = (value, currency) => (value === null || value === undefined ? '—' : formatCurrency(value, currency && currency !== 'UNKNOWN' ? currency : undefined));

/** Situação de uma linha: with | without | unknown (erro ou o TikTok não informou). */
const situationOf = (row) => (row.status !== 'ok' ? 'unknown' : row.hasBalance ? 'with' : 'without');
const situationBadge = (row) => {
  const kind = situationOf(row);
  if (kind === 'with') return badge('Com saldo', 'success');
  if (kind === 'without') return badge('Sem saldo', 'neutral');
  const el = badge('Sem informação', 'warning');
  if (row.error) el.title = row.error;
  return el;
};

/** Situação da conta no TikTok (STATUS_ENABLE…) em português; o que não for conhecido aparece sem o prefixo, em minúsculas. */
const ACCOUNT_STATUS = { show_account_status_approved: 'aprovada', show_account_status_not_approved: 'reprovada', show_account_status_in_review: 'em análise', show_account_status_punished: 'punida', enable: 'ativa', disable: 'desativada' };
const accountStatus = (raw) => {
  const key = String(raw).toLowerCase();
  return ACCOUNT_STATUS[key] ?? key.replace(/_/g, ' ');
};
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const timeText = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

function balanceLayout({ active, counts, children }) {
  const tab = (path, text, count) => h('a', { href: path, 'data-link': '', class: `tab${path === active ? ' is-active' : ''}`, 'aria-current': path === active ? 'page' : null }, text, count === null ? null : h('span', { class: 'tab__count' }, String(count)));
  return h(
    'div',
    { class: 'reports balance' },
    pageHeader('Saldo', 'Quanto há de saldo em cada Business Center e em cada conta de anúncio, direto do TikTok.'),
    h('nav', { class: 'tabs tabs--hub tabs--left', 'aria-label': 'Seções de Saldo' }, tab('/balance', 'Business Centers', counts?.bcs ?? null), tab('/balance/accounts', 'Contas de anúncio', counts?.accounts ?? null)),
    ...children,
  );
}

/** Tabela com linhas que se expandem em "Detalhes" (todos os valores do TikTok). */
function table({ columns, rows, renderCells, renderDetails, renderActions = null, emptyText }) {
  const open = new Set();
  const body = h('tbody');
  function paint() {
    if (!rows.length) return setChildren(body, h('tr', null, h('td', { colspan: columns.length + 1, class: 'muted' }, emptyText)));
    const nodes = [];
    for (const row of rows) {
      const isOpen = open.has(row.key);
      const toggle = h('button', {
        type: 'button', class: 'balance__toggle', 'aria-expanded': String(isOpen), 'aria-label': `${isOpen ? 'Ocultar' : 'Ver'} detalhes`,
        onClick: () => { if (open.has(row.key)) open.delete(row.key); else open.add(row.key); paint(); },
      }, isOpen ? 'Ocultar' : 'Detalhes');
      nodes.push(h('tr', { class: isOpen ? 'is-open' : null }, renderCells(row), h('td', { 'data-label': 'Detalhes', class: 'balance__cell-toggle' }, h('div', { class: 'balance__actions' }, renderActions?.(row) ?? null, toggle))));
      if (isOpen) nodes.push(h('tr', { class: 'balance__details-row' }, h('td', { colspan: columns.length + 1 }, renderDetails(row))));
    }
    setChildren(body, nodes);
  }
  paint();
  return h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' }, h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col' }, c)), h('th', { scope: 'col' }, ''))), body));
}

/** De onde vem o "saldo disponível" mostrado (só quando não é o saldo da própria conta). */
const SOURCE_NOTE = {
  portfolio: (row) => `Saldo compartilhado${row.portfolio?.name ? ` · portfólio ${row.portfolio.name}` : ''}: todas as contas ligadas ao portfólio gastam dele`,
  budget: () => 'Orçamento restante (gasta do saldo da BC)',
};
const sourceCaption = (row) => (SOURCE_NOTE[row.mainSource] ? h('span', { class: 'acc-id balance__source' }, SOURCE_NOTE[row.mainSource](row)) : null);

/** Painel "Detalhes": todos os valores do TikTok, mais avisos. */
function details(row, extra = []) {
  return h(
    'div',
    { class: 'balance__details' },
    row.error ? alertBox(row.error, 'warning') : null,
    row.mainSource === 'portfolio' ? alertBox('Esta conta usa um portfólio de pagamento COMPARTILHADO: o saldo disponível é o do portfólio (o mesmo para todas as contas ligadas a ele) e é somado uma única vez.', 'info') : null,
    row.mainSource === 'budget' ? alertBox(`Esta conta gasta do saldo da Business Center, dentro de um orçamento (${BUDGET_MODE_LABELS[row.budgetMode] ?? row.budgetMode}). O saldo próprio dela fica zerado de propósito; o que ela pode gastar é o orçamento restante, limitado pelo saldo da BC.`, 'info') : null,
    row.portfolioType ? alertBox(`${PORTFOLIO_TYPE_LABELS[row.portfolioType] ?? row.portfolioType}: o TikTok informa aqui o saldo do portfólio de pagamento, não só desta Business Center.`, 'info') : null,
    row.portfolio?.amounts?.length ? h('h4', { class: 'balance__sub' }, 'Valores da própria conta') : null,
    row.amounts.length
      ? h('dl', { class: 'balance__grid' }, row.amounts.map((a) => h('div', { class: 'balance__amount' }, h('dt', null, a.label), h('dd', null, money(a.value, row.currency)))))
      : h('p', { class: 'muted' }, 'O TikTok não informou valores para este item.'),
    row.portfolio?.amounts?.length
      ? [h('h4', { class: 'balance__sub' }, `Portfólio de pagamento${row.portfolio.name ? `: ${row.portfolio.name}` : ''}${row.portfolio.type ? ` (${PORTFOLIO_TYPE_LABELS[row.portfolio.type] ?? row.portfolio.type})` : ''}`),
        h('dl', { class: 'balance__grid' }, row.portfolio.amounts.map((a) => h('div', { class: 'balance__amount' }, h('dt', null, a.label), h('dd', null, money(a.value, row.currency)))))]
      : null,
    ...extra,
  );
}

async function balanceScreen(tabName) {
  const state = { q: '', status: '', currency: '', connection: '', data: null, transfers: null };
  const content = h('div', { class: 'reports__content' }, spinner());
  const filtersBar = h('div', { class: 'reports__filters' });
  let shell;
  let loadId = 0;

  const rowsOf = () => (tabName === 'bc' ? state.data.bcs : state.data.accounts);

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
      return true;
    } catch (err) {
      if (current !== loadId) return false;
      setChildren(content, alertBox(err.message || 'Não foi possível consultar o saldo.'), h('p', null, button('Tentar de novo', { onClick: () => load() })));
      return false;
    } finally {
      if (current === loadId) content.classList.remove('is-loading');
    }
  }

  function redrawShell() {
    const counts = { bcs: state.data.bcs.length, accounts: state.data.accounts.length };
    const next = balanceLayout({ active: tabName === 'bc' ? '/balance' : '/balance/accounts', counts, children: [filtersBar, content] });
    shell.replaceWith(next);
    shell = next;
  }

  function filtered() {
    const q = normalize(state.q);
    return rowsOf().filter((r) => {
      if (state.status && situationOf(r) !== state.status) return false;
      if (state.currency && (r.currency ?? 'UNKNOWN') !== state.currency) return false;
      if (state.connection && String(r.connectionId) !== state.connection) return false;
      if (q && !normalize(`${r.name ?? ''} ${r.advertiserId ?? ''} ${r.bcId ?? ''} ${r.connectionName}`).includes(q)) return false;
      return true;
    });
  }

  function drawFilters() {
    const all = state.data ? rowsOf() : [];
    const currencies = [...new Set(all.map((r) => r.currency ?? 'UNKNOWN'))];
    const connections = [...new Map(all.map((r) => [String(r.connectionId), r.connectionName])).entries()];
    const search = h('input', {
      class: 'input toolbar__search', type: 'search', maxlength: 100, value: state.q, 'aria-label': 'Buscar',
      placeholder: tabName === 'bc' ? 'Buscar por ID da BC ou conexão…' : 'Buscar por nome ou ID da conta…',
      onInput: (e) => { state.q = e.target.value; drawContent(); },
    });
    const status = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Situação' }, STATUS_FILTERS.map(([value, label]) => h('button', { type: 'button', class: `segmented__btn${state.status === value ? ' is-on' : ''}`, 'aria-pressed': String(state.status === value), onClick: () => { state.status = value; drawFilters(); drawContent(); } }, label)));
    const select = (label, value, options, onChange) => {
      const el = h('select', { class: 'input input--filter', 'aria-label': label, onChange: (e) => onChange(e.target.value) }, options.map(([v, text]) => h('option', { value: v }, text)));
      el.value = value;
      return el;
    };
    const currency = currencies.length > 1 ? select('Moeda', state.currency, [['', 'Todas as moedas'], ...currencies.map((c) => [c, c === 'UNKNOWN' ? 'Moeda não informada' : c])], (v) => { state.currency = v; drawContent(); }) : null;
    const connection = connections.length > 1 ? select('Conexão', state.connection, [['', 'Todas as conexões'], ...connections], (v) => { state.connection = v; drawContent(); }) : null;
    const refresh = button([icon('chart', 14), ' Atualizar agora'], { small: true, onClick: async (e) => {
      const trigger = e.currentTarget;
      trigger.disabled = true;
      if (await load({ fresh: true })) toast('Saldo atualizado.');
      else trigger.disabled = false;
    } });
    refresh.classList.add('reports__refresh');
    setChildren(filtersBar, search, status, currency, connection, state.data ? h('span', { class: 'muted balance__updated' }, `Atualizado às ${timeText(state.data.fetchedAt)}`) : null, refresh);
  }

  function summaryCards() {
    const s = state.data.summary;
    const card = (label, value, hint, tone) => h('div', { class: `kpi kpi--static${tone ? ` kpi--${tone}` : ''}` }, h('span', { class: 'kpi__label' }, label), h('strong', { class: 'kpi__value' }, value), h('span', { class: 'kpi__hint muted' }, hint ?? ''));
    const cards = tabName === 'bc'
      ? [card('BCs com saldo', `${s.bcsWithBalance} de ${s.bcs}`, 'têm saldo disponível'), card('BCs sem saldo', String(s.bcsWithoutBalance), 'o TikTok informou saldo zero'), card('Sem informação', String(s.bcsWithError), 'erro ou sem permissão')]
      : [card('Contas com saldo', `${s.accountsWithBalance} de ${s.accounts}`, 'têm saldo disponível'), card('Contas sem saldo', String(s.accountsWithoutBalance), 'o TikTok informou saldo zero'), card('Sem informação', String(s.accountsUnknown), 'erro ou não informado')];
    for (const t of state.data.totals) {
      const value = tabName === 'bc' ? t.bc : t.accounts;
      if (value > 0 || state.data.totals.length === 1) cards.push(card(`Disponível${state.data.totals.length > 1 ? ` (${t.currency === 'UNKNOWN' ? '?' : t.currency})` : ''}`, money(value, t.currency), tabName === 'bc' ? 'somando as BCs' : 'somando as contas'));
    }
    return h('div', { class: 'kpis', role: 'group', 'aria-label': 'Resumo do saldo' }, cards);
  }

  // ---------- transferência de saldo (BC ↔ conta) ----------
  const bcOf = (row) => state.data.bcs.find((b) => b.connectionId === row.connectionId && b.bcId === row.bcId) ?? null;
  function transferButton(row) {
    if (!state.data.canTransfer || !transferEligibility(row, bcOf(row)).ok) return null;
    return button('Transferir', { small: true, ariaLabel: `Transferir saldo da conta ${row.name}`, onClick: () => openTransferDialog({ account: row, bc: bcOf(row), onDone: () => { load({ fresh: true }); loadTransfers(); } }) });
  }
  /** Nos detalhes: por que esta conta não tem o botão (ou dica de que ele existe). */
  function transferNote(row) {
    if (!state.data.canTransfer) return state.data.accounts.length ? h('p', { class: 'muted balance__meta' }, 'Só o dono da conta movimenta saldo.') : null;
    const e = transferEligibility(row, bcOf(row));
    return e.ok ? null : alertBox(`Sem transferência por aqui: ${e.reason}`, 'info');
  }

  async function loadTransfers() {
    try {
      state.transfers = (await get('/tiktok/balance/transfers')).transfers;
    } catch {
      state.transfers = null; // o histórico é um extra: se falhar, a tela segue
    }
    if (state.data) drawContent();
  }

  const TRANSFER_STATUS = { success: ['Concluída', 'success'], pending: ['Em andamento', 'warning'], failed: ['Não concluída', 'danger'], unknown: ['Sem confirmação', 'warning'] };
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
              h('td', { 'data-label': 'Transferência' }, h('span', { class: 'cell-strong' }, TRANSFER_TYPES[t.direction]?.label ?? t.direction), h('span', { class: 'acc-id' }, `${t.advertiserName || t.advertiserId} · BC ${t.bcId}`)),
              h('td', { 'data-label': 'Valor', class: 'num' }, money(t.amount, t.currency)),
              h('td', { 'data-label': 'Resultado' }, badge(label, tone), t.error ? h('span', { class: 'acc-id balance__source' }, t.error) : null));
          }))))
        : h('p', { class: 'muted' }, 'Nenhuma transferência feita por aqui ainda.'));
  }

  function drawContent() {
    const data = state.data;
    if (!data) return;
    if (!data.bcs.length && !data.accounts.length) {
      setChildren(content, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Conecte uma Business Center para ver o saldo dela e das contas de anúncio aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
      return;
    }
    const rows = filtered();
    const note = h('p', { class: 'hub__note' }, 'O saldo vem direto do TikTok (atualiza a cada 1 minuto). “Sem informação” quer dizer que o TikTok não deixou ver o saldo (por exemplo, falta permissão financeira na Business Center): passe o mouse sobre o aviso para ver o motivo.');
    const bcTable = () => table({
      columns: ['Business Center', 'Moeda', 'Saldo disponível', 'Situação', 'Contas'],
      rows,
      emptyText: 'Nenhuma Business Center encontrada com esses filtros.',
      renderCells: (r) => [
        h('td', { 'data-label': 'Business Center' }, h('span', { class: 'cell-strong' }, r.bcId ?? 'BC não identificada'), h('span', { class: 'acc-id' }, `Conexão: ${r.connectionName}`)),
        h('td', { 'data-label': 'Moeda' }, currencyBadge(r.currency) ?? h('span', { class: 'muted' }, '—')),
        h('td', { 'data-label': 'Saldo disponível', class: 'num' }, h('strong', null, money(r.main, r.currency)), r.portfolioType ? h('span', { class: 'acc-id balance__source' }, PORTFOLIO_TYPE_LABELS[r.portfolioType]) : null),
        h('td', { 'data-label': 'Situação' }, situationBadge(r)),
        h('td', { 'data-label': 'Contas' }, r.accountsError ? h('span', { class: 'muted', title: r.accountsError }, `${r.accountsTotal} · sem informação`) : `${r.accountsWithBalance} com saldo de ${r.accountsTotal}`),
      ],
      renderDetails: (r) => details(r, [r.accountsError ? alertBox(`Contas desta BC: ${r.accountsError}`, 'warning') : null]),
    });
    const accountsTable = () => table({
      columns: ['Conta de anúncio', 'Business Center', 'Moeda', 'Saldo disponível', 'Situação'],
      rows,
      emptyText: 'Nenhuma conta de anúncio encontrada com esses filtros.',
      renderCells: (r) => [
        h('td', { 'data-label': 'Conta' }, h('div', { class: 'acc-name' }, h('span', { class: 'cell-strong' }, r.name), h('span', { class: 'acc-id' }, `ID ${r.advertiserId}`))),
        h('td', { 'data-label': 'Business Center' }, h('span', { class: 'cell-strong' }, r.bcId ?? '—'), h('span', { class: 'acc-id' }, r.bcHasBalance === null ? 'Saldo da BC desconhecido' : r.bcHasBalance ? 'BC com saldo' : 'BC sem saldo')),
        h('td', { 'data-label': 'Moeda' }, currencyBadge(r.currency) ?? h('span', { class: 'muted' }, '—')),
        h('td', { 'data-label': 'Saldo disponível', class: 'num' }, h('strong', null, money(r.main, r.currency)), sourceCaption(r)),
        h('td', { 'data-label': 'Situação' }, situationBadge(r)),
      ],
      renderActions: (r) => transferButton(r),
      renderDetails: (r) => details(r, [transferNote(r), h('p', { class: 'muted balance__meta' }, `Conexão: ${r.connectionName}${r.advertiserStatus ? ` · Situação da conta no TikTok: ${accountStatus(r.advertiserStatus)}` : ''}`)]),
    });
    const s = data.summary;
    const accountNotes = tabName === 'accounts' && (s.accountsOnBudget || s.accountsSharedPortfolio)
      ? h('p', { class: 'hub__note' }, [
        s.accountsSharedPortfolio ? `${s.accountsSharedPortfolio} conta(s) dividem o saldo de um portfólio de pagamento: o valor entra UMA vez na soma. ` : '',
        s.accountsOnBudget ? `${s.accountsOnBudget} conta(s) gastam do saldo da BC dentro de um orçamento: o valor mostrado é o orçamento restante e não entra na soma (já está no saldo da BC).` : '',
      ].join(''))
      : null;
    setChildren(content, summaryCards(), tabName === 'bc' ? bcTable() : accountsTable(), accountNotes, tabName === 'accounts' ? transferHistory() : null, note);
  }

  shell = balanceLayout({ active: tabName === 'bc' ? '/balance' : '/balance/accounts', counts: null, children: [filtersBar, content] });
  drawFilters();
  load();
  if (tabName === 'accounts') loadTransfers();
  return { element: shell };
}

export const balanceBcView = () => balanceScreen('bc');
export const balanceAccountsView = () => balanceScreen('accounts');
