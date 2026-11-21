import { FIELDS, STEPS, fieldsOfStep, formatValue, getPath, isVisible, stepOfPath } from '/shared/campaign-spec.js';
import { h } from '../../dom.js';
import { button } from '../../ui.js';

const isBlankValue = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const REVIEW_STEPS = ['objective', 'campaign', 'adGroup', 'ad'];
const fieldFor = (path) => {
  const [section, key] = path.split('.');
  return FIELDS[section]?.find((f) => f.key === key);
};

/** Passo final: resumo legível de tudo o que foi configurado, com atalhos para corrigir cada parte. */
export function renderReview({ config, advertisers, creatives, errors, publish, readOnly, goTo }) {
  const advertiserLabel = (id) => {
    const a = advertisers.find((x) => x.id === id);
    return a ? `${a.businessCenterName} · ${a.name} (${id})` : id;
  };

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
      .filter(({ section, field }) => isVisible(field, config) && (field.required || field.type === 'advertiser' || !isBlankValue(getPath(config, `${section}.${field.key}`))))
      .map(({ section, field }) => {
        const value = getPath(config, `${section}.${field.key}`);
        const creativeName = (id) => creatives.get(id)?.name ?? `Criativo #${id}`;
        let formatted;
        if (field.type === 'advertiser') formatted = value ? advertiserLabel(value) : '—';
        else if (field.type === 'creative') formatted = value ? creativeName(value) : '—';
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

  const published =
    publish.status === 'none'
      ? null
      : h(
          'div',
          { class: `alert ${publish.status === 'published' ? 'alert--success' : 'alert--danger'}` },
          h('strong', null, publish.status === 'published' ? 'Publicada no TikTok (pausada).' : 'Publicação parcial: alguns níveis já foram criados no TikTok.'),
          h(
            'p',
            null,
            `Campanha: ${publish.campaignId ?? '—'} · Grupo de anúncios: ${publish.adGroupId ?? '—'} · Anúncio: ${publish.adId ?? '—'}`,
          ),
          publish.error ? h('p', null, `Último erro: ${publish.error}`) : null,
          publish.status === 'partial' ? h('p', null, 'Ao publicar de novo, só os níveis que faltam serão criados.') : null,
        );

  return h('div', { class: 'review' }, published, problems, sections);
}
