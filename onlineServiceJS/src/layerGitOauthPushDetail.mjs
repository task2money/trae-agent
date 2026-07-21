/**
 * 多仓 OAuth 推送结果文案（父仓/嵌套子仓统一：slug + rel_prefix）。
 */

/** @param {object} r */
export function labelOauthPushRepo(r) {
  const slug = String(r?.github_slug || '').trim();
  const prefix = String(r?.rel_prefix || '').trim();
  if (slug && prefix) return `${slug}（路径 ${prefix}）`;
  if (slug) return slug;
  if (prefix) return prefix || '（层根）';
  return 'unknown';
}

/**
 * @param {object[]} repos
 * @returns {string}
 */
export function formatOauthMultiRepoPushDetail(repos) {
  const list = Array.isArray(repos) ? repos.filter(Boolean) : [];
  if (!list.length) {
    return '层内未发现可供 OAuth 推送的 Git 远程仓库（请确认 oauth_auth_by_repo 与 origin 地址一致）';
  }
  const ok = list.filter((r) => r.push_ok);
  const bad = list.filter((r) => !r.push_ok);
  const lines = [];
  if (bad.length && ok.length) {
    lines.push(`部分仓库推送未成功（成功 ${ok.length}，失败 ${bad.length}）`);
  } else if (bad.length) {
    lines.push(`推送失败（${bad.length}/${list.length}）`);
  } else {
    lines.push(`推送成功（${ok.length}）`);
  }
  for (const r of list) {
    const lab = labelOauthPushRepo(r);
    if (r.push_ok) {
      lines.push(`成功：${lab}`);
    } else {
      const why = String(r.detail || '未推送').trim().slice(0, 240);
      lines.push(`失败：${lab} — ${why}`);
    }
  }
  return lines.join('\n');
}
