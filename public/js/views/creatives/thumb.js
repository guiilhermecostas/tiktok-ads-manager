import { h, icon } from '../../dom.js';

/** Endereço do arquivo (só o dono consegue abrir: a API exige a sessão e confere o dono). */
export const creativeFileUrl = (creative) => `/api/creatives/${creative.id}/file`;

/**
 * Miniatura de um criativo: imagem, primeiro quadro do vídeo ou um ícone (criativo que só existe no TikTok).
 * Todo texto vira nó de texto (nunca HTML).
 */
export function creativeThumb(creative, { video = false } = {}) {
  let media;
  if (!creative.hasFile) {
    media = h('div', { class: 'thumb__placeholder' }, icon(creative.kind === 'video' ? 'video' : 'image', 28), h('span', null, 'No TikTok'));
  } else if (creative.kind === 'video') {
    media = video
      ? h('video', { src: creativeFileUrl(creative), controls: true, preload: 'metadata', playsinline: true, 'aria-label': creative.name })
      : h('video', { src: `${creativeFileUrl(creative)}#t=0.1`, preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' });
  } else {
    media = h('img', { src: creativeFileUrl(creative), alt: creative.name, loading: 'lazy', decoding: 'async' });
  }
  return h('div', { class: `thumb thumb--${creative.kind}` }, media, creative.kind === 'video' && !video ? h('span', { class: 'thumb__badge' }, icon('video', 14)) : null);
}
