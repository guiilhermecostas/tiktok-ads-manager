/**
 * Notificações (o sino do topo): regras e rótulos usados pelo servidor (validação do que o admin envia) e pela tela (formulário, cores,
 * textos), para os dois nunca divergirem. Módulo isomórfico: não depende de Node nem do DOM.
 */
export const NOTIFICATION_LEVELS = Object.freeze({
  info: { label: 'Aviso', tone: 'neutral' },
  success: { label: 'Novidade', tone: 'success' },
  warning: { label: 'Atenção', tone: 'warning' },
  danger: { label: 'Urgente', tone: 'danger' },
});
export const NOTIFICATION_LEVEL_IDS = Object.freeze(Object.keys(NOTIFICATION_LEVELS));
export const NOTIFICATION_AUDIENCES = Object.freeze({ all: 'Todos os usuários', user: 'Uma pessoa' });

export const TITLE_MAX = 80;
export const BODY_MAX = 600;
export const LINK_MAX = 100;
/** Só endereços INTERNOS do sistema ("/manager", "/balance/accounts"): nunca um site externo nem "//outro-site". */
export const LINK_RE = /^\/(?!\/)[a-z0-9_/-]{0,99}$/;
/** Validade: por quantos dias a notificação continua aparecendo (null = sem prazo). */
export const EXPIRY_DAYS = Object.freeze([1, 3, 7, 30, 90]);
/** Quantas notificações a pessoa vê no sino e o teto do número no selo. */
export const BELL_LIMIT = 30;
export const BADGE_MAX = 99;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // permite quebra de linha (\n) e tabulação no texto da mensagem

const clean = (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '');

/**
 * Valida o que o admin enviou. Devolve `{ value, errors }`; `errors`: [{ path, message }]. Só campos conhecidos; textos aparados.
 * `value`: { title, body, level, audience, userId, link, expiresInDays }.
 */
export function validateNotificationInput(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const errors = [];
  const fail = (path, message) => errors.push({ path, message });

  const title = clean(input.title).replace(/\s+/g, ' ');
  if (!title || title.length > TITLE_MAX) fail('title', `Escreva um título de até ${TITLE_MAX} caracteres.`);
  else if (CONTROL_RE.test(title)) fail('title', 'O título tem caracteres inválidos.');

  const body = clean(input.body);
  if (!body || body.length > BODY_MAX) fail('body', `Escreva a mensagem (até ${BODY_MAX} caracteres).`);
  else if (CONTROL_RE.test(body)) fail('body', 'A mensagem tem caracteres inválidos.');

  const level = input.level ?? 'info';
  if (!NOTIFICATION_LEVEL_IDS.includes(level)) fail('level', 'Escolha o tipo da notificação.');

  const audience = input.audience ?? 'all';
  if (!Object.keys(NOTIFICATION_AUDIENCES).includes(audience)) fail('audience', 'Escolha quem recebe.');
  let userId = null;
  if (audience === 'user') {
    if (Number.isSafeInteger(input.userId) && input.userId > 0 && input.userId <= 2_147_483_647) userId = input.userId;
    else fail('userId', 'Escolha a pessoa que vai receber.');
  } else if (input.userId !== undefined && input.userId !== null) {
    fail('userId', 'Não informe a pessoa quando a notificação é para todos.');
  }

  let link = null;
  const rawLink = typeof input.link === 'string' ? input.link.trim() : '';
  if (rawLink) {
    if (rawLink.length > LINK_MAX || !LINK_RE.test(rawLink)) fail('link', 'Use um endereço interno do sistema, como /manager ou /balance.');
    else link = rawLink;
  } else if (input.link !== undefined && input.link !== null && typeof input.link !== 'string') {
    fail('link', 'Endereço inválido.');
  }

  let expiresInDays = null;
  if (input.expiresInDays !== undefined && input.expiresInDays !== null && input.expiresInDays !== '') {
    if (EXPIRY_DAYS.includes(input.expiresInDays)) expiresInDays = input.expiresInDays;
    else fail('expiresInDays', 'Escolha uma validade da lista.');
  }

  return { value: errors.length ? null : { title, body, level, audience, userId, link, expiresInDays }, errors };
}

/** Número do selo do sino: "99+" a partir de 100. */
export const badgeText = (count) => (count > BADGE_MAX ? `${BADGE_MAX}+` : String(count));
