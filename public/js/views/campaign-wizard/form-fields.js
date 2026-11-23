import { ACCOUNT_FIELDS, OBJECTIVES, fieldsOfStep, findField, getOptions, getPath, isRequired, isVisible } from '/shared/campaign-spec.js';
import { h } from '../../dom.js';
import { centsToInput, parseMoneyToCents } from '../../format.js';
import { creativeThumb } from '../creatives/thumb.js';
import { createMultiChoice } from './choice-controls.js';
import { createPixelPicker } from './pixel-picker.js';

let uid = 0;
const nextId = () => `wz-${++uid}`;

/**
 * Renderiza os campos de uma etapa a partir da especificação compartilhada.
 * ctx: { config, errors, readOnly, set(path, value, { rerender }), moneyText }
 * Todo texto entra no DOM como nó de texto (sem innerHTML).
 */
export function renderStepForm(stepId, ctx) {
  const entries = fieldsOfStep(stepId).filter(({ field }) => isVisible(field, ctx.config));
  // O seletor de objetivo vem primeiro na etapa 1.
  entries.sort((a, b) => Number(b.field.type === 'objective') - Number(a.field.type === 'objective'));

  const groups = [];
  for (const entry of entries) {
    // O seletor de objetivo não repete título: o cabeçalho da etapa já diz "Escolha o que você quer alcançar".
    const title = entry.field.type === 'objective' ? '' : (entry.field.group ?? entry.field.label);
    let group = groups.find((g) => g.title === title);
    if (!group) groups.push((group = { title, entries: [] }));
    group.entries.push(entry);
  }

  return h(
    'div',
    { class: 'wizard-form' },
    groups.map((group) =>
      h(
        'section',
        { class: 'form-section' },
        group.title ? h('h3', { class: 'form-section__title' }, group.title) : null,
        h('div', { class: 'form-grid' }, group.entries.map((entry) => renderField(entry, ctx))),
      ),
    ),
  );
}

/**
 * Só os campos que dependem da conta de anúncio (pixel, app, catálogo, formulário, identidade) que estão visíveis
 * para a configuração atual. Usado nos ajustes por conta da publicação.
 */
export function renderAccountFields(ctx) {
  const entries = ACCOUNT_FIELDS.map((path) => {
    const [section, key] = path.split('.');
    return { section, field: findField(section, key) };
  }).filter(({ field }) => isVisible(field, ctx.config));
  return h('div', { class: 'form-grid' }, entries.map((entry) => renderField(entry, ctx)));
}

function renderField({ section, field }, ctx) {
  const path = `${section}.${field.key}`;
  const value = getPath(ctx.config, path);
  const error = ctx.errors[path];
  const required = isRequired(field, ctx.config);
  // Lista de botões (até 6 opções) cabe em meia linha; lista suspensa e demais campos longos ocupam a linha toda.
  const compactChips = field.type === 'enumList' && getOptions(field, ctx.config).length <= 6;
  const wide = (['objective', 'enumList', 'stringList', 'creative', 'creativeList'].includes(field.type) && !compactChips) || field.multiline || field.type === 'url';
  const id = nextId();
  const describedBy = [error ? `${id}-err` : null, field.help ? `${id}-help` : null].filter(Boolean).join(' ') || null;
  const disabled = typeof ctx.readOnly === 'function' ? ctx.readOnly(path) : ctx.readOnly; // por campo (ajustes por conta) ou geral

  // Pixel: escolhe entre os que já existem na conta (e ainda dá para digitar o ID). Só quando o contexto traz contas usáveis.
  if (field.key === 'pixelId' && ctx.pixelAccounts?.length) {
    const picker = createPixelPicker({ id, value, disabled, error: Boolean(error), describedBy, accounts: ctx.pixelAccounts, onPick: (v) => ctx.set(path, v) });
    return wrapper({ path, field, id, wide: true, error, describedBy, control: picker, required });
  }

  let control;
  switch (field.type) {
    case 'objective':
      return objectiveCards(field, value, path, ctx, error);
    case 'enum':
      control = enumControl(field, value, path, ctx, { id, describedBy, error, disabled });
      break;
    case 'enumList':
      control = checkGroup(field, value ?? [], path, ctx, { disabled });
      break;
    case 'bool':
      control = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: value === true, disabled, onChange: (e) => ctx.set(path, e.target.checked ? true : undefined) }), h('span', null, field.label));
      return wrapper({ path, field, id, wide: false, error, describedBy, control, hideLabel: true, required: false });
    case 'creative':
    case 'creativeList':
      control = creativeControl(field, value, path, ctx, { disabled });
      break;
    case 'money':
      control = moneyInput(path, value, ctx, { id, describedBy, error, disabled });
      break;
    case 'int':
      control = h('input', {
        id, class: `input${error ? ' input--error' : ''}`, type: 'number', min: field.min, max: field.max, step: 1, disabled,
        value: value ?? '', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
        onInput: (e) => ctx.set(path, e.target.value === '' ? undefined : Number(e.target.value)),
      });
      break;
    case 'datetime':
      control = h('input', { id, class: `input${error ? ' input--error' : ''}`, type: 'datetime-local', disabled, value: value ?? '', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy, onInput: (e) => ctx.set(path, e.target.value || undefined) });
      break;
    case 'stringList':
      control = h('textarea', {
        id, class: `input input--area${error ? ' input--error' : ''}`, rows: 3, disabled, value: (value ?? []).join('\n'),
        'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
        onInput: (e) => ctx.set(path, e.target.value.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean)),
      });
      break;
    case 'url':
      control = h('input', { id, class: `input${error ? ' input--error' : ''}`, type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxlength: field.max, disabled, value: value ?? '', placeholder: 'https://', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy, onInput: (e) => ctx.set(path, e.target.value || undefined) });
      break;
    default: {
      // string
      const props = {
        id, class: `input${error ? ' input--error' : ''}`, maxlength: field.max, disabled, value: value ?? '', placeholder: field.placeholder,
        autocomplete: 'off', 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
        onInput: (e) => ctx.set(path, e.target.value === '' ? undefined : e.target.value),
      };
      control = field.multiline ? h('textarea', { ...props, class: `${props.class} input--area`, rows: 3 }) : h('input', { ...props, type: 'text' });
    }
  }
  return wrapper({ path, field, id, wide, error, describedBy, control, required, note: field.type === 'money' ? ctx.currencyNote : null });
}

