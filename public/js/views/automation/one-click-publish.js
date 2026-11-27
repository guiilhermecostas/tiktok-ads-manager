import { get, post } from '../../api.js';
import { h, icon } from '../../dom.js';
import { alertBox, button, confirmDialog, openModal, spinner, toast } from '../../ui.js';
import { publishToAccounts } from '../campaign-wizard/publish-run.js';
import { createPublishTargets } from '../campaign-wizard/publish-targets.js';

let active = null; // um pop-up por vez (duplo clique no botão não abre dois)

/**
 * Pop-up "Publicar" de uma configuração one-click: lista TODAS as contas de anúncio, com filtro por Business Center, tipo e situação (ativas/inativas)
 * e busca por nome ou ID da conta; a pessoa marca as contas e publica. Cada conta é uma publicação própria (progresso, erro e retomada por conta),
 * sempre PAUSADA. A campanha é criada a partir da configuração no primeiro clique em publicar e reaproveitada se a pessoa tentar de novo as contas que falharam.
 * `template`: { id, name, config }. `onDone()`: chamado ao fechar, se algo foi publicado.
 */
export function openOneClickPublish({ template, onDone }) {
  if (active) return active;
  const body = h('div', { class: 'oneclick-publish__scroll' }, spinner('Carregando as contas de anúncio…'));
  let targets = null;
  let busy = false;
  let published = false;
  let campaignId = null; // criada no primeiro "Publicar"; as tentativas seguintes (contas que falharam) usam a mesma
  let publications = [];
  const bannerSlot = h('div', { class: 'oneclick-publish__banner' });
  const footer = h('div', { class: 'oneclick-publish__footer' }); // fora da área que rola: o botão Publicar fica sempre à vista, mesmo com muitas contas

  const modal = openModal({
    title: `Publicar “${template.name}”`,
    size: 'wide',
    body: h('div', { class: 'oneclick-publish' }, bannerSlot, body, footer),
    dismissOnOverlay: false,
    canClose: () => {
      if (!busy) return true;
      toast('Aguarde a publicação terminar para fechar.', 'danger');
      return false;
    },
    onClose: () => {
      active = null;
      if (published) onDone?.();
    },
  });
  active = modal;

  const showBanner = (message) => bannerSlot.replaceChildren(...(message ? [alertBox(message)] : []));

  function drawFooter() {
    const count = targets ? targets.selectedIds().length : 0;
    footer.replaceChildren(
      button(published ? 'Fechar' : 'Cancelar', { onClick: () => modal.requestClose(), disabled: busy }),
      targets
        ? button(busy ? 'Publicando…' : [icon('megaphone', 16), ` ${count > 1 ? `Publicar em ${count} contas` : 'Publicar'}`], { variant: 'primary', onClick: publish, disabled: busy || count === 0 })
        : null,
    );
  }

  async function publish() {
    const ids = targets.selectedIds();
    if (!ids.length) return showBanner('Escolha ao menos uma conta de anúncio.');
    if (Object.keys(targets.validate()).length) return showBanner('Corrija os IDs destacados nas contas selecionadas.');
    showBanner(null);
    const ok = await confirmDialog({
      title: 'Publicar no TikTok',
      message: `Vamos criar a campanha, o grupo de anúncios e o anúncio de “${template.name}” em ${ids.length === 1 ? '1 conta' : `${ids.length} contas`}. Tudo será criado PAUSADO: nada começa a gastar até você ativar no TikTok.`,
      confirmLabel: ids.length === 1 ? 'Publicar (pausada)' : `Publicar em ${ids.length} contas (pausadas)`,
    });
    if (!ok) return undefined;

    busy = true;
    targets.clearResults();
    targets.setBusy(true);
    drawFooter();
    try {
      if (!campaignId) campaignId = (await post(`/automation/one-click/${template.id}/launch`)).campaign.id;
    } catch (err) {
      // Configuração incompleta, criativo apagado, etc.: nada foi criado no TikTok.
      showBanner(Array.isArray(err.details) && err.details.length ? `Esta configuração precisa de ajustes antes de publicar: ${err.details.slice(0, 3).map((d) => d.message).join(' · ')}. Edite o cartão e tente de novo.` : err.message);
      busy = false;
      targets.setBusy(false);
      drawFooter();
      return undefined;
    }
    const { succeeded, failed } = await publishToAccounts({ campaignId, ids, targets });
    if (succeeded.length) published = true;
    try {
      publications = (await get(`/campaigns/${campaignId}`)).campaign.publications;
    } catch {
      /* mantém o estado anterior */
    }
    targets.deselect(succeeded);
    busy = false;
    targets.setBusy(false);
    if (succeeded.length && !failed) toast(succeeded.length === 1 ? 'Publicada no TikTok (pausada).' : `Publicada em ${succeeded.length} contas (pausadas).`);
    else if (succeeded.length) toast(`Publicada em ${succeeded.length} de ${ids.length} contas. Veja os erros na lista.`, 'danger');
    else toast('Nenhuma conta foi publicada. Veja os erros na lista.', 'danger');
    drawFooter();
    return undefined;
  }

  get('/tiktok/advertisers')
    .then(({ advertisers }) => {
      targets = createPublishTargets({ advertisers, getConfig: () => template.config, getPublications: () => publications, onChange: drawFooter, alwaysSearch: true });
      body.replaceChildren(
        h('p', { class: 'muted oneclick-publish__intro' }, 'Escolha em quais contas de anúncio publicar esta configuração. Use a busca (nome ou ID da conta) e os filtros por Business Center e situação para achar mais rápido.'),
        targets.element,
      );
      drawFooter();
    })
    .catch((err) => {
      body.replaceChildren(alertBox(err.message || 'Não foi possível carregar as contas de anúncio.'));
      drawFooter();
    });
  drawFooter();
  return modal;
}
