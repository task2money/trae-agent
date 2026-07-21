import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  composeAutoRunCommand,
  shouldTriggerAutoRunFirstInstruction,
  maybeStartAutoRunFirstInstruction,
  runAutoRunDelivery,
  hasAutoRunFirstJobMarker,
  writeAutoRunFirstJobMarker,
  hasAutoRunDeliveryDone,
  writeAutoRunDeliveryDone,
  shouldSkipAutoRunDelivery,
  autoRunFirstJobMarkerPath,
  autoRunDeliveryDonePath,
} from './autoRunOrchestration.mjs';

test('composeAutoRunCommand joins title and description', () => {
  assert.equal(composeAutoRunCommand('T', 'D'), 'T\n\nD');
  assert.equal(composeAutoRunCommand('  T  ', '  D  '), 'T\n\nD');
  assert.equal(composeAutoRunCommand('T', ''), 'T');
  assert.equal(composeAutoRunCommand('', 'D'), 'D');
  assert.equal(composeAutoRunCommand('  ', '  '), '');
});

test('shouldTriggerAutoRunFirstInstruction gates', () => {
  assert.equal(
    shouldTriggerAutoRunFirstInstruction({
      autoRun: true,
      layerId: 'L1',
      command: 'x',
      markerExists: false,
    }),
    true,
  );
  assert.equal(
    shouldTriggerAutoRunFirstInstruction({
      autoRun: false,
      layerId: 'L1',
      command: 'x',
      markerExists: false,
    }),
    false,
  );
  assert.equal(
    shouldTriggerAutoRunFirstInstruction({
      autoRun: true,
      layerId: '',
      command: 'x',
      markerExists: false,
    }),
    false,
  );
  assert.equal(
    shouldTriggerAutoRunFirstInstruction({
      autoRun: true,
      layerId: 'L1',
      command: '',
      markerExists: false,
    }),
    false,
  );
  assert.equal(
    shouldTriggerAutoRunFirstInstruction({
      autoRun: true,
      layerId: 'L1',
      command: 'x',
      markerExists: true,
    }),
    false,
  );
});

test('maybeStartAutoRunFirstInstruction creates job once when auto_run', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  const calls = [];
  const createJobFn = async (body) => {
    calls.push(body);
    return { id: 'job_1', layer_id: 'layer_child', ...body };
  };
  const rec = await maybeStartAutoRunFirstInstruction({
    detail: {
      task: { auto_run: true, title: 'Fix bug', description: 'Do it carefully' },
    },
    layerId: 'layer_root',
    createJobFn,
  });
  assert.ok(rec);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'Fix bug\n\nDo it carefully');
  assert.equal(calls[0].command_kind, 'trae');
  assert.equal(calls[0].repo_layer_id, 'layer_root');
  assert.equal(calls[0].auto_run_first, true);
  assert.equal(hasAutoRunFirstJobMarker(), true);

  const again = await maybeStartAutoRunFirstInstruction({
    detail: {
      task: { auto_run: true, title: 'Fix bug', description: 'Do it carefully' },
    },
    layerId: 'layer_root',
    createJobFn,
  });
  assert.equal(again, null);
  assert.equal(calls.length, 1);
});

test('maybeStartAutoRunFirstInstruction skips when auto_run false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  let called = 0;
  const rec = await maybeStartAutoRunFirstInstruction({
    detail: { task: { auto_run: false, title: 'T', description: 'D' } },
    layerId: 'L',
    createJobFn: async () => {
      called += 1;
      return { id: 'j' };
    },
  });
  assert.equal(rec, null);
  assert.equal(called, 0);
});

