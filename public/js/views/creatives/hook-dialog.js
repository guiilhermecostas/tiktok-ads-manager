import { HOOK_DURATIONS_MS, HOOK_STYLES, MAX_HOOKS_PER_REQUEST, MAX_HOOK_IDEA_LENGTH, hookStyleLabel } from '/shared/hook-styles.js';
import { del, get, post } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { alertBox, badge, button, field, openModal, spinner, toast } from '../../ui.js';

const POLL_MS = 3000;
const TYPICAL_SECONDS = 70; // a Kling costuma levar de 1 a 3 minutos; a barra é uma ESTIMATIVA e nunca passa de 95%
const seconds = (ms) => `${String(ms / 1000).replace('.', ',')} s`;

/**
 * "Hook com IA": cria um começo de 2 a 3 segundos, fora do padrão, para prender a atenção (gerado pela Kling) e o junta ao início
 * de um vídeo da biblioteca. O vídeo original NUNCA é alterado: o resultado é um criativo novo, marcado como "gerado por IA".
 *  - `onCreated()`: chamado ao fechar, se algum criativo novo foi criado (recarrega a biblioteca).
 *  - `onClose()`: chamado ao fechar (a tela volta a acompanhar o que ainda estiver em andamento).
 * O trabalho (gerar e juntar) roda no SERVIDOR: fechar esta janela, o site ou o navegador não o interrompe; a biblioteca mostra uma bolinha
 * piscando no botão "Hook com IA" enquanto houver algo em andamento.
 */
