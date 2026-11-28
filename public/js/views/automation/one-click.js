import { COUNTRIES, summarize } from '/shared/campaign-spec.js';
import { copyName } from '/shared/one-click.js';
import { del, get } from '../../api.js';
import { h, icon } from '../../dom.js';
import { formatDate, formatMoney, OBJECTIVES } from '../../format.js';
import { alertBox, badge, button, confirmDialog, spinner, toast } from '../../ui.js';
import { openCampaignWizard } from '../campaign-wizard/index.js';
import { pageHeader } from '../layout.js';
import { tabIntro } from '../subtabs.js';
import { openOneClickPublish } from './one-click-publish.js';

const COUNTRY_NAME = Object.fromEntries(COUNTRIES.map((c) => [c.value, c.label]));
const MAX_COUNTRIES_SHOWN = 3;

/** Site de destino só pelo endereço (sem caminho nem parâmetros): é para reconhecer a configuração, não para copiar o link. */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** As linhas curtas que o cartão mostra: para onde vai, quanto gasta e qual é o destino. */
function cardFacts(config) {
  const countries = (config.adGroup.locations ?? []).map((code) => COUNTRY_NAME[code] ?? code);
  const shown = countries.slice(0, MAX_COUNTRIES_SHOWN).join(', ');
  const extra = countries.length > MAX_COUNTRIES_SHOWN ? ` +${countries.length - MAX_COUNTRIES_SHOWN}` : '';
  const { dailyBudget } = summarize(config);
  const budgetCents = config.adGroup.budget ?? config.campaign.budget;
  const budgetKind = config.adGroup.budgetMode === 'BUDGET_MODE_TOTAL' || config.campaign.budgetMode === 'BUDGET_MODE_TOTAL' ? 'total' : 'por dia';
  return [
    ['Campanha', config.campaign.name],
    ['Países', countries.length ? `${shown}${extra}` : '—'],
    ['Orçamento', dailyBudget || budgetCents ? `${formatMoney(dailyBudget || budgetCents)} ${budgetKind}` : 'Sem limite definido'],
    ['Destino', hostOf(config.ad.landingPageUrl) ?? '—'],
  ];
}

/**
 * Automação → Campanha one-click. A pessoa monta UMA vez a campanha completa (campanha, grupo de anúncios e anúncio), dá um nome
 * ("Campanha para o Brasil") e ela vira um cartão com dois botões: Apagar e Publicar. Publicar abre a lista de contas de anúncio (com busca e
 * filtros), deixa escolher quantas campanhas iguais criar em cada conta e se entram já ativas, e cria tudo nas contas marcadas. O mesmo cartão serve para quantas publicações a pessoa quiser.
 */
export async function oneClickView(ctx) {
  const container = h('div', { class: 'oneclick' }, spinner());

  async function load() {
    const { templates } = await get('/automation/one-click');
    container.replaceChildren(draw(templates));
  }

  async function safeReload() {
    try {
      await load();
    } catch (err) {
      container.replaceChildren(alertBox(err.message));
    }
  }

  const create = () => openCampaignWizard({ ...ctx, reload: safeReload }, { template: { id: null } });
  const edit = (template) => openCampaignWizard({ ...ctx, reload: safeReload }, { template: { id: template.id } });
  // Duplicar: abre a cópia no passo do anúncio, para trocar os criativos; só vira cartão quando a pessoa salva.
  const duplicate = (template, all) => openCampaignWizard({ ...ctx, reload: safeReload }, { template: { id: null, copyOf: { name: copyName(template.name, all.map((t) => t.name)), config: structuredClone(template.config) } } });

  async function remove(template) {
    const ok = await confirmDialog({
      title: 'Apagar configuração',
      message: `Apagar “${template.name}”? As campanhas que você já publicou a partir dela continuam no TikTok e no painel; só este cartão some. Não dá para desfazer.`,
      confirmLabel: 'Apagar',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/automation/one-click/${template.id}`);
      toast('Configuração apagada.');
      await safeReload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  const publish = (template) => openOneClickPublish({ template, onDone: safeReload });

  function card(template, all) {
    const facts = cardFacts(template.config);
    return h(
      'article',
      { class: 'oneclick-card' },
      h(
        'div',
        { class: 'oneclick-card__head' },
        h('button', { type: 'button', class: 'oneclick-card__title', title: 'Editar esta configuração', onClick: () => edit(template) }, template.name),
        badge(OBJECTIVES[template.objective] ?? template.objective, 'neutral'),
      ),
      h('dl', { class: 'oneclick-card__facts' }, facts.map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, value)))),
      h('p', { class: 'hub-meta' }, `Atualizada em ${formatDate(template.updatedAt)}`),
      h(
        'div',
        { class: 'oneclick-card__actions' },
        button('Apagar', { variant: 'danger-ghost', onClick: () => remove(template), ariaLabel: `Apagar a configuração ${template.name}` }),
        button('Duplicar', { onClick: () => duplicate(template, all), ariaLabel: `Duplicar a configuração ${template.name}`, title: 'Cria uma cópia para você trocar os criativos (ou o que quiser) sem montar tudo de novo' }),
        button([icon('megaphone', 16), ' Publicar'], { variant: 'primary', onClick: () => publish(template), ariaLabel: `Publicar a configuração ${template.name}` }),
      ),
    );
  }

  const addCard = () => h(
    'button',
    { type: 'button', class: 'oneclick-add', onClick: create, 'aria-label': 'Criar nova configuração' },
    h('span', { class: 'oneclick-add__plus', 'aria-hidden': 'true' }, '+'),
    h('span', { class: 'oneclick-add__label' }, 'Nova configuração'),
    h('span', { class: 'oneclick-add__hint' }, 'Monte campanha, grupo e anúncio uma vez'),
  );

  function draw(templates) {
    return h(
      'div',
      null,
      pageHeader('Campanha one-click', 'Monte a campanha uma vez, dê um nome e publique em várias contas com um clique.'),
      tabIntro('Suas configurações', 'Cada cartão é uma campanha pronta (campanha, grupo de anúncios e anúncio). Clique em + para criar uma, ou em Duplicar para copiar uma que já existe e só trocar os criativos, ex.: “Campanha para os Estados Unidos” e “Campanha para o Brasil”. Em Publicar você escolhe as contas, quantas campanhas iguais criar em cada uma (para testar fatias de público) e se entram já ativas ou pausadas.'),
      h('div', { class: 'oneclick-grid' }, addCard(), templates.map((t) => card(t, templates))),
      templates.length ? null : h('p', { class: 'muted oneclick-empty' }, 'Você ainda não tem nenhuma configuração. Clique em “Nova configuração” para criar a primeira.'),
    );
  }

  await load();
  return { element: container };
}
