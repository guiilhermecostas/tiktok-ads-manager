import { AVAILABILITY, CONDITIONS, PRODUCT_SET_NAME_MAX, buildSetConditions, normalizeProductSetName } from '/shared/catalog.js';
import { get, post } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatNumber } from '../../format.js';
import { alertBox, badge, button, emptyState, spinner, toast } from '../../ui.js';
import { tabIntro } from '../subtabs.js';
import { catalogUrl, refQuery } from './detail.js';

/**
 * Aba "Conjuntos de produtos": grupos de produtos do catálogo por filtros (marca, título, preço, estoque, condição). Um conjunto permite
 * anunciar só parte do catálogo (campanha de catálogo → "Um conjunto de produtos"). O ID do conjunto aparece para usar na campanha.
 */
export function productSetsTab({ catalog, canWrite }) {
  const root = h('div', { class: 'catalog-sets' });
  const listSlot = h('div');
  const errorSlot = h('div');
  const text = (label, props, hint) => {
    const id = `set-${label}`;
    const control = h('input', { id, class: 'input', type: 'text', autocomplete: 'off', ...props });
    return { control, element: h('div', { class: 'field' }, h('label', { for: id, class: 'field__label' }, label), control, hint ? h('p', { class: 'field__hint' }, hint) : null) };
  };
  const select = (label, options) => {
    const id = `set-${label}`;
    const control = h('select', { id, class: 'input' }, h('option', { value: '' }, 'Qualquer'), options.map(([value, option]) => h('option', { value }, option)));
    return { control, element: h('div', { class: 'field' }, h('label', { for: id, class: 'field__label' }, label), control) };
  };
  const name = text('Nome do conjunto', { maxlength: PRODUCT_SET_NAME_MAX, placeholder: 'Ex.: Camisas até R$ 100' });
  const brands = text('Marcas', { placeholder: 'Nike, Adidas' }, 'Separe por vírgula (até 20).');
  const words = text('O título contém', { placeholder: 'camisa, polo' }, 'Qualquer uma das palavras (separe por vírgula).');
  const min = text('Preço mínimo', { inputmode: 'decimal', placeholder: '0,00' });
  const max = text('Preço máximo', { inputmode: 'decimal', placeholder: '0,00' });
  const availability = select('Estoque', AVAILABILITY);
  const condition = select('Condição', CONDITIONS);
  const submit = button('Criar conjunto', { variant: 'primary', type: 'submit', disabled: !canWrite });
  const list = (control) => control.value.split(/[,\n]+/).map((v) => v.trim()).filter(Boolean);

  async function load() {
    setChildren(listSlot, spinner());
    try {
      const { sets } = await get(`${catalogUrl(catalog, '/sets')}?${refQuery(catalog)}`);
      setChildren(listSlot, sets.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Conjunto', 'ID (use na campanha)', 'Produtos'].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, sets.map((s) => h('tr', null,
            h('td', { 'data-label': 'Conjunto' }, h('span', { class: 'cell-strong' }, s.name)),
            h('td', { 'data-label': 'ID' }, h('code', null, s.id)),
            h('td', { class: 'num', 'data-label': 'Produtos' }, s.productCount === null ? badge('calculando', 'neutral') : formatNumber(s.productCount)))))))
        : h('div', { class: 'card' }, emptyState({ title: 'Nenhum conjunto ainda', text: 'Crie um conjunto para anunciar só parte do catálogo (por marca, preço, estoque…).' })));
    } catch (err) {
      setChildren(listSlot, alertBox(err.message));
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    errorSlot.replaceChildren();
    const named = normalizeProductSetName(name.control.value);
    const filters = { brands: list(brands.control), titleContains: list(words.control), priceMin: min.control.value.trim() || undefined, priceMax: max.control.value.trim() || undefined, availability: availability.control.value || undefined, condition: condition.control.value || undefined };
    const built = buildSetConditions(filters);
    const problem = named.error ?? built.errors[0]?.message;
    if (problem) {
      errorSlot.replaceChildren(alertBox(problem));
      return;
    }
    submit.disabled = true;
    try {
      const { set } = await post(catalogUrl(catalog, '/sets'), { connectionId: catalog.connectionId, bcId: catalog.bcId, name: named.name, filters });
      toast(`Conjunto "${set.name}" criado.`);
      for (const c of [name, brands, words, min, max, availability, condition]) c.control.value = '';
      await load();
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    } finally {
      submit.disabled = !canWrite;
    }
  }

  setChildren(root,
    tabIntro('Conjuntos de produtos', 'Um conjunto é um grupo de produtos (por marca, preço, estoque…). Use quando quiser anunciar só uma parte do catálogo.'),
    listSlot,
    h('section', { class: 'form-section' },
      h('h3', { class: 'form-section__title' }, 'Criar um conjunto'),
      h('p', { class: 'form-section__help' }, 'Preencha pelo menos um filtro. Se preencher vários, o produto precisa servir em todos.'),
      h('form', { class: 'form', novalidate: true, onSubmit },
        errorSlot,
        h('div', { class: 'form-grid' }, name.element, brands.element, words.element, availability.element, condition.element, min.element, max.element),
        submit)));
  load();
  return root;
}
