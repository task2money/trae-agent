/**
 * 并行执行 tasks，最多 concurrency 路同时进行。
 * @template T
 * @param {Array<() => Promise<T>>} factories
 * @param {number} concurrency
 * @returns {Promise<T[]>}
 */
export async function mapPool(factories, concurrency) {
  const list = Array.isArray(factories) ? factories : [];
  const n = list.length;
  if (!n) return [];
  const limit = Math.max(1, Math.min(n, Number(concurrency) || 1));
  /** @type {T[]} */
  const results = new Array(n);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= n) return;
      results[i] = await list[i]();
    }
  }
  const workers = [];
  for (let w = 0; w < limit; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export function bootstrapCloneConcurrencyFromEnv(env = process.env) {
  const raw = Number(env?.BOOTSTRAP_CLONE_CONCURRENCY);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return 8;
}
