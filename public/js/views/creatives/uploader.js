import { uploadFile } from '../../api.js';
import { h } from '../../dom.js';
import { formatBytes } from '../../format.js';
import { button, toast } from '../../ui.js';

/** Tipos aceitos (o servidor confere o CONTEÚDO de verdade; aqui é só para avisar cedo). */
export const ACCEPT = 'image/jpeg,image/png,video/mp4,video/quicktime,.jpg,.jpeg,.png,.mp4,.mov';
const KIND_BY_TYPE = { 'image/jpeg': 'image', 'image/png': 'image', 'video/mp4': 'video', 'video/quicktime': 'video' };
const MAX_PARALLEL = 2;

/** Mensagem curta para o tamanho máximo, ex.: "10 MB". */
const limitText = (bytes) => formatBytes(bytes);

/** Confere tipo e tamanho antes de gastar banda. Retorna a mensagem de erro ou null. */
function validate(file, limits) {
  const kind = KIND_BY_TYPE[file.type];
  if (!kind) return 'Tipo não suportado. Use JPG, PNG, MP4 ou MOV.';
  if (file.size === 0) return 'O arquivo está vazio.';
  const max = kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes;
  if (max && file.size > max) return `Arquivo maior que o limite de ${limitText(max)} para ${kind === 'video' ? 'vídeos' : 'imagens'}.`;
  return null;
}

/**
 * Fila de envios com barra de progresso (até 2 em paralelo).
 * `getLimits()` devolve os limites atuais; `onUploaded(creative)` é chamado a cada envio concluído.
 * Retorna { element, add(files), pending() }.
 */
export function createUploader({ getLimits, onUploaded }) {
  const list = h('ul', { class: 'uploads__list' });
  const panel = h('div', { class: 'uploads', hidden: true, 'aria-live': 'polite' }, list);
  const queue = [];
  let running = 0;

  const refreshVisibility = () => {
    panel.hidden = list.children.length === 0;
  };

  function makeItem(file) {
    const bar = h('div', { class: 'progress__bar' });
    const status = h('span', { class: 'uploads__status' }, 'Na fila');
    const cancel = h('button', { type: 'button', class: 'link-btn' }, 'Cancelar');
    const li = h('li', { class: 'uploads__item' }, h('div', { class: 'uploads__row' }, h('span', { class: 'uploads__name' }, file.name), h('span', { class: 'muted' }, formatBytes(file.size)), status, cancel), h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Envio de ${file.name}` }, bar));
    return { li, bar, status, cancel };
  }

  function finish(item, ok, message) {
    item.cancel.remove();
    if (!ok) item.li.querySelector('.progress')?.remove(); // erro: a barra não faz mais sentido
    item.li.classList.add(ok ? 'is-done' : 'is-error');
    item.status.textContent = message;
    if (ok) setTimeout(() => { item.li.remove(); refreshVisibility(); }, 4000);
    else item.li.append(h('button', { type: 'button', class: 'link-btn', onClick: () => { item.li.remove(); refreshVisibility(); } }, 'Dispensar'));
  }

  async function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const { file, item } = queue.shift();
      running += 1;
      item.status.textContent = 'Enviando…';
      const upload = uploadFile(`/creatives?filename=${encodeURIComponent(file.name)}`, file, {
        onProgress: (fraction) => {
          const percent = Math.round(fraction * 100);
          item.bar.style.width = `${percent}%`;
          item.status.textContent = `Enviando… ${percent}%`;
        },
      });
      item.cancel.onclick = () => upload.abort();
      upload.promise
        .then(({ creative }) => {
          item.bar.style.width = '100%';
          finish(item, true, 'Concluído');
          onUploaded(creative);
        })
        .catch((err) => finish(item, false, err.code === 'aborted' ? 'Cancelado' : err.message))
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  return {
    element: panel,
    pending: () => running + queue.length,
    add(files) {
      const limits = getLimits();
      let accepted = 0;
      for (const file of files) {
        const item = makeItem(file);
        list.append(item.li);
        const problem = validate(file, limits);
        if (problem) {
          item.bar.parentElement.remove();
          finish(item, false, problem);
          continue;
        }
        queue.push({ file, item });
        accepted += 1;
      }
      refreshVisibility();
      if (!accepted && files.length) toast('Nenhum arquivo válido para enviar.', 'danger');
      pump();
    },
  };
}

/** Botão "Enviar arquivos" com seletor de arquivos escondido. */
export function uploadButton(uploader, { label = 'Enviar arquivos', variant = 'primary' } = {}) {
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    uploader.add([...input.files]);
    input.value = '';
  });
  const trigger = button(label, { variant, onClick: () => input.click() });
  return h('span', null, trigger, input);
}
