import { PIXEL_EVENTS, PIXEL_EVENT_NAME_MAX } from '/shared/pixel-events.js';
import { post } from '../../api.js';
import { h } from '../../dom.js';
import { alertBox, button, field, openModal, toast } from '../../ui.js';

/**
 * Pop-up "Criar evento no pixel": cria um evento padrão (Compra, Início de pedido…) no pixel da conta pela API do TikTok, para a campanha poder otimizar por
 * ele (o TikTok recusa o grupo de anúncios se o evento não existir no pixel). Só lista os eventos que o pixel ainda NÃO tem. Todo texto entra como texto.
 *  - advertiser: { id, name }; pixel: { id, name }; suggested: evento escolhido na campanha (já vem marcado); existing: Set com os eventos que o pixel já tem
 *  - onCreated(): chamado depois de criar (a lista de pixels é recarregada)
 */
export function openPixelEventDialog({ advertiser, pixel, suggested = null, existing = new Set(), onCreated }) {
  const available = PIXEL_EVENTS.filter(([value]) => !existing.has(value));
  const errorSlot = h('div');
  if (!available.length) {
    const modal = openModal({
      title: 'Criar evento no pixel',
      body: h('div', { class: 'modal__body' }, alertBox('Este pixel já tem todos os eventos padrão.', 'info'), h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() }))),
    });
    return modal;
  }
  const type = field('Evento', { as: 'select', options: available.map(([value, label, name]) => [value, `${label} (${name})`]), value: available.some(([v]) => v === suggested) ? suggested : available[0][0] }, { hint: 'É a ação do seu site que a campanha vai otimizar (ex.: Compra).' });
  const name = field('Nome do evento (opcional)', { type: 'text', maxlength: PIXEL_EVENT_NAME_MAX, autocomplete: 'off', placeholder: 'Ex.: Compra no site' }, { hint: 'Só para você se organizar no Gerenciador de Eventos. Em branco, o TikTok usa o nome padrão.' });
  const submit = button('Criar evento', { variant: 'primary', type: 'submit' });
  const modal = openModal({
    title: 'Criar evento no pixel',
    body: h(
      'form',
      {
        class: 'form modal__body',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          errorSlot.replaceChildren();
          submit.disabled = true;
          submit.textContent = 'Criando…';
          try {
            const value = name.control.value.replace(/\s+/g, ' ').trim();
            await post(`/tiktok/advertisers/${encodeURIComponent(advertiser.id)}/pixel-events`, { pixelId: pixel.id, eventType: type.control.value, ...(value ? { name: value } : {}) });
            toast('Evento criado no pixel. O TikTok pode levar de 2 a 4 horas para listá-lo como recebido; ele já existe para a campanha.');
            modal.close();
            onCreated?.();
          } catch (err) {
            errorSlot.replaceChildren(alertBox(err.message));
            submit.disabled = false;
            submit.textContent = 'Criar evento';
          }
        },
      },
      errorSlot,
      h('p', { class: 'muted' }, `Pixel: ${pixel.name || 'Pixel sem nome'} (ID ${pixel.id}) · conta ${advertiser.name}. Isto cria o evento no pixel; para ele contar conversões, o seu site precisa enviá-lo (pelo código do pixel ou pela API de Eventos).`),
      type.element,
      name.element,
      h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
    ),
  });
  type.control.focus();
  return modal;
}
