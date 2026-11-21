import { STEPS, collectCreativeRefs, defaultConfig, reconcileConfig, stepOfPath, validateConfig } from '/shared/campaign-spec.js';
import { get, post, put } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { parseMoneyToCents } from '../../format.js';
import { state } from '../../state.js';
import { alertBox, button, confirmDialog, toast } from '../../ui.js';
import { pageHeader } from '../layout.js';
import { pickCreatives } from '../creatives/picker.js';
import { renderStepForm } from './form-fields.js';
import { renderReview } from './review.js';

const FORM_STEPS = STEPS.slice(0, -1).map((s) => s.id);
const REVIEW_INDEX = STEPS.length - 1;

/**
 * Assistente passo a passo de criação de campanhas.
 * A UI é gerada pela especificação compartilhada (/shared/campaign-spec.js); o servidor valida de novo.
 */
export async function campaignWizardView(ctx) {
  const params = new URLSearchParams(location.search);
  const editing = location.pathname.endsWith('/edit');
  const editId = editing ? Number(params.get('id')) : null;
  if (editing && !Number.isSafeInteger(editId)) throw new Error('Campanha inválida.');

  const [advertiserResult, loaded] = await Promise.all([
    get('/tiktok/advertisers').catch(() => ({ advertisers: [] })),
    editing ? get(`/campaigns/${editId}`) : Promise.resolve(null),
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

  const st = {
    id: existing?.id ?? null,
    config: reconcileConfig(existing?.config ?? defaultConfig()),
    publish: existing?.publish ?? { status: 'none' },
    step: 0,
    maxStep: 0,
    errors: {},
    allErrors: [],
    dirty: false,
    busy: null, // 'save' | 'publish'
    banner: null,
    moneyText: {},
    advertisers: advertiserResult.advertisers,
  };

  /** Níveis já criados no TikTok ficam travados (o servidor também impõe isso). */
  const locked = () => {
    if (st.publish.status === 'published') return new Set(FORM_STEPS);
    const set = new Set();
    if (st.publish.campaignId) ['objective', 'campaign'].forEach((s) => set.add(s));
    if (st.publish.adGroupId) set.add('adGroup');
    return set;
  };
  const readOnlyAll = () => st.publish.status === 'published';

  // ---------- validação ----------
  function collect(stepIds, { forPublish = false } = {}) {
    const { errors } = validateConfig(st.config, { requireComplete: true, publish: forPublish, steps: stepIds });
    const map = {};
    for (const e of errors) map[e.path] = e.message;
    for (const [path, text] of Object.entries(st.moneyText)) {
      if (text.trim() && parseMoneyToCents(text) === null && stepIds.includes(stepOfPath(path))) map[path] = 'Informe um valor válido, ex.: 150,00.';
    }
    return map;
  }
  const toList = (map) => Object.entries(map).map(([path, message]) => ({ path, message }));

  /** Primeira etapa (índice) que ainda tem pendência: define até onde o usuário pode navegar. */
  function computeMaxStep() {
    for (let i = 0; i < FORM_STEPS.length; i += 1) if (Object.keys(collect([FORM_STEPS[i]])).length) return i;
    return REVIEW_INDEX;
  }
  if (existing) st.maxStep = computeMaxStep();

  // ---------- estado ----------
  const root = h('div', { class: 'wizard' });
  let focusPath = null;

  const formCtx = {
    get config() { return st.config; },
    get errors() { return st.errors; },
    advertisers: st.advertisers,
    creatives: creativeMap,
    pickCreatives: (options) => pickCreatives({ ...options, cache: creativeMap }),
    moneyText: st.moneyText,
    get readOnly() { return readOnlyAll() || locked().has(FORM_STEPS[st.step]); },
    set(path, value, { rerender = false } = {}) {
      const [section, key] = path.split('.');
      if (value === undefined) delete st.config[section][key];
      else st.config[section][key] = value;
      st.dirty = true;
      if (st.errors[path]) {
        delete st.errors[path];
        root.querySelector(`[data-path="${path}"] .field__error`)?.remove();
        root.querySelector(`[data-path="${path}"] [aria-invalid]`)?.removeAttribute('aria-invalid');
        root.querySelector(`[data-path="${path}"] .input--error`)?.classList.remove('input--error');
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

  // ---------- ações ----------
  function goTo(index) {
    if (index < 0 || index > REVIEW_INDEX || index > st.maxStep) return;
    st.step = index;
    if (index === REVIEW_INDEX) st.allErrors = toList(collect(FORM_STEPS, { forPublish: true }));
    st.errors = {};
    st.banner = null;
    draw({ scrollTop: true });
  }

  function next() {
    const stepId = FORM_STEPS[st.step];
    const errors = collect([stepId]);
    if (Object.keys(errors).length) {
      st.errors = errors;
      st.banner = null;
      draw({ focusFirstError: true });
      return;
    }
    st.errors = {};
    st.step += 1;
    st.maxStep = Math.max(st.maxStep, st.step);
    if (st.step === REVIEW_INDEX) st.allErrors = toList(collect(FORM_STEPS, { forPublish: true }));
    draw({ scrollTop: true });
  }

  async function save({ quiet = false } = {}) {
    // Rascunho exige apenas um objetivo; o resto é validado ao publicar.
    const payload = { config: st.config };
    const result = st.id ? await put(`/campaigns/${st.id}`, payload) : await post('/campaigns', payload);
    const saved = result.campaign;
    const isNew = !st.id;
    st.id = saved.id;
    st.config = reconcileConfig(saved.config);
    st.publish = saved.publish;
    st.moneyText = {};
    formCtx.moneyText = st.moneyText;
    st.dirty = false;
    if (isNew) history.replaceState({}, '', `/campaigns/edit?id=${saved.id}`);
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

  async function publish() {
    const errors = collect(FORM_STEPS, { forPublish: true });
    st.allErrors = toList(errors);
    if (st.allErrors.length) {
      st.banner = null;
      draw({ scrollTop: true });
      return;
    }
    const advertiser = st.advertisers.find((a) => a.id === st.config.account.advertiserId);
    const ok = await confirmDialog({
      title: 'Publicar no TikTok',
      message: `Vamos criar a campanha, o grupo de anúncios e o anúncio${advertiser ? ` na conta "${advertiser.name}"` : ''}. Tudo será criado PAUSADO: nada começa a gastar até você ativar no TikTok.`,
      confirmLabel: 'Publicar (pausada)',
    });
    if (!ok) return;

    st.busy = 'publish';
    st.banner = null;
    draw();
    try {
      await save({ quiet: true });
      await post(`/campaigns/${st.id}/publish`, { confirm: true });
      st.dirty = false;
      toast('Campanha publicada no TikTok (pausada).');
      await ctx.navigate('/campaigns');
      return;
    } catch (err) {
      if (!applyServerErrors(err)) st.banner = err.message;
      if (st.id) {
        // Mostra o que já foi criado no TikTok (publicação parcial).
        try {
          st.publish = (await get(`/campaigns/${st.id}`)).campaign.publish;
        } catch {
          /* mantém o estado anterior */
        }
      }
    }
    st.busy = null;
    draw({ scrollTop: true });
  }

  function cancel() {
    if (st.dirty && !window.confirm('Há alterações não salvas. Sair mesmo assim?')) return;
    st.dirty = false;
    ctx.navigate('/campaigns');
  }

  // ---------- desenho ----------
  function stepper() {
    return h(
      'ol',
      { class: 'stepper', 'aria-label': 'Etapas da campanha' },
      STEPS.map((s, i) => {
        const done = i < st.step || (i <= st.maxStep && i !== st.step);
        const reachable = i <= st.maxStep;
        return h(
          'li',
          { class: `stepper__item${i === st.step ? ' is-current' : ''}${done ? ' is-done' : ''}` },
          h(
            'button',
            { type: 'button', class: 'stepper__btn', disabled: !reachable || st.busy !== null, 'aria-current': i === st.step ? 'step' : null, onClick: () => goTo(i) },
            h('span', { class: 'stepper__num' }, done && i !== st.step ? '✓' : String(i + 1)),
            h('span', { class: 'stepper__label' }, s.title),
          ),
        );
      }),
    );
  }

  function footer() {
    const busy = st.busy !== null;
    const onReview = st.step === REVIEW_INDEX;
    const left = h(
      'div',
      { class: 'wizard-footer__side' },
      button('Cancelar', { onClick: cancel, disabled: busy }),
      readOnlyAll() ? null : button(st.busy === 'save' ? 'Salvando…' : 'Salvar rascunho', { onClick: saveDraft, disabled: busy }),
    );
    const right = h(
      'div',
      { class: 'wizard-footer__side' },
      st.step > 0 ? button('Voltar', { onClick: () => goTo(st.step - 1), disabled: busy }) : null,
      readOnlyAll() && onReview
        ? null
        : onReview
          ? button(st.busy === 'publish' ? 'Publicando…' : [icon('megaphone', 16), ' Publicar no TikTok'], { variant: 'primary', onClick: publish, disabled: busy || st.allErrors.length > 0 })
          : button('Continuar', { variant: 'primary', onClick: next, disabled: busy }),
    );
    return h('div', { class: 'wizard-footer' }, left, right);
  }

  function draw({ scrollTop = false, focusFirstError = false } = {}) {
    const onReview = st.step === REVIEW_INDEX;
    const meta = STEPS[st.step];
    const lockedNotice = !onReview && formCtx.readOnly
      ? alertBox(readOnlyAll() ? 'Esta campanha já foi publicada no TikTok e não pode mais ser editada aqui.' : 'Este nível já foi criado no TikTok e não pode mais ser alterado. Ajuste as próximas etapas e publique novamente para concluir.', 'warning')
      : null;
    const body = onReview
      ? renderReview({ config: st.config, advertisers: st.advertisers, creatives: creativeMap, errors: st.allErrors, publish: st.publish, readOnly: readOnlyAll(), goTo })
      : renderStepForm(meta.id, formCtx);
    const noAccounts = !onReview && meta.id === 'objective' && !st.advertisers.some((a) => a.businessCenterStatus === 'active')
      ? h('p', { class: 'field__hint' }, 'Nenhuma conta de anúncio disponível: você pode salvar rascunhos normalmente; para publicar, conecte sua Business Center em Contas TikTok.')
      : null;

    setChildren(
      root,
      stepper(),
      st.banner ? alertBox(st.banner) : null,
      h('div', { class: 'card card--pad wizard-card' }, h('h2', { class: 'wizard-card__title' }, meta.title), h('p', { class: 'muted' }, meta.description), lockedNotice, body, noAccounts),
      footer(),
    );

    if (focusPath) {
      const target = root.querySelector(`[data-path="${focusPath}"] input:checked, [data-path="${focusPath}"] select`);
      target?.focus();
      focusPath = null;
    }
    if (focusFirstError) {
      const field = root.querySelector('.field__error')?.closest('.field');
      field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      field?.querySelector('input, select, textarea')?.focus({ preventScroll: true });
    } else if (scrollTop) {
      root.scrollIntoView({ block: 'start' });
    }
  }

  // ---------- proteção contra perda de dados ----------
  const beforeUnload = (event) => {
    if (!st.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };
  window.addEventListener('beforeunload', beforeUnload);
  state.leaveGuard = () => !st.dirty || window.confirm('Há alterações não salvas. Sair mesmo assim?');

  if (st.publish.status === 'published') st.step = REVIEW_INDEX;
  else if (existing && st.maxStep === REVIEW_INDEX) st.step = REVIEW_INDEX;
  if (st.step === REVIEW_INDEX) st.allErrors = toList(collect(FORM_STEPS, { forPublish: true }));
  draw();

  const title = existing ? existing.name : 'Nova campanha';
  return {
    element: h('div', null, pageHeader(title, existing ? 'Edite o rascunho ou publique no TikTok.' : 'Siga as etapas para criar sua campanha de TikTok Ads.'), root),
    cleanup: () => {
      window.removeEventListener('beforeunload', beforeUnload);
      state.leaveGuard = null;
    },
  };
}

