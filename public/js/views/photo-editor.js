import { h } from '../dom.js';

const VIEW = 288; // lado da área de recorte na tela (px)
const OUTPUT = 512; // lado da imagem enviada (o servidor reduz para 256)
const MAX_ZOOM = 4;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Editor de foto: a pessoa arrasta para posicionar, dá zoom e gira; o círculo mostra o que vai aparecer. Tudo acontece no
 * navegador (canvas); só o resultado recortado sai daqui. `bitmap` vem de createImageBitmap (já com a orientação da câmera).
 * Retorna { element, toBlob(), destroy() }.
 */
export function createPhotoEditor(bitmap) {
  const state = { zoom: 1, rotation: 0, x: 0, y: 0 }; // x,y: deslocamento do centro da imagem (px na área de VIEW)

  const canvas = h('canvas', {
    class: 'photo-editor__canvas', width: VIEW, height: VIEW, tabindex: 0, role: 'img',
    'aria-label': 'Área de recorte da foto. Arraste para posicionar; use as setas para mover e + ou - para o zoom.',
  });
  const ctx = canvas.getContext('2d');

  /** Dimensões da imagem depois de girar. */
  const rotated = () => (state.rotation % 2 ? { w: bitmap.height, h: bitmap.width } : { w: bitmap.width, h: bitmap.height });
  /** Escala que faz a imagem COBRIR o quadrado de lado `side` (com zoom 1) e o limite de deslocamento para não aparecer fundo. */
  function geometry(side) {
    const r = rotated();
    const scale = Math.max(side / r.w, side / r.h) * state.zoom;
    return { scale, maxX: Math.max(0, (r.w * scale - side) / 2), maxY: Math.max(0, (r.h * scale - side) / 2) };
  }
  function clampOffsets() {
    const g = geometry(VIEW);
    state.x = clamp(state.x, -g.maxX, g.maxX);
    state.y = clamp(state.y, -g.maxY, g.maxY);
  }

  /** Desenha a imagem no contexto `c` (lado `side`), com o deslocamento proporcional. */
  function paint(c, side) {
    const g = geometry(side);
    const k = side / VIEW;
    c.save();
    c.translate(side / 2 + state.x * k, side / 2 + state.y * k);
    c.rotate((state.rotation * Math.PI) / 2);
    c.scale(g.scale, g.scale);
    c.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    c.restore();
  }

  function draw() {
    clampOffsets();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, VIEW, VIEW);
    paint(ctx, VIEW);
    // Escurece o que fica fora do círculo (o que o recorte vai esconder na bolinha) e desenha o contorno.
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, VIEW, VIEW);
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 4, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(VIEW / 2, VIEW / 2, VIEW / 2 - 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---------- arrastar (mouse, toque e caneta) ----------
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.classList.add('is-dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = VIEW / rect.width; // a tela pode mostrar o canvas menor (celular)
    state.x += (e.clientX - drag.x) * ratio;
    state.y += (e.clientY - drag.y) * ratio;
    drag.x = e.clientX;
    drag.y = e.clientY;
    draw();
  });
  const stop = (e) => {
    if (drag && drag.id === e.pointerId) drag = null;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  // ---------- zoom ----------
  const slider = h('input', { type: 'range', min: 1, max: MAX_ZOOM, step: 0.01, value: 1, class: 'photo-editor__zoom', 'aria-label': 'Zoom da foto' });
  function setZoom(value) {
    state.zoom = clamp(value, 1, MAX_ZOOM);
    slider.value = String(state.zoom);
    draw();
  }
  slider.addEventListener('input', () => setZoom(Number(slider.value)));
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });

  // ---------- teclado (acessibilidade) ----------
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 30 : 10;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      state.x += moves[e.key][0];
      state.y += moves[e.key][1];
      draw();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setZoom(state.zoom + 0.1);
    } else if (e.key === '-') {
      e.preventDefault();
      setZoom(state.zoom - 0.1);
    }
  });

  const rotate = (turns) => {
    state.rotation = (state.rotation + turns + 4) % 4;
    state.x = 0;
    state.y = 0;
    draw();
  };
  const reset = () => {
    state.rotation = 0;
    state.x = 0;
    state.y = 0;
    setZoom(1);
  };
  const tool = (label, onClick) => h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onClick }, label);

  const element = h(
    'div',
    { class: 'photo-editor' },
    canvas,
    h('div', { class: 'photo-editor__zoom-row' }, h('span', { class: 'muted', 'aria-hidden': 'true' }, '−'), slider, h('span', { class: 'muted', 'aria-hidden': 'true' }, '+')),
    h('div', { class: 'photo-editor__tools' }, tool('↺ Girar', () => rotate(-1)), tool('↻ Girar', () => rotate(1)), tool('Centralizar', reset)),
    h('p', { class: 'field__hint' }, 'Arraste a foto para posicionar. O círculo é o que vai aparecer.'),
  );
  draw();

  return {
    element,
    /** Imagem final recortada (JPEG 512x512) como Blob; null se o navegador não conseguir gerar. */
    toBlob() {
      const out = document.createElement('canvas');
      out.width = OUTPUT;
      out.height = OUTPUT;
      const c = out.getContext('2d');
      c.fillStyle = '#ffffff'; // PNG com transparência vira fundo branco no JPEG
      c.fillRect(0, 0, OUTPUT, OUTPUT);
      paint(c, OUTPUT);
      return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.9));
    },
    destroy: () => bitmap.close?.(),
  };
}
