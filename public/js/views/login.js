import { post } from '../api.js';
import { h } from '../dom.js';
import { setSession } from '../state.js';
import { alertBox, button, field } from '../ui.js';
import { authShell } from './auth-shell.js';

export function loginView(ctx) {
  const email = field('E-mail', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: 254, autofocus: true });
  const password = field('Senha', { type: 'password', name: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
  const errorSlot = h('div');
  const submit = button('Entrar', { variant: 'primary', type: 'submit' });
  submit.classList.add('btn--block');

  const form = h(
    'form',
    {
      class: 'form',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        errorSlot.replaceChildren();
        submit.disabled = true;
        try {
          const data = await post('/auth/login', { email: email.control.value, password: password.control.value });
          setSession(data);
          password.control.value = '';
          await ctx.navigate('/', { replace: true });
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
          password.control.value = '';
          password.control.focus();
        } finally {
          submit.disabled = false;
        }
      },
    },
    errorSlot,
    email.element,
    password.element,
    submit,
  );

  return authShell(
    h('h1', { class: 'auth__title' }, 'Entrar'),
    h('p', { class: 'muted' }, 'Acesse o painel com seu e-mail e senha.'),
    form,
    h('p', { class: 'auth__switch' }, 'Ainda não tem conta? ', h('a', { href: '/register', 'data-link': true }, 'Criar conta')),
  );
}
