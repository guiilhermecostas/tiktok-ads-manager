import { CATALOG_DEFAULT_GROUPS, catalogPresetConfig, catalogReadiness, pickDefaults, validateCatalogDefaults } from '/shared/catalog-defaults.js';
import { collectCreativeRefs, reconcileConfig } from '/shared/campaign-spec.js';
import { moneyPrefix } from '/shared/currency.js';
import { del, get, put } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { alertBox, button, confirmDialog, spinner, toast } from '../../ui.js';
import { renderFields } from '../campaign-wizard/form-fields.js';
import { pickCreatives } from '../creatives/picker.js';
import { catalogUrl, refQuery } from './detail.js';
import { openCatalogCampaign } from './open-campaign.js';

/**
 * Aba "Campanha": o ANÚNCIO PADRÃO do catálogo. A pessoa escolhe uma vez os criativos da biblioteca (vídeo e capa), quais produtos mostrar, o texto,
 * o botão, a URL, a identidade, a conversão e o orçamento; quando cria uma campanha com este catálogo, tudo já vem preenchido (e vai certo para a
 * publicação). Usa os MESMOS campos, listas e validações do assistente de campanha. Mostra o que ainda falta para sair pronto.
 */
export function catalogCampaignTab({ ctx, catalog }) {
  const root = h('div', { class: 'catalog-campaign' }, spinner());
  let config = null;
  let errors = {};
  let saved = null; // o que está salvo no servidor (para saber se há alterações)
  let busy = false;
  const moneyText = {};
  const creativeMap = new Map();
  let advertisers = [];

  const readinessSlot = h('div', { class: 'catalog-campaign__readiness' });
  const formSlot = h('div');
  const errorSlot = h('div');
  const saveButton = button('Salvar anúncio padrão', { variant: 'primary', onClick: save });
  const clearButton = button('Remover padrão', { variant: 'danger-ghost', onClick: clear });

  const current = () => pickDefaults(config);
  const dirty = () => JSON.stringify(current()) !== JSON.stringify(saved ?? { adGroup: {}, ad: {} });

  const formCtx = {
    get config() { return config; },
    get errors() { return errors; },
    creatives: creativeMap,
    pickCreatives: (options) => pickCreatives({ ...options, cache: creativeMap }),
    moneyText,
    get moneyPrefix() { return moneyPrefix([catalog.currency]); },
    get pixelAccounts() { return advertisers; },
    readOnly: false,
    set(path, value, { rerender = false } = {}) {
      const [section, key] = path.split('.');
      if (value === undefined) delete config[section][key];
      else config[section][key] = value;
      delete errors[path];
      if (rerender) config = reconcileConfig(config);
      if (rerender) drawForm();
      drawReadiness();
    },
  };

  function drawReadiness() {
    const { groups, ready, missing } = catalogReadiness(catalog, current());
    saveButton.disabled = busy || !dirty();
    clearButton.disabled = busy || !saved;
    setChildren(readinessSlot,
      h('div', { class: `card card--pad catalog-campaign__status${ready ? ' is-ready' : ''}` },
        h('strong', null, ready ? '✓ Pronto: a campanha deste catálogo já sai completa.' : `Faltam ${missing.length} ${missing.length === 1 ? 'item' : 'itens'} para a campanha sair completa:`),
        ready ? null : h('p', { class: 'muted' }, missing.map((m) => m.label).join(' · ')),
        h('div', { class: 'catalog-campaign__groups' }, groups.map((group) => h('div', { class: 'catalog-campaign__group' },
          h('span', { class: 'catalog-campaign__group-title' }, group.title),
          h('span', { class: group.items.every((i) => i.ok) ? 'catalog-campaign__ok' : 'catalog-campaign__todo' }, group.items.every((i) => i.ok) ? 'completo' : `${group.items.filter((i) => !i.ok).length} pendente(s)`)))),
        h('div', { class: 'catalog-campaign__actions' },
          button('Criar campanha com este catálogo', { variant: 'primary', small: true, onClick: () => openCatalogCampaign(ctx, catalog, current()) }),
          h('span', { class: 'muted' }, dirty() ? 'Usa o que está na tela agora. Salve para reutilizar nas próximas campanhas.' : 'Usa o anúncio padrão salvo.'))));
  }

  function drawForm() {
    setChildren(formSlot, CATALOG_DEFAULT_GROUPS.map((group) => {
      const fields = renderFields(group.paths, formCtx);
      return fields.childElementCount ? h('section', { class: 'form-section' }, h('h3', { class: 'form-section__title' }, group.title), fields) : null;
    }));
  }

  async function save() {
    errorSlot.replaceChildren();
    const raw = current();
    const { errors: found } = validateCatalogDefaults(raw);
    if (found.length) {
      errors = Object.fromEntries(found.map((e) => [e.path, e.message]));
      drawForm();
      errorSlot.replaceChildren(alertBox(found[0].message));
      return;
    }
    busy = true;
    drawReadiness();
    try {
      const result = await put(`${catalogUrl(catalog, '/defaults')}`, { connectionId: catalog.connectionId, bcId: catalog.bcId, ...raw });
      saved = pickDefaults(result.defaults ?? {});
      toast('Anúncio padrão salvo. As próximas campanhas deste catálogo já saem com ele.');
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    } finally {
      busy = false;
      drawReadiness();
    }
  }

  async function clear() {
    const ok = await confirmDialog({ title: 'Remover o anúncio padrão?', message: 'As próximas campanhas deste catálogo voltam a sair só com o catálogo e o país. Os criativos da biblioteca não são apagados.', confirmLabel: 'Remover', danger: true });
    if (!ok) return;
    busy = true;
    drawReadiness();
    try {
      await del(`${catalogUrl(catalog, '/defaults')}?${refQuery(catalog)}`);
      saved = null;
      config = catalogPresetConfig(catalog, null);
      errors = {};
      drawForm();
      toast('Anúncio padrão removido.');
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    } finally {
      busy = false;
      drawReadiness();
    }
  }

  async function load() {
    try {
      const [defaults, library, accounts] = await Promise.all([
        get(`${catalogUrl(catalog, '/defaults')}?${refQuery(catalog)}`),
        get('/creatives?limit=100').catch(() => ({ creatives: [] })),
        get('/tiktok/advertisers').catch(() => ({ advertisers: [] })),
      ]);
      library.creatives.forEach((c) => creativeMap.set(c.id, c));
      // Só as contas desta Business Center entram no seletor de pixel (o pixel pertence a uma conta).
      advertisers = accounts.advertisers.filter((a) => a.businessCenterStatus === 'active' && a.businessCenterId === catalog.connectionId && (!a.ownerBcId || a.ownerBcId === catalog.bcId));
      saved = defaults.defaults ? pickDefaults(defaults.defaults) : null;
      config = catalogPresetConfig(catalog, defaults.defaults);
      const missing = [...new Set(collectCreativeRefs(config).map((r) => r.id))].filter((id) => !creativeMap.has(id));
      await Promise.allSettled(missing.map(async (id) => creativeMap.set(id, (await get(`/creatives/${id}`)).creative)));
      setChildren(root,
        h('div', { class: 'card card--pad catalog-add__intro' },
          h('p', null, h('strong', null, 'Monte uma vez, publique quando quiser.')),
          h('p', { class: 'muted' }, 'Escolha aqui os criativos da biblioteca, os produtos, o texto e o destino. Ao criar uma campanha com este catálogo (ou escolhê-lo no assistente e usar "o anúncio padrão"), tudo já vem preenchido e é enviado certo para o TikTok. Só falta escolher as contas de anúncio na hora de publicar.')),
        readinessSlot, errorSlot, formSlot,
        h('div', { class: 'catalog-campaign__footer' }, saveButton, clearButton));
      drawForm();
      drawReadiness();
    } catch (err) {
      setChildren(root, alertBox(err.message));
    }
  }

  load();
  return root;
}
