import { LEVELS, computeLevel, formatUsdShort, ladder, levelRange } from '/shared/spend-levels.js';
import { h } from '../dom.js';
import { formatCurrency } from '../format.js';

const SEEN_KEY = (userId) => `tt.level-seen.${userId}`;

/** Último nível que a pessoa já viu (para comemorar só quando ela SOBE de nível). Falha de armazenamento nunca atrapalha a tela. */
function readSeen(userId) {
  try {
    const value = Number(localStorage.getItem(SEEN_KEY(userId)));
    return Number.isInteger(value) && value >= 1 && value <= LEVELS.length ? value : null;
  } catch {
    return null;
  }
}
function writeSeen(userId, n) {
  try {
    localStorage.setItem(SEEN_KEY(userId), String(n));
  } catch { /* navegação privada ou armazenamento cheio: só não comemora na próxima vez */ }
}

/** Pinta o elemento com a cor do nível (variável CSS por CSSOM, permitido pela CSP). */
const tint = (el, color) => {
  el.style.setProperty('--lvl', color);
  return el;
};

/**
 * Painel "Meu nível": barra de progresso que muda de cor a cada um dos 13 níveis, quanto falta para o próximo, uma frase de incentivo e a
 * escada completa. O servidor manda só o gasto em dólar; nome, cor e faixas vêm do módulo compartilhado (a mesma regra dos testes).
 */
export function levelPanel(data, { userId }) {
  const result = computeLevel(data.spendUsd);
  const { level, progress, next, isMax } = result;
  const seen = readSeen(userId);
  const leveledUp = seen !== null && level.n > seen;
  writeSeen(userId, Math.max(level.n, seen ?? 0));

  const percent = Math.round(progress * 100);
  const fill = h('span', { class: 'lvl-bar__fill' });
  const bar = h('div', { class: 'lvl-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent), 'aria-label': `Progresso no nível ${level.n}: ${percent}%` }, fill);
  // A barra enche com uma transição suave (de 0 até o valor) assim que a tela aparece.
  requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${percent}%`; }));

  const goal = isMax
    ? h('p', { class: 'lvl-card__goal' }, h('strong', null, 'Você chegou ao topo da escada!'), ' Nenhum nível acima: agora é manter o ritmo.')
    : h('p', { class: 'lvl-card__goal' }, 'Faltam ', h('strong', null, formatCurrency(result.remaining, 'USD')), ` para o nível ${next.n} · ${next.name}.`);

  const card = tint(h(
    'section',
    { class: 'lvl-card', 'aria-label': `Seu nível: ${level.name}` },
    leveledUp ? h('p', { class: 'lvl-card__up', role: 'status' }, `🎉 Você subiu para o nível ${level.n}!`) : null,
    h(
      'div',
      { class: 'lvl-card__head' },
      h('span', { class: 'lvl-card__badge', 'aria-hidden': 'true' }, String(level.n)),
      h(
        'div',
        { class: 'lvl-card__title' },
        h('span', { class: 'lvl-card__kicker' }, `Nível ${level.n} de ${LEVELS.length}`),
        h('strong', { class: 'lvl-card__name' }, level.name),
      ),
      h('div', { class: 'lvl-card__spent' }, h('span', null, 'Já investido em anúncios'), h('strong', null, formatCurrency(data.spendUsd, 'USD'))),
    ),
    h('div', { class: 'lvl-card__barwrap' }, bar, h('div', { class: 'lvl-card__scale' }, h('span', null, formatUsdShort(level.from)), h('span', { class: 'lvl-card__percent' }, `${percent}%`), h('span', null, formatUsdShort(level.to)))),
    goal,
    h('p', { class: 'lvl-card__message' }, level.message),
  ), level.color);

  const steps = h('ol', { class: 'lvl-ladder', 'aria-label': 'Os 13 níveis' }, ...ladder(level.n).map((step) => tint(h(
    'li',
    { class: `lvl-step lvl-step--${step.state}`, title: `${step.name}: ${levelRange(step)}`, 'aria-current': step.state === 'current' ? 'step' : null },
    h('span', { class: 'lvl-step__n' }, step.state === 'done' ? '✓' : String(step.n)),
    h('span', { class: 'lvl-step__name' }, step.name),
    h('span', { class: 'lvl-step__range' }, `até ${formatUsdShort(step.to)}`),
  ), step.color)));

  const notes = [
    'O nível usa tudo o que você já gastou em anúncios nas suas contas (em dólar) e sobe sozinho conforme você investe.',
    data.partial ? 'O TikTok não respondeu agora; o valor pode estar um pouco desatualizado.' : null,
    data.unconverted?.length ? `Gasto em ${data.unconverted.map((u) => u.currency).join(', ')} ainda não entra na conta (falta a cotação para dólar).` : null,
  ].filter(Boolean);

  return h('div', { class: 'lvl' }, card, h('h3', { class: 'lvl__title' }, 'A escada até US$ 100 milhões'), steps, ...notes.map((text) => h('p', { class: 'field__hint lvl__note' }, text)));
}
