/**
 * Identidade do anúncio (quem aparece como autor): regras compartilhadas entre o servidor e a tela.
 * A "identidade personalizada" (`CUSTOMIZED_USER`) é só um nome e uma foto, criada na conta de anúncio pelo `/identity/create/` do TikTok.
 */

/** Tipos que o TikTok sabe LISTAR por conta de anúncio (`/identity/get/`). O código de autorização (`AUTH_CODE`) não é listado. */
export const LISTABLE_IDENTITY_TYPES = Object.freeze(['CUSTOMIZED_USER', 'TT_USER', 'BC_AUTH_TT']);
/** Nome da identidade personalizada: de 1 a 100 caracteres (limite do TikTok). */
export const IDENTITY_NAME_MAX = 100;
/** Foto da identidade: JPG ou PNG, quadrada (1:1, exigência do TikTok), de até 2 MB; lado mínimo em pixels. */
export const IDENTITY_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const IDENTITY_PHOTO_MIN_SIDE = 100;
