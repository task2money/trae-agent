/** 容器入站请求附带的评论/容器作用域（UserData 注入 COMMENT_ID / CONTAINER_NAME）。 */
export function saasInboundScopeFields(env = process.env) {
  const out = {};
  const commentId = String(env.COMMENT_ID || '').trim();
  const containerName = String(env.CONTAINER_NAME || '').trim();
  if (commentId) out.comment_id = commentId;
  if (containerName) out.container_name = containerName;
  return out;
}

/** 合并评论作用域；SaaS `resolveInboundCommentCSC` 两评论时必须有 comment_id。 */
export function withSaasInboundScope(body, env = process.env) {
  const base = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  return { ...base, ...saasInboundScopeFields(env) };
}