export function openHookDialog({ onCreated, onClose }) {
  const state = { info: null, hooks: [], videos: null, style: HOOK_STYLES[0].id, durationMs: 2500, count: 2 };
  let timer = null;
  let closed = false;
  let createdAny = false;
  const cards = new Map(); // id -> { element, signature, bar }

  const body = h('div', { class: 'modal__body hook' }, spinner());
  const modal = openModal({
    title: 'Hook com IA',
    size: 'wide',
    body,
    dismissOnOverlay: false,
    onClose: () => {
      closed = true;
      clearInterval(timer);
      if (createdAny) onCreated?.();
      onClose?.();
    },
  });

  const errorSlot = h('div');
  const usageLine = h('p', { class: 'muted hook__usage' });
  const list = h('div', { class: 'hook-list', 'aria-live': 'polite' });

  // ---------- formulário ----------
  const styleGrid = h('div', { class: 'hook-styles', role: 'radiogroup', 'aria-label': 'Estilo do hook' });
  function drawStyles() {
    setChildren(
      styleGrid,
      HOOK_STYLES.map((s) => h(
        'label',
        { class: `hook-style${state.style === s.id ? ' is-on' : ''}` },
        h('input', { type: 'radio', name: 'hook-style', class: 'hook-style__input', value: s.id, checked: state.style === s.id, onChange: () => { state.style = s.id; drawStyles(); } }),
        h('strong', { class: 'hook-style__title' }, s.label),
        h('span', { class: 'hook-style__text' }, s.description),
      )),
    );
  }
  const segmented = (label, items, isOn, pick) => h('div', { class: 'segmented', role: 'group', 'aria-label': label }, items.map((item) => h('button', { type: 'button', class: `segmented__btn${isOn(item) ? ' is-on' : ''}`, 'aria-pressed': String(isOn(item)), onClick: () => pick(item) }, item.label)));
  const options = h('div', { class: 'hook-options' });
  function drawOptions() {
    setChildren(
      options,
      h('div', { class: 'hook-options__item' }, h('span', { class: 'field__label' }, 'Duração do hook'), segmented('Duração', HOOK_DURATIONS_MS.map((ms) => ({ ms, label: seconds(ms) })), (i) => i.ms === state.durationMs, (i) => { state.durationMs = i.ms; drawOptions(); })),
      h('div', { class: 'hook-options__item' }, h('span', { class: 'field__label' }, 'Quantas opções gerar'), segmented('Opções', Array.from({ length: MAX_HOOKS_PER_REQUEST }, (_, i) => ({ n: i + 1, label: String(i + 1) })), (i) => i.n === state.count, (i) => { state.count = i.n; drawOptions(); })),
    );
  }
  const idea = field('Ideia extra (opcional)', { as: 'textarea', rows: 2, maxlength: MAX_HOOK_IDEA_LENGTH, placeholder: 'Ex.: cores quentes, estilo cinematográfico, algo engraçado…', autocomplete: 'off' }, { hint: 'Não precisa falar do produto: o hook só precisa prender a atenção nos primeiros segundos.' });
  const generate = button('Gerar hook', { variant: 'primary', type: 'submit' });

  const form = h(
    'form',
    {
      class: 'form hook__form',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        errorSlot.replaceChildren();
        generate.disabled = true;
        generate.textContent = 'Enviando…';
        try {
          await post('/hooks', { style: state.style, idea: idea.control.value.trim(), durationMs: state.durationMs, count: state.count });
          await refresh();
          toast(state.count === 1 ? 'Gerando o hook…' : `Gerando ${state.count} opções…`);
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
        } finally {
          generate.disabled = false;
          generate.textContent = 'Gerar hook';
        }
      },
    },
    errorSlot,
    h('span', { class: 'field__label' }, 'Estilo'),
    styleGrid,
    idea.element,
    options,
    usageLine,
    h('div', { class: 'hook__submit' }, generate),
  );

  // ---------- resultados ----------
  const statusText = { queued: 'Na fila…', generating: 'Gerando com IA…', processing: 'Ajustando o vídeo…' };
  const isActive = (hook) => ['queued', 'generating', 'processing'].includes(hook.status);

  /** Estimativa de andamento (a Kling não informa porcentagem). */
  function percentOf(hook) {
    if (hook.status === 'queued') return 5;
    if (hook.status === 'processing') return 97;
    const elapsed = (Date.now() - new Date(hook.submittedAt ?? hook.createdAt).getTime()) / 1000;
    return Math.round(Math.min(95, 100 * (1 - Math.exp(-Math.max(0, elapsed) / TYPICAL_SECONDS))));
  }

  async function loadVideos() {
    if (state.videos) return state.videos;
    try {
      const data = await get('/creatives?kind=video&limit=100');
      state.videos = data.creatives.filter((c) => c.hasFile);
    } catch {
      state.videos = [];
    }
    return state.videos;
  }

  async function discard(hook) {
    try {
      await del(`/hooks/${hook.id}`);
      await refresh();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  function readyCard(hook) {
    const target = h('select', { class: 'input', 'aria-label': 'Aplicar o hook a qual vídeo' }, h('option', { value: '' }, 'Só guardar o hook na biblioteca'));
    loadVideos().then((videos) => {
      for (const v of videos) target.append(h('option', { value: String(v.id) }, `Juntar ao início de: ${v.name}`));
    });
    const apply = button('Aplicar', { variant: 'primary', small: true, onClick: async (e) => {
      const trigger = e.currentTarget;
      trigger.disabled = true;
      try {
        await post(`/hooks/${hook.id}/apply`, target.value ? { creativeId: Number(target.value) } : {});
        await refresh();
      } catch (err) {
        toast(err.message, 'danger');
        trigger.disabled = false;
      }
    } });
    return h(
      'div',
      { class: 'hook-item__ready' },
      h('video', { class: 'hook-item__video', src: `/api/hooks/${hook.id}/file`, controls: true, muted: true, loop: true, playsinline: true, preload: 'metadata', 'aria-label': `Prévia do hook ${hookStyleLabel(hook.style)}` }),
      h('div', { class: 'hook-item__actions' }, h('label', { class: 'field__label' }, 'Usar este hook'), target, h('div', { class: 'hook-item__buttons' }, apply, button('Descartar', { small: true, variant: 'danger-ghost', onClick: () => discard(hook) })),
        hook.applyError ? alertBox(hook.applyError, 'warning') : null,
        hook.creativeId ? h('p', { class: 'hook-item__done' }, '✓ Já aplicado: o vídeo novo está na biblioteca (pode aplicar de novo a outro vídeo).') : null),
    );
  }

  function buildCard(hook) {
    const head = h('div', { class: 'hook-item__head' }, h('strong', null, hookStyleLabel(hook.style)), badge(seconds(hook.durationMs), 'neutral'), badge('Gerado por IA', 'neutral'));
    if (hook.applying) {
      // Botão com a bolinha piscando enquanto junta; a junção roda no servidor e continua se a janela (ou o navegador) for fechada.
      const busyButton = h('button', { type: 'button', class: 'btn btn--primary btn--sm is-busy', disabled: true, 'aria-label': 'Juntando o hook ao vídeo' }, h('span', { class: 'pulse-dot', 'aria-hidden': 'true' }), 'Juntando…');
      return { element: h('article', { class: 'hook-item' }, head, h('p', { class: 'hook-item__status' }, 'Juntando o hook ao vídeo…'), h('div', { class: 'progress progress--busy', role: 'progressbar', 'aria-label': 'Aplicando o hook' }, h('div', { class: 'progress__bar progress__bar--indeterminate' })), h('div', { class: 'hook-item__buttons' }, busyButton), h('p', { class: 'muted hook-item__keep' }, 'Pode fechar esta janela ou o navegador: a junção continua no servidor e o vídeo novo aparece na biblioteca.')), bar: null };
    }
    if (hook.status === 'ready') return { element: h('article', { class: 'hook-item hook-item--ready' }, head, readyCard(hook)), bar: null };
    if (hook.status === 'failed') {
      return { element: h('article', { class: 'hook-item hook-item--failed' }, head, alertBox(hook.errorMessage ?? 'Não foi possível gerar este hook.'), h('div', { class: 'hook-item__buttons' }, button('Descartar', { small: true, onClick: () => discard(hook) }))), bar: null };
    }
    const bar = h('div', { class: 'progress__bar' });
    bar.style.width = `${percentOf(hook)}%`;
    const label = h('span', { class: 'hook-item__percent' }, `${percentOf(hook)}%`);
    return {
      element: h('article', { class: 'hook-item' }, head, h('p', { class: 'hook-item__status' }, statusText[hook.status] ?? 'Gerando…', ' ', label, h('span', { class: 'muted' }, ' · estimativa, leva de 1 a 3 minutos. Pode fechar esta janela: continua no servidor.')), h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Andamento estimado' }, bar), h('div', { class: 'hook-item__buttons' }, button('Cancelar', { small: true, variant: 'danger-ghost', onClick: () => discard(hook) }))),
      bar,
      label,
    };
  }

  const signatureOf = (hook) => `${hook.status}|${hook.applying}|${hook.applyError ?? ''}|${hook.creativeId ?? ''}|${hook.errorMessage ?? ''}`;

  function drawList() {
    const seen = new Set();
    const nodes = [];
    for (const hook of state.hooks) {
      seen.add(hook.id);
      const signature = signatureOf(hook);
      let entry = cards.get(hook.id);
      if (!entry || entry.signature !== signature) {
        entry = { ...buildCard(hook), signature };
        cards.set(hook.id, entry);
      } else if (entry.bar) { // só atualiza a barra (o resto do cartão fica como está)
        const percent = percentOf(hook);
        entry.bar.style.width = `${percent}%`;
        if (entry.label) entry.label.textContent = `${percent}%`;
      }
      nodes.push(entry.element);
    }
    for (const id of [...cards.keys()]) if (!seen.has(id)) cards.delete(id);
    setChildren(list, nodes.length ? nodes : h('p', { class: 'muted hook__empty' }, 'Os hooks que você gerar aparecem aqui, com prévia.'));
  }

  function drawUsage() {
    const { usedLast24h, dailyLimit } = state.info;
    usageLine.textContent = `Hoje: ${usedLast24h} de ${dailyLimit} hooks usados nas últimas 24 horas. Cada hook é gerado por IA (Kling) e pode levar de 1 a 3 minutos.`;
  }

  async function refresh() {
    if (closed) return;
    const data = await get('/hooks');
    if (closed) return;
    const before = new Map(state.hooks.map((x) => [x.id, x]));
    state.info = data;
    state.hooks = data.hooks;
    for (const hook of state.hooks) {
      const old = before.get(hook.id);
      if (old?.applying && !hook.applying) {
        if (hook.applyError) toast(hook.applyError, 'danger');
        else if (hook.creativeId) {
          createdAny = true;
          toast('Pronto! O vídeo com o hook já está na sua biblioteca.');
        }
      }
    }
    drawUsage();
    drawList();
    const busy = state.hooks.some((x) => isActive(x) || x.applying);
    if (busy && !timer) timer = setInterval(() => refresh().catch(() => {}), POLL_MS);
    if (!busy && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function start() {
    try {
      await refresh();
    } catch (err) {
      setChildren(body, alertBox(err.message || 'Não foi possível abrir o Hook com IA.'), h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() })));
      return;
    }
    if (!state.info.enabled) {
      setChildren(body, alertBox('O Hook com IA ainda não foi ligado neste servidor (falta a chave da Kling). Avise o administrador do sistema.', 'warning'), h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() })));
      return;
    }
    drawStyles();
    drawOptions();
    setChildren(
      body,
      h('p', { class: 'hook__intro' }, 'Crie um começo de 2 a 3 segundos, fora do padrão, que prende a atenção, e junte ao início de um dos seus vídeos. O vídeo original não é alterado: o resultado é um vídeo novo, marcado como “gerado por IA”.'),
      form,
      h('h3', { class: 'hook__subtitle' }, 'Seus hooks'),
      list,
      h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.requestClose() })),
    );
  }
  start();
}