function wrapper({ path, field, id, wide, error, control, required, hideLabel = false, note = null }) {
  return h(
    'div',
    { class: `field${wide ? ' field--wide' : ''}`, 'data-path': path },
    hideLabel ? null : h('label', { for: id, class: 'field__label' }, field.label, required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null),
    control,
    field.help ? h('p', { id: `${id}-help`, class: 'field__hint' }, field.help) : null,
    note ? h('p', { class: 'field__hint field__hint--currency' }, note) : null,
    error ? h('p', { id: `${id}-err`, class: 'field__error', role: 'alert' }, error) : null,
  );
}

/**
 * Objetivos como cartões compactos (nome e uma frase, sem ícones): grade de 4 por linha no computador, 2 no celular. O botão de
 * opção continua real (teclado com as setas, leitor de tela), só fica invisível; o cartão mostra a seleção com um "✓".
 */
function objectiveCards(field, value, path, ctx, error) {
  const cards = getOptions(field, ctx.config).map(({ value: optionValue }) => {
    const meta = OBJECTIVE_META[optionValue];
    const selected = value === optionValue;
    return h(
      'label',
      { class: `objective-card${selected ? ' is-selected' : ''}` },
      h('input', { type: 'radio', name: 'objective', value: optionValue, checked: selected, disabled: ctx.readOnly, onChange: () => ctx.set(path, optionValue, { rerender: true }) }),
      h('span', { class: 'objective-card__check', 'aria-hidden': 'true' }, '✓'),
      h('span', { class: 'objective-card__title' }, OBJECTIVES.find((o) => o.value === optionValue).label),
      h('span', { class: 'objective-card__text' }, meta),
    );
  });
  return h(
    'div',
    { class: 'field field--wide', 'data-path': path },
    h('div', { class: 'objective-grid', role: 'radiogroup', 'aria-label': field.label }, cards),
    error ? h('p', { class: 'field__error', role: 'alert' }, error) : null,
  );
}
const OBJECTIVE_META = Object.fromEntries(OBJECTIVES.map((o) => [o.value, o.description]));

