/**
 * 环境变量日志脱敏：用于 init.log / feature-params-env.log。
 * 默认关闭（与历史「原值落盘」一致）；开启后对 token/api_key 等敏感键与嵌套 JSON 字段打码。
 */

const SENSITIVE_KEY_RE =
  /(^|_)(access_token|refresh_token|id_token|api_?key|client_secret|password|passwd|secret|authorization|credential|private_key|proxy_token)(_|$)/i;

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isTruthyEnvFlag(raw) {
  return ['1', 'true', 'yes', 'on'].includes(String(raw ?? '').trim().toLowerCase());
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveEnvKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || '').trim());
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function redactSecretValue(value) {
  const s = String(value ?? '');
  if (!s) return '(empty)';
  return `(redacted len=${s.length})`;
}

/**
 * 递归脱敏对象/数组中的敏感字段；无法解析的 JSON 字符串原样返回。
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactNestedValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactNestedValue(item));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveEnvKey(k)) {
        out[k] = redactSecretValue(v);
      } else {
        out[k] = redactNestedValue(v);
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try {
        const parsed = JSON.parse(text);
        return JSON.stringify(redactNestedValue(parsed));
      } catch {
        return value;
      }
    }
  }
  return value;
}

/**
 * @param {Record<string, string>} envSnapshot
 * @param {boolean} enabled
 * @returns {Record<string, string>}
 */
export function redactEnvSnapshot(envSnapshot, enabled) {
  const source = envSnapshot && typeof envSnapshot === 'object' ? envSnapshot : {};
  if (!enabled) {
    return { ...source };
  }
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (isSensitiveEnvKey(key)) {
      out[key] = redactSecretValue(value);
      continue;
    }
    const nested = redactNestedValue(value);
    out[key] = typeof nested === 'string' ? nested : String(nested);
  }
  return out;
}
