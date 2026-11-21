import { post } from '../api.js';
import { h } from '../dom.js';
import { alertBox, button, field } from '../ui.js';
import { authShell } from './auth-shell.js';

export function registerView() {
  const name = field('Nome completo', { type: 'text', name: 'name', autocomplete: 'name', required: true, maxlength: 80, autofocus: true });
  const company = field('Empresa (opcional)', { type: 'text', name: 'company', autocomplete: 'organization', maxlength: 100 });
  const email = field('E-mail', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const password = field('Senha', { type: 'password', name: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 128 }, { hint: 'Mínimo de 10 caracteres.' });
  const confirm = field('Confirmar senha', { type: 'password', name: 'confirm', autocomplete: 'new-password', required: true, maxlength: 128 });
  const errorSlot = h('div');
  const submit = button('Criar conta', { variant: 'primary', type: 'submit' });
  submit.classList.add('btn--block');
  const container = h('div');

  const form = h(
    'form',
    {
      class: 'form',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        errorSlot.replaceChildren();
        if (password.control.value !== confirm.control.value) {
          errorSlot.replaceChildren(alertBox('As senhas não conferem.'));
          return;
        }
        submit.disabled = true;
        try {
          const data = await post('/auth/register', {
            name: name.control.value,
            company: company.control.value,
            email: email.control.value,
            password: password.control.value,
          });
          container.replaceChildren(
            h('h1', { class: 'auth__title' }, 'Cadastro enviado'),
            alertBox(data.message, 'success'),
            h('p', { class: 'auth__switch' }, h('a', { href: '/login', 'data-link': true }, 'Ir para o login')),
          );
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
        } finally {
          submit.disabled = false;
        }
      },
    },
    errorSlot,
    name.element,
    company.element,
    email.element,
    password.element,
    confirm.element,
    submit,
  );

  container.append(
    h('h1', { class: 'auth__title' }, 'Criar conta'),
    h('p', { class: 'muted' }, 'Após o cadastro, sua conta ficará pendente até a aprovação do administrador.'),
    form,
    h('p', { class: 'auth__switch' }, 'Já tem conta? ', h('a', { href: '/login', 'data-link': true }, 'Entrar')),
  );
  return authShell(container);
}
