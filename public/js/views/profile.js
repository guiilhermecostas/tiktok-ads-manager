import { del, get, patch, uploadFile } from '../api.js';
import { h, setChildren } from '../dom.js';
import { setSession, state } from '../state.js';
import { alertBox, button, confirmDialog, field, openModal, spinner, toast } from '../ui.js';
import { avatarEl, syncAccountUi } from './avatar.js';
import { createPhotoEditor } from './photo-editor.js';
import { levelPanel } from './profile-level.js';
import { subTabs } from './subtabs.js';

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SOURCE_BYTES = 25 * 1024 * 1024; // só para não abrir arquivos absurdos no navegador; o envio é o recorte (~50 KB)

/**
 * "Minha conta": cabeçalho com foto, nome e acesso; abaixo, duas abas — "Meu nível" (barra de gasto em anúncios com 13 níveis, só para o
 * dono da conta) e "Meus dados" (foto com editor de recorte e nome). A foto aparece no menu e para a equipe.
 */
export function openProfile() {
  const body = h('div', { class: 'profile' });
  let editor = null;
  let tab = null; // aba aberta (lembrada ao voltar do editor de foto)
  let levelData; // undefined = ainda não pediu, null = sem nível para esta pessoa, objeto = nível carregado
  let levelError = null;
  const showsLevel = () => Boolean(state.workspace?.isOwner) && state.user.role !== 'admin'; // colaborador não vê o gasto do dono; admin não anuncia

  const roleText = () => {
    if (!state.workspace?.isOwner) return `Colaborador · equipe de ${state.workspace?.ownerName ?? '—'}`;
    return state.user.role === 'admin' ? 'Administrador' : 'Titular da conta';
  };

  /** Relê a sessão (nome e versão da foto) e atualiza o menu sem recarregar a página. */
  async function refresh() {
    setSession(await get('/auth/me'));
    syncAccountUi();
  }

  // ---------- tela principal ----------
  function showMain() {
    editor?.destroy();
    editor = null;
    const user = state.user;
    const errorSlot = h('div');
    const fileInput = h('input', { type: 'file', accept: ACCEPTED_TYPES.join(','), class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (file) openEditor(file, errorSlot);
    });

    const name = field('Seu nome', { type: 'text', name: 'name', value: user.name, required: true, maxlength: 80, autocomplete: 'name' });
    const saveName = button('Salvar nome', { small: true, type: 'submit' });
    const nameForm = h('form', { class: 'profile__name', novalidate: true, onSubmit: async (event) => {
      event.preventDefault();
      if (name.control.value.trim() === user.name) return;
      saveName.disabled = true;
      try {
        await patch('/profile', { name: name.control.value });
        await refresh();
        toast('Nome atualizado.');
        showMain();
      } catch (err) {
        errorSlot.replaceChildren(alertBox(err.message));
        saveName.disabled = false;
      }
    } }, name.element, saveName);

    const panel = h('div', { class: 'profile__panel', role: 'tabpanel' });
    const header = h(
      'header',
      { class: 'profile__hero' },
      avatarEl(user, { size: 'lg' }),
      h('div', { class: 'profile__who' }, h('strong', { class: 'profile__name-text' }, user.name), h('span', { class: 'profile__email' }, user.email), h('span', { class: 'badge badge--neutral profile__role' }, roleText())),
    );

    const dataTab = () => h(
      'div',
      { class: 'profile__section' },
      h(
        'div',
        { class: 'profile__photo' },
        h(
          'div',
          { class: 'profile__photo-actions' },
          h('strong', { class: 'profile__label' }, 'Sua foto'),
          h('div', { class: 'profile__buttons' }, button(user.avatarVersion ? 'Trocar foto' : 'Escolher foto', { variant: 'primary', small: true, onClick: () => fileInput.click() }), user.avatarVersion ? button('Remover foto', { variant: 'danger-ghost', small: true, onClick: () => removePhoto(errorSlot) }) : null),
          fileInput,
          h('p', { class: 'field__hint' }, 'JPG, PNG ou WebP. Você ajusta o recorte antes de salvar. Sua equipe vê esta foto.'),
        ),
      ),
      h('div', { class: 'profile__block' }, h('strong', { class: 'profile__label' }, 'Seu nome'), nameForm),
    );

    const draw = () => {
      if (tab === 'level') setChildren(panel, levelContent());
      else setChildren(panel, dataTab());
    };

    function levelContent() {
      if (levelError) return h('div', null, alertBox(levelError), button('Tentar de novo', { small: true, onClick: () => { levelError = null; levelData = undefined; draw(); loadLevel(); } }));
      if (levelData === undefined) return spinner('Calculando seu nível…');
      if (levelData === null) return h('p', { class: 'field__hint' }, 'O nível de gasto aparece para o titular da conta.');
      return levelPanel(levelData, { userId: user.id });
    }

    async function loadLevel() {
      if (levelData !== undefined) return;
      try {
        levelData = (await get('/profile/level')).level;
      } catch (err) {
        levelError = err.message;
      }
      if (body.isConnected && tab === 'level') draw();
    }

    let tabs = null;
    if (showsLevel()) {
      tab ??= 'level';
      tabs = subTabs({ items: [{ id: 'level', label: 'Meu nível' }, { id: 'data', label: 'Meus dados' }], active: tab, label: 'Minha conta', onChange: (id) => { tab = id; draw(); if (id === 'level') loadLevel(); } });
    } else {
      tab = 'data';
    }

    setChildren(body, errorSlot, header, tabs?.element, panel);
    draw();
    if (tab === 'level') loadLevel();
  }

  // ---------- escolher e ajustar ----------
  async function openEditor(file, errorSlot) {
    errorSlot.replaceChildren();
    if (!ACCEPTED_TYPES.includes(file.type)) return errorSlot.replaceChildren(alertBox('Use uma foto JPG, PNG ou WebP.'));
    if (file.size > MAX_SOURCE_BYTES) return errorSlot.replaceChildren(alertBox('Essa imagem é grande demais (máximo de 25 MB).'));
    let bitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); // respeita a rotação da câmera
    } catch {
      return errorSlot.replaceChildren(alertBox('Não foi possível abrir esta imagem. Tente outra foto.'));
    }
    editor = createPhotoEditor(bitmap);
    const message = h('div');
    const save = button('Salvar foto', { variant: 'primary', type: 'button' });
    const cancel = button('Cancelar', { onClick: showMain });
    save.addEventListener('click', async () => {
      message.replaceChildren();
      save.disabled = true;
      cancel.disabled = true;
      save.textContent = 'Enviando…';
      try {
        const blob = await editor.toBlob();
        if (!blob) throw new Error('Não foi possível preparar a imagem. Tente outra foto.');
        await uploadFile('/profile/avatar', blob).promise;
        await refresh();
        toast('Foto atualizada.');
        showMain();
      } catch (err) {
        message.replaceChildren(alertBox(err.message));
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = 'Salvar foto';
      }
    });
    setChildren(body, h('h3', { class: 'profile__subtitle' }, 'Ajuste sua foto'), message, editor.element, h('div', { class: 'modal__actions' }, cancel, save));
    return undefined;
  }

  async function removePhoto(errorSlot) {
    const ok = await confirmDialog({ title: 'Remover foto', message: 'Sua foto será apagada e voltam as suas iniciais. Você pode escolher outra quando quiser.', confirmLabel: 'Remover', danger: true });
    if (!ok) return;
    try {
      await del('/profile/avatar');
      await refresh();
      toast('Foto removida.');
      showMain();
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    }
  }

  showMain();
  const modal = openModal({ title: 'Minha conta', body: h('div', { class: 'modal__body' }, body), size: 'md', onClose: () => editor?.destroy(), dismissOnOverlay: false });
  return modal;
}
