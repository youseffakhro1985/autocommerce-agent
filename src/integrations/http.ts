/** Minimal resilient HTTP client: timeouts, retry with backoff on 429/5xx, never logs secrets. */
export class HttpError extends Error {
  constructor(public status: number, public body: string, public url: string) {
    super(`HTTP ${status} ${url.replace(/([?&](key|token|api_key)=)[^&]+/gi, '$1[REDACTED]')}: ${body.slice(0, 300)}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function http<T = any>(
  url: string,
  init: RequestInit & { retries?: number; timeoutMs?: number; raw?: boolean } = {},
): Promise<T> {
  const retries = init.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const text = await res.text();
      if (res.ok) return (init.raw ? text : text ? JSON.parse(text) : {}) as T;
      const retryable = res.status === 429 || res.status >= 500;
      // Never retry non-idempotent POSTs on 5xx (could double-order); caller reconciles instead.
      const isUnsafe = (init.method ?? 'GET').toUpperCase() === 'POST' && res.status !== 429;
      if (!retryable || isUnsafe || attempt >= retries) throw new HttpError(res.status, text, url);
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt + Math.random() * 250);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const unsafe = (init.method ?? 'GET').toUpperCase() === 'POST';
      if (unsafe || attempt >= retries) throw e; // network error on POST: outcome unknown -> reconcile
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(t);
    }
  }
}
