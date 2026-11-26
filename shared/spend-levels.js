/**
 * Níveis de gasto em anúncios (13 níveis, de US$ 0 a US$ 100 milhões): quanto mais a pessoa investiu desde sempre, mais alto o nível. Regras puras,
 * usadas pelo servidor (calcula) e pela tela (desenha a barra, que muda de cor a cada nível). Valores sempre em DÓLAR.
 */

const K = 1_000;
const M = 1_000_000;

/** Cada nível: de `from` (inclusive) até `to` (exclusivo), com nome, cor da barra e uma frase de incentivo. O último nível não tem próximo. */
export const LEVELS = Object.freeze([
  { n: 1, from: 0, to: 1 * K, name: 'Iniciante', color: '#94a3b8', message: 'Todo grande anunciante começou aqui. O primeiro passo já foi dado!' },
  { n: 2, from: 1 * K, to: 10 * K, name: 'Aprendiz', color: '#22d3ee', message: 'Você já está testando e aprendendo. Continue: os dados mostram o caminho.' },
  { n: 3, from: 10 * K, to: 50 * K, name: 'Praticante', color: '#14b8a6', message: 'Ritmo de quem leva a sério. Suas campanhas já têm história.' },
  { n: 4, from: 50 * K, to: 100 * K, name: 'Operador', color: '#22c55e', message: 'Você opera com confiança. Está quase na casa dos seis dígitos!' },
  { n: 5, from: 100 * K, to: 250 * K, name: 'Escalador', color: '#84cc16', message: 'Seis dígitos investidos! Agora é escalar o que funciona.' },
  { n: 6, from: 250 * K, to: 500 * K, name: 'Veterano', color: '#eab308', message: 'Poucos chegam até aqui. A sua experiência vale ouro.' },
  { n: 7, from: 500 * K, to: 1 * M, name: 'Especialista', color: '#f59e0b', message: 'Meio milhão investido: você domina a plataforma. Falta pouco para o milhão!' },
  { n: 8, from: 1 * M, to: 2.5 * M, name: 'Mestre', color: '#f97316', message: 'Passou de 1 milhão! Você joga o jogo dos grandes.' },
  { n: 9, from: 2.5 * M, to: 5 * M, name: 'Elite', color: '#ef4444', message: 'Elite dos anunciantes. Cada decisão sua move muito dinheiro.' },
  { n: 10, from: 5 * M, to: 10 * M, name: 'Imparável', color: '#fe2c55', message: 'Nada te segura. Você já está no clube dos milhões.' },
  { n: 11, from: 10 * M, to: 20 * M, name: 'Lenda', color: '#d946ef', message: 'Dez milhões investidos: histórias como a sua inspiram o mercado.' },
  { n: 12, from: 20 * M, to: 50 * M, name: 'Titã', color: '#8b5cf6', message: 'Um gigante dos anúncios. Falta só o último nível!' },
  { n: 13, from: 50 * M, to: 100 * M, name: 'Imperador', color: '#f5c518', message: 'O topo da escada. Você chegou onde quase ninguém chega!' },
]);
export const MAX_LEVEL = LEVELS.length;
export const TOP_AMOUNT = LEVELS[MAX_LEVEL - 1].to;

/** Valor em dólar legível e curto: "US$ 500", "US$ 10 mil", "US$ 2,5 mi". */
export function formatUsdShort(value) {
  const number = (n, digits) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits }).format(n);
  if (value >= M) return `US$ ${number(value / M, 2)} mi`;
  if (value >= K) return `US$ ${number(value / K, 1)} mil`;
  return `US$ ${number(value, 0)}`;
}

/** Faixa do nível em texto: "US$ 10 mil a US$ 50 mil". */
export const levelRange = (level) => `${formatUsdShort(level.from)} a ${formatUsdShort(level.to)}`;

/**
 * Nível de quem já gastou `spendUsd` (dólares, número ≥ 0). Valor inválido ou negativo conta como zero; acima de US$ 100 milhões fica no último nível, completo.
 * Devolve { level, progress (0 a 1 dentro do nível), remaining (dólares para o próximo), next (nível seguinte ou null), isMax, spendUsd }.
 */
export function computeLevel(spendUsd) {
  const spend = Number.isFinite(spendUsd) && spendUsd > 0 ? spendUsd : 0;
  const level = LEVELS.find((l) => spend >= l.from && spend < l.to) ?? LEVELS[MAX_LEVEL - 1];
  const isMax = level.n === MAX_LEVEL;
  const progress = isMax && spend >= level.to ? 1 : Math.min(1, Math.max(0, (spend - level.from) / (level.to - level.from)));
  return { level, progress, remaining: isMax ? Math.max(0, level.to - spend) : level.to - spend, next: isMax ? null : LEVELS[level.n], isMax, spendUsd: spend };
}

/** A escada dos 13 níveis para desenhar: cada degrau diz se já foi vencido, é o atual ou ainda falta. */
export function ladder(currentN) {
  return LEVELS.map((level) => ({ ...level, state: level.n < currentN ? 'done' : level.n === currentN ? 'current' : 'todo' }));
}
