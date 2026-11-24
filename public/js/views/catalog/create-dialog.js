import { CATALOG_NAME_MAX, normalizeCatalogInput } from '/shared/catalog.js';
import { TIKTOK_LOCATIONS } from '/shared/tiktok-locations.js';
import { get, post } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { alertBox, button, confirmDialog, field, openModal, stepper } from '../../ui.js';

const STEPS = [{ title: 'Catálogo' }, { title: 'País e moeda' }, { title: 'Revisar e criar' }];
const COUNTRY_NAME = new Map(TIKTOK_LOCATIONS);

/**
 * Pop-up "+ Catálogo" em 3 etapas (tamanho fixo; só o miolo rola): Business Center e nome → país e moeda (só os que o TikTok aceita, lidos da
 * API oficial) → revisar e criar. País e moeda NÃO podem ser alterados depois (regra do TikTok); por isso a revisão avisa e pede confirmação.
 *  - businessCenters: BCs onde a pessoa pode criar [{ connectionId, bcId, connectionName }]
 *  - onCreated(catalog, { openAdd }): chamado ao fechar depois de criar
 */
export function openCreateCatalogDialog({ businessCenters, onCreated }) {
  let step = 0;
  let maxStep = 0;
  let busy = false;
  let created = null;
  let openAdd = false;
  let regions = null; // [{ code, currencies }] da BC escolhida
  let metaFor = null;
  let metaError = null;
  let metaRequest = 0;

  const body = h('div', { class: 'modal__body create-ca' });
  const modal = openModal({
    title: 'Criar catálogo', size: 'md', body, dismissOnOverlay: false, canClose: () => !busy,
    onClose: () => { if (created) onCreated?.(created, { openAdd }); },
  });

  const bcSelect = field('Business Center', { as: 'select', options: businessCenters.map((b) => [`${b.connectionId}:${b.bcId}`, `BC ${b.bcId} · ${b.connectionName}`]) });
  const name = field('Nome do catálogo', { type: 'text', maxlength: CATALOG_NAME_MAX, required: true, autocomplete: 'off', placeholder: 'Ex.: Loja de roupas' }, { hint: `Até ${CATALOG_NAME_MAX} caracteres.` });
  const country = field('País de destino', { as: 'select', options: [['', 'Carregando…']], required: true }, { hint: 'O país para onde os anúncios deste catálogo serão entregues. Não pode ser alterado depois.' });
  const currency = field('Moeda', { as: 'select', options: [['', 'Escolha o país primeiro']], required: true }, { hint: 'Moeda dos preços dos produtos neste país. Não pode ser alterada depois.' });
  const errorSlot = h('div');
  const status = h('p', { class: 'create-ca__status muted' });
  const stepSlot = h('div', { class: 'create-ca__steps' });
  const pane = h('div', { class: 'create-ca__pane' });
  const review = h('dl', { class: 'create-ca__review' });
  const submit = button('Continuar', { variant: 'primary', type: 'submit' });
  const back = button('Cancelar', { onClick: () => (step === 0 ? modal.requestClose() : goTo(step - 1)) });

  const selected = () => {
    const [connectionId, bcId] = bcSelect.control.value.split(':');
    return { connectionId: Number(connectionId), bcId };
  };

  function drawCurrencies() {
    const region = regions?.find((r) => r.code === country.control.value);
    const keep = currency.control.value;
    setChildren(currency.control, region ? region.currencies.map((c) => h('option', { value: c }, c)) : h('option', { value: '' }, 'Escolha o país primeiro'));
    currency.control.value = region?.currencies.includes(keep) ? keep : (region?.currencies[0] ?? '');
  }
  country.control.addEventListener('change', drawCurrencies);

  async function loadMeta() {
    const { connectionId, bcId } = selected();
    const key = `${connectionId}:${bcId}`;
    if (metaFor === key && regions) return;
    const ticket = ++metaRequest;
    regions = null;
    metaError = null;
    setChildren(country.control, h('option', { value: '' }, 'Carregando…'));
    drawCurrencies();
    status.textContent = 'Buscando os países e moedas aceitos pelo TikTok…';
    try {
      const data = await get(`/tiktok/catalogs/meta?connectionId=${connectionId}&bcId=${encodeURIComponent(bcId)}`);
      if (ticket !== metaRequest) return;
      regions = data.regions;
      metaFor = key;
      const keep = country.control.value;
      const sorted = [...regions].sort((a, b) => (COUNTRY_NAME.get(a.code) ?? a.code).localeCompare(COUNTRY_NAME.get(b.code) ?? b.code));
      setChildren(country.control, h('option', { value: '' }, 'Escolha o país…'), sorted.map((r) => h('option', { value: r.code }, `${COUNTRY_NAME.get(r.code) ?? r.code} (${r.code})`)));
      country.control.value = regions.some((r) => r.code === keep) ? keep : '';
      drawCurrencies();
      status.textContent = '';
    } catch (err) {
      if (ticket !== metaRequest) return;
      metaError = err.message;
      setChildren(country.control, h('option', { value: '' }, 'Não foi possível carregar'));
      status.textContent = '';
      if (step === 1) errorSlot.replaceChildren(alertBox(err.message));
    }
  }
  bcSelect.control.addEventListener('change', () => { metaFor = null; regions = null; loadMeta(); });

  function checkCatalog() {
    if (!businessCenters.length) throw new Error('Nenhuma Business Center disponível para criar catálogos.');
    const { errors } = normalizeCatalogInput({ name: name.control.value, regionCode: 'XX', currency: 'XXX' });
    const bad = errors.find((e) => e.path === 'name');
    if (bad) throw new Error(bad.message);
  }
  function checkRegion() {
    if (metaError) throw new Error(metaError);
    if (!regions) throw new Error('Aguarde os países carregarem.');
    if (!country.control.value) throw new Error('Escolha o país de destino do catálogo.');
    if (!currency.control.value) throw new Error('Escolha a moeda do catálogo.');
  }
  const CHECKS = [checkCatalog, checkRegion, () => {}];

  function drawReview() {
    const { bcId } = selected();
    const rows = [
      ['Business Center', `${bcId} · ${businessCenters.find((b) => `${b.connectionId}:${b.bcId}` === bcSelect.control.value)?.connectionName ?? ''}`],
      ['Nome', name.control.value.trim().replace(/\s+/g, ' ')],
      ['Tipo', 'E-commerce (produtos)'],
      ['País de destino', `${COUNTRY_NAME.get(country.control.value) ?? country.control.value} (${country.control.value})`],
      ['Moeda', currency.control.value],
    ];
    setChildren(review, rows.map(([label, value]) => h('div', { class: 'create-ca__review-row' }, h('dt', null, label), h('dd', null, value))));
  }

  function drawStep({ keepError = false } = {}) {
    if (!keepError) errorSlot.replaceChildren();
    if (step === 0) {
      setChildren(pane, errorSlot, businessCenters.length > 1 ? bcSelect.element : h('p', { class: 'create-ca__bc' }, 'Business Center do TikTok: ', h('strong', null, businessCenters[0]?.bcId ?? '—')), name.element,
        h('p', { class: 'field__hint' }, 'Será criado um catálogo do tipo E-commerce, o usado em campanhas de Vendas de produtos. Depois de criar, você adiciona os produtos.'));
    } else if (step === 1) {
      setChildren(pane, errorSlot, country.element, currency.element);
      loadMeta();
    } else {
      drawReview();
      setChildren(pane, errorSlot, h('p', { class: 'create-ca__section' }, 'Confira antes de criar'), review,
        h('p', { class: 'field__hint' }, 'O país e a moeda não podem ser alterados depois de criar o catálogo.'));
    }
    setChildren(stepSlot, stepper({ steps: STEPS, current: step, maxStep, disabled: busy, onGo: goTo, label: 'Etapas da criação do catálogo' }));
    pane.scrollTop = 0;
    sync();
  }

  function sync() {
    const last = step === STEPS.length - 1;
    back.textContent = step === 0 ? 'Cancelar' : 'Voltar';
    back.disabled = busy;
    submit.textContent = busy ? 'Criando no TikTok…' : last ? 'Criar catálogo' : 'Continuar';
    submit.disabled = busy;
  }

  function goTo(target) {
    if (busy || target === step) return;
    if (target > step) {
      try {
        for (let i = step; i < target; i += 1) CHECKS[i]();
      } catch (err) {
        errorSlot.replaceChildren(alertBox(err.message));
        return;
      }
    }
    step = target;
    maxStep = Math.max(maxStep, step);
    drawStep();
  }

  function showResult(catalog) {
    created = catalog;
    body.classList.add('is-result');
    setChildren(body,
      h('p', { class: 'create-ca__headline' }, 'Catálogo criado no TikTok.'),
      h('ul', { class: 'create-ca__list' }, h('li', null, h('strong', null, catalog.name), h('span', { class: 'muted' }, ` · ID ${catalog.id} · ${catalog.regionCode} · ${catalog.currency}`))),
      h('p', { class: 'muted' }, 'Próximo passo: adicione os produtos. O catálogo só pode ser usado em anúncios depois que tiver produtos aprovados e disponíveis.'),
      h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() }), button('Adicionar produtos', { variant: 'primary', onClick: () => { openAdd = true; modal.close(); } })));
  }

  async function createNow() {
    errorSlot.replaceChildren();
    try {
      CHECKS.forEach((check) => check());
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
      return;
    }
    const { connectionId, bcId } = selected();
    const payload = { connectionId, bcId, name: name.control.value, regionCode: country.control.value, currency: currency.control.value };
    const ok = await confirmDialog({
      title: 'Criar catálogo?',
      message: `"${name.control.value.trim()}" será criado na Business Center ${bcId}, para ${COUNTRY_NAME.get(payload.regionCode) ?? payload.regionCode} em ${payload.currency}. O país e a moeda não poderão ser alterados.`,
      confirmLabel: 'Criar agora',
    });
    if (!ok) return;
    busy = true;
    sync();
    stepSlot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      showResult((await post('/tiktok/catalogs', payload)).catalog);
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    } finally {
      busy = false;
      if (pane.isConnected) drawStep({ keepError: true });
    }
  }

  body.append(h('form', { class: 'form create-ca__form', novalidate: true, onSubmit: (event) => { event.preventDefault(); if (busy) return; if (step < STEPS.length - 1) goTo(step + 1); else createNow(); } },
    stepSlot, pane, status, h('div', { class: 'modal__footer create-ca__footer' }, back, submit)));
  drawStep();
  name.control.focus();
}
