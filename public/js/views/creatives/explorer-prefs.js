/** Preferências de visualização do gerenciador de arquivos (modo e ordenação), guardadas só neste navegador. */
export const VIEWS = ['grid', 'list'];
export const SORT_OPTIONS = [
  ['date', 'Data de envio'],
  ['name', 'Nome'],
  ['size', 'Tamanho'],
  ['kind', 'Tipo'],
];
const SORT_KEYS = SORT_OPTIONS.map(([key]) => key);
const DIRS = ['asc', 'desc'];
export const DEFAULT_PREFS = Object.freeze({ view: 'grid', sort: 'date', dir: 'desc' });
const STORAGE_KEY = 'creatives.explorer';

/** Só valores conhecidos passam: o que estiver no armazenamento (ou vier de outra versão) nunca vira parâmetro da API sem conferir. */
export function normalizePrefs(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    view: VIEWS.includes(value.view) ? value.view : DEFAULT_PREFS.view,
    sort: SORT_KEYS.includes(value.sort) ? value.sort : DEFAULT_PREFS.sort,
    dir: DIRS.includes(value.dir) ? value.dir : DEFAULT_PREFS.dir,
  };
}

export function loadPrefs() {
  try {
    return normalizePrefs(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return { ...DEFAULT_PREFS }; // sem armazenamento (modo privado, bloqueado) ou valor corrompido
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizePrefs(prefs)));
  } catch {
    /* sem armazenamento: a preferência vale só até recarregar a página */
  }
}

/** Sentido natural ao escolher uma coluna pela primeira vez: texto de A a Z; data e tamanho do maior/mais novo para o menor. */
export const defaultDirFor = (sort) => (sort === 'name' || sort === 'kind' ? 'asc' : 'desc');
