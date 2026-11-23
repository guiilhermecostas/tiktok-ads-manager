import { get, post } from '../api.js';
import { lineChart } from '../charts.js';
import { h, setChildren } from '../dom.js';
import { formatCurrency, formatNumber } from '../format.js';
import { alertBox, button, emptyState, spinner, toast } from '../ui.js';
import { currencyBadge } from './account-filter.js';
import { reportsLayout } from './reports.js';

const PERIODS = [
  { hours: 24, label: '24 horas' },
  { hours: 48, label: '48 horas' },
  { hours: 168, label: '7 dias' },
];
const METRICS = [
  { key: 'spend', label: 'Gasto', title: 'Gasto por hora', money: true },
  { key: 'clicks', label: 'Cliques', title: 'Cliques por hora', money: false },
  { key: 'impressions', label: 'Impressões', title: 'Impressões por hora', money: false },
  { key: 'conversions', label: 'Conversões', title: 'Conversões por hora', money: false },
];

const two = (n) => String(n).padStart(2, '0');
/** "23/11 14h" no horário do NAVEGADOR (o servidor guarda tudo em UTC). */
const hourLabel = (iso) => {
  const d = new Date(iso);
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}h`;
};
const timeLabel = (iso) => {
  const d = new Date(iso);
  return `${two(d.getDate())}/${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** "Por hora": gasto de cada hora (coletado do TikTok a cada 30 minutos) em gráfico de linha suave, com filtros. */
export async function reportsHourlyView() {
  const state = { hours: 24, advertiserId: '', currency: null, metric: 'spend' };
  const filtersBar = h('div', { class: 'reports__filters' });
  const content = h('div', { class: 'reports__content' }, spinner());
  let data = null;
  let loadId = 0;
  let refreshing = false;

  const currentGroup = () => (data?.groups.length ? data.groups.find((g) => g.currency === state.currency) ?? data.groups[0] : null);
  const money = (value, currency) => formatCurrency(value, currency === 'UNKNOWN' ? undefined : currency);
  const valueOf = (metric, value, currency) => (metric.money ? money(value, currency) : formatNumber(Math.round(value)));

  async function load() {
    const current = ++loadId;
    content.classList.add('is-loading');
    try {
      const params = new URLSearchParams({ hours: String(state.hours) });
      if (state.advertiserId) params.set('advertiserId', state.advertiserId);
      const fresh = await get(`/tiktok/hourly?${params}`);
      if (current !== loadId) return;
      data = fresh;
      if (!data.groups.some((g) => g.currency === state.currency)) state.currency = data.groups[0]?.currency ?? null;
      drawFilters();
      drawContent();
    } catch (err) {
      if (current !== loadId) return;
      setChildren(content, alertBox(err.message || 'Não foi possível carregar o gasto por hora.'), h('p', null, button('Tentar de novo', { onClick: load })));
    } finally {
      if (current === loadId) content.classList.remove('is-loading');
    }
  }

  async function refreshNow(trigger) {
    if (refreshing) return;
    refreshing = true;
    trigger.disabled = true;
    trigger.textContent = 'Buscando no TikTok…';
    try {
      const result = await post('/tiktok/hourly/refresh');
      toast(result.connections ? `Atualizado: ${result.rows} ${result.rows === 1 ? 'hora' : 'horas'} de ${result.advertisers} ${result.advertisers === 1 ? 'conta' : 'contas'}${result.failed ? ` (${result.failed} sem resposta)` : ''}.` : 'Nenhuma conexão ativa para atualizar.', result.failed ? 'danger' : 'success');
    } catch (err) {
      toast(err.message, 'danger');
    }
    refreshing = false;
    await load();
  }

  // ---------- filtros ----------
  function drawFilters() {
    const segmented = (label, items, isOn, onPick) => h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': label },
      items.map((item) => h('button', { type: 'button', class: `segmented__btn${isOn(item) ? ' is-on' : ''}`, 'aria-pressed': String(isOn(item)), onClick: () => onPick(item) }, item.label)),
    );
    const period = segmented('Período', PERIODS, (p) => p.hours === state.hours, (p) => { state.hours = p.hours; load(); });
    const metric = segmented('Métrica', METRICS, (m) => m.key === state.metric, (m) => { state.metric = m.key; drawFilters(); drawContent(); });
    const account = h(
      'select',
      { class: 'input input--filter', 'aria-label': 'Filtrar por conta de anúncio', onChange: (e) => { state.advertiserId = e.target.value; load(); } },
      h('option', { value: '' }, `Todas as contas${data ? ` (${data.accountOptions.length})` : ''}`),
      (data?.accountOptions ?? []).map((a) => h('option', { value: a.id }, `${a.name}${a.currency ? ` · ${a.currency}` : ''}`)),
    );
    account.value = state.advertiserId;
    const currency = data && data.groups.length > 1
      ? h('select', { class: 'input input--filter', 'aria-label': 'Moeda dos valores', onChange: (e) => { state.currency = e.target.value; drawContent(); } }, data.groups.map((g) => h('option', { value: g.currency }, g.currency === 'UNKNOWN' ? 'Moeda não informada' : g.currency)))
      : null;
    if (currency) currency.value = state.currency;
    const refresh = button('Atualizar agora', { small: true, onClick: (e) => refreshNow(e.currentTarget) });
    refresh.classList.add('reports__refresh');
    setChildren(filtersBar, period, metric, account, currency, refresh);
  }

  // ---------- conteúdo ----------
  function drawContent() {
    if (!data) return;
    if (data.totalAdvertisers === 0) {
      setChildren(content, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Conecte sua Business Center para acompanhar o gasto de cada hora das suas contas.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
      return;
    }
    const group = currentGroup();
    if (!group) {
      setChildren(
        content,
        h('div', { class: 'card' }, emptyState({
          title: 'Ainda não há dados por hora',
          text: `O sistema busca o gasto de cada hora no TikTok a cada ${data.everyMinutes} minutos. Se acabou de conectar, clique em “Atualizar agora” para buscar já; se as contas ainda não gastaram, o gráfico aparece quando houver gasto.`,
        })),
      );
      return;
    }

    const metric = METRICS.find((m) => m.key === state.metric);
    const { currency } = group;
    const values = group.points.map((p) => p[metric.key]);
    const total = group.totals[metric.key];
    const perHour = group.hoursCovered ? total / group.hoursCovered : 0;
    const peakPoint = group.points.reduce((best, p) => (p[metric.key] > (best?.[metric.key] ?? 0) ? p : best), null);
    const activeHours = group.points.filter((p) => p[metric.key] > 0).length;

    const kpi = (label, value, hint) => h('div', { class: 'kpi kpi--static' }, h('span', { class: 'kpi__label' }, label), h('strong', { class: 'kpi__value' }, value), h('span', { class: 'kpi__hint muted' }, hint ?? ''));
    const kpis = h(
      'div',
      { class: 'kpis kpis--4', role: 'group', 'aria-label': 'Resumo do período' },
      kpi(`${metric.label} no período`, valueOf(metric, total, currency), `${group.hoursCovered} ${group.hoursCovered === 1 ? 'hora' : 'horas'} com coleta`),
      kpi('Média por hora', valueOf(metric, perHour, currency), 'considerando todas as horas coletadas'),
      kpi('Hora de maior valor', peakPoint ? valueOf(metric, peakPoint[metric.key], currency) : '—', peakPoint ? hourLabel(peakPoint.hour) : 'sem movimento'),
      kpi('Horas com movimento', `${activeHours} de ${group.hoursCovered}`, 'horas em que houve valor'),
    );

    const rangeNote = `${hourLabel(group.points[0].hour)} → ${hourLabel(group.points.at(-1).hour)} · horário do seu navegador${state.advertiserId ? ' · conta selecionada' : ''}`;
    const chartCard = h(
      'section',
      { class: 'card card--pad reports__chart' },
      h('div', { class: 'reports__chart-head' }, h('div', null, h('h2', { class: 'card__title' }, metric.title), h('p', { class: 'muted' }, rangeNote)), h('div', { class: 'reports__chart-side' }, currencyBadge(currency === 'UNKNOWN' ? null : currency), h('strong', { class: 'reports__chart-total' }, valueOf(metric, total, currency)))),
      group.points.length > 1
        ? lineChart({ dates: group.points.map((p) => p.hour), values, format: (v) => valueOf(metric, v, currency), label: metric.title, formatX: (iso, kind) => (kind === 'eixo' ? hourLabel(iso) : `${hourLabel(iso)}–${two((new Date(iso).getHours() + 1) % 24)}h`), unit: 'horas', maxTicks: state.hours === 168 ? 7 : 6 })
        : h('p', { class: 'muted' }, `Só há uma hora coletada até agora (${hourLabel(group.points[0].hour)}): ${valueOf(metric, values[0], currency)}. O gráfico de linha aparece a partir da segunda hora.`),
    );

    const top = [...group.points].filter((p) => p[metric.key] > 0).sort((a, b) => b[metric.key] - a[metric.key]).slice(0, 5);
    const topCard = h(
      'section',
      { class: 'card card--pad reports__insights' },
      h('h2', { class: 'card__title' }, 'Horas de maior valor'),
      top.length
        ? h('ol', { class: 'hours-top' }, top.map((p) => h('li', null, h('span', null, `${hourLabel(p.hour)}–${two((new Date(p.hour).getHours() + 1) % 24)}h`), h('strong', null, valueOf(metric, p[metric.key], currency)))))
        : h('p', { class: 'muted' }, 'Nenhuma hora com movimento neste período.'),
    );

    const collected = data.lastCollectedAt
      ? `Última coleta: ${timeLabel(data.lastCollectedAt)} · coleta automática a cada ${data.everyMinutes} minutos. O TikTok pode ainda ajustar os números da hora em andamento.`
      : `Coleta automática a cada ${data.everyMinutes} minutos.`;
    setChildren(content, kpis, h('div', { class: 'reports__split' }, chartCard, topCard), h('p', { class: 'hub__note' }, collected));
  }

  drawFilters();
  load();
  return {
    element: reportsLayout({ active: '/reports/hourly', subtitle: 'Quanto cada hora gastou, buscado no TikTok a cada 30 minutos.', children: [filtersBar, content] }),
  };
}
