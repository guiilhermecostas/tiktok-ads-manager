import { del, get } from '../api.js';
import { h, icon } from '../dom.js';
import { CAMPAIGN_STATUS, formatDate, formatMoney, OBJECTIVES } from '../format.js';
import { alertBox, badge, button, confirmDialog, emptyState, toast } from '../ui.js';
import { pageHeader } from './layout.js';

const PUBLISH_BADGE = {
  published: ['Publicada no TikTok', 'success'],
  partial: ['Publicação parcial', 'danger'],
  none: ['Não publicada', 'neutral'],
};

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
    const published = campaign.publish.status !== 'none';
    const ok = await confirmDialog({
      title: 'Excluir campanha',
      message: published
        ? `Excluir "${campaign.name}" deste painel? Os itens já criados no TikTok continuam existindo lá (pausados) e precisam ser removidos pelo próprio TikTok.`
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
    const newButton = button([icon('plus', 16), ' Nova campanha'], { variant: 'primary', onClick: () => ctx.navigate('/campaigns/new') });
    const header = pageHeader('Campanhas', 'Crie campanhas passo a passo e publique no TikTok Ads.', newButton);
    if (!campaigns.length) {
      return h(
        'div',
        null,
        header,
        h('div', { class: 'card' }, emptyState({ title: 'Nenhuma campanha ainda', text: 'O assistente guia você por objetivo, público, orçamento, lances e anúncio. Você pode salvar como rascunho em qualquer etapa.', action: button('Criar primeira campanha', { variant: 'primary', onClick: () => ctx.navigate('/campaigns/new') }) })),
      );
    }

    const rows = campaigns.map((c) => {
      const status = CAMPAIGN_STATUS[c.status] ?? { label: c.status, tone: 'neutral' };
      const [publishLabel, publishTone] = c.wizard ? PUBLISH_BADGE[c.publish.status] : ['Simples', 'neutral'];
      const open = () => ctx.navigate(`/campaigns/edit?id=${c.id}`);
      const view = c.publish.status === 'published';
      return h(
        'tr',
        null,
        h('td', { class: 'cell-strong' }, c.name, c.publish.error ? h('p', { class: 'muted cell-note' }, c.publish.error) : null),
        h('td', null, OBJECTIVES[c.objective] ?? c.objective),
        h('td', null, c.dailyBudget ? formatMoney(c.dailyBudget) : '—'),
        h('td', null, badge(status.label, status.tone)),
        h('td', null, badge(publishLabel, publishTone)),
        h('td', { class: 'muted' }, formatDate(c.createdAt)),
        h('td', { class: 'cell-actions' }, c.wizard ? button(view ? 'Detalhes' : c.publish.status === 'partial' ? 'Concluir' : 'Editar', { small: true, onClick: open }) : null, button('Excluir', { small: true, variant: 'danger-ghost', onClick: () => remove(c) })),
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
