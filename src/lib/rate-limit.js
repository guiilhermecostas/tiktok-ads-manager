/**
 * Limitador em memória (janela deslizante por chave).
 * Suficiente para instância única; com várias instâncias use um store compartilhado.
 */
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.timer.unref();
  }

  sweep(now = Date.now()) {
    for (const [key, list] of this.hits) {
      const fresh = list.filter((t) => now - t < this.windowMs);
      if (fresh.length) this.hits.set(key, fresh);
      else this.hits.delete(key);
    }
  }

  /** Registra uma tentativa. Retorna { allowed, retryAfterSec }. */
  consume(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { allowed: false, retryAfterSec: Math.ceil((this.windowMs - (now - list[0])) / 1000) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, retryAfterSec: 0 };
  }

  clear(key) {
    this.hits.delete(key);
  }

  stop() {
    clearInterval(this.timer);
  }
}
