import { countByKind } from '/shared/account-labels.js';
import { distinctCurrencies, isMainCurrency, moneyPrefix } from '/shared/currency.js';
import { COUNTRIES, STEPS, collectCreativeRefs, defaultConfig, findField, reconcileConfig, stepOfPath, validateConfig } from '/shared/campaign-spec.js';
import { get, post, put } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { parseMoneyToCents } from '../../format.js';
import { alertBox, button, confirmDialog, openModal, spinner, stepper as stepperView, toast } from '../../ui.js';
import { pickCreatives } from '../creatives/picker.js';
import { renderStepForm } from './form-fields.js';
import { createPublishTargets } from './publish-targets.js';
import { renderReview } from './review.js';

const FORM_STEPS = STEPS.slice(0, -1).map((s) => s.id);
const REVIEW_INDEX = STEPS.length - 1;
const NO_PUBLISH = { status: 'none', published: 0, partial: 0, failed: 0, locks: { campaign: false, adGroup: false, ad: false } };

let active = null; // só um assistente aberto por vez (duplo clique no botão não abre dois)

/** Mensagem curta de uma falha de publicação numa conta (inclui os campos inválidos, se houver). */
function failureMessage(err) {
  if (Array.isArray(err.details) && err.details.length) {
    const parts = err.details.slice(0, 3).map((d) => {
      const [section, key] = String(d.path).split('.');
      return `${findField(section, key)?.label ?? d.path}: ${d.message}`;
    });
    return `Corrija na campanha: ${parts.join(' · ')}`;
  }
  return err.message;
}

/**
 * Campanha de catálogo já encaminhada (atalho "Criar campanha com este catálogo"): objetivo Vendas de produtos, o catálogo e a BC dona dele,
 * vídeo do catálogo, o país do catálogo como destino e nomes sugeridos. A pessoa só completa o resto.
 */
export function catalogPresetConfig(catalog) {
  const config = defaultConfig();
  const label = (catalog.name || catalog.id).slice(0, 80);
  config.campaign.objective = 'PRODUCT_SALES';
  config.campaign.name = `Vendas | ${label}`;
  config.adGroup.name = `Grupo | ${label}`;
  config.adGroup.catalogId = catalog.id;
  config.adGroup.catalogBcId = catalog.bcId;
  if (COUNTRIES.some((c) => c.value === catalog.regionCode)) config.adGroup.locations = [catalog.regionCode];
  config.ad.name = `Anúncio | ${label}`;
  config.ad.format = 'CATALOG_VIDEO';
  return config;
}

/**
 * Assistente de campanha em POP-UP (aberto pelo botão flutuante "Publicar campanha" ou por "Editar" na lista).
 * Passos: Objetivo → Campanha → Grupo de anúncios → Anúncio → Revisão e publicação (escolha das contas de anúncio).
 * A UI é gerada pela especificação compartilhada (/shared/campaign-spec.js); o servidor valida de novo.
 * `ctx.reload()` atualiza a página de trás quando algo foi salvo/publicado.
 */
