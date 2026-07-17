import assert from 'node:assert/strict';
import test from 'node:test';

import { formatConfigErrMsg } from '../src/formatConfigErrMsg.mjs';

test('formatConfigErrMsg：原始 JSON not found 映射为可读的拉取配置失败文案', () => {
  assert.equal(
    formatConfigErrMsg('拉取配置失败', '{"detail":"not found"}'),
    '拉取配置失败：当前尚无配置文件，请先上传配置',
  );
});

test('formatConfigErrMsg：保留其它 detail 并加操作前缀', () => {
  assert.equal(
    formatConfigErrMsg('上传配置失败', '{"detail":"Empty file"}'),
    '上传配置失败：Empty file',
  );
});

test('formatConfigErrMsg：非 JSON 原文原样附在前缀后', () => {
  assert.equal(
    formatConfigErrMsg('拉取配置失败', 'gateway timeout'),
    '拉取配置失败：gateway timeout',
  );
});

test('formatConfigErrMsg：空响应仍给出拉取配置失败提示', () => {
  assert.equal(formatConfigErrMsg('拉取配置失败', ''), '拉取配置失败：请求失败');
  assert.equal(formatConfigErrMsg('拉取配置失败', '   '), '拉取配置失败：请求失败');
});
