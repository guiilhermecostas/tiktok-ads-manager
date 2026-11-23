import { get } from '../api.js';
import { h, icon, setChildren } from '../dom.js';
import { formatCurrency } from '../format.js';
import { alertBox, badge, button, emptyState, spinner, toast } from '../ui.js';
import { currencyBadge } from './account-filter.js';
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
const ACCOUNT_STATUS = { enable: 'ativa', disable: 'desativada', limited: 'limitada', pending_confirm: 'aguardando confirmação', pending_verify: 'em verificação', pending_closure: 'em encerramento', confirm_fail: 'confirmação recusada', close: 'encerrada', share_cbs: 'compartilhada' };
const accountStatus = (raw) => {
  const key = String(raw).replace(/^STATUS_/, '').toLowerCase();
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
function table({ columns, rows, renderCells, renderDetails, emptyText }) {
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
      nodes.push(h('tr', { class: isOpen ? 'is-open' : null }, renderCells(row), h('td', { 'data-label': 'Detalhes', class: 'balance__cell-toggle' }, toggle)));
      if (isOpen) nodes.push(h('tr', { class: 'balance__details-row' }, h('td', { colspan: columns.length + 1 }, renderDetails(row))));
    }
    setChildren(body, nodes);
  }
  paint();
  return h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' }, h('thead', null, h('tr', null, columns.map((c) => h('th', { scope: 'col' }, c)), h('th', { scope: 'col' }, ''))), body));
}

/** Painel "Detalhes": todos os valores do TikTok, mais avisos. */
function details(row, extra = []) {
  return h(
    'div',
    { class: 'balance__details' },
    row.error ? alertBox(row.error, 'warning') : null,
    row.amounts.length
      ? h('dl', { class: 'balance__grid' }, row.amounts.map((a) => h('div', { class: 'balance__amount' }, h('dt', null, a.label), h('dd', null, money(a.value, row.currency)))))
      : h('p', { class: 'muted' }, 'O TikTok não informou valores para este item.'),
    ...extra,
  );
}

async function balanceScreen(tabName) {
  const state = { q: '', status: '', currency: '', connection: '', data: null };
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
        h('td', { 'data-label': 'Saldo disponível', class: 'num' }, h('strong', null, money(r.main, r.currency))),
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
        h('td', { 'data-label': 'Saldo disponível', class: 'num' }, h('strong', null, money(r.main, r.currency))),
        h('td', { 'data-label': 'Situação' }, situationBadge(r)),
      ],
      renderDetails: (r) => details(r, [h('p', { class: 'muted balance__meta' }, `Conexão: ${r.connectionName}${r.advertiserStatus ? ` · Situação da conta no TikTok: ${accountStatus(r.advertiserStatus)}` : ''}`)]),
    });
    setChildren(content, summaryCards(), tabName === 'bc' ? bcTable() : accountsTable(), note);
  }

  shell = balanceLayout({ active: tabName === 'bc' ? '/balance' : '/balance/accounts', counts: null, children: [filtersBar, content] });
  drawFilters();
  load();
  return { element: shell };
}

export const balanceBcView = () => balanceScreen('bc');
export const balanceAccountsView = () => balanceScreen('accounts');