export function openCampaignWizard(ctx, { campaignId = null, catalog = null } = {}) {
  if (active) return active;

  const body = h('div', { class: 'wizard-modal' }, spinner());
  let st = null;
  let targets = null;

  async function canClose() {
    if (!st) return true;
    if (st.busy) {
      toast('Aguarde a publicação terminar para fechar.', 'danger');
      return false;
    }
    if (!st.dirty) return true;
    return confirmDialog({
      title: 'Sair sem salvar?',
      message: 'Há alterações não salvas nesta campanha. Se sair agora, elas serão perdidas.',
      confirmLabel: 'Sair sem salvar',
      danger: true,
    });
  }

  const beforeUnload = (event) => {
    if (!st?.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  const modal = openModal({
    title: 'Publicar campanha',
    size: 'wizard',
    body,
    dismissOnOverlay: false, // um clique fora, sem querer, não pode jogar fora uma campanha em andamento
    canClose,
    onClose: () => {
      window.removeEventListener('beforeunload', beforeUnload);
      active = null;
      if (st?.changed) ctx.reload?.();
    },
  });
  active = modal;
  window.addEventListener('beforeunload', beforeUnload);

  /** Carrega contas, campanha (se for edição) e criativos; qualquer falha vira mensagem no próprio pop-up. */
  async function load() {
    const [advertiserResult, loaded] = await Promise.all([
      get('/tiktok/advertisers').catch(() => ({ advertisers: [] })),
      campaignId ? get(`/campaigns/${campaignId}`) : Promise.resolve(null),
    ]);
    const existing = loaded?.campaign ?? null;
    if (existing && !existing.wizard) throw new Error('Esta campanha foi criada no formato simples e não pode ser editada pelo assistente.');

    // Biblioteca de criativos: carregamos os mais recentes e, se a campanha já usa algum que ficou de fora, buscamos individualmente.
    const creativeMap = new Map();
    try {
      (await get('/creatives?limit=100')).creatives.forEach((c) => creativeMap.set(c.id, c));
    } catch {
      /* a biblioteca vazia/indisponível não impede abrir o assistente */
    }
    if (existing?.config) {
      const missing = [...new Set(collectCreativeRefs(reconcileConfig(existing.config)).map((r) => r.id))].filter((id) => !creativeMap.has(id));
      await Promise.allSettled(missing.map(async (id) => creativeMap.set(id, (await get(`/creatives/${id}`)).creative)));
    }
    return { existing, creativeMap, advertisers: advertiserResult.advertisers };
  }

  function start({ existing, creativeMap, advertisers }) {
    st = {
      id: existing?.id ?? null,
      config: reconcileConfig(existing?.config ?? (catalog ? catalogPresetConfig(catalog) : defaultConfig())),
      publish: existing?.publish ?? NO_PUBLISH,
      publications: existing?.publications ?? [],
      step: catalog && !existing ? 1 : 0, // com o catálogo escolhido, o objetivo já está definido: começa em "Campanha"
      maxStep: catalog && !existing ? 1 : 0,
      errors: {},
      allErrors: [],
      dirty: false,
      changed: false,
      busy: null, // 'save' | 'publish'
      banner: null,
      moneyText: {},
      advertisers,
    };
    if (existing) body.closest('.modal')?.querySelector('.modal__title')?.replaceChildren(existing.name);

    targets = createPublishTargets({
      advertisers: st.advertisers,
      getConfig: () => st.config,
      getPublications: () => st.publications,
      onChange: () => drawFooter(),
    });

    // ---------- o que já existe no TikTok fica travado (o servidor também impõe isso) ----------
    const locked = () => {
      const { locks } = st.publish;
      const set = new Set();
      if (locks.campaign) ['objective', 'campaign'].forEach((s) => set.add(s));
      if (locks.adGroup) set.add('adGroup');
      if (locks.ad) set.add('ad');
      return set;
    };
    const readOnlyAll = () => st.publish.locks.ad;

    // ---------- validação ----------
    const collect = (stepIds) => {
      const { errors } = validateConfig(st.config, { requireComplete: true, steps: stepIds });
      const map = {};
      for (const e of errors) map[e.path] = e.message;
      for (const [path, text] of Object.entries(st.moneyText)) {
        if (text.trim() && parseMoneyToCents(text) === null && stepIds.includes(stepOfPath(path))) map[path] = 'Informe um valor válido, ex.: 150,00.';
      }
      return map;
    };
    const toList = (map) => Object.entries(map).map(([path, message]) => ({ path, message }));

    /** Primeira etapa (índice) que ainda tem pendência: define até onde o usuário pode navegar. */
    function computeMaxStep() {
      for (let i = 0; i < FORM_STEPS.length; i += 1) if (Object.keys(collect([FORM_STEPS[i]])).length) return i;
      return REVIEW_INDEX;
    }
    if (existing) st.maxStep = computeMaxStep();

    // ---------- estrutura da janela ----------
    const stepperSlot = h('div', { class: 'wizard-modal__stepper' });
    const bannerSlot = h('div', { class: 'wizard-modal__banner' });
    const scroll = h('div', { class: 'wizard-modal__scroll' });
    const footerSlot = h('div', { class: 'wizard-modal__footer' });
    body.replaceChildren(stepperSlot, bannerSlot, scroll, footerSlot);

    let focusPath = null;
    const usableCurrencies = () => distinctCurrencies(st.advertisers.filter((a) => a.businessCenterStatus === 'active'));
    const formCtx = {
      get config() { return st.config; },
      get errors() { return st.errors; },
      creatives: creativeMap,
      pickCreatives: (options) => pickCreatives({ ...options, cache: creativeMap }),
      moneyText: st.moneyText,
      // Moeda das contas que o usuário pode usar: o campo de valor mostra o símbolo certo (ou "BRL / USD") e avisa quando não é só BRL.
      get moneyPrefix() { return moneyPrefix(usableCurrencies()); },
      get currencyNote() {
        const codes = usableCurrencies();
        return codes.some((c) => !isMainCurrency(c)) ? `Você tem contas em ${codes.join(' e ')}. O valor é usado como está, na moeda de cada conta onde publicar (não é convertido). As contas são escolhidas no último passo.` : null;
      },
      // Contas usáveis: o campo de pixel lista os pixels que já existem nelas.
      get pixelAccounts() { return st.advertisers.filter((a) => a.businessCenterStatus === 'active'); },
      get readOnly() { return readOnlyAll() || locked().has(FORM_STEPS[st.step]); },
      set(path, value, { rerender = false } = {}) {
        const [section, key] = path.split('.');
        if (value === undefined) delete st.config[section][key];
        else st.config[section][key] = value;
        st.dirty = true;
        if (st.errors[path]) {
          delete st.errors[path];
          scroll.querySelector(`[data-path="${path}"] .field__error`)?.remove();
          scroll.querySelector(`[data-path="${path}"] [aria-invalid]`)?.removeAttribute('aria-invalid');
          scroll.querySelector(`[data-path="${path}"] .input--error`)?.classList.remove('input--error');
        }
        if (rerender) {
          st.config = reconcileConfig(st.config);
          focusPath = path;
          draw();
        }
      },
    };

    function applyServerErrors(err) {
      if (!Array.isArray(err.details) || !err.details.length) return false;
      const map = {};
      for (const d of err.details) map[d.path] = d.message;
      st.errors = map;
      st.allErrors = err.details;
      const first = err.details.map((d) => STEPS.findIndex((s) => s.id === stepOfPath(d.path))).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (first !== undefined && st.step !== REVIEW_INDEX) st.step = first;
      return true;
    }

    // ---------- navegação ----------
    function enterReview() {
      st.allErrors = toList(collect(FORM_STEPS));
      targets.refresh();
    }

    function goTo(index) {
      if (st.busy) return;
      if (index < 0 || index > REVIEW_INDEX || index > st.maxStep) return;
      st.step = index;
      if (index === REVIEW_INDEX) enterReview();
      st.errors = {};
      st.banner = null;
      draw({ scrollTop: true });
    }

    function next() {
      const errors = collect([FORM_STEPS[st.step]]);
      if (Object.keys(errors).length) {
        st.errors = errors;
        st.banner = null;
        draw({ focusFirstError: true });
        return;
      }
      st.errors = {};
      st.step += 1;
      st.maxStep = Math.max(st.maxStep, st.step);
      if (st.step === REVIEW_INDEX) enterReview();
      draw({ scrollTop: true });
    }

    // ---------- ações ----------
    async function save({ quiet = false } = {}) {
      // Rascunho exige apenas um objetivo; o resto é validado ao publicar.
      const payload = { config: st.config };
      const result = st.id ? await put(`/campaigns/${st.id}`, payload) : await post('/campaigns', payload);
      const saved = result.campaign;
      st.id = saved.id;
      st.config = reconcileConfig(saved.config);
      st.publish = saved.publish;
      st.publications = saved.publications;
      st.moneyText = {};
      formCtx.moneyText = st.moneyText;
      st.dirty = false;
      st.changed = true;
      if (!quiet) toast('Rascunho salvo.');
      return saved;
    }

    async function saveDraft() {
      st.busy = 'save';
      st.banner = null;
      draw();
      try {
        await save();
      } catch (err) {
        if (!applyServerErrors(err)) st.banner = err.message;
      } finally {
        st.busy = null;
        draw();
      }
    }

    /** Publica nas contas escolhidas, UMA de cada vez: cada conta tem progresso, erro e retomada próprios. */
    async function publishSelected() {
      const ids = targets.selectedIds();
      if (!ids.length) {
        st.banner = 'Escolha ao menos uma conta de anúncio para publicar.';
        drawBanner();
        return;
      }
      st.allErrors = toList(collect(FORM_STEPS));
      if (st.allErrors.length) {
        st.banner = null;
        draw({ scrollTop: true });
        return;
      }
      if (Object.keys(targets.validate()).length) {
        st.banner = 'Corrija os IDs destacados nas contas selecionadas.';
        drawBanner();
        return;
      }
      const chosen = st.advertisers.filter((a) => ids.includes(a.id));
      const centers = new Set(chosen.map((a) => a.businessCenterId)).size;
      const kinds = countByKind(chosen);
      const kindText = kinds.agency ? ` (${kinds.agency} de agência${kinds.standard ? ` e ${kinds.standard} ${kinds.standard === 1 ? 'comum' : 'comuns'}` : ''})` : '';
      const ok = await confirmDialog({
        title: 'Publicar no TikTok',
        message: `Vamos criar a campanha, o grupo de anúncios e o anúncio em ${ids.length === 1 ? `1 conta ("${chosen[0].name}")` : `${ids.length} contas${kindText} de ${centers === 1 ? '1 Business Center' : `${centers} Business Centers`}`}. Tudo será criado PAUSADO: nada começa a gastar até você ativar no TikTok.`,
        confirmLabel: ids.length === 1 ? 'Publicar (pausada)' : `Publicar em ${ids.length} contas (pausadas)`,
      });
      if (!ok) return;

      st.busy = 'publish';
      st.banner = null;
      targets.clearResults();
      targets.setBusy(true);
      draw();
      try {
        if (!readOnlyAll()) await save({ quiet: true }); // campanha já publicada em alguma conta é somente leitura
      } catch (err) {
        if (!applyServerErrors(err)) st.banner = err.message;
        st.busy = null;
        targets.setBusy(false);
        draw({ scrollTop: true });
        return;
      }

      const succeeded = [];
      let failed = 0;
      for (const id of ids) {
        targets.setResult(id, { state: 'running' });
        try {
          const overrides = targets.overridesFor(id);
          await post(`/campaigns/${st.id}/publish`, { confirm: true, advertiserId: id, ...(Object.keys(overrides).length ? { overrides } : {}) });
          targets.setResult(id, { state: 'done' });
          succeeded.push(id);
        } catch (err) {
          failed += 1;
          targets.setResult(id, { state: 'failed', message: failureMessage(err) });
          if (err.status === 401) break; // sessão caiu: o restante falharia do mesmo jeito
        }
      }
      st.changed = true;
      try {
        const fresh = (await get(`/campaigns/${st.id}`)).campaign;
        st.publish = fresh.publish;
        st.publications = fresh.publications;
      } catch {
        /* mantém o estado anterior */
      }
      targets.deselect(succeeded);
      st.busy = null;
      targets.setBusy(false);
      if (succeeded.length && !failed) toast(succeeded.length === 1 ? 'Campanha publicada no TikTok (pausada).' : `Campanha publicada em ${succeeded.length} contas (pausadas).`);
      else if (succeeded.length) toast(`Publicada em ${succeeded.length} de ${ids.length} contas. Veja os erros abaixo.`, 'danger');
      else toast('Nenhuma conta foi publicada. Veja os erros abaixo.', 'danger');
      draw();
    }

    // ---------- desenho ----------
    const stepper = () => stepperView({ steps: STEPS, current: st.step, maxStep: st.maxStep, disabled: st.busy !== null, onGo: goTo, label: 'Etapas da campanha' });

    function drawBanner() {
      bannerSlot.replaceChildren(...(st.banner ? [alertBox(st.banner)] : []));
    }

    function drawFooter() {
      const busy = st.busy !== null;
      const onReview = st.step === REVIEW_INDEX;
      const count = onReview ? targets.selectedIds().length : 0;
      const publishLabel = st.busy === 'publish' ? 'Publicando…' : count > 1 ? `Publicar em ${count} contas` : 'Publicar no TikTok';
      const left = h(
        'div',
        { class: 'wizard-footer__side' },
        button('Fechar', { onClick: () => modal.requestClose(), disabled: busy }),
        readOnlyAll() ? null : button(st.busy === 'save' ? 'Salvando…' : 'Salvar rascunho', { onClick: saveDraft, disabled: busy }),
      );
      const right = h(
        'div',
        { class: 'wizard-footer__side' },
        st.step > 0 ? button('Voltar', { onClick: () => goTo(st.step - 1), disabled: busy }) : null,
        onReview
          ? button(st.busy === 'publish' ? publishLabel : [icon('megaphone', 16), ` ${publishLabel}`], { variant: 'primary', onClick: publishSelected, disabled: busy || count === 0 || st.allErrors.length > 0 })
          : button('Continuar', { variant: 'primary', onClick: next, disabled: busy }),
      );
      footerSlot.replaceChildren(left, right);
    }

    function draw({ scrollTop = false, focusFirstError = false } = {}) {
      const onReview = st.step === REVIEW_INDEX;
      const meta = STEPS[st.step];
      const lockedNotice = !onReview && formCtx.readOnly
        ? alertBox(readOnlyAll() ? 'Esta campanha já foi publicada no TikTok e não pode mais ser editada aqui. Para mudar o anúncio, crie uma nova campanha.' : 'Este nível já foi criado no TikTok e não pode mais ser alterado. Ajuste as próximas etapas e publique novamente para concluir.', 'warning')
        : null;
      const content = onReview
        ? renderReview({ config: st.config, creatives: creativeMap, errors: st.allErrors, publish: st.publish, readOnly: readOnlyAll(), goTo, targets: targets.element, moneyPrefix: formCtx.moneyPrefix })
        : renderStepForm(meta.id, formCtx);

      setChildren(stepperSlot, stepper());
      drawBanner();
      setChildren(scroll, h('div', { class: 'wizard-card' }, h('p', { class: 'wizard-card__step' }, onReview ? 'Última etapa' : `Etapa ${st.step + 1} de ${STEPS.length}`), h('h2', { class: 'wizard-card__title' }, meta.title), h('p', { class: 'wizard-card__subtitle' }, meta.description), lockedNotice, content));
      drawFooter();

      if (focusPath) {
        scroll.querySelector(`[data-path="${focusPath}"] input:checked, [data-path="${focusPath}"] select`)?.focus();
        focusPath = null;
      }
      if (focusFirstError) {
        const field = scroll.querySelector('.field__error')?.closest('.field');
        field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        field?.querySelector('input, select, textarea')?.focus({ preventScroll: true });
      } else if (scrollTop) {
        scroll.scrollTo({ top: 0 });
      }
    }

    // Campanha já publicada (ou pronta para revisar) abre direto na última etapa.
    if (readOnlyAll()) st.step = REVIEW_INDEX;
    else if (existing && st.maxStep === REVIEW_INDEX) st.step = REVIEW_INDEX;
    if (st.step === REVIEW_INDEX) enterReview();
    draw();
  }

  load()
    .then(start)
    .catch((err) => {
      body.replaceChildren(h('div', { class: 'wizard-modal__scroll' }, alertBox(err.message || 'Não foi possível abrir a campanha.'), h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() }))));
    });

  return modal;
}
