/**
 * Sugestões inteligentes do campo do Início: enquanto a pessoa digita, aparecem só as perguntas que o assistente sabe responder e que combinam
 * com o texto (e `/` lista tudo). Regras puras, sem DOM (usadas pela tela e testadas em Node). Sem modelo de linguagem: combinação de palavras.
 */
import { OPERATIONS } from './assistant-intents.js';
import { EXTRA_TOPICS, TOPICS } from './chat-topics.js';

/** Palavras que a pessoa costuma usar para cada operação (além do título e do texto). */
const ALIASES = Object.freeze({
  bcs: ['bm', 'bc', 'business center', 'business centers'],
  accounts: ['ca', 'conta', 'contas', 'anunciante'],
  accountsDown: ['caiu', 'cairam', 'banida', 'suspensa', 'derrubada', 'punida'],
  adsRejected: ['reprovado', 'rejeitado', 'recusado', 'anuncio', 'anuncios'],
  creativesUploaded: ['criativo', 'criativos', 'upload', 'video', 'videos', 'subi'],
  spendTotal: ['gasto', 'gastei', 'investimento', 'investi', 'quanto'],
  bestCreatives: ['melhor', 'performou', 'criativo', 'ranking'],
  bestCost: ['custo', 'cpa', 'cpc', 'barato', 'metricas'],
});

/** Tudo o que o assistente responde: as perguntas sobre a operação e os assuntos gerais. */
export const SUGGESTION_POOL = Object.freeze([
  ...Object.values(OPERATIONS).map((op) => ({ kind: 'operation', id: op.id, title: op.title, text: op.text, keywords: ALIASES[op.id] ?? [] })),
  ...[...TOPICS, ...EXTRA_TOPICS].map((topic) => ({ kind: 'topic', id: topic.id, title: topic.title, text: topic.text, keywords: [] })),
]);

/** Exemplos que se alternam no campo vazio (mostram o que dá para perguntar sem encher a tela). */
export const PLACEHOLDERS = Object.freeze([
  'Pergunte sobre as suas campanhas, contas e relatórios…',
  'Ex.: Quantas contas caíram hoje?',
  'Ex.: Quanto gastei no total esta semana?',
  'Ex.: Quais criativos performaram melhor?',
  'Ex.: Quantos anúncios foram rejeitados ontem?',
  'Digite / para ver tudo o que eu sei responder',
]);

const MAX_SUGGESTIONS = 5;

export const plain = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * Sugestões para o texto digitado. `/` (sozinho) mostra tudo; `/palavra` filtra; texto comum precisa de ao menos uma palavra com 2+ letras e
 * TODAS as palavras precisam combinar (no título pesa mais). Devolve até 5 itens (até todos, para `/`), do mais ao menos relevante.
 */
export function suggest(query, { pool = SUGGESTION_POOL, limit = MAX_SUGGESTIONS } = {}) {
  const raw = String(query ?? '').trimStart();
  const command = raw.startsWith('/');
  const q = plain(command ? raw.slice(1) : raw);
  if (command && !q) return [...pool];
  const tokens = q.split(' ').filter((t) => t.length >= 2);
  if (!tokens.length) return [];
  const scored = [];
  for (const item of pool) {
    const title = plain(item.title);
    const body = plain(`${item.text} ${item.keywords.join(' ')}`);
    let score = 0;
    let all = true;
    for (const token of tokens) {
      if (title.split(' ').some((w) => w.startsWith(token))) score += 4;
      else if (title.includes(token)) score += 3;
      else if (body.split(' ').some((w) => w.startsWith(token))) score += 2;
      else if (body.includes(token)) score += 1;
      else all = false;
    }
    if (all) scored.push({ item, score });
  }
  const sorted = scored.sort((a, b) => b.score - a.score).map((entry) => entry.item);
  return command ? sorted : sorted.slice(0, limit);
}
