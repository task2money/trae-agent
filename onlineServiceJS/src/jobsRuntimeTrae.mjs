import fs from 'fs';
import path from 'path';

import { configFilePath, repoRoot, layerArtifactsDir } from './paths.mjs';
import { getJobsMap } from './jobsRuntimeState.mjs';

const PRIOR_CTX_MAX_TOTAL = 14000;
const PRIOR_CTX_MAX_TASK = 2500;
const PRIOR_CTX_MAX_FINAL = 9000;
const PRIOR_CTX_TAIL_STEPS = 12;
const PRIOR_CTX_MAX_STEP_SUMMARY = 500;

function venvTraePaths() {
  const venv = String(process.env.TRAE_VENV || path.join(repoRoot(), '.venv')).trim();
  return {
    traeCli: path.join(venv, 'bin', 'trae-cli'),
    py: path.join(venv, 'bin', 'python'),
    py3: path.join(venv, 'bin', 'python3'),
  };
}

export function buildTraeCmd(workDir, cmdText, opts = {}) {
  const { trajectoryFile, model, provider } = opts;
  const custom = String(process.env.TRAE_CLI || '').trim();
  if (custom) {
    const args = [cmdText, `--working-dir=${workDir}`];
    if (trajectoryFile) args.push(`--trajectory-file=${trajectoryFile}`);
    if (provider) args.push(`--provider=${provider}`);
    if (model) args.push(`--model=${model}`);
    return { cmd: custom, args, shell: true };
  }
  const { traeCli, py, py3 } = venvTraePaths();
  const cfg = configFilePath();
  const modelArgs = [
    ...(provider ? [`--provider=${provider}`] : []),
    ...(model ? [`--model=${model}`] : []),
  ];
  if (fs.existsSync(traeCli)) {
    const a = ['run', cmdText, `--config-file=${cfg}`, `--working-dir=${workDir}`, ...modelArgs];
    if (trajectoryFile) a.push(`--trajectory-file=${trajectoryFile}`);
    return { cmd: traeCli, args: a, shell: false };
  }
  if (fs.existsSync(py)) {
    return {
      cmd: py,
      args: [
        '-m',
        'trae_agent.cli',
        'run',
        cmdText,
        `--config-file=${cfg}`,
        `--working-dir=${workDir}`,
        ...modelArgs,
        ...(trajectoryFile ? [`--trajectory-file=${trajectoryFile}`] : []),
      ],
      shell: false,
    };
  }
  if (fs.existsSync(py3)) {
    return {
      cmd: py3,
      args: [
        '-m',
        'trae_agent.cli',
        'run',
        cmdText,
        `--config-file=${cfg}`,
        `--working-dir=${workDir}`,
        ...modelArgs,
        ...(trajectoryFile ? [`--trajectory-file=${trajectoryFile}`] : []),
      ],
      shell: false,
    };
  }
  return null;
}

/**
 * 从上一任务的 trajectory JSON 生成前置文本，注入到新 Trae 指令前以延续「会话」语义。
 * 轨迹路径约定与 runJobAsync 写入一致：layer_artifacts/{layer}/.trajectories/trajectory_{jobId}.json
 */
export function loadPriorTrajectoryContextPrefix(priorJobId) {
  const jid = String(priorJobId || '').trim();
  if (!jid) return '';
  const jobs = getJobsMap();
  const j = jobs.get(jid);
  if (!j || j.command_kind === 'clone') return '';
  let trajPath;
  try {
    trajPath = path.join(layerArtifactsDir(j.layer_id), '.trajectories', `trajectory_${jid}.json`);
  } catch {
    return '';
  }
  if (!fs.existsSync(trajPath)) return '';
  let raw;
  try {
    raw = fs.readFileSync(trajPath, 'utf8');
  } catch {
    return '';
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return '';
  }
  if (!doc || typeof doc !== 'object') return '';

  const trunc = (s, n) => {
    const t = String(s ?? '').trim();
    if (!t) return '';
    return t.length <= n ? t : t.slice(0, n - 1) + '…';
  };

  const task = trunc(doc.task, PRIOR_CTX_MAX_TASK);
  const finalResult = trunc(doc.final_result, PRIOR_CTX_MAX_FINAL);

  const steps = Array.isArray(doc.agent_steps) ? doc.agent_steps : [];
  const tail = steps.slice(-PRIOR_CTX_TAIL_STEPS);
  const stepLines = tail
    .map((s, idx) => {
      const sn = s && s.step_number != null ? s.step_number : idx + 1;
      const sum = trunc(s.delivery_summary || s.reflection || '', PRIOR_CTX_MAX_STEP_SUMMARY);
      return sum ? `- 步骤 ${sn}: ${sum}` : '';
    })
    .filter(Boolean);

  const parts = [
    '<<< PRIOR_AGENT_SESSION_CONTEXT >>>',
    '以下内容为同一工作区上一段 AI 任务的轨迹摘要，请在回答新指令时继承其中的结论与约束（除非新指令明确要求推翻）。',
    task ? `上一任务指令:\n${task}` : '',
    finalResult ? `上一任务最终结果摘要:\n${finalResult}` : '',
    stepLines.length ? `上一任务后续关键步骤:\n${stepLines.join('\n')}` : '',
    '<<< END_PRIOR_CONTEXT >>>',
  ].filter(Boolean);

  let block = parts.join('\n\n');
  if (block.length > PRIOR_CTX_MAX_TOTAL) block = block.slice(0, PRIOR_CTX_MAX_TOTAL - 1) + '…';
  return block ? `${block}\n\n` : '';
}
