import { get } from '../api.js';
import { buildInsights, percentChange } from '/shared/report-insights.js';
import { lineChart, sparkline } from '../charts.js';
import { h, setChildren } from '../dom.js';
import { formatCurrency, formatMoney, formatNumber, formatPercent } from '../format.js';
import { can } from '../state.js';
import { alertBox, button, emptyState, spinner } from '../ui.js';
import { currencyBadge } from './account-filter.js';
import { pageHeader } from './layout.js';

const PERIODS = [7, 14, 30];

/** Indicadores. `good`: para onde é "melhor" (up/down); `null` = sem juízo de valor (ex.: gasto). */
const METRICS = [
  { key: 'spend', label: 'Gasto', kind: 'money', good: null },
  { key: 'impressions', label: 'Impressões', kind: 'number', good: 'up' },
  { key: 'clicks', label: 'Cliques', kind: 'number', good: 'up' },
  { key: 'ctr', label: 'CTR', kind: 'percent', good: 'up' },
  { key: 'cpc', label: 'CPC', kind: 'money', good: 'down' },
  { key: 'conversions', label: 'Conversões', kind: 'number', good: 'up' },
  { key: 'cpa', label: 'Custo por conversão', kind: 'money', good: 'down' },
];
const metricOf = (key) => METRICS.find((m) => m.key === key);

/** Totais com o custo por conversão (CPA) calculado. */
const withCpa = (t) => (t ? { ...t, cpa: t.conversions ? t.spend / t.conversions : 0 } : null);

function format(metric, value, currency) {
  if (metric.kind === 'money') return formatCurrency(value, currency === 'UNKNOWN' ? undefined : currency);
  return metric.kind === 'percent' ? formatPercent(value) : formatNumber(Math.round(value));
}

/** Estrutura das telas de Relatórios: título, abas ("Visão geral" / "Por hora" / "Por conta") e conteúdo. */
export function reportsLayout({ active, subtitle, children }) {
  const tab = (path, text) => h('a', { href: path, 'data-link': '', class: `tab${path === active ? ' is-active' : ''}`, 'aria-current': path === active ? 'page' : null }, text);
  return h(
    'div',
    { class: 'reports' },
    pageHeader('Relatórios', subtitle),
    h('nav', { class: 'tabs tabs--hub tabs--left', 'aria-label': 'Seções de Relatórios' }, tab('/reports', 'Visão geral'), tab('/reports/hourly', 'Por hora'), tab('/reports/accounts', 'Por conta')),
    ...children,
  );
}

/** Pílula com a variação (▲/▼) e uma cor SUTIL só no texto: verde = melhorou, vermelho = piorou. */
function deltaPill(metric, current, previous) {
  const change = percentChange(current, previous);
  if (change === null) return h('span', { class: 'delta delta--flat', title: 'Sem dados no período anterior para comparar' }, previous === undefined || previous === null ? '' : '—');
  const rounded = Math.abs(change) < 0.05 ? 0 : change;
  const tone = rounded === 0 || metric.good === null ? 'flat' : (rounded > 0) === (metric.good === 'up') ? 'good' : 'bad';
  return h('span', { class: `delta delta--${tone}`, title: 'Comparado com o período anterior de mesmo tamanho' }, `${rounded > 0 ? '▲' : rounded < 0 ? '▼' : '•'} ${formatPercent(Math.abs(rounded))}`);
}

