/**
 * Hook com IA: um começo de 2 a 3 segundos, fora do padrão, para prender a atenção (gerado pela Kling). Regras compartilhadas pelo
 * servidor (validação) e pela tela (escolhas). Os textos enviados à IA ficam só no servidor (`hook-prompts.js`).
 */

/** Durações finais permitidas (a Kling gera no mínimo 3 s; o servidor corta para a duração escolhida). */
export const HOOK_DURATIONS_MS = Object.freeze([2000, 2500, 3000]);

/** Quantas opções de hook podem ser pedidas de uma vez. */
export const MAX_HOOKS_PER_REQUEST = 3;

/** Tamanho máximo da ideia livre que a pessoa pode acrescentar. */
export const MAX_HOOK_IDEA_LENGTH = 300;

/** Estilos "quebra-padrão": nome e descrição curtos para a tela. */
export const HOOK_STYLES = Object.freeze([
  { id: 'color-burst', label: 'Explosão de cor', description: 'Tinta e pó colorido explodem em câmera lenta.' },
  { id: 'impossible-zoom', label: 'Zoom impossível', description: 'A câmera atravessa portais rumo a um mundo surreal.' },
  { id: 'giant-object', label: 'Objeto gigante', description: 'Um objeto comum, enorme, invade uma cena tranquila.' },
  { id: 'flip-world', label: 'Mundo de cabeça para baixo', description: 'A rua inteira gira e as coisas flutuam.' },
  { id: 'extreme-closeup', label: 'Close extremo', description: 'Detalhe macro que recua e revela algo inesperado.' },
  { id: 'liquid-splash', label: 'Splash em câmera lenta', description: 'Respingo gigante de líquido sob luz neon.' },
  { id: 'paper-tear', label: 'Rasgando a tela', description: 'Um papel se rasga e mostra um mundo brilhante.' },
  { id: 'object-rain', label: 'Chuva de objetos', description: 'Centenas de objetos coloridos caem na tela.' },
  { id: 'glitch-reveal', label: 'Glitch e revelação', description: 'A imagem "quebra", volta ao contrário e revela um objeto.' },
]);

export const HOOK_STYLE_IDS = Object.freeze(HOOK_STYLES.map((s) => s.id));
export const isHookStyle = (id) => HOOK_STYLE_IDS.includes(id);
export const hookStyleLabel = (id) => HOOK_STYLES.find((s) => s.id === id)?.label ?? 'Hook';