test('runAutoRunDelivery syncs commit and push; skips when done', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-del-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  const syncCalls = [];
  const commitCalls = [];
  const pushCalls = [];
  const result = await runAutoRunDelivery({
    layerId: 'layer_x',
    commitMessage: 'msg',
    identities: [{ repo_url: 'https://example.com/a.git', user_name: 'A', user_email: 'a@e.com' }],
    targetBranch: 'feature/x',
    syncRepoIdentitiesToLayer: async (lid, ids) => {
      syncCalls.push({ lid, ids });
      return { applied_count: 1, results: [] };
    },
    commitLayerChanges: async (lid, msg) => {
      commitCalls.push({ lid, msg });
      return { ok: true, committed: 1 };
    },
    runLayerOauthRefreshPush: async (opts) => {
      pushCalls.push(opts);
      return { httpStatus: 200, payload: { ok: true, github_pull_request: { html_url: 'https://pr' } } };
    },
    aheadDeps: {
      layerGitRemoteSnapshot: () => ({ is_git: true, ahead: 0 }),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(syncCalls.length, 1);
  assert.equal(commitCalls.length, 1);
  assert.equal(pushCalls.length, 1);
  assert.equal(pushCalls[0].targetBranch, 'feature/x');
  assert.equal(hasAutoRunDeliveryDone(), true);
  assert.equal(shouldSkipAutoRunDelivery(), true);

  const again = await runAutoRunDelivery({
    layerId: 'layer_x',
    syncRepoIdentitiesToLayer: async () => {
      throw new Error('should not run');
    },
    commitLayerChanges: async () => {
      throw new Error('should not run');
    },
    runLayerOauthRefreshPush: async () => {
      throw new Error('should not run');
    },
  });
  assert.equal(again.skipped, true);
});

test('runAutoRunDelivery does not lock done on push failure; allows retry', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-del-fail-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  let pushes = 0;
  const failOnce = await runAutoRunDelivery({
    layerId: 'layer_y',
    commitMessage: 'msg',
    targetBranch: 'feature/y',
    syncRepoIdentitiesToLayer: async () => ({ applied_count: 0, results: [] }),
    commitLayerChanges: async () => ({ ok: true, committed: 1 }),
    runLayerOauthRefreshPush: async () => {
      pushes += 1;
      return { httpStatus: 400, payload: { ok: false, detail: 'push rejected' } };
    },
    aheadDeps: {
      layerGitRemoteSnapshot: () => ({ is_git: true, ahead: 1 }),
    },
  });
  assert.equal(failOnce.ok, false);
  assert.equal(shouldSkipAutoRunDelivery(), false);
  assert.equal(pushes, 1);

  const okSecond = await runAutoRunDelivery({
    layerId: 'layer_y',
    commitMessage: 'msg',
    targetBranch: 'feature/y',
    syncRepoIdentitiesToLayer: async () => ({ applied_count: 0, results: [] }),
    commitLayerChanges: async () => ({ ok: true, committed: 0, skipped: true }),
    runLayerOauthRefreshPush: async () => {
      pushes += 1;
      return { httpStatus: 200, payload: { ok: true } };
    },
    aheadDeps: {
      layerGitRemoteSnapshot: () => ({ is_git: true, ahead: 0 }),
    },
  });
  assert.equal(okSecond.ok, true);
  assert.equal(pushes, 2);
  assert.equal(shouldSkipAutoRunDelivery(), true);
});

test('shouldSkipAutoRunDelivery retries legacy push_ok=false done marker', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-skip-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  assert.equal(shouldSkipAutoRunDelivery(), false);
  writeAutoRunDeliveryDone({ layer_id: 'L', push_ok: false, push_http_status: 400 });
  assert.equal(shouldSkipAutoRunDelivery(), false);
  writeAutoRunDeliveryDone({ layer_id: 'L', push_ok: true });
  assert.equal(shouldSkipAutoRunDelivery(), true);
});

test('marker path helpers write under runtime', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autorun-m-'));
  process.env.ONLINE_PROJECT_STATE_ROOT = tmp;
  assert.ok(autoRunFirstJobMarkerPath().includes(path.join('runtime', 'auto_run_first_job.json')));
  assert.ok(autoRunDeliveryDonePath().includes(path.join('runtime', 'auto_run_delivery.done')));
  writeAutoRunFirstJobMarker('j1');
  writeAutoRunDeliveryDone({ push_ok: true });
  assert.equal(hasAutoRunFirstJobMarker(), true);
  assert.equal(hasAutoRunDeliveryDone(), true);
});
