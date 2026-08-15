import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectRepoCloneJobs,
  projectAllowsNestedClone,
} from './bootstrapRepoCredentials.mjs';

describe('projectAllowsNestedClone', () => {
  it('defaults true when flag is missing', () => {
    assert.equal(projectAllowsNestedClone({}), true);
    assert.equal(projectAllowsNestedClone(null), true);
  });

  it('treats false / 0 / "false" as disabled', () => {
    assert.equal(projectAllowsNestedClone({ auto_clone_nested_repos: false }), false);
    assert.equal(projectAllowsNestedClone({ auto_clone_nested_repos: 0 }), false);
    assert.equal(projectAllowsNestedClone({ auto_clone_nested_repos: '0' }), false);
    assert.equal(projectAllowsNestedClone({ auto_clone_nested_repos: 'false' }), false);
  });
});

describe('collectRepoCloneJobs auto_clone_nested_repos', () => {
  it('skips nested entries when project flag is false', () => {
    const jobs = collectRepoCloneJobs({
      project_repos: [
        {
          auto_clone_nested_repos: false,
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
    ]);
  });

  it('skips top-level git_repo_entries nested when any project flag is false', () => {
    const jobs = collectRepoCloneJobs({
      project_repos: [{ auto_clone_nested_repos: false, git_repos: [] }],
      git_repo_entries: [
        { url: 'https://gitlab.example/g/ram-work.git' },
        {
          url: 'https://gitlab.example/g/task2app.git',
          clone_alias: 'task2app',
          parent_repo_url: 'https://gitlab.example/g/ram-work.git',
        },
      ],
    });
    assert.deepEqual(
      jobs.map((j) => j.url),
      ['https://gitlab.example/g/ram-work.git'],
    );
  });

  it('keeps nested entries when project flag is true', () => {
    const jobs = collectRepoCloneJobs({
      project_repos: [
        {
          auto_clone_nested_repos: true,
          git_repo_entries: [
            { url: 'https://gitlab.example/g/ram-work.git' },
            {
              url: 'https://gitlab.example/g/task2app.git',
              clone_alias: 'task2app',
              parent_repo_url: 'https://gitlab.example/g/ram-work.git',
            },
          ],
        },
      ],
    });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].parentRepoUrl, 'https://gitlab.example/g/ram-work.git');
  });

  it('OPT-20260815-020: onSkippedNested fires with count when nested repos are skipped', () => {
    let skipCount = 0;
    const jobs = collectRepoCloneJobs(
      {
        project_repos: [
          {
            auto_clone_nested_repos: false,
            git_repo_entries: [
              { url: 'https://gitlab.example/g/ram-work.git' },
              {
                url: 'https://gitlab.example/g/task2app.git',
                clone_alias: 'task2app',
                parent_repo_url: 'https://gitlab.example/g/ram-work.git',
              },
              {
                url: 'https://gitlab.example/g/helper.git',
                clone_alias: 'helper',
                parent_repo_url: 'https://gitlab.example/g/ram-work.git',
              },
            ],
          },
        ],
      },
      { onSkippedNested: (n) => { skipCount = n; } },
    );
    assert.equal(skipCount, 2);
    assert.equal(jobs.length, 1);
  });

  it('OPT-20260815-020: onSkippedNested stays 0 when nothing is skipped', () => {
    let skipCount = -1;
    collectRepoCloneJobs(
      {
        project_repos: [
          {
            auto_clone_nested_repos: true,
            git_repo_entries: [{ url: 'https://gitlab.example/g/ram-work.git' }],
          },
        ],
      },
      { onSkippedNested: (n) => { skipCount = n; } },
    );
    assert.equal(skipCount, -1);
  });
});
