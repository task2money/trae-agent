import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  collectRepoCloneJobs,
  planBootstrapCloneJobs,
} from './bootstrap.mjs';
import {
  relocateClonedRepo,
  sanitizeCloneRelPath,
  resolveRepoCloneRelPath,
} from './layerFs.mjs';

describe('sanitizeCloneRelPath', () => {
  it('keeps path segments and sanitizes each', () => {
    assert.equal(sanitizeCloneRelPath('task2app'), 'task2app');
    assert.equal(sanitizeCloneRelPath('libs/foo'), 'libs/foo');
    assert.equal(sanitizeCloneRelPath('My App/sub'), 'My-App/sub');
  });

  it('rejects traversal and absolute paths', () => {
    assert.equal(sanitizeCloneRelPath('../x'), '');
    assert.equal(sanitizeCloneRelPath('/abs'), '');
    assert.equal(sanitizeCloneRelPath('a/../b'), '');
  });
});

describe('resolveRepoCloneRelPath', () => {
  it('prefers relative alias path over url basename', () => {
    assert.equal(
      resolveRepoCloneRelPath('https://github.com/o/repo.git', 'libs/foo'),
      'libs/foo',
    );
  });
});

describe('collectRepoCloneJobs parent_repo_url', () => {
  it('reads parent_repo_url from git_repo_entries', () => {
    const jobs = collectRepoCloneJobs({
      project_repos: [
        {
          git_repo_entries: [
            { url: 'https://gitlab.example/g/ram-work.git', clone_alias: '' },
            {
              url: 'https://gitlab.example/g/task2app.git',
              clone_alias: 'task2app',
              parent_repo_url: 'https://gitlab.example/g/ram-work.git',
            },
          ],
        },
      ],
    });
    assert.deepEqual(jobs, [
      {
        url: 'https://gitlab.example/g/ram-work.git',
        cloneAlias: '',
        parentRepoUrl: '',
      },
      {
        url: 'https://gitlab.example/g/task2app.git',
        cloneAlias: 'task2app',
        parentRepoUrl: 'https://gitlab.example/g/ram-work.git',
      },
    ]);
  });
});

describe('planBootstrapCloneJobs', () => {
  it('plans nested clone into staging and final under parent', () => {
    const layerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-clone-'));
    try {
      const { jobs, stagingRoot } = planBootstrapCloneJobs(layerDir, [
        { url: 'https://gitlab.example/g/ram-work.git', cloneAlias: '', parentRepoUrl: '' },
        {
          url: 'https://gitlab.example/g/task2app.git',
          cloneAlias: 'task2app',
          parentRepoUrl: 'https://gitlab.example/g/ram-work.git',
        },
        {
          url: 'https://gitlab.example/g/docs.git',
          cloneAlias: 'docs',
          parentRepoUrl: 'https://gitlab.example/g/ram-work.git',
        },
      ]);
      assert.equal(jobs.length, 3);
      const parent = jobs.find((j) => j.raw.includes('ram-work'));
      const child = jobs.find((j) => j.raw.includes('task2app'));
      assert.ok(parent);
      assert.equal(parent.needsRelocate, false);
      assert.equal(parent.finalDir, path.join(layerDir, 'ram-work'));
      assert.ok(child.needsRelocate);
      assert.ok(child.repoDir.startsWith(stagingRoot));
      assert.equal(child.finalDir, path.join(layerDir, 'ram-work', 'task2app'));
      assert.equal(child.requireParentDir, true);
    } finally {
      fs.rmSync(layerDir, { recursive: true, force: true });
    }
  });
});

describe('relocateClonedRepo', () => {
  it('moves staging into parent path replacing empty placeholder', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reloc-'));
    try {
      const parent = path.join(root, 'ram-work');
      const placeholder = path.join(parent, 'task2app');
      const staging = path.join(root, '.bootstrap-staging', '0-task2app');
      fs.mkdirSync(placeholder, { recursive: true });
      fs.writeFileSync(path.join(placeholder, '.keep'), '');
      fs.mkdirSync(staging, { recursive: true });
      fs.mkdirSync(path.join(staging, '.git'), { recursive: true });
      fs.writeFileSync(path.join(staging, 'README.md'), 'nested');
      relocateClonedRepo(staging, placeholder);
      assert.ok(fs.existsSync(path.join(placeholder, '.git')));
      assert.equal(fs.readFileSync(path.join(placeholder, 'README.md'), 'utf8'), 'nested');
      assert.equal(fs.existsSync(staging), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
