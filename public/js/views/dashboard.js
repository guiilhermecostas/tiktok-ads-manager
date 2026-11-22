import { get } from '../api.js';
import { h } from '../dom.js';
import { formatCurrency, formatMoney, formatNumber, formatPercent } from '../format.js';
import { can, isWorkspaceOwner, state } from '../state.js';
import { button, emptyState } from '../ui.js';
import { openCampaignWizard } from './campaign-wizard/index.js';
import { pageHeader } from './layout.js';

const metric = (label, value, accent = 'neutral') =>
  h('div', { class: `card metric metric--${accent}` }, h('span', { class: 'metric__label' }, label), h('strong', { class: 'metric__value' }, value));

const OVERVIEW_DAYS = 7;

/** A visão do TikTok nunca pode derrubar o Início: qualquer falha vira `null`. */
async function loadOverview() {
  try {
    return await get(`/tiktok/overview?days=${OVERVIEW_DAYS}`);
  } catch {
    return null;
  }
}

function tiktokSection(overview) {
  const title = h('h2', { class: 'card__title section-title' }, `TikTok Ads · últimos ${OVERVIEW_DAYS} dias`);

  if (overview === null) {
    return h('div', null, title, h('div', { class: 'card card--pad' }, h('p', { class: 'muted' }, 'Não foi possível carregar os dados do TikTok agora. Tente novamente em instantes.')));
  }
  if (overview.totalAdvertisers === 0) {
    return h(
      'div',
      null,
      title,
      h(
        'div',
        { class: 'card' },
        emptyState({
          title: 'Conecte sua Business Center',
          text: 'Conecte sua Business Center para ver gasto, cliques e conversões das suas contas aqui.',
          action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center'),
        }),
      ),
    );
  }

  const groups = overview.groups.map((g) => {
    const money = (v) => formatCurrency(v, g.currency);
    return h(
      'div',
      null,
      overview.groups.length > 1 ? h('p', { class: 'muted section-note' }, `Contas em ${g.currency === 'UNKNOWN' ? 'moeda não informada' : g.currency} (${g.advertisers})`) : null,
      h(
        'div',
        { class: 'grid grid--6' },
        metric('Gasto', money(g.totals.spend), 'cyan'),
        metric('Impressões', formatNumber(g.totals.impressions)),
        metric('Cliques', formatNumber(g.totals.clicks)),
        metric('CTR', formatPercent(g.totals.ctr)),
        metric('CPC', money(g.totals.cpc)),
        metric('Conversões', formatNumber(g.totals.conversions), 'red'),
      ),
    );
  });
  const notes = [];
  if (overview.failed > 0) notes.push(`${overview.failed} conta(s) não puderam ser consultadas.`);
  if (overview.analyzed < overview.totalAdvertisers) notes.push(`Mostrando as primeiras ${overview.analyzed} de ${overview.totalAdvertisers} contas.`);
  return h('div', null, title, groups, notes.length ? h('p', { class: 'muted section-note section-note--lg' }, notes.join(' ')) : null);
}

/** Colaborador sem campanhas nem relatórios: o Início só aponta para o que ele pode usar. */
function welcomeSection() {
  const links = [
    ['creatives', '/creatives', 'Criativos'],
    ['accounts', '/business-centers', 'Contas TikTok'],
  ].filter(([area]) => can(area));
  return h(
    'div',
    { class: 'card' },
    emptyState({
      title: `Equipe de ${state.workspace.ownerName}`,
      text: 'Você tem acesso às áreas liberadas no menu à esquerda. Se precisar de mais acesso, peça a quem convidou você.',
      action: links.length ? h('div', { class: 'page-header__actions' }, links.map(([, href, label]) => h('a', { href, 'data-link': true, class: 'btn btn--primary' }, label))) : null,
    }),
  );
}

export async function dashboardView(ctx) {
  const withCampaigns = can('campaigns');
  const withReports = can('reports');
  // Cada bloco só é pedido (e mostrado) se a pessoa tem a área; a visão do TikTok nunca derruba o Início.
  const [summaryResult, overview] = await Promise.all([withCampaigns ? get('/campaigns/summary') : null, withReports ? loadOverview() : null]);
  const summary = summaryResult?.summary ?? null;
  const firstName = state.user.name.split(' ')[0];

  const body = !summary
    ? null
    : summary.total === 0
      ? h(
          'div',
          { class: 'card' },
          emptyState({
            title: 'Crie sua primeira campanha',
            text: 'Organize objetivos, orçamentos e status das suas campanhas de TikTok Ads em um só lugar.',
            action: button('Publicar campanha', { variant: 'primary', onClick: () => openCampaignWizard(ctx) }),
          }),
        )
      : h(
          'div',
          { class: 'card card--pad' },
          h('h2', { class: 'card__title' }, 'Resumo da operação'),
          h('p', { class: 'muted' }, `${isWorkspaceOwner() ? 'Você tem' : 'A equipe tem'} ${summary.draft} rascunho(s), ${summary.active} campanha(s) ativa(s) e ${summary.paused} pausada(s).`),
          h('div', { class: 'page-header__actions' }, button('Publicar campanha', { variant: 'primary', onClick: () => openCampaignWizard(ctx) }), h('a', { href: '/campaigns', 'data-link': true, class: 'btn btn--secondary' }, 'Gerenciar campanhas')),
        );

  return {
    element: h(
      'div',
      null,
      pageHeader(`Olá, ${firstName}`, withCampaigns || withReports ? 'Veja um resumo da sua operação de TikTok Ads.' : 'Bem-vindo(a) ao TikTok Ads Manager.'),
      withReports ? tiktokSection(overview) : null,
      summary
        ? [
            h('h2', { class: 'card__title section-title' }, 'Campanhas internas'),
            h(
              'div',
              { class: 'grid grid--4' },
              metric('Campanhas', String(summary.total), 'neutral'),
              metric('Ativas', String(summary.active), 'cyan'),
              metric('Pausadas', String(summary.paused), 'red'),
              metric('Orçamento diário ativo', formatMoney(summary.activeBudget), 'neutral'),
            ),
          ]
        : null,
      body,
      withCampaigns || withReports ? null : welcomeSection(),
    ),
  };
}
