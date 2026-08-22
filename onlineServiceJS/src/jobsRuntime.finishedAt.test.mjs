import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stampJobFinishedAt } from './jobsRuntimeState.mjs';

describe('stampJobFinishedAt', () => {
  it('writes ISO finished_at once', () => {
    const rec = { id: 'j1', status: 'completed' };
    stampJobFinishedAt(rec, () => '2026-08-22T14:01:03.000Z');
    assert.equal(rec.finished_at, '2026-08-22T14:01:03.000Z');
    stampJobFinishedAt(rec, () => '2026-08-22T15:00:00.000Z');
    assert.equal(rec.finished_at, '2026-08-22T14:01:03.000Z');
  });

  it('ignores null rec', () => {
    assert.equal(stampJobFinishedAt(null), null);
  });
});
