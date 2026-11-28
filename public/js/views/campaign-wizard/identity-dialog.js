import { IDENTITY_NAME_MAX, IDENTITY_PHOTO_MIN_SIDE } from '/shared/identity.js';
import { uploadFile } from '../../api.js';
import { h } from '../../dom.js';
import { alertBox, button, field, openModal } from '../../ui.js';

const MAX_SOURCE_BYTES = 15 * 1024 * 1024; // foto escolhida (antes de recortar): só para não travar o navegador
const OUTPUT_SIDE = 640; // a foto enviada ao TikTok é quadrada, no máximo 640 × 640

/** Texto de erro de uma foto que não deu para usar. */
class PhotoError extends Error {}

/**
 * Recorta o CENTRO da imagem em formato quadrado (1:1, como o TikTok exige para a foto da identidade) e devolve um JPEG.
 * Tudo acontece no navegador: a imagem original nunca sai do computador.
 * @param {File} file JPG, PNG ou WebP
 * @returns {Promise<{ blob: Blob, canvas: HTMLCanvasElement }>}
 */
export async function squarePhoto(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new PhotoError('Use uma foto JPG, PNG ou WebP.');
  if (file.size > MAX_SOURCE_BYTES) throw new PhotoError('A foto é grande demais (máximo 15 MB).');
  if (typeof createImageBitmap !== 'function') throw new PhotoError('Este navegador não consegue preparar a foto. Atualize o navegador.');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PhotoError('Não consegui abrir esta imagem. Tente outra foto.');
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side < IDENTITY_PHOTO_MIN_SIDE) throw new PhotoError(`A foto é pequena demais (use pelo menos ${IDENTITY_PHOTO_MIN_SIDE} × ${IDENTITY_PHOTO_MIN_SIDE} pixels).`);
    const out = Math.min(side, OUTPUT_SIDE);
    const canvas = h('canvas', { width: String(out), height: String(out) });
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; // PNG com transparência vira JPEG: o fundo transparente ficaria preto
    context.fillRect(0, 0, out, out);
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new PhotoError('Não consegui preparar a foto. Tente outra.');
    return { blob, canvas };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Pop-up "Criar identidade personalizada": nome + foto (opcional). Cria a identidade na conta de anúncio, no TikTok, e chama
 * `onCreated({ id, name })`. O nome entra sempre como texto (nunca HTML).
 *  - advertiser: { id, name } conta de anúncio onde a identidade será criada
 */
export function openIdentityDialog({ advertiser, onCreated }) {
  const name = field('Nome da identidade', { type: 'text', required: true, maxlength: IDENTITY_NAME_MAX, autocomplete: 'off', placeholder: 'Ex.: Dona Now' }, { hint: 'É o nome que aparece acima do anúncio, no lugar do nome de uma conta do TikTok.' });
  const errorSlot = h('div');
  let photo = null; // { blob, canvas } depois de escolher uma foto

  const preview = h('div', { class: 'identity-photo__preview', 'aria-live': 'polite' }, h('span', { class: 'muted' }, 'Sem foto'));
  const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', class: 'visually-hidden', id: 'identity-photo-input', 'aria-label': 'Foto da identidade' });
  const choose = h('label', { class: 'btn btn--secondary btn--sm', for: 'identity-photo-input' }, 'Escolher foto');
  const remove = button('Remover foto', { small: true, onClick: () => setPhoto(null) });
  remove.hidden = true;

  function setPhoto(next) {
    photo = next;
    remove.hidden = !next;
    if (next) {
      next.canvas.className = 'identity-photo__canvas';
      next.canvas.setAttribute('role', 'img');
      next.canvas.setAttribute('aria-label', 'Prévia da foto recortada em quadrado');
      preview.replaceChildren(next.canvas);
    } else {
      fileInput.value = '';
      preview.replaceChildren(h('span', { class: 'muted' }, 'Sem foto'));
    }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    errorSlot.replaceChildren();
    try {
      setPhoto(await squarePhoto(file));
    } catch (err) {
      setPhoto(null);
      errorSlot.replaceChildren(alertBox(err instanceof PhotoError ? err.message : 'Não consegui preparar a foto. Tente outra.'));
    }
  });

  const submit = button('Criar identidade', { variant: 'primary', type: 'submit' });
  const modal = openModal({
    title: 'Criar identidade personalizada',
    body: h(
      'form',
      {
        class: 'form modal__body',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          const value = name.control.value.replace(/\s+/g, ' ').trim();
          if (!value) return errorSlot.replaceChildren(alertBox('Informe o nome da identidade.'));
          errorSlot.replaceChildren();
          submit.disabled = true;
          submit.textContent = 'Criando…';
          try {
            const path = `/tiktok/advertisers/${encodeURIComponent(advertiser.id)}/identities?name=${encodeURIComponent(value)}`;
            // Com foto, o corpo é a imagem (JPEG quadrado); sem foto, um corpo JSON vazio: o TikTok usa uma imagem padrão.
            const body = photo ? photo.blob : new Blob(['{}'], { type: 'application/json' });
            const { identity } = await uploadFile(path, body).promise;
            modal.close();
            onCreated(identity);
          } catch (err) {
            errorSlot.replaceChildren(alertBox(err.message));
            submit.disabled = false;
            submit.textContent = 'Criar identidade';
          }
          return undefined;
        },
      },
      errorSlot,
      h('p', { class: 'muted' }, `Conta de anúncio: ${advertiser.name}. Uma identidade personalizada é só um nome e uma foto: não precisa de conta do TikTok.`),
      name.element,
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field__label' }, 'Foto (opcional)'),
        h('div', { class: 'identity-photo' }, preview, h('div', { class: 'identity-photo__actions' }, choose, fileInput, remove)),
        h('p', { class: 'field__hint' }, 'JPG, PNG ou WebP. Recortamos o centro em formato quadrado (1:1), como o TikTok exige. Sem foto, o TikTok usa uma imagem padrão.'),
      ),
      h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
    ),
  });
  name.control.focus();
  return modal;
}