function enumControl(field, initialValue, path, ctx, { id, describedBy, error, disabled }) {
  let value = initialValue;
  const options = getOptions(field, ctx.config);
  if (!options.length) {
    return h('p', { class: 'field__hint' }, field.optionsBy ? 'Escolha o objetivo na primeira etapa para ver as opções.' : 'Sem opções disponíveis.');
  }
  // Única opção válida (ex.: oCPM para conversões): já vem selecionada, sem exigir clique.
  if (options.length === 1 && value === undefined && !disabled) {
    value = options[0].value;
    ctx.set(path, value);
  }
  if (options.length <= 3) {
    const name = nextId();
    return h(
      'div',
      { class: 'choice-list choice-list--segmented', role: 'radiogroup', 'aria-label': field.label },
      options.map((o) =>
        h('label', { class: `choice${value === o.value ? ' is-selected' : ''}` }, h('input', { type: 'radio', name, value: o.value, checked: value === o.value, disabled, onChange: () => ctx.set(path, o.value, { rerender: true }) }), h('span', null, o.label)),
      ),
    );
  }
  const select = h(
    'select',
    { id, class: `input${error ? ' input--error' : ''}`, disabled, 'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy, onChange: (e) => ctx.set(path, e.target.value || undefined, { rerender: true }) },
    h('option', { value: '' }, field.required || isRequired(field, ctx.config) ? 'Selecione…' : '— Nenhum —'),
    options.map((o) => h('option', { value: o.value }, o.label)),
  );
  select.value = value ?? '';
  return select;
}

/** Lista de escolha múltipla compacta: botões (poucas opções) ou lista suspensa com busca (muitas). */
function checkGroup(field, selected, path, ctx, { disabled }) {
  const options = getOptions(field, ctx.config);
  return createMultiChoice({
    options, selected, maxItems: field.maxItems, disabled, label: field.label,
    onChange: (next) => ctx.set(path, next),
  });
}

function moneyInput(path, value, ctx, { id, describedBy, error, disabled }) {
  const shown = ctx.moneyText[path] ?? (value === undefined ? '' : centsToInput(value));
  return h(
    'div',
    { class: 'money' },
    h('span', { class: 'money__prefix' }, ctx.moneyPrefix ?? 'R$'), // símbolo da moeda das contas (ou "BRL / USD" quando há mais de uma)
    h('input', {
      id, class: `input${error ? ' input--error' : ''}`, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0,00', disabled, value: shown,
      'aria-invalid': error ? 'true' : null, 'aria-describedby': describedBy,
      onInput: (e) => {
        ctx.moneyText[path] = e.target.value;
        ctx.set(path, e.target.value.trim() === '' ? undefined : (parseMoneyToCents(e.target.value) ?? undefined));
      },
      onBlur: (e) => {
        const cents = parseMoneyToCents(e.target.value);
        if (cents !== null) {
          delete ctx.moneyText[path];
          e.target.value = centsToInput(cents);
        }
      },
    }),
  );
}

/**
 * Escolha de criativos da biblioteca: mostra miniatura e nome do que foi escolhido e abre o seletor.
 * No carrossel a ORDEM importa, então há botões para subir/descer.
 */
function creativeControl(field, value, path, ctx, { disabled }) {
  const multiple = field.type === 'creativeList';
  const ids = multiple ? (value ?? []) : value === undefined ? [] : [value];
  const kindText = field.creativeKind === 'video' ? 'vídeo' : 'imagem';
  const commit = (next) => ctx.set(path, multiple ? (next.length ? next : undefined) : next[0], { rerender: true });

  async function open() {
    const picked = await ctx.pickCreatives({
      kind: field.creativeKind,
      multiple,
      max: field.maxItems ?? 1,
      selected: ids,
      title: multiple ? `Escolher imagens (até ${field.maxItems ?? 10})` : `Escolher ${kindText}`,
    });
    if (picked !== null) commit(picked);
  }
  const move = (index, delta) => {
    const next = [...ids];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    commit(next);
  };

  const rows = ids.map((id, index) => {
    const creative = ctx.creatives.get(id);
    return h(
      'li',
      { class: 'creative-field__item' },
      creative ? creativeThumb(creative) : h('div', { class: 'thumb thumb--missing' }, '?'),
      h('div', { class: 'creative-field__text' }, h('strong', null, creative ? creative.name : `Criativo #${id}`), creative ? null : h('span', { class: 'muted' }, 'Não encontrado na biblioteca: remova ou escolha outro.')),
      disabled
        ? null
        : h(
            'div',
            { class: 'creative-field__actions' },
            multiple && ids.length > 1 ? h('button', { type: 'button', class: 'icon-btn', title: 'Mover para cima', 'aria-label': 'Mover para cima', disabled: index === 0, onClick: () => move(index, -1) }, '↑') : null,
            multiple && ids.length > 1 ? h('button', { type: 'button', class: 'icon-btn', title: 'Mover para baixo', 'aria-label': 'Mover para baixo', disabled: index === ids.length - 1, onClick: () => move(index, 1) }, '↓') : null,
            h('button', { type: 'button', class: 'icon-btn icon-btn--danger', title: 'Remover', 'aria-label': 'Remover', onClick: () => commit(ids.filter((x) => x !== id)) }, '✕'),
          ),
    );
  });

  const label = !ids.length ? `Escolher ${kindText}${multiple ? 's' : ''} da biblioteca` : multiple ? 'Adicionar ou trocar' : 'Trocar';
  return h('div', { class: 'creative-field' }, rows.length ? h('ul', { class: 'creative-field__list' }, rows) : null, disabled ? null : h('button', { type: 'button', class: 'btn btn--secondary', onClick: open }, label));
}
