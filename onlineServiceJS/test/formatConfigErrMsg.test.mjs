import assert from 'node:assert/strict';
import test from 'node:test';

import { formatConfigErrMsg } from '../src/formatConfigErrMsg.mjs';

test('formatConfigErrMsg：原始 JSON not found 映射为 traceId 排查文案', () => {
  assert.equal(
    formatConfigErrMsg('拉取配置失败', '{"detail":"not found"}'),
    '拉取配置失败，请根据traceId 寻找原因',
  );
});

test('formatConfigErrMsg：保留其它 detail 并加操作前缀', () => {
  assert.equal(
    formatConfigErrMsg('上传配置失败', '{"detail":"Empty file"}'),
    '上传配置失败：Empty file',
  );
});

test('formatConfigErrMsg：拉取失败其它 detail 附带 traceId 指引', () => {
  assert.equal(
    formatConfigErrMsg('拉取配置失败', 'gateway timeout'),
    '拉取配置失败：gateway timeout（请根据traceId 寻找原因）',
  );
});

test('formatConfigErrMsg：空响应仍给出拉取配置失败提示并附 traceId 指引', () => {
  assert.equal(
    formatConfigErrMsg('拉取配置失败', ''),
    '拉取配置失败：请求失败（请根据traceId 寻找原因）',
  );
  assert.equal(
    formatConfigErrMsg('拉取配置失败', '   '),
    '拉取配置失败：请求失败（请根据traceId 寻找原因）',
  );
});
