/** Cache em memória com expiração e tamanho máximo. Protege a API do TikTok contra chamadas repetidas. */
export class TtlCache {
  constructor({ ttlMs, maxEntries = 500 }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value, now = Date.now()) {
    if (this.entries.size >= this.maxEntries) {
      // Remove a entrada mais antiga (Map preserva a ordem de inserção).
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  /** Retorna o valor em cache ou executa `loader` (e guarda o resultado). */
  async remember(key, loader) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await loader();
    this.set(key, value);
    return value;
  }

  clear() {
    this.entries.clear();
  }
}
