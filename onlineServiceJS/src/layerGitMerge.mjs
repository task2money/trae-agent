/**
 * 层内 Git：将 source（默认当前 HEAD）合并进 target_branch。
 * 冲突时 abort 并切回源分支。
 */

/**
 * @param {object} deps
 * @param {(args: string[], cwd: string, env?: object) => Promise<string>} deps.gitExec
 * @param {string} deps.work
 * @param {string} deps.targetBranch
 * @param {string} [deps.sourceRef]
 * @returns {Promise<{ httpStatus: number, payload: object }>}
 */
export async function runLayerGitMerge(deps) {
  const gitExec = deps.gitExec;
  const work = String(deps.work || '').trim();
  const targetBranch = String(deps.targetBranch || '').trim();
  const sourceRefIn = deps.sourceRef != null ? String(deps.sourceRef).trim() : '';

  if (!work) {
    return { httpStatus: 400, payload: { detail: 'no git' } };
  }
  if (!targetBranch) {
    return { httpStatus: 400, payload: { detail: 'target_branch 必填' } };
  }

  const env = { GIT_TERMINAL_PROMPT: '0' };

  let porcelain = '';
  try {
    porcelain = await gitExec(['status', '--porcelain'], work, env);
  } catch (e) {
    return { httpStatus: 400, payload: { detail: String(e.message || e) } };
  }
  if (String(porcelain || '').trim()) {
    return { httpStatus: 400, payload: { detail: '工作区有未提交变更，请先提交后再合并' } };
  }

  let sourceRef = sourceRefIn;
  let sourceBranchName = '';
  try {
    sourceBranchName = String(await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], work, env)).trim();
  } catch (e) {
    return { httpStatus: 400, payload: { detail: String(e.message || e) } };
  }
  if (!sourceRef) {
    sourceRef = sourceBranchName === 'HEAD' ? 'HEAD' : sourceBranchName;
  }

  let sourceSha = '';
  try {
    sourceSha = String(await gitExec(['rev-parse', sourceRef], work, env)).trim();
  } catch (e) {
    return { httpStatus: 400, payload: { detail: `无法解析源引用 ${sourceRef}: ${e.message || e}` } };
  }

  if (sourceBranchName === targetBranch) {
    return {
      httpStatus: 200,
      payload: {
        ok: true,
        status: 'noop',
        detail: '当前已在目标分支，无需合并',
        source_ref: sourceRef,
        target_branch: targetBranch,
        source_sha: sourceSha,
      },
    };
  }

  // 尽量保证本地有目标分支
  let checkedOut = false;
  try {
    await gitExec(['rev-parse', '--verify', targetBranch], work, env);
    await gitExec(['checkout', targetBranch], work, env);
    checkedOut = true;
  } catch {
    try {
      await gitExec(['rev-parse', '--verify', `origin/${targetBranch}`], work, env);
      await gitExec(['checkout', '-B', targetBranch, `origin/${targetBranch}`], work, env);
      checkedOut = true;
    } catch {
      return {
        httpStatus: 400,
        payload: {
          detail: `目标分支不存在：${targetBranch}（本地与 origin/${targetBranch} 均未找到）`,
        },
      };
    }
  }
  if (!checkedOut) {
    return { httpStatus: 400, payload: { detail: `无法检出目标分支：${targetBranch}` } };
  }

  try {
    const mergeOut = await gitExec(['merge', '--no-edit', sourceSha], work, env);
    const summary = String(mergeOut || '').trim().slice(0, 2000);
    return {
      httpStatus: 200,
      payload: {
        ok: true,
        status: 'merged',
        source_ref: sourceRef,
        target_branch: targetBranch,
        source_sha: sourceSha,
        summary: summary || `merged ${sourceRef} into ${targetBranch}`,
      },
    };
  } catch (e) {
    const errMsg = String(e.message || e);
    try {
      await gitExec(['merge', '--abort'], work, env);
    } catch {
      /* ignore */
    }
    try {
      if (sourceBranchName && sourceBranchName !== 'HEAD') {
        await gitExec(['checkout', sourceBranchName], work, env);
      } else {
        await gitExec(['checkout', sourceSha], work, env);
      }
    } catch {
      /* ignore */
    }
    const isConflict = /CONFLICT|conflict|Automatic merge failed/i.test(errMsg);
    return {
      httpStatus: isConflict ? 409 : 400,
      payload: {
        detail: isConflict
          ? `合并冲突，已中止：${errMsg.slice(0, 1500)}`
          : `合并失败：${errMsg.slice(0, 1500)}`,
        source_ref: sourceRef,
        target_branch: targetBranch,
        conflict: isConflict,
      },
    };
  }
}
