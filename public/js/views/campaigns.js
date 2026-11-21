import { del, get } from '../api.js';
import { h, icon } from '../dom.js';
import { CAMPAIGN_STATUS, formatDate, formatMoney, OBJECTIVES } from '../format.js';
import { alertBox, badge, button, confirmDialog, emptyState, toast } from '../ui.js';
import { openCampaignWizard } from './campaign-wizard/index.js';
import { pageHeader } from './layout.js';

/** Etiqueta da situação no TikTok: quantas contas receberam a campanha. */
function publishBadge(publish) {
  if (publish.status === 'partial') return ['Publicação parcial', 'danger'];
  if (publish.status === 'published') return [publish.published === 1 ? 'Publicada em 1 conta' : `Publicada em ${publish.published} contas`, 'success'];
  return ['Não publicada', 'neutral'];
}

export async function campaignsView(ctx) {
  const container = h('div');

  async function load() {
    const { campaigns } = await get('/campaigns');
    container.replaceChildren(draw(campaigns));
  }

  async function safeReload() {
    try {
      await load();
    } catch (err) {
      container.replaceChildren(alertBox(err.message));
    }
  }

  async function remove(campaign) {
    const published = campaign.publish.published + campaign.publish.partial > 0;
    const ok = await confirmDialog({
      title: 'Excluir campanha',
      message: published
        ? `Excluir "${campaign.name}" deste painel? Os itens já criados no TikTok (em todas as contas) continuam existindo lá, pausados, e precisam ser removidos pelo próprio TikTok.`
        : `Tem certeza que deseja excluir "${campaign.name}"? Esta ação não pode ser desfeita.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/campaigns/${campaign.id}`);
      toast('Campanha excluída.');
      await safeReload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function draw(campaigns) {
    const newButton = button([icon('plus', 16), ' Nova campanha'], { variant: 'primary', onClick: () => openCampaignWizard(ctx) });
    const header = pageHeader('Campanhas', 'Seus rascunhos e campanhas publicadas. Para criar uma nova, use também o botão “Publicar campanha”, disponível em qualquer tela.', newButton);
    if (!campaigns.length) {
      return h(
        'div',
        null,
        header,
        h('div', { class: 'card' }, emptyState({ title: 'Nenhuma campanha ainda', text: 'O assistente guia você por objetivo, público, orçamento, lances e anúncio. Você pode salvar como rascunho em qualquer etapa.', action: button('Criar primeira campanha', { variant: 'primary', onClick: () => openCampaignWizard(ctx) }) })),
      );
    }

    const rows = campaigns.map((c) => {
      const status = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: 'neutral' };
      const [publishLabel, publishTone] = c.wizard ? publishBadge(c.publish) : ['Simples', 'neutral'];
      const open = () => openCampaignWizard(ctx, { campaignId: c.id });
      const view = c.publish.locks.ad;
      return h(
        'tr',
        null,
        h('td', { class: 'cell-strong' }, c.name, c.publish.error ? h('p', { class: 'muted cell-note' }, c.publish.error) : null),
        h('td', null, OBJECTIVES[c.objective] ?? c.objective),
        h('td', null, c.dailyBudget ? formatMoney(c.dailyBudget) : '—'),
        h('td', null, badge(status.label, status.tone)),
        h('td', null, badge(publishLabel, publishTone)),
        h('td', { class: 'muted' }, formatDate(c.createdAt)),
        h('td', { class: 'cell-actions' }, c.wizard ? button(view ? 'Detalhes e novas contas' : c.publish.status === 'partial' ? 'Concluir' : 'Editar', { small: true, onClick: open }) : null, button('Excluir', { small: true, variant: 'danger-ghost', onClick: () => remove(c) })),
      );
    });
    return h(
      'div',
      null,
      header,
      h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Campanha', 'Objetivo', 'Orçamento diário', 'Status', 'TikTok', 'Criada em', ''].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows))),
    );
  }

  await load();
  return { element: container };
}
