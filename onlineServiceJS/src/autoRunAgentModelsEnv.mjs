/**
 * auto_run 首指令 job env overlay：从 context_pack / at_mention_run 取本副本模型。
 */

function firstAgentModelItem(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const item = raw[0];
  if (!item || typeof item !== 'object') return null;
  const model = String(item.model || '').trim();
  const provider = String(item.provider || '').trim();
  if (!model || !provider) return null;
  return { model, provider };
}

/**
 * 查找顺序：pack.agent_models → at_mention_run.agent_models → 顶层 agent_models。
 */
export function agentModelsEnvFromContextPack(detail) {
  const pack = detail?.context_pack && typeof detail.context_pack === 'object'
    ? detail.context_pack
    : {};
  const atRun = detail?.at_mention_run && typeof detail.at_mention_run === 'object'
    ? detail.at_mention_run
    : (pack.at_mention_run && typeof pack.at_mention_run === 'object' ? pack.at_mention_run : {});
  const item =
    firstAgentModelItem(pack.agent_models) ||
    firstAgentModelItem(atRun.agent_models) ||
    firstAgentModelItem(detail?.agent_models);
  if (!item) return null;
  return {
    TASK_AGENT_MODEL: item.model,
    TASK_AGENT_MODEL_PROVIDER: item.provider,
  };
}
