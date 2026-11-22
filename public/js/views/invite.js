import { AREAS } from '/shared/permissions.js';
import { post } from '../api.js';
import { h } from '../dom.js';
import { setSession } from '../state.js';
import { alertBox, badge, button, field, spinner } from '../ui.js';
import { authShell } from './auth-shell.js';

const AREA_LABEL = Object.fromEntries(AREAS.map((a) => [a.id, a.label]));
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Tela pública de aceite do convite. O token vem no fragmento do link (#…), que o navegador nunca envia a servidor algum;
 * daqui ele segue só no corpo (POST) das chamadas. A pessoa define a PRÓPRIA senha e já entra.
 */
export function inviteView(ctx) {
  const token = location.hash.slice(1);
  const card = h('div', null, spinner());
  const shell = authShell(card);

  const invalid = (message) =>
    card.replaceChildren(
      h('h1', { class: 'auth__title' }, 'Convite indisponível'),
      alertBox(message ?? 'Convite inválido ou expirado. Peça um novo convite a quem convidou você.'),
      h('p', { class: 'auth__switch' }, h('a', { href: '/login', 'data-link': true }, 'Ir para o login')),
    );

  function form(invitation) {
    const name = field('Seu nome', { name: 'name', value: invitation.name, required: true, maxlength: 80, autocomplete: 'name' });
    const password = field('Crie uma senha', { type: 'password', name: 'password', required: true, minlength: 10, maxlength: 128, autocomplete: 'new-password' }, { hint: 'Mínimo de 10 caracteres. É só sua: ninguém mais precisa saber.' });
    const confirm = field('Repita a senha', { type: 'password', name: 'confirm', required: true, maxlength: 128, autocomplete: 'new-password' });
    const errorSlot = h('div');
    const submit = button('Criar minha conta e entrar', { variant: 'primary', type: 'submit' });
    submit.classList.add('btn--block');
    return h(
      'form',
      {
        class: 'form',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          errorSlot.replaceChildren();
          if (password.control.value.length < 10) return errorSlot.replaceChildren(alertBox('A senha deve ter pelo menos 10 caracteres.'));
          if (password.control.value !== confirm.control.value) return errorSlot.replaceChildren(alertBox('As senhas não conferem.'));
          submit.disabled = true;
          try {
            const data = await post('/invitations/accept', { token, name: name.control.value, password: password.control.value });
            password.control.value = '';
            confirm.control.value = '';
            setSession(data);
            history.replaceState({}, '', '/invite'); // tira o token do endereço
            await ctx.navigate('/', { replace: true });
          } catch (err) {
            errorSlot.replaceChildren(alertBox(err.message));
            submit.disabled = false;
          }
          return undefined;
        },
      },
      errorSlot,
      h('p', { class: 'muted' }, 'E-mail de acesso: ', h('strong', null, invitation.email)),
      name.element,
      password.element,
      confirm.element,
      submit,
    );
  }

  if (!TOKEN_RE.test(token)) {
    invalid();
    return shell;
  }
  post('/invitations/lookup', { token })
    .then(({ invitation }) =>
      card.replaceChildren(
        h('h1', { class: 'auth__title' }, 'Você foi convidado(a)'),
        h('p', { class: 'muted' }, h('strong', null, invitation.ownerName), ' convidou você para trabalhar no TikTok Ads Manager, com acesso a:'),
        h('p', { class: 'team__areas' }, invitation.areas.map((id) => badge(AREA_LABEL[id] ?? id, 'success'))),
        form(invitation),
        h('p', { class: 'auth__switch' }, 'Já tem uma conta? ', h('a', { href: '/login', 'data-link': true }, 'Entrar')),
      ),
    )
    .catch((err) => invalid(err.status === 404 || err.status === 400 ? undefined : err.message));
  return shell;
}
