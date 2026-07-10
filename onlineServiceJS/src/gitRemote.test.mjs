// @ts-check
import { test } from 'node:test';
import assert from 'node:assert';
import {
  gitSshFromHttps,
  gitPushRemoteArgFromOrigin,
  normalizeRepoUrlForHttpsClone,
  parseGitSshRepoUrl,
} from './gitRemote.mjs';

test('gitSshFromHttps: github https 转 ssh', () => {
  assert.equal(gitSshFromHttps('https://github.com/AAAA/BBBB'), 'git@github.com:AAAA/BBBB.git');
  assert.equal(gitSshFromHttps('https://github.com/AAAA/BBBB.git'), 'git@github.com:AAAA/BBBB.git');
  assert.equal(gitSshFromHttps('https://www.github.com/AAAA/BBBB'), 'git@github.com:AAAA/BBBB.git');
});

test('parseGitSshRepoUrl: SCP 风格', () => {
  assert.deepEqual(parseGitSshRepoUrl('git@183.250.1.132:ljy124818167/somanyad.git'), {
    host: '183.250.1.132',
    path: 'ljy124818167/somanyad',
  });
});

test('normalizeRepoUrlForHttpsClone: 已是 https 保持', () => {
  assert.equal(
    normalizeRepoUrlForHttpsClone('http://183.250.1.132:8012/ljy/somanyad.git'),
    'http://183.250.1.132:8012/ljy/somanyad.git',
  );
});

test('normalizeRepoUrlForHttpsClone: 优先 https_clone_url', () => {
  assert.equal(
    normalizeRepoUrlForHttpsClone('git@183.250.1.132:ljy124818167/somanyad.git', {
      httpsCloneUrl: 'http://183.250.1.132:8012/ljy124818167/somanyad',
    }),
    'http://183.250.1.132:8012/ljy124818167/somanyad',
  );
});

test('normalizeRepoUrlForHttpsClone: 公有托管转 https', () => {
  assert.equal(
    normalizeRepoUrlForHttpsClone('git@github.com:AAAA/BBBB.git'),
    'https://github.com/AAAA/BBBB',
  );
  assert.equal(
    normalizeRepoUrlForHttpsClone('git@gitlab.com:group/proj.git'),
    'https://gitlab.com/group/proj',
  );
});

test('normalizeRepoUrlForHttpsClone: 自托管无 website 时保留 SSH（避免错端口）', () => {
  assert.equal(
    normalizeRepoUrlForHttpsClone('git@183.250.1.132:ljy124818167/somanyad.git'),
    'git@183.250.1.132:ljy124818167/somanyad.git',
  );
});

test('gitPushRemoteArgFromOrigin: github https 默认保持 origin（容器凭据可用）', () => {
  assert.equal(gitPushRemoteArgFromOrigin('https://github.com/AAAA/BBBB.git'), 'origin');
  assert.equal(gitPushRemoteArgFromOrigin('https://my-user@github.com/AAAA/BBBB'), 'origin');
});

test('gitPushRemoteArgFromOrigin: github https 在 preferGithubSsh=true 时转 ssh remote', () => {
  assert.equal(
    gitPushRemoteArgFromOrigin('https://github.com/AAAA/BBBB.git', { preferGithubSsh: true }),
    'git@github.com:AAAA/BBBB.git',
  );
  assert.equal(
    gitPushRemoteArgFromOrigin('https://my-user@github.com/AAAA/BBBB', { preferGithubSsh: true }),
    'git@github.com:AAAA/BBBB.git',
  );
});

test('gitPushRemoteArgFromOrigin: github ssh 输入保持可推送', () => {
  assert.equal(gitPushRemoteArgFromOrigin('git@github.com:AAAA/BBBB.git'), 'git@github.com:AAAA/BBBB.git');
  assert.equal(
    gitPushRemoteArgFromOrigin('ssh://git@github.com/AAAA/BBBB.git'),
    'git@github.com:AAAA/BBBB.git',
  );
});

test('gitPushRemoteArgFromOrigin: 非 github 维持 origin', () => {
  assert.equal(gitPushRemoteArgFromOrigin('https://gitlab.com/AAAA/BBBB.git'), 'origin');
  assert.equal(gitPushRemoteArgFromOrigin(''), 'origin');
});

test('gitPushRemoteArgFromOrigin: github https 默认保持 origin（容器凭据可用）', () => {
  assert.equal(gitPushRemoteArgFromOrigin('https://github.com/AAAA/BBBB.git'), 'origin');
  assert.equal(gitPushRemoteArgFromOrigin('https://my-user@github.com/AAAA/BBBB'), 'origin');
});

test('gitPushRemoteArgFromOrigin: github https 在 preferGithubSsh=true 时转 ssh remote', () => {
  assert.equal(
    gitPushRemoteArgFromOrigin('https://github.com/AAAA/BBBB.git', { preferGithubSsh: true }),
    'git@github.com:AAAA/BBBB.git',
  );
  assert.equal(
    gitPushRemoteArgFromOrigin('https://my-user@github.com/AAAA/BBBB', { preferGithubSsh: true }),
    'git@github.com:AAAA/BBBB.git',
  );
});

test('gitPushRemoteArgFromOrigin: github ssh 输入保持可推送', () => {
  assert.equal(gitPushRemoteArgFromOrigin('git@github.com:AAAA/BBBB.git'), 'git@github.com:AAAA/BBBB.git');
  assert.equal(
    gitPushRemoteArgFromOrigin('ssh://git@github.com/AAAA/BBBB.git'),
    'git@github.com:AAAA/BBBB.git',
  );
});

test('gitPushRemoteArgFromOrigin: 非 github 维持 origin', () => {
  assert.equal(gitPushRemoteArgFromOrigin('https://gitlab.com/AAAA/BBBB.git'), 'origin');
  assert.equal(gitPushRemoteArgFromOrigin(''), 'origin');
});
