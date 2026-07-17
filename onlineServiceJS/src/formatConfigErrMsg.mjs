/**
 * 将 /api/config 失败响应体格式化为控制台 #cfgErr 可读文案。
 * @param {string} actionLabel 如「拉取配置失败」「上传配置失败」
 * @param {string} rawText 原始响应文本
 * @returns {string}
 */
export function formatConfigErrMsg(actionLabel, rawText) {
  const prefix = String(actionLabel || '操作失败').trim() || '操作失败';
  let detail = String(rawText ?? '').trim();
  if (detail) {
    try {
      const j = JSON.parse(detail);
      if (j && j.detail !== undefined) {
        detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
      }
    } catch {
      /* 非 JSON：保留原文 */
    }
  }
  detail = String(detail || '').trim();
  if (!detail) detail = '请求失败';
  else if (/^not found$/i.test(detail)) {
    detail = '当前尚无配置文件，请先上传配置';
  }
  return prefix + '：' + detail;
}
