import { MAX_HOOK_IDEA_LENGTH } from '../../../shared/hook-styles.js';

/**
 * Textos enviados à IA (em inglês, que a Kling entende melhor). Cada estilo descreve UMA cena curta e chamativa. Regras fixas no
 * final de TODO pedido: sem texto na tela, sem marcas, sem pessoas reais/famosos, sem violência ou nudez, e nada que mostre o
 * resultado de um produto: o hook só prende a atenção, não faz promessas.
 */
const SCENES = {
  'color-burst': 'Extreme slow-motion macro shot of vivid colored powder and paint exploding straight toward the camera, saturated neon colors, glossy particles hanging in the air.',
  'impossible-zoom': 'A fast cinematic camera push that flies through a series of glowing impossible doorways and portals into a surreal dreamlike world, ending in a burst of light.',
  'giant-object': 'A giant everyday object, such as an enormous lemon or donut, rolls into a calm empty street and makes the whole scene shake, playful and surprising, bright daylight.',
  'flip-world': 'A city street slowly rotates and flips upside down while cars, trees and small objects float weightlessly, smooth dreamlike motion.',
  'extreme-closeup': 'An extreme macro close-up of an iris or a colorful texture that suddenly pulls back fast to reveal an unexpected surreal scene.',
  'liquid-splash': 'A huge slow-motion splash of colorful liquid under neon light, sparkles and droplets frozen mid-air, high contrast.',
  'paper-tear': 'A large sheet of white paper is torn open from the center by two hands out of frame, revealing a bright glowing neon world behind it.',
  'object-rain': 'Hundreds of small colorful objects, such as candies, balloons and confetti, fall into the frame in slow motion against a clean bright background.',
  'glitch-reveal': 'A digital glitch and rewind effect that distorts the image, then snaps into a crisp glossy abstract 3D object spinning in the center, no brand.',
};

const RULES = 'Vertical 9:16 video, cinematic, strong motion from the very first frame, high contrast, smooth camera. No text, no captions, no logos, no brand names, no real people, no celebrities, no violence, no nudity.';

/** Texto livre da pessoa: sem caracteres de controle, espaços normalizados e no máximo MAX_HOOK_IDEA_LENGTH. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
export function cleanIdea(value) {
  return String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_HOOK_IDEA_LENGTH);
}

/** Pedido final à IA para um estilo (e, opcionalmente, a ideia extra da pessoa). Devolve null se o estilo não existir. */
export function buildHookPrompt(styleId, idea = '') {
  if (typeof styleId !== 'string' || !Object.hasOwn(SCENES, styleId)) return null; // nada de "__proto__" & cia
  const scene = SCENES[styleId];
  const extra = cleanIdea(idea);
  return [scene, extra ? `Extra creative direction from the advertiser: ${extra}.` : '', RULES].filter(Boolean).join(' ');
}
