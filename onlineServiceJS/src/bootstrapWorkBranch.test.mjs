import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectRepoBranchPlans,
  ensureRepoOnWorkBranch,
  checkoutWorkBranchesForJobs,
} from './bootstrapWorkBranch.mjs';

test('collectRepoBranchPlans: shared work + per-repo plans', () => {
  const { sharedWorkBranch, byUrl } = collectRepoBranchPlans({
    task: {
      target_branch: 'feature/work-a',
      parameters: {
        branch_strategy: {
          work_branch_name: 'feature/work-a',
          merge_target_branch_name: 'develop',
        },
      },
    },
    project_repos: [
      {
        project_id: 'p1',
        git_repos: ['https://example.com/a.git', 'https://example.com/b.git'],
        repo_branches: [
          {
            git_repo: 'https://example.com/a.git',
            base_branch: 'main',
            target_branch: 'feature/work-a',
          },
        ],
      },
    ],
    repo_branch_plans: [
      {
        repo_url: 'https://example.com/b.git',
        base_branch: 'develop',
        target_branch: 'feature/work-a',
      },
    ],
  });

  assert.equal(sharedWorkBranch, 'feature/work-a');
  assert.equal(byUrl.get('https://example.com/a.git')?.baseBranch, 'main');
  assert.equal(byUrl.get('https://example.com/a.git')?.workBranch, 'feature/work-a');
  assert.equal(byUrl.get('https://example.com/b.git')?.baseBranch, 'develop');
  assert.equal(byUrl.get('https://example.com/b.git')?.workBranch, 'feature/work-a');
});

test('ensureRepoOnWorkBranch: already on work → skipped', async () => {
  const calls = [];
  const gitExec = async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'feature/work\n';
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const r = await ensureRepoOnWorkBranch({
    gitExec,
    repoDir: '/tmp/repo',
    workBranch: 'feature/work',
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'already_on_work_branch');
  assert.deepEqual(calls, ['rev-parse --abbrev-ref HEAD']);
});

test('ensureRepoOnWorkBranch: track origin work branch', async () => {
  const calls = [];
  const gitExec = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
    if (key === 'rev-parse --verify refs/remotes/origin/feature/work') return 'abc\n';
    if (key === 'checkout -B feature/work origin/feature/work') return '';
    throw new Error(`unexpected ${key}`);
  };
  const r = await ensureRepoOnWorkBranch({
    gitExec,
    repoDir: '/tmp/repo',
    workBranch: 'feature/work',
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'track_origin');
  assert.ok(calls.includes('checkout -B feature/work origin/feature/work'));
});

test('ensureRepoOnWorkBranch: create local from base then work', async () => {
  const calls = [];
  const gitExec = async (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
    if (key.startsWith('rev-parse --verify refs/remotes/origin/feature/work')) {
      throw new Error('missing');
    }
    if (key.startsWith('rev-parse --verify refs/heads/feature/work')) {
      throw new Error('missing');
    }
    if (key === 'rev-parse --verify refs/remotes/origin/develop') return 'def\n';
    if (key === 'checkout -B develop origin/develop') return '';
    if (key === 'checkout -b feature/work') return '';
    throw new Error(`unexpected ${key}`);
  };
  const r = await ensureRepoOnWorkBranch({
    gitExec,
    repoDir: '/tmp/repo',
    workBranch: 'feature/work',
    baseBranch: 'develop',
  });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'create_local');
  assert.ok(calls.includes('checkout -B develop origin/develop'));
  assert.ok(calls.includes('checkout -b feature/work'));
});

test('ensureRepoOnWorkBranch: empty work → skipped', async () => {
  const r = await ensureRepoOnWorkBranch({
    gitExec: async () => {
      throw new Error('should not call');
    },
    repoDir: '/tmp/repo',
    workBranch: '',
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'empty_work_branch');
});

test('checkoutWorkBranchesForJobs: applies plans to each job', async () => {
  const logs = [];
  const gitExec = async (args, cwd) => {
    const key = args.join(' ');
    if (key === 'rev-parse --abbrev-ref HEAD') return 'main\n';
    if (key.startsWith('rev-parse --verify refs/remotes/origin/')) throw new Error('no');
    if (key.startsWith('rev-parse --verify refs/heads/')) throw new Error('no');
    if (key.startsWith('checkout -b ')) return '';
    throw new Error(`unexpected ${key} cwd=${cwd}`);
  };
  const plansByUrl = new Map([
    ['https://example.com/a.git', { baseBranch: '', workBranch: 'feature/a' }],
    ['https://example.com/b.git', { baseBranch: '', workBranch: 'feature/b' }],
  ]);
  const out = await checkoutWorkBranchesForJobs({
    gitExec,
    jobs: [
      { raw: 'https://example.com/a.git', repoDir: '/tmp/a' },
      { raw: 'https://example.com/b.git', repoDir: '/tmp/b' },
    ],
    plansByUrl,
    appendLog: (line) => logs.push(line),
  });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 2);
  assert.equal(out.results[0].mode, 'create_local');
  assert.equal(out.results[1].workBranch, 'feature/b');
  assert.ok(logs.some((l) => l.includes('ok repo=https://example.com/a.git')));
});
