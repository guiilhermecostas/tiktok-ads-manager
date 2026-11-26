import { AREAS } from '../../../shared/permissions.js';

const APP_NAME = 'TikTok Ads Manager';

/** Todo texto dinâmico entra escapado: nome de quem convida ou de quem é convidado nunca vira HTML. */
export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const areaLabels = (areas) => AREAS.filter((a) => areas.includes(a.id)).map((a) => a.label);
const oneLine = (value) => String(value ?? '').replace(/[\r\n\0]+/g, ' ').trim();

/**
 * E-mail de convite. `link` já vem pronto do servidor (APP_URL + token no fragmento "#", que o navegador não envia a ninguém).
 * Devolve { subject, html, text }.
 */
export function inviteEmail({ ownerName, inviteeName, areas, link, expiresInDays }) {
  const owner = oneLine(ownerName);
  const invitee = oneLine(inviteeName);
  const labels = areaLabels(areas);
  const subject = `${owner} convidou você para o ${APP_NAME}`.slice(0, 150);
  const text = [
    `Olá, ${invitee}!`,
    '',
    `${owner} convidou você para trabalhar no ${APP_NAME}, com acesso a: ${labels.join(', ')}.`,
    '',
    'Para aceitar, abra o link abaixo, defina a sua senha e entre:',
    link,
    '',
    `O link vale por ${expiresInDays} dias e só pode ser usado uma vez. Você usa o seu próprio e-mail e a sua senha: ninguém precisa compartilhar login com você.`,
    'Se você não esperava este convite, ignore este e-mail.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px;">
      <tr><td style="font-size:18px;font-weight:700;padding-bottom:12px;">${escapeHtml(APP_NAME)}</td></tr>
      <tr><td style="font-size:15px;line-height:1.55;padding-bottom:12px;">Olá, ${escapeHtml(invitee)}!</td></tr>
      <tr><td style="font-size:15px;line-height:1.55;padding-bottom:12px;"><strong>${escapeHtml(owner)}</strong> convidou você para trabalhar no ${escapeHtml(APP_NAME)}, com acesso a: <strong>${escapeHtml(labels.join(', '))}</strong>.</td></tr>
      <tr><td style="padding:8px 0 18px;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;">Aceitar convite e criar minha senha</a></td></tr>
      <tr><td style="font-size:13px;line-height:1.5;color:#555;">O link vale por ${escapeHtml(expiresInDays)} dias e só pode ser usado uma vez. Você entra com o seu próprio e-mail e a sua senha: ninguém precisa compartilhar login com você.</td></tr>
      <tr><td style="font-size:12px;line-height:1.5;color:#888;padding-top:14px;">Se o botão não funcionar, copie este endereço no navegador:<br>${escapeHtml(link)}</td></tr>
      <tr><td style="font-size:12px;color:#888;padding-top:14px;">Se você não esperava este convite, ignore este e-mail.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html, text };
}

/**
 * E-mail com o código de 6 dígitos que confirma o e-mail no cadastro. O nome entra escapado; o código é só dígitos (gerado pelo servidor).
 * Devolve { subject, html, text }.
 */
export function verificationEmail({ name, code, expiresInMinutes }) {
  const person = oneLine(name);
  const subject = `${code} é o seu código de verificação`;
  const text = [
    `Olá, ${person}!`,
    '',
    `Seu código para confirmar o e-mail no ${APP_NAME} é:`,
    '',
    code,
    '',
    `Ele vale por ${expiresInMinutes} minutos. Digite-o na tela de cadastro para concluir a criação da conta.`,
    'Se você não pediu este código, ignore este e-mail: nenhuma conta será criada.',
    'Nunca compartilhe este código com ninguém.',
  ].join('\n');
  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:28px;">
      <tr><td style="font-size:18px;font-weight:700;padding-bottom:12px;">${escapeHtml(APP_NAME)}</td></tr>
      <tr><td style="font-size:15px;line-height:1.55;padding-bottom:12px;">Olá, ${escapeHtml(person)}! Use este código para confirmar o seu e-mail:</td></tr>
      <tr><td align="center" style="padding:8px 0 18px;"><div style="display:inline-block;background:#f4f4f5;border-radius:10px;padding:14px 26px;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace;">${escapeHtml(code)}</div></td></tr>
      <tr><td style="font-size:13px;line-height:1.5;color:#555;">O código vale por ${escapeHtml(expiresInMinutes)} minutos. Digite-o na tela de cadastro para concluir a criação da conta. Nunca compartilhe este código com ninguém.</td></tr>
      <tr><td style="font-size:12px;color:#888;padding-top:14px;">Se você não pediu este código, ignore este e-mail: nenhuma conta será criada.</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  return { subject, html, text };
}
