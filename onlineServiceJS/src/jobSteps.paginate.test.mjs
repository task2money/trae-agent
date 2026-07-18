import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paginateJobStepsPayload } from './jobSteps.mjs';

describe('paginateJobStepsPayload', () => {
  const payload = {
    steps: [
      { step_number: 1, delivery_summary: 'a' },
      { step_number: 3, delivery_summary: 'c' },
      { step_number: 2, delivery_summary: 'b' },
    ],
    note: null,
    trajectory_file: 't.json',
    task: 'demo',
  };

  it('without limit returns all sorted and has_more false', () => {
    const out = paginateJobStepsPayload(payload, { afterStep: 0 });
    assert.equal(out.steps.length, 3);
    assert.equal(out.steps[0].step_number, 1);
    assert.equal(out.steps[2].step_number, 3);
    assert.equal(out.total_steps, 3);
    assert.equal(out.has_more, false);
    assert.equal(out.next_after_step, null);
  });

  it('pages by after_step and limit', () => {
    const p1 = paginateJobStepsPayload(payload, { afterStep: 0, limit: 2 });
    assert.deepEqual(
      p1.steps.map((s) => s.step_number),
      [1, 2],
    );
    assert.equal(p1.has_more, true);
    assert.equal(p1.next_after_step, 2);
    assert.equal(p1.total_steps, 3);

    const p2 = paginateJobStepsPayload(payload, { afterStep: 2, limit: 2 });
    assert.deepEqual(
      p2.steps.map((s) => s.step_number),
      [3],
    );
    assert.equal(p2.has_more, false);
    assert.equal(p2.next_after_step, null);
  });

  it('clamps limit to 50', () => {
    const many = {
      steps: Array.from({ length: 60 }, (_, i) => ({ step_number: i + 1 })),
    };
    const out = paginateJobStepsPayload(many, { afterStep: 0, limit: 999 });
    assert.equal(out.steps.length, 50);
    assert.equal(out.has_more, true);
    assert.equal(out.next_after_step, 50);
  });
});
