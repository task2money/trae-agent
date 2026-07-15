import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapPool, bootstrapCloneConcurrencyFromEnv } from './mapPool.mjs';

describe('mapPool', () => {
  it('runs with concurrency limit and preserves order', async () => {
    let active = 0;
    let maxActive = 0;
    const factories = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      factories.push(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 15));
        active -= 1;
        return idx * 2;
      });
    }
    const got = await mapPool(factories, 3);
    assert.equal(maxActive <= 3, true, `maxActive=${maxActive}`);
    assert.deepEqual(got, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});

describe('bootstrapCloneConcurrencyFromEnv', () => {
  it('defaults to 8', () => {
    assert.equal(bootstrapCloneConcurrencyFromEnv({}), 8);
  });
  it('reads BOOTSTRAP_CLONE_CONCURRENCY', () => {
    assert.equal(bootstrapCloneConcurrencyFromEnv({ BOOTSTRAP_CLONE_CONCURRENCY: '4' }), 4);
  });
});
