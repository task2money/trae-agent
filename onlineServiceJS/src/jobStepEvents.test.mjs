import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it } from 'node:test';

import {
  formatStepJobEventMessage,
  listAgentStepsFromTaeJsonDir,
  listAgentStepsFromTrajectoryFile,
  listVisibleAgentSteps,
  takeNewAgentSteps,
} from './jobStepEvents.mjs';

describe('jobStepEvents', () => {
  it('listAgentStepsFromTrajectoryFile reads agent_steps', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-step-events-'));
    const traj = path.join(dir, 'trajectory_j1.json');
    fs.writeFileSync(
      traj,
      JSON.stringify({
        agent_steps: [
          { step_number: 1, delivery_summary: 'bash ls', state: 'completed' },
          { step_number: 2, delivery_summary: 'edit a.js', state: 'completed' },
        ],
      }),
      'utf8',
    );
    const steps = listAgentStepsFromTrajectoryFile(traj);
    assert.equal(steps.length, 2);
    assert.equal(steps[0].step_number, 1);
    assert.equal(steps[1].delivery_summary, 'edit a.js');
  });

  it('listAgentStepsFromTaeJsonDir reads step_* dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tae-json-'));
    const s1 = path.join(root, 'step_000001');
    fs.mkdirSync(s1);
    fs.writeFileSync(
      path.join(s1, 'agent_step_full.json'),
      JSON.stringify({ type: 'agent_step_full', step_number: 1, delivery_summary: 'think', state: 'completed' }),
      'utf8',
    );
    const steps = listAgentStepsFromTaeJsonDir(root);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].step_number, 1);
    assert.equal(steps[0].delivery_summary, 'think');
  });

  it('takeNewAgentSteps only returns unseen step_numbers', () => {
    const seen = new Set([1]);
    const neu = takeNewAgentSteps(
      [
        { step_number: 1, delivery_summary: 'a' },
        { step_number: 2, delivery_summary: 'b' },
      ],
      seen,
    );
    assert.equal(neu.length, 1);
    assert.equal(neu[0].step_number, 2);
    assert.ok(seen.has(2));
    const again = takeNewAgentSteps([{ step_number: 2, delivery_summary: 'b' }], seen);
    assert.equal(again.length, 0);
  });

  it('formatStepJobEventMessage prefers delivery_summary', () => {
    assert.equal(
      formatStepJobEventMessage({ step_number: 3, delivery_summary: 'bash echo hi', state: 'completed' }),
      'step 3: bash echo hi',
    );
    assert.equal(formatStepJobEventMessage({ step_number: 1, state: 'completed' }), 'step 1: completed');
  });

  it('listVisibleAgentSteps merges trajectory and tae', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-steps-'));
    const traj = path.join(dir, 't.json');
    fs.writeFileSync(
      traj,
      JSON.stringify({ agent_steps: [{ step_number: 1, state: 'completed' }] }),
      'utf8',
    );
    const tae = path.join(dir, 'tae');
    const s2 = path.join(tae, 'step_000002');
    fs.mkdirSync(s2, { recursive: true });
    fs.writeFileSync(
      path.join(s2, 'agent_step_full.json'),
      JSON.stringify({ step_number: 2, delivery_summary: 'second', state: 'completed' }),
      'utf8',
    );
    const steps = listVisibleAgentSteps(traj, tae);
    assert.equal(steps.length, 2);
    assert.equal(steps[1].step_number, 2);
  });
});
