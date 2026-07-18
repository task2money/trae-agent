import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repoDirNameFromUrl, resolveRepoCloneDirName, sanitizeCloneDirName } from './layerFs.mjs';
import { collectRepoCloneJobs } from './bootstrap.mjs';

describe('repoDirNameFromUrl', () => {
  it('parses https and scp urls', () => {
    assert.equal(repoDirNameFromUrl('https://github.com/acme/somanyad.git'), 'somanyad');
    assert.equal(repoDirNameFromUrl('https://github.com/acme/somanyad-emailD.git'), 'somanyad-emailD');
  });

  it('parses scp-style urls', () => {
    assert.equal(
      repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad.git'),
      'somanyad',
    );
    assert.equal(
      repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad-emailD.git'),
      'somanyad-emailD',
    );
  });

  it('keeps distinct names for sibling repos', () => {
    const a = repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad.git');
    const b = repoDirNameFromUrl('git@183.250.1.132:ljy124818167/somanyad-emailD.git');
    assert.notEqual(a, b);
  });
});

describe('resolveRepoCloneDirName', () => {
  it('prefers clone alias over url-derived name', () => {
    assert.equal(
      resolveRepoCloneDirName('https://github.com/acme/somanyad.git', 'my-app'),
      'my-app',
    );
  });

  it('sanitizes alias and falls back when empty after sanitize', () => {
    assert.equal(sanitizeCloneDirName('My App!!'), 'My-App');
    assert.equal(
      resolveRepoCloneDirName('https://github.com/acme/somanyad.git', '---'),
      'somanyad',
    );
  });
});

describe('collectRepoCloneJobs', () => {
  it('reads git_repo_entries with clone_alias', () => {
    const jobs = collectRepoCloneJobs({
      project_repos: [
        {
          project_id: 'p1',
          git_repos: ['https://github.com/o/a.git'],
          git_repo_entries: [
            { url: 'https://github.com/o/a.git', clone_alias: 'custom-a' },
            { url: 'https://github.com/o/b.git', clone_alias: '' },
          ],
        },
      ],
    });
    assert.deepEqual(jobs, [
      { url: 'https://github.com/o/a.git', cloneAlias: 'custom-a', parentRepoUrl: '' },
      { url: 'https://github.com/o/b.git', cloneAlias: '', parentRepoUrl: '' },
    ]);
  });

  it('falls back to git_repos strings when entries absent', () => {
    const jobs = collectRepoCloneJobs({
      project_repos: [{ git_repos: ['https://github.com/o/plain.git'] }],
    });
    assert.deepEqual(jobs, [
      { url: 'https://github.com/o/plain.git', cloneAlias: '', parentRepoUrl: '' },
    ]);
  });
});
