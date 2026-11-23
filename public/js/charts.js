import { h } from './dom.js';

/**
 * Gráficos em SVG puro (sem biblioteca): linha com curva SUAVE (spline cúbica monótona, que nunca "passa" dos valores nem
 * cria vales falsos), área em degradê, grade, eixos, dica ao passar o mouse/tocar e navegação pelo teclado. Compatível com a CSP
 * (só atributos SVG e CSSOM; nada de estilo inline nem HTML dinâmico). Todo texto vem como texto.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
let gradientCounter = 0;

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) el.setAttribute(key, String(value));
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

/**
 * Caminho suave por pontos [x, y] (x crescente): interpolação cúbica monótona de Fritsch–Carlson, convertida em curvas de Bézier.
 * Com 1 ponto devolve só o "M"; com 2, uma reta.
 */
export function smoothPath(points) {
  const n = points.length;
  if (n === 0) return '';
  const fmt = (v) => Number(v.toFixed(2));
  if (n === 1) return `M${fmt(points[0][0])} ${fmt(points[0][1])}`;
  if (n === 2) return `M${fmt(points[0][0])} ${fmt(points[0][1])}L${fmt(points[1][0])} ${fmt(points[1][1])}`;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / (dx[i] || 1));
  }
  const tangent = [slope[0]];
  for (let i = 1; i < n - 1; i += 1) {
    tangent.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2); // extremo local: tangente plana
  }
  tangent.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i += 1) { // limita as tangentes (monotonicidade)
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
    } else {
      const a = tangent[i] / slope[i];
      const b = tangent[i + 1] / slope[i];
      const sum = a * a + b * b;
      if (sum > 9) {
        const scale = 3 / Math.sqrt(sum);
        tangent[i] = scale * a * slope[i];
        tangent[i + 1] = scale * b * slope[i];
      }
    }
  }
  let path = `M${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 0; i < n - 1; i += 1) {
    const step = dx[i] / 3;
    path += `C${fmt(points[i][0] + step)} ${fmt(points[i][1] + tangent[i] * step)} ${fmt(points[i + 1][0] - step)} ${fmt(points[i + 1][1] - tangent[i + 1] * step)} ${fmt(points[i + 1][0])} ${fmt(points[i + 1][1])}`;
  }
  return path;
}

/** Limite "bonito" de eixo (1, 2, 2.5, 5 × 10ⁿ) acima do maior valor, para os rótulos do eixo Y não ficarem quebrados. */
export function niceMax(value) {
  if (!(value > 0)) return 1;
  const exponent = 10 ** Math.floor(Math.log10(value));
  const fraction = value / exponent;
  const nice = [1, 2, 2.5, 5, 10].find((f) => fraction <= f);
  return nice * exponent;
}

const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Gráfico de linha. `dates`: ['2026-11-01', …]; `values`: números do mesmo tamanho; `format(v)`: texto de um valor (dica e eixo).
 * Retorna o elemento (redesenha sozinho quando o tamanho da área muda).
 */
export function lineChart({ dates, values, format, label, height = 260 }) {
  const id = `chart-grad-${++gradientCounter}`;
  const wrap = h('div', { class: 'chart', tabindex: 0, role: 'img' });
  const tooltip = h('div', { class: 'chart__tip', hidden: true });
  const stage = h('div', { class: 'chart__stage' });
  wrap.append(stage, tooltip);
  let active = values.length - 1;
  let geometry = null;

  const total = values.reduce((s, v) => s + v, 0);
  const peak = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
  wrap.setAttribute('aria-label', `${label}: ${values.length} dias, de ${shortDate(dates[0] ?? '0000-00-00')} a ${shortDate(dates.at(-1) ?? '0000-00-00')}. Maior valor ${format(values[peak] ?? 0)} em ${shortDate(dates[peak] ?? '0000-00-00')}. Use as setas para navegar pelos dias.`);

  function draw() {
    const width = Math.max(280, Math.floor(wrap.clientWidth || 640));
    const pad = { top: 14, right: 14, bottom: 26, left: 58 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const top = niceMax(Math.max(...values, 0));
    const x = (i) => pad.left + (values.length <= 1 ? innerW / 2 : (i / (values.length - 1)) * innerW);
    const y = (v) => pad.top + innerH - (v / top) * innerH;
    const points = values.map((v, i) => [x(i), y(v)]);
    geometry = { width, pad, innerH, x, y };

    const grid = [];
    for (let i = 0; i <= 4; i += 1) {
      const value = (top / 4) * i;
      grid.push(svg('line', { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: 'chart__grid' }), svg('text', { x: pad.left - 8, y: y(value) + 4, class: 'chart__axis', 'text-anchor': 'end' }, format(value)));
    }
    const ticks = Math.min(6, values.length);
    const labels = [];
    for (let t = 0; t < ticks; t += 1) {
      const i = ticks === 1 ? 0 : Math.round((t / (ticks - 1)) * (values.length - 1));
      labels.push(svg('text', { x: x(i), y: height - 6, class: 'chart__axis', 'text-anchor': t === 0 ? 'start' : t === ticks - 1 ? 'end' : 'middle' }, shortDate(dates[i])));
    }
    const line = smoothPath(points);
    const area = points.length > 1 ? `${line}L${points.at(-1)[0]} ${pad.top + innerH}L${points[0][0]} ${pad.top + innerH}Z` : '';
    const cursor = svg('line', { class: 'chart__cursor', y1: pad.top, y2: pad.top + innerH, x1: 0, x2: 0 });
    const dot = svg('circle', { class: 'chart__dot', r: 5, cx: 0, cy: 0 });
    geometry.cursor = cursor;
    geometry.dot = dot;

    stage.replaceChildren(
      svg(
        'svg',
        { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true', focusable: 'false' },
        svg('defs', {}, svg('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, svg('stop', { offset: '0%', 'stop-color': '#111', 'stop-opacity': 0.16 }), svg('stop', { offset: '100%', 'stop-color': '#111', 'stop-opacity': 0 }))),
        grid,
        labels,
        area ? svg('path', { d: area, fill: `url(#${id})` }) : null,
        svg('path', { d: line, class: 'chart__line', fill: 'none' }),
        cursor,
        dot,
      ),
    );
    show(active, false);
  }

  function show(index, withTip = true) {
    if (!geometry || !values.length) return;
    active = Math.max(0, Math.min(values.length - 1, index));
    const cx = geometry.x(active);
    const cy = geometry.y(values[active]);
    geometry.cursor.setAttribute('x1', cx);
    geometry.cursor.setAttribute('x2', cx);
    geometry.dot.setAttribute('cx', cx);
    geometry.dot.setAttribute('cy', cy);
    tooltip.hidden = !withTip;
    if (withTip) {
      tooltip.replaceChildren(h('strong', null, format(values[active])), h('span', { class: 'muted' }, shortDate(dates[active])));
      tooltip.style.left = `${Math.min(Math.max(cx, 60), geometry.width - 60)}px`; // CSSOM: permitido pela CSP
      tooltip.style.top = `${Math.max(cy - 8, 0)}px`;
    }
  }

  function nearest(event) {
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    if (!geometry || values.length <= 1) return 0;
    const ratio = (px - geometry.pad.left) / (geometry.width - geometry.pad.left - geometry.pad.right);
    return Math.round(Math.max(0, Math.min(1, ratio)) * (values.length - 1));
  }

  wrap.addEventListener('pointermove', (e) => show(nearest(e)));
  wrap.addEventListener('pointerdown', (e) => show(nearest(e)));
  wrap.addEventListener('pointerleave', () => { tooltip.hidden = true; });
  wrap.addEventListener('keydown', (e) => {
    const move = { ArrowLeft: -1, ArrowRight: 1, Home: -values.length, End: values.length }[e.key];
    if (move) {
      e.preventDefault();
      show(active + move);
    }
  });
  wrap.addEventListener('blur', () => { tooltip.hidden = true; });
  wrap.dataset.total = String(total);

  if (typeof ResizeObserver === 'function') {
    let lastWidth = 0;
    new ResizeObserver(() => {
      if (wrap.clientWidth && wrap.clientWidth !== lastWidth) {
        lastWidth = wrap.clientWidth;
        draw();
      }
    }).observe(wrap);
  }
  draw();
  return wrap;
}

/** Mini gráfico (sem eixos) para os cartões de indicador. */
export function sparkline(values, { width = 96, height = 30 } = {}) {
  const top = Math.max(...values, 0);
  const bottom = Math.min(...values, 0);
  const range = top - bottom || 1;
  const points = values.map((v, i) => [values.length <= 1 ? width / 2 : (i / (values.length - 1)) * width, height - 3 - ((v - bottom) / range) * (height - 6)]);
  return svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'spark', 'aria-hidden': 'true', focusable: 'false' }, svg('path', { d: smoothPath(points), class: 'spark__line', fill: 'none' }));
}
