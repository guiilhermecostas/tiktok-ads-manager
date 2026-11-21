import { FIELDS, STEPS, fieldsOfStep, formatValue, getPath, isVisible, stepOfPath } from '/shared/campaign-spec.js';
import { h } from '../../dom.js';
import { button } from '../../ui.js';

const isBlankValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const REVIEW_STEPS = ['objective', 'campaign', 'adGroup', 'ad'];
const fieldFor = (path) => {
  const [section, key] = path.split('.');
  return FIELDS[section]?.find((f) => f.key === key);
};

/**
 * Passo final: resumo legível de tudo o que foi configurado (com atalhos para corrigir cada parte) e, abaixo,
 * o painel `targets` para escolher em quais contas de anúncio publicar.
 */
export function renderReview({ config, creatives, errors, publish, readOnly, goTo, targets }) {
  const problems = errors.length
    ? h(
        'div',
        { class: 'alert alert--danger', role: 'alert' },
        h('strong', null, `Corrija ${errors.length} ponto(s) antes de publicar:`),
        h(
          'ul',
          { class: 'review-errors' },
          errors.map((e) => {
            const field = fieldFor(e.path);
            const step = stepOfPath(e.path);
            const stepIndex = STEPS.findIndex((s) => s.id === step);
            return h(
              'li',
              null,
              `${field?.label ?? e.path}: ${e.message} `,
              stepIndex >= 0 && !readOnly ? h('button', { type: 'button', class: 'link-btn', onClick: () => goTo(stepIndex) }, 'Corrigir') : null,
            );
          }),
        ),
      )
    : null;

  const sections = REVIEW_STEPS.map((stepId) => {
    const stepIndex = STEPS.findIndex((s) => s.id === stepId);
    const rows = fieldsOfStep(stepId)
      .filter(({ section, field }) => isVisible(field, config) && (field.required || !isBlankValue(getPath(config, `${section}.${field.key}`))))
      .map(({ section, field }) => {
        const value = getPath(config, `${section}.${field.key}`);
        const creativeName = (id) => creatives.get(id)?.name ?? `Criativo #${id}`;
        let formatted;
        if (field.type === 'creative') formatted = value ? creativeName(value) : '—';
        else if (field.type === 'creativeList') formatted = value?.length ? value.map(creativeName).join(', ') : '—';
        else formatted = formatValue(field, value, config);
        const text = field.type === 'money' && formatted !== '—' ? `R$ ${formatted}` : formatted;
        return h('div', { class: 'review-row' }, h('dt', null, field.label), h('dd', { class: text === '—' ? 'muted' : null }, text));
      });
    return h(
      'section',
      { class: 'card card--pad review-card' },
      h(
        'div',
        { class: 'review-card__head' },
        h('h3', { class: 'card__title' }, STEPS[stepIndex].title),
        readOnly ? null : button('Editar', { small: true, onClick: () => goTo(stepIndex) }),
      ),
      h('dl', { class: 'review-list' }, rows),
    );
  });

  const count = publish.published + publish.partial;
  const notice =
    publish.status === 'none'
      ? null
      : h(
          'div',
          { class: `alert ${publish.status === 'published' ? 'alert--success' : 'alert--danger'}` },
          h('strong', null, publish.status === 'published' ? `Publicada no TikTok (pausada) em ${count === 1 ? '1 conta' : `${count} contas`}.` : 'Publicação parcial: alguns níveis já foram criados no TikTok.'),
          publish.status === 'published' ? h('p', null, 'A configuração da campanha não muda mais, mas você pode publicar em outras contas logo abaixo.') : h('p', null, 'Ao publicar de novo nessa conta, só os níveis que faltam serão criados.'),
        );

  return h('div', { class: 'review' }, notice, problems, sections, targets);
}
