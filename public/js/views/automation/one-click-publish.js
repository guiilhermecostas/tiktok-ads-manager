import { confirmLabel, confirmMessage, resultToasts, verifyToasts } from '/shared/publish-messages.js';
import { get, post } from '../../api.js';
import { h, icon } from '../../dom.js';
import { alertBox, button, confirmDialog, openModal, spinner, toast } from '../../ui.js';
import { publishToAccounts, verifyPublished } from '../campaign-wizard/publish-run.js';
import { createPublishTargets } from '../campaign-wizard/publish-targets.js';

let active = null; // um pop-up por vez (duplo clique no botão não abre dois)

/**
 * Pop-up "Publicar" de uma configuração one-click: lista TODAS as contas de anúncio, com filtro por Business Center, tipo e situação (ativas/inativas)
 * e busca por nome ou ID da conta; a pessoa marca as contas e publica. Cada conta é uma publicação própria (progresso, erro e retomada por conta),
 * pausada ou, se a pessoa quiser, já ATIVA. A pessoa também escolhe quantas campanhas iguais criar em cada conta (para testar fatias de público). As campanhas são criadas a partir da configuração no primeiro clique em publicar e reaproveitadas se a pessoa tentar de novo as contas que falharam.
 * `template`: { id, name, config }. `onDone()`: chamado ao fechar, se algo foi publicado.
 */
export function openOneClickPublish({ template, onDone }) {
  if (active) return active;
  const body = h('div', { class: 'oneclick-publish__scroll' }, spinner('Carregando as contas de anúncio…'));
  let targets = null;
  let busy = false;
  let published = false;
  let drafts = []; // campanhas (rascunhos) criadas no primeiro "Publicar" (uma por cópia); as tentativas seguintes (contas que falharam) usam as mesmas
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
    const copies = targets.copies();
    const activate = targets.activate();
    const ok = await confirmDialog({
      title: 'Publicar no TikTok',
      message: confirmMessage({ what: `a campanha, o grupo de anúncios e o anúncio de “${template.name}”`, where: `em ${ids.length === 1 ? '1 conta' : `${ids.length} contas`}`, accounts: ids.length, copies, activate }),
      confirmLabel: confirmLabel({ accounts: ids.length, copies, activate }),
    });
    if (!ok) return undefined;

    busy = true;
    targets.clearResults();
    targets.setBusy(true);
    drawFooter();
    try {
      if (drafts.length !== copies) drafts = (await post(`/automation/one-click/${template.id}/launch`, { count: copies })).campaigns.map((c) => c.id);
    } catch (err) {
      // Configuração incompleta, criativo apagado, etc.: nada foi criado no TikTok.
      showBanner(Array.isArray(err.details) && err.details.length ? `Esta configuração precisa de ajustes antes de publicar: ${err.details.slice(0, 3).map((d) => d.message).join(' · ')}. Edite o cartão e tente de novo.` : err.message);
      busy = false;
      targets.setBusy(false);
      drawFooter();
      return undefined;
    }
    const { succeeded, failed, renamed, created, unverified } = await publishToAccounts({ campaignIds: drafts, ids, targets, activate });
    if (succeeded.length) published = true;
    try {
      if (drafts.length === 1) publications = (await get(`/campaigns/${drafts[0]}`)).campaign.publications;
    } catch {
      /* mantém o estado anterior */
    }
    targets.deselect(succeeded);
    busy = false;
    targets.setBusy(false);
    for (const { message, tone } of resultToasts({ requested: ids.length, succeeded: succeeded.length, failed, created, copies, activate, renamed, unverified })) toast(message, tone);
    drawFooter();
    return undefined;
  }

  /** "Conferir no TikTok" de uma conta publicada: confere por ID e, se faltar algo, a conta volta para "tentar de novo". */
  async function verifyAccount(account) {
    if (busy || drafts.length !== 1) return;
    busy = true;
    targets.setBusy(true);
    drawFooter();
    try {
      for (const { message, tone } of verifyToasts(await verifyPublished({ campaignId: drafts[0], advertiserId: account.id }))) toast(message, tone);
      publications = (await get(`/campaigns/${drafts[0]}`)).campaign.publications;
      targets.setResult(account.id, null); // o selo da rodada anterior ("publicada") não vale mais: a situação volta a vir do registro
    } catch (err) {
      toast(err.message, 'danger');
    }
    busy = false;
    targets.setBusy(false);
    targets.refresh();
    drawFooter();
  }

  get('/tiktok/advertisers')
    .then(({ advertisers }) => {
      targets = createPublishTargets({ advertisers, getConfig: () => template.config, getPublications: () => (drafts.length > 1 ? [] : publications), onChange: drawFooter, alwaysSearch: true, onVerify: verifyAccount });
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
