/**
 * Ditado por voz do campo do Início (Web Speech API do navegador). Recurso opcional: onde o navegador não oferece, o botão nem aparece.
 * Observação de privacidade: no Chrome e no Edge o reconhecimento é feito pelo serviço de voz do próprio navegador (o áudio sai do computador
 * para esse serviço); por isso só começa quando a pessoa clica no microfone, e nada é gravado ou enviado ao servidor deste sistema.
 */
const Recognition = typeof window === 'undefined' ? undefined : window.SpeechRecognition ?? window.webkitSpeechRecognition;

export const voiceSupported = Boolean(Recognition);

const ERRORS = {
  'not-allowed': 'Permita o uso do microfone no navegador para ditar.',
  'service-not-allowed': 'O navegador não liberou o ditado por voz.',
  'no-speech': 'Não ouvi nada. Tente de novo.',
  'audio-capture': 'Não encontrei um microfone.',
  network: 'O ditado por voz precisa de internet.',
};

/**
 * `onText(text)`: texto reconhecido até agora (parcial, vai se completando); `onState(listening)`: começou ou parou de ouvir;
 * `onError(message)`: aviso curto em português. Retorna { toggle(), stop(), listening() }.
 */
export function createVoice({ onText, onState, onError, lang = 'pt-BR' }) {
  let recognition = null;

  function stop() {
    recognition?.stop();
  }

  function start() {
    recognition = new Recognition();
    recognition.lang = lang;
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => onState(true);
    recognition.onend = () => {
      recognition = null;
      onState(false);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'aborted') onError(ERRORS[event.error] ?? 'Não foi possível usar o ditado por voz.');
    };
    recognition.onresult = (event) => {
      const text = [...event.results].map((result) => result[0].transcript).join(' ').replace(/\s+/g, ' ').trim();
      if (text) onText(text);
    };
    try {
      recognition.start();
    } catch {
      recognition = null;
      onState(false);
    }
  }

  return { toggle: () => (recognition ? stop() : start()), stop, listening: () => recognition !== null };
}
