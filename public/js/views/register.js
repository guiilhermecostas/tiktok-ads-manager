import { post } from '../api.js';
import { h } from '../dom.js';
import { alertBox, button, field } from '../ui.js';
import { authShell } from './auth-shell.js';

/**
 * Cadastro em duas etapas: (1) dados da conta → o sistema envia um código de 6 dígitos para o e-mail; (2) a pessoa digita o código e SÓ ENTÃO a conta é criada
 * (pendente da aprovação do administrador, já com o plano padrão). O "ticket" que liga o código a este cadastro fica só na memória desta tela.
 */
export function registerView() {
  const container = h('div');
  let timer = null;
  const stopTimer = () => { clearInterval(timer); timer = null; };

  // ---------- etapa 1: dados ----------
  function stepForm({ keepEmail = '' } = {}) {
    stopTimer();
    const name = field('Nome completo', { type: 'text', name: 'name', autocomplete: 'name', required: true, maxlength: 80, autofocus: true });
    const company = field('Empresa (opcional)', { type: 'text', name: 'company', autocomplete: 'organization', maxlength: 100 });
    const email = field('E-mail', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: 254, value: keepEmail }, { hint: 'Vamos enviar um código de 6 dígitos para confirmar este e-mail.' });
    const password = field('Senha', { type: 'password', name: 'password', autocomplete: 'new-password', required: true, minlength: 10, maxlength: 128 }, { hint: 'Mínimo de 10 caracteres.' });
    const confirm = field('Confirmar senha', { type: 'password', name: 'confirm', autocomplete: 'new-password', required: true, maxlength: 128 });
    const errorSlot = h('div');
    const submit = button('Enviar código para o e-mail', { variant: 'primary', type: 'submit' });
    submit.classList.add('btn--block');
    const form = h('form', {
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
          const data = await post('/auth/register', { name: name.control.value, company: company.control.value, email: email.control.value, password: password.control.value });
          stepCode(data);
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
          submit.disabled = false;
        }
      },
    }, errorSlot, name.element, company.element, email.element, password.element, confirm.element, submit);
    container.replaceChildren(
      h('h1', { class: 'auth__title' }, 'Criar conta'),
      h('p', { class: 'muted' }, 'Confirmamos o seu e-mail com um código. Depois, sua conta ficará pendente até a aprovação do administrador.'),
      form,
      h('p', { class: 'auth__switch' }, 'Já tem conta? ', h('a', { href: '/login', 'data-link': true }, 'Entrar')),
    );
  }

  // ---------- etapa 2: código ----------
  function stepCode({ ticket, email, expiresInMinutes, resendAfterSeconds }) {
    stopTimer();
    const code = field('Código de 6 dígitos', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, required: true, autofocus: true, placeholder: '000000' });
    code.control.classList.add('auth__code');
    const errorSlot = h('div', { 'aria-live': 'polite' });
    const info = h('div', { 'aria-live': 'polite' }, alertBox(`Enviamos um código para ${email}. Ele vale por ${expiresInMinutes} minutos. Veja também a caixa de spam.`, 'info'));
    const submit = button('Confirmar e criar conta', { variant: 'primary', type: 'submit' });
    submit.classList.add('btn--block');
    const resend = button('Reenviar código', { small: true });
    let left = resendAfterSeconds;
    const paintResend = () => {
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Reenviar código em ${left}s` : 'Reenviar código';
    };
    const tick = () => { left = Math.max(0, left - 1); paintResend(); if (left === 0) stopTimer(); };
    const startCountdown = (seconds) => { stopTimer(); left = seconds; paintResend(); if (left > 0) timer = setInterval(tick, 1000); };
    startCountdown(resendAfterSeconds);

    // só dígitos, no máximo 6 (colar "123 456" também funciona)
    code.control.addEventListener('input', () => { code.control.value = code.control.value.replace(/\D/g, '').slice(0, 6); });

    async function confirm() {
      errorSlot.replaceChildren();
      const value = code.control.value.replace(/\D/g, '');
      if (value.length !== 6) {
        errorSlot.replaceChildren(alertBox('Digite os 6 números do código.'));
        return;
      }
      submit.disabled = true;
      try {
        const data = await post('/auth/register/verify', { ticket, code: value });
        stopTimer();
        container.replaceChildren(
          h('h1', { class: 'auth__title' }, 'Conta criada'),
          alertBox(data.message, 'success'),
          h('p', { class: 'auth__switch' }, h('a', { href: '/login', 'data-link': true }, 'Ir para o login')),
        );
      } catch (err) {
        errorSlot.replaceChildren(alertBox(err.message));
        code.control.select();
        submit.disabled = false;
        if (err.code === 'invalid_code' && /tentativas acabaram|inválido ou vencido/.test(err.message)) stepForm({ keepEmail: email }); // sem tentativas ou vencido: recomeça
      }
    }

    resend.addEventListener('click', async () => {
      errorSlot.replaceChildren();
      resend.disabled = true;
      try {
        const data = await post('/auth/register/resend', { ticket });
        info.replaceChildren(alertBox(`Enviamos um novo código para ${email}.`, 'success'));
        startCountdown(data.resendAfterSeconds ?? 60);
        code.control.value = '';
        code.control.focus();
      } catch (err) {
        errorSlot.replaceChildren(alertBox(err.message));
        startCountdown(err.status === 429 ? 30 : 10);
      }
    });

    const form = h('form', { class: 'form', novalidate: true, onSubmit: (event) => { event.preventDefault(); confirm(); } },
      info, errorSlot, code.element, submit,
      h('div', { class: 'auth__code-actions' }, resend, button('Trocar e-mail', { small: true, onClick: () => stepForm({ keepEmail: email }) })));
    container.replaceChildren(
      h('h1', { class: 'auth__title' }, 'Confirme o seu e-mail'),
      h('p', { class: 'muted' }, 'Digite o código para concluir a criação da conta.'),
      form,
    );
    code.control.focus();
  }

  stepForm();
  return authShell(container);
}