/** "Visão geral": indicadores com comparação, gráfico de linha suave, observações e ranking das contas, tudo filtrável. */
export async function reportsView() {
  const state = { days: 7, advertiserId: '', compare: true, currency: null, metric: 'spend', sort: { key: 'spend', dir: -1 }, q: '' };
  const content = h('div', { class: 'reports__content' }, spinner());
  const filtersBar = h('div', { class: 'reports__filters' });
  let data = null;
  let loadId = 0;
  const campaignsSummary = can('campaigns') ? get('/campaigns/summary').then((r) => r.summary).catch(() => null) : Promise.resolve(null);

  const currentGroup = () => {
    if (!data?.groups.length) return null;
    return data.groups.find((g) => g.currency === state.currency) ?? data.groups[0];
  };

  async function load() {
    const current = ++loadId;
    content.classList.add('is-loading');
    try {
      const params = new URLSearchParams({ days: String(state.days) });
      if (state.advertiserId) params.set('advertiserId', state.advertiserId);
      if (state.compare) params.set('compare', '1');
      const fresh = await get(`/tiktok/overview?${params}`);
      if (current !== loadId) return; // um filtro mais novo venceu
      data = fresh;
      if (!data.groups.some((g) => g.currency === state.currency)) state.currency = data.groups[0]?.currency ?? null;
      drawFilters();
      await drawContent();
    } catch (err) {
      if (current !== loadId) return;
      setChildren(content, alertBox(err.message || 'Não foi possível carregar os relatórios.'), h('p', null, button('Tentar de novo', { onClick: load })));
    } finally {
      if (current === loadId) content.classList.remove('is-loading');
    }
  }

  // ---------- filtros ----------
  function drawFilters() {
    const period = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Período' },
      PERIODS.map((d) => h('button', { type: 'button', class: `segmented__btn${state.days === d ? ' is-on' : ''}`, 'aria-pressed': String(state.days === d), onClick: () => { state.days = d; load(); } }, `${d} dias`)),
    );
    const account = h(
      'select',
      { class: 'input input--filter', 'aria-label': 'Filtrar por conta de anúncio', onChange: (e) => { state.advertiserId = e.target.value; load(); } },
      h('option', { value: '' }, `Todas as contas${data ? ` (${data.accountOptions.length})` : ''}`),
      (data?.accountOptions ?? []).map((a) => h('option', { value: a.id }, `${a.name}${a.currency ? ` · ${a.currency}` : ''}`)),
    );
    account.value = state.advertiserId;
    const compare = h('label', { class: 'check reports__compare' }, h('input', { type: 'checkbox', checked: state.compare, onChange: (e) => { state.compare = e.target.checked; load(); } }), h('span', null, 'Comparar com o período anterior'));
    const currency = data && data.groups.length > 1
      ? h('select', { class: 'input input--filter', 'aria-label': 'Moeda dos valores', onChange: (e) => { state.currency = e.target.value; drawContent(); } }, data.groups.map((g) => h('option', { value: g.currency }, `${g.currency === 'UNKNOWN' ? 'Moeda não informada' : g.currency} (${g.advertisers} ${g.advertisers === 1 ? 'conta' : 'contas'})`)))
      : null;
    if (currency) currency.value = state.currency;
    setChildren(filtersBar, period, account, currency, compare);
  }

  // ---------- conteúdo ----------
  async function drawContent() {
    if (!data) return;
    if (data.totalAdvertisers === 0) {
      setChildren(content, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Conecte sua Business Center para ver gasto, cliques e conversões das suas contas aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
      return;
    }
    const group = currentGroup();
    if (!group) {
      setChildren(content, h('div', { class: 'card' }, emptyState({ title: 'Sem dados para mostrar', text: data.failed ? 'Não foi possível consultar as contas agora. Tente de novo em instantes.' : 'Nenhuma conta ativa respondeu para este filtro.' })));
      return;
    }
    const { currency } = group;
    const totals = withCpa(group.totals);
    const previous = withCpa(group.previous);
    const daily = group.daily.map(withCpa);

    const kpis = h(
      'div',
      { class: 'kpis', role: 'group', 'aria-label': 'Indicadores' },
      METRICS.map((m) => h(
        'button',
        { type: 'button', class: `kpi${state.metric === m.key ? ' is-on' : ''}`, 'aria-pressed': String(state.metric === m.key), onClick: () => { state.metric = m.key; drawContent(); } },
        h('span', { class: 'kpi__label' }, m.label),
        h('strong', { class: 'kpi__value' }, format(m, totals[m.key], currency)),
        h('span', { class: 'kpi__row' }, state.compare ? deltaPill(m, totals[m.key], previous?.[m.key]) : h('span'), sparkline(daily.map((d) => d[m.key]))),
      )),
    );

    const metric = metricOf(state.metric);
    const chartCard = h(
      'section',
      { class: 'card card--pad reports__chart' },
      h('div', { class: 'reports__chart-head' }, h('div', null, h('h2', { class: 'card__title' }, metric.label), h('p', { class: 'muted' }, `Dia a dia · últimos ${data.days} dias${state.advertiserId ? ' · conta selecionada' : ''}`)), h('strong', { class: 'reports__chart-total' }, format(metric, totals[metric.key], currency))),
      lineChart({ dates: daily.map((d) => d.date), values: daily.map((d) => d[metric.key]), format: (v) => format(metric, v, currency), label: metric.label }),
    );

    const insights = buildInsights({ group, data, metricsCurrency: currency, format: { money: (v) => formatCurrency(v, currency === 'UNKNOWN' ? undefined : currency), percent: formatPercent } });
    const insightsCard = h(
      'section',
      { class: 'card card--pad reports__insights' },
      h('h2', { class: 'card__title' }, 'O que chama atenção'),
      insights.length ? h('ul', { class: 'insights' }, insights.map((n) => h('li', { class: `insights__item insights__item--${n.tone}` }, n.text))) : h('p', { class: 'muted' }, 'Nada fora do normal por enquanto.'),
    );

    const summary = await campaignsSummary;
    const internal = summary
      ? h('section', { class: 'reports__internal' }, h('h2', { class: 'card__title section-title' }, 'Campanhas internas'), h('div', { class: 'grid grid--4' },
        [['Campanhas', String(summary.total)], ['Ativas', String(summary.active)], ['Pausadas', String(summary.paused)], ['Orçamento diário ativo', formatMoney(summary.activeBudget)]].map(([label, value]) => h('div', { class: 'card metric' }, h('span', { class: 'metric__label' }, label), h('strong', { class: 'metric__value' }, value)))))
      : null;

    setChildren(content, kpis, h('div', { class: 'reports__split' }, chartCard, insightsCard), accountsTable(group), internal);
  }

  // ---------- ranking por conta ----------
  function accountsTable(group) {
    const rows = data.accounts.filter((a) => (a.currency ?? 'UNKNOWN') === group.currency);
    const normalize = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const columns = [{ key: 'name', label: 'Conta' }, ...METRICS.filter((m) => m.key !== 'cpa').map((m) => ({ key: m.key, label: m.label, metric: m }))];
    const body = h('tbody');
    const search = h('input', { class: 'input toolbar__search', type: 'search', placeholder: 'Buscar conta…', 'aria-label': 'Buscar conta no ranking', maxlength: 80, value: state.q });
    const head = h('tr');

    function paint() {
      const list = rows
        .filter((a) => !state.q || normalize(`${a.name} ${a.id}`).includes(normalize(state.q)))
        .sort((x, y) => {
          const get2 = (a) => (state.sort.key === 'name' ? a.name.toLowerCase() : a.totals[state.sort.key]);
          const a = get2(x);
          const b = get2(y);
          return (a < b ? -1 : a > b ? 1 : 0) * state.sort.dir;
        });
      setChildren(head, h('th', { scope: 'col' }, 'Conta'), ...columns.slice(1).map((c) => h('th', { scope: 'col', 'aria-sort': state.sort.key === c.key ? (state.sort.dir === -1 ? 'descending' : 'ascending') : 'none' }, h('button', { type: 'button', class: 'th-sort', onClick: () => { state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : -1 }; paint(); } }, c.label, state.sort.key === c.key ? (state.sort.dir === -1 ? ' ↓' : ' ↑') : ''))));
      const share = (a) => (group.totals.spend ? (a.totals.spend / group.totals.spend) * 100 : 0);
      setChildren(
        body,
        list.length
          ? list.map((a) => h('tr', null,
            h('td', { 'data-label': 'Conta' }, h('span', { class: 'cell-strong' }, a.name), h('span', { class: 'hub-meta' }, `ID ${a.id} · ${formatPercent(share(a))} do gasto`), shareBar(share(a))),
            columns.slice(1).map((c) => h('td', { 'data-label': c.label, class: 'num' }, format(c.metric, a.totals[c.key], group.currency)))))
          : h('tr', null, h('td', { colspan: columns.length, class: 'muted' }, 'Nenhuma conta encontrada.')),
      );
    }
    search.addEventListener('input', () => { state.q = search.value; paint(); });
    paint();
    return h('section', { class: 'reports__table' }, h('div', { class: 'reports__table-head' }, h('h2', { class: 'card__title' }, 'Desempenho por conta'), currencyBadge(group.currency === 'UNKNOWN' ? null : group.currency), search), h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' }, h('thead', null, head), body)));
  }

  drawFilters();
  load();
  return {
    element: reportsLayout({ active: '/reports', subtitle: 'Gasto, cliques e conversões das suas contas, com comparação e gráficos.', children: [filtersBar, content] }),
  };
}

/** Barra fina com a participação da conta no gasto (a largura vai por CSSOM: permitido pela CSP). */
function shareBar(percent) {
  const bar = h('span', { class: 'share' }, h('span', { class: 'share__fill' }));
  bar.firstChild.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  return bar;
}
