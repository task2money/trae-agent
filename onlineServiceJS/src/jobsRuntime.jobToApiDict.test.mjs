import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { jobToApiDict } from './jobsRuntime.mjs';

describe('jobToApiDict output omission', () => {
  const rec = {
    id: 'j1',
    layer_id: 'L1',
    command: 'echo hi',
    status: 'completed',
    output: 'a'.repeat(1000),
    exit_code: 0,
  };

  it('omits full output by default and reports output_chars', () => {
    const d = jobToApiDict(rec);
    assert.equal(d.output_omitted, true);
    assert.equal(d.output_chars, 1000);
    assert.equal('output' in d, false);
    assert.equal(d.id, 'j1');
    assert.equal(d.git_destructive_locked, false);
  });

  it('includes full output when includeOutput is true', () => {
    const d = jobToApiDict(rec, { includeOutput: true });
    assert.equal(d.output_omitted, false);
    assert.equal(d.output_chars, 1000);
    assert.equal(d.output, rec.output);
  });

  it('treats missing output as empty string length 0', () => {
    const d = jobToApiDict({ id: 'j2', status: 'pending' });
    assert.equal(d.output_chars, 0);
    assert.equal(d.output_omitted, true);
    assert.equal('output' in d, false);
  });
});
