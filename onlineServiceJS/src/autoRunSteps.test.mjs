import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

import {
  DEFAULT_AUTO_RUN_STEPS_PATH,
  readAutoRunStepsMarkdown,
  resolveAutoRunStepsPath,
} from './autoRunSteps.mjs';

describe('autoRunSteps', () => {
  it('resolveAutoRunStepsPath defaults to /app/autoRunStep.md', () => {
    assert.equal(resolveAutoRunStepsPath({}), DEFAULT_AUTO_RUN_STEPS_PATH);
  });

  it('resolveAutoRunStepsPath honors AUTO_RUN_STEPS_MD_PATH', () => {
    assert.equal(
      resolveAutoRunStepsPath({ AUTO_RUN_STEPS_MD_PATH: '/tmp/x.md' }),
      '/tmp/x.md',
    );
  });

  it('readAutoRunStepsMarkdown returns markdown when file exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ars-'));
    const fp = path.join(dir, 'autoRunStep.md');
    fs.writeFileSync(fp, '# hello\n\nstep 1\n', 'utf8');
    const out = readAutoRunStepsMarkdown(fp);
    assert.equal(out.ok, true);
    assert.match(out.markdown, /hello/);
    assert.equal(out.source, 'image_filesystem');
  });

  it('readAutoRunStepsMarkdown fails when missing', () => {
    const out = readAutoRunStepsMarkdown('/tmp/definitely-missing-autoRunStep.md');
    assert.equal(out.ok, false);
    assert.match(out.detail, /not found/i);
  });
});
