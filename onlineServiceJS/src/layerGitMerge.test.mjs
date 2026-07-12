import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runLayerGitMerge } from './layerGitMerge.mjs';

function makeGitExec(script) {
  let i = 0;
  return async (args) => {
    const step = script[i++];
    if (!step) throw new Error(`unexpected git ${args.join(' ')}`);
    const key = args.join(' ');
    if (step.match && !step.match.test(key)) {
      throw new Error(`expected ${step.match}, got ${key}`);
    }
    if (step.reject) throw new Error(step.reject);
    return step.out ?? '';
  };
}

describe('runLayerGitMerge', () => {
  it('T1: missing target_branch → 400', async () => {
    const r = await runLayerGitMerge({
      gitExec: async () => '',
      work: '/tmp/repo',
      targetBranch: '',
    });
    assert.equal(r.httpStatus, 400);
    assert.match(r.payload.detail, /target_branch/);
  });

  it('T2: no work → 400 no git', async () => {
    const r = await runLayerGitMerge({
      gitExec: async () => '',
      work: '',
      targetBranch: 'main',
    });
    assert.equal(r.httpStatus, 400);
    assert.equal(r.payload.detail, 'no git');
  });

  it('T3: dirty worktree → 400', async () => {
    const r = await runLayerGitMerge({
      gitExec: makeGitExec([{ match: /status --porcelain/, out: ' M file.txt\n' }]),
      work: '/tmp/repo',
      targetBranch: 'main',
    });
    assert.equal(r.httpStatus, 400);
    assert.match(r.payload.detail, /未提交/);
  });

  it('T4: clean merge success', async () => {
    const r = await runLayerGitMerge({
      gitExec: makeGitExec([
        { match: /status --porcelain/, out: '' },
        { match: /rev-parse --abbrev-ref HEAD/, out: 'feature/x\n' },
        { match: /rev-parse feature\/x/, out: 'abc123\n' },
        { match: /rev-parse --verify main/, out: 'main\n' },
        { match: /checkout main/, out: '' },
        { match: /merge --no-edit abc123/, out: 'Merge made by the recursive strategy.\n' },
      ]),
      work: '/tmp/repo',
      targetBranch: 'main',
    });
    assert.equal(r.httpStatus, 200);
    assert.equal(r.payload.ok, true);
    assert.equal(r.payload.status, 'merged');
    assert.equal(r.payload.target_branch, 'main');
  });

  it('T5: conflict → 409 abort', async () => {
    const calls = [];
    const gitExec = async (args) => {
      const key = args.join(' ');
      calls.push(key);
      if (key === 'status --porcelain') return '';
      if (key === 'rev-parse --abbrev-ref HEAD') return 'feature/x\n';
      if (key === 'rev-parse feature/x') return 'abc123\n';
      if (key === 'rev-parse --verify main') return 'main\n';
      if (key === 'checkout main') return '';
      if (key.startsWith('merge --no-edit')) throw new Error('CONFLICT (content): Merge conflict in a.txt');
      if (key === 'merge --abort') return '';
      if (key === 'checkout feature/x') return '';
      throw new Error(`unexpected ${key}`);
    };
    const r = await runLayerGitMerge({
      gitExec,
      work: '/tmp/repo',
      targetBranch: 'main',
    });
    assert.equal(r.httpStatus, 409);
    assert.equal(r.payload.conflict, true);
    assert.ok(calls.includes('merge --abort'));
    assert.ok(calls.includes('checkout feature/x'));
  });

  it('noop when already on target', async () => {
    const r = await runLayerGitMerge({
      gitExec: makeGitExec([
        { match: /status --porcelain/, out: '' },
        { match: /rev-parse --abbrev-ref HEAD/, out: 'main\n' },
        { match: /rev-parse main/, out: 'abc\n' },
      ]),
      work: '/tmp/repo',
      targetBranch: 'main',
    });
    assert.equal(r.httpStatus, 200);
    assert.equal(r.payload.status, 'noop');
  });
});
