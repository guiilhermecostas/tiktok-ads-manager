import { BULK_NAME_MAX, MAX_BULK_PRODUCTS, generateProducts, previewProduct } from '/shared/catalog-bulk.js';
import { h, setChildren } from '../../dom.js';
import { formatNumber } from '../../format.js';
import { button } from '../../ui.js';

const DEFAULTS = { count: '100', startAt: '1', brand: 'Generic' };

/** Sufixo aleatório (hex) desta geração: duas gerações com o mesmo nome nunca sobrescrevem os produtos uma da outra. */
const newTag = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Formulário "Gerar produtos em lote" (a introdução fica na aba que o contém): a pessoa preenche nome, link, preço, marca, imagem e quantidade UMA vez e um clique cria todos os produtos
 * (cada um com SKU próprio e título numerado) e os envia. Valida com as regras de shared/catalog-bulk.js (as mesmas do servidor).
 *  - catalog: { currency }  (o preço é sempre na moeda do catálogo)
 *  - onGenerate(products): recebe os produtos válidos e faz o envio; devolve uma Promise
 *  - disabled: sem permissão de escrita
 */
export function bulkGenerator({ catalog, disabled = false, onGenerate }) {
  const fields = {};
  const errorSlots = {};
  let busy = false;

  function field({ key, label, wide = false, hint = null, attrs = {} }) {
    const id = `bulk-${key}`;
    fields[key] = attrs.tag === 'textarea'
      ? h('textarea', { id, class: 'input input--area', rows: 2, autocomplete: 'off', maxlength: 10_000, disabled, ...attrs.props })
      : h('input', { id, class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', disabled, value: DEFAULTS[key] ?? '', ...attrs.props });
    errorSlots[key] = h('p', { class: 'field__error', role: 'alert', hidden: true });
    return h('div', { class: `field${wide ? ' field--wide' : ''}` },
      h('label', { for: id, class: 'field__label' }, label), fields[key], hint ? h('p', { class: 'field__hint' }, hint) : null, errorSlots[key]);
  }

  const preview = h('p', { class: 'field__hint catalog-bulk__preview', 'aria-live': 'polite' });
  const submit = button('Gerar e enviar produtos', { variant: 'primary', type: 'submit', disabled });

  const read = () => Object.fromEntries(Object.entries(fields).map(([key, el]) => [key, el.value]));

  function showErrors(errors) {
    for (const [key, slot] of Object.entries(errorSlots)) {
      const found = errors.find((e) => e.path === key);
      slot.textContent = found?.message ?? '';
      slot.hidden = !found;
      fields[key].classList.toggle('input--error', Boolean(found));
      if (found) fields[key].setAttribute('aria-invalid', 'true');
      else fields[key].removeAttribute('aria-invalid');
    }
  }

  function drawPreview() {
    const { name, count, startAt } = read();
    const sample = previewProduct(name, startAt);
    const total = Number(count);
    setChildren(preview, sample && total > 0 ? `Exemplo: "${sample.title}" (SKU ${sample.skuId}). Serão ${formatNumber(total)} ${total === 1 ? 'produto' : 'produtos'}.` : '');
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (busy) return;
    const { products, errors } = generateProducts(read(), newTag());
    showErrors(errors);
    if (errors.length) {
      fields[errors[0].path]?.focus();
      return;
    }
    busy = true;
    submit.disabled = true;
    try {
      await onGenerate(products);
    } finally {
      busy = false;
      submit.disabled = disabled;
    }
  }

  const form = h('form', { class: 'form', novalidate: true, onSubmit, onInput: drawPreview },
    h('div', { class: 'form-grid' },
      field({ key: 'name', label: 'Nome base *', attrs: { props: { maxlength: BULK_NAME_MAX, placeholder: 'Ex.: AD-EX-01' } }, hint: 'É o título de cada produto, com o número no fim (ex.: "AD-EX-01 · 1").' }),
      field({ key: 'count', label: 'Quantidade de produtos *', attrs: { props: { inputmode: 'numeric', maxlength: 5 } }, hint: `De 1 a ${formatNumber(MAX_BULK_PRODUCTS)}.` }),
      field({ key: 'landingPageUrl', label: 'Link de destino (página do produto) *', wide: true, attrs: { props: { maxlength: 2000, placeholder: 'https://seudominio.com/oferta' } }, hint: 'Para onde a pessoa vai ao clicar. Cole o link completo, ele é usado igual em todos os produtos.' }),
      field({ key: 'imageUrl', label: 'Imagem dos produtos (URL) *', wide: true, attrs: { props: { maxlength: 2000, placeholder: 'https://seudominio.com/imagem.jpg' } }, hint: 'JPG ou PNG com pelo menos 500 × 500 px, que abra sem login. Menor que isso o TikTok reprova.' }),
      field({ key: 'price', label: `Preço (${catalog.currency ?? 'moeda do catálogo'}) *`, attrs: { props: { inputmode: 'decimal', maxlength: 14, placeholder: '27' } }, hint: 'Sempre na moeda do catálogo.' }),
      field({ key: 'brand', label: 'Marca *', attrs: { props: { maxlength: 150 } } }),
      field({ key: 'description', label: 'Descrição padrão', wide: true, attrs: { tag: 'textarea' }, hint: 'Opcional. Sem texto, usamos o nome base.' }),
      field({ key: 'startAt', label: 'Numerar a partir de', attrs: { props: { inputmode: 'numeric', maxlength: 5 } }, hint: 'Para gerar mais depois, continuando a contagem.' })),
    preview,
    h('div', { class: 'catalog-add__send' }, submit));
  drawPreview();

  return form;
}
