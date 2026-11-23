import { get } from '../api.js';
import { h } from '../dom.js';
import { formatCurrency, formatNumber, formatPercent, tiktokObjective, tiktokStatus } from '../format.js';
import { alertBox, badge, emptyState, field, spinner } from '../ui.js';
import { reportsLayout } from './reports.js';

function metric(label, value) {
  return h('div', { class: 'card metric metric--sm' }, h('span', { class: 'metric__label' }, label), h('strong', { class: 'metric__value' }, value));
}

/** Página alimentada pelas Business Centers cadastradas: contas, desempenho e campanhas do TikTok. */
export async function tiktokAdsView() {
  const { advertisers } = await get('/tiktok/advertisers');
  // Mesma estrutura da aba "Visão geral" (título e abas de Relatórios); aqui o foco é UMA conta: desempenho e campanhas dela.
  const wrap = (...children) => reportsLayout({ active: '/reports/accounts', subtitle: 'Desempenho e campanhas de uma conta de anúncio, direto do TikTok.', children });

  if (!advertisers.length) {
    return {
      element: wrap(
        h(
          'div',
          { class: 'card' },
          emptyState({
            title: 'Nenhuma conta de anúncio conectada',
            text: 'Conecte sua Business Center para ver o desempenho e as campanhas das suas contas do TikTok.',
            action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center'),
          }),
        ),
      ),
    };
  }

  const usable = advertisers.filter((a) => a.businessCenterStatus === 'active');
  const data = h('div', null, spinner());
  const toolbar = h('div', { class: 'toolbar' });
  let advertiser = usable[0] ?? null;
  let days = 7;
  let loadId = 0;

  async function loadData() {
    const current = ++loadId;
    data.replaceChildren(spinner());
    try {
      const base = `/tiktok/advertisers/${encodeURIComponent(advertiser.id)}`;
      const [report, campaigns] = await Promise.all([get(`${base}/report?days=${days}`), get(`${base}/campaigns`)]);
      if (current === loadId) data.replaceChildren(drawData(report, campaigns));
    } catch (err) {
      if (current === loadId) data.replaceChildren(alertBox(err.message));
    }
  }

  function drawData(report, campaigns) {
    const money = (v) => formatCurrency(v, advertiser.currency);
    const t = report.totals;
    const max = Math.max(...report.days.map((d) => d.spend), 0);
    const bars = report.days.length
      ? h(
          'div',
          { class: 'card card--pad' },
          h('h2', { class: 'card__title' }, 'Gasto por dia'),
          h(
            'div',
            { class: 'bars', role: 'img', 'aria-label': 'Gráfico de gasto diário' },
            report.days.map((d) => h('div', { class: `bars__col${d.spend ? '' : ' bars__col--empty'}`, title: `${d.date}: ${money(d.spend)}`, style: { height: `${max ? Math.max(2, (d.spend / max) * 100) : 2}%` } })),
          ),
          h('div', { class: 'bars__legend' }, h('span', null, report.days[0].date), h('span', null, report.days.at(-1).date)),
        )
      : h('div', { class: 'card' }, emptyState({ title: 'Sem dados no período', text: 'O TikTok não retornou desempenho para as datas selecionadas.' }));

    const table = campaigns.campaigns.length
      ? h(
          'div',
          { class: 'card table-wrap' },
          h(
            'table',
            { class: 'table' },
            h('thead', null, h('tr', null, ['Campanha', 'Objetivo', 'Status', 'Orçamento'].map((c) => h('th', { scope: 'col' }, c)))),
            h(
              'tbody',
              null,
              campaigns.campaigns.map((c) => {
                const st = tiktokStatus(c.status);
                return h('tr', null, h('td', { class: 'cell-strong' }, c.name), h('td', null, tiktokObjective(c.objective)), h('td', null, badge(st.label, st.tone)), h('td', null, c.budget ? money(c.budget) : '—'));
              }),
            ),
          ),
        )
      : h('div', { class: 'card' }, emptyState({ title: 'Nenhuma campanha', text: 'Esta conta ainda não tem campanhas no TikTok.' }));

    return h(
      'div',
      null,
      h(
        'div',
        { class: 'grid grid--6' },
        metric('Gasto', money(t.spend)),
        metric('Impressões', formatNumber(t.impressions)),
        metric('Cliques', formatNumber(t.clicks)),
        metric('CTR', formatPercent(t.ctr)),
        metric('CPC', money(t.cpc)),
        metric('Conversões', formatNumber(t.conversions)),
      ),
      bars,
      h('h2', { class: 'card__title section-title' }, `Campanhas no TikTok (${campaigns.total})`),
      table,
    );
  }

  if (!advertiser) {
    data.replaceChildren(alertBox('Todas as suas Business Centers estão com o token com erro. Atualize o token em Contas TikTok (Editar).'));
    return { element: wrap(data) };
  }

  const advField = field('Conta de anúncio', {
    as: 'select',
    options: usable.map((a) => [a.id, `${a.businessCenterName} · ${a.name}`]),
    value: advertiser.id,
  });
  const periodField = field('Período', { as: 'select', options: [['7', 'Últimos 7 dias'], ['14', 'Últimos 14 dias'], ['30', 'Últimos 30 dias']], value: '7' });
  advField.control.addEventListener('change', () => {
    advertiser = usable.find((a) => a.id === advField.control.value) ?? advertiser;
    loadData();
  });
  periodField.control.addEventListener('change', () => {
    days = Number(periodField.control.value);
    loadData();
  });
  toolbar.append(advField.element, periodField.element);

  loadData();
  return { element: wrap(toolbar, data), cleanup: () => { loadId += 1; } };
}
