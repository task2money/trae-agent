# Trae Online Service Skill（Node / onlineServiceJS）

面向自动化代理与工具的说明：如何通过 HTTP 调用本仓库中的 **onlineServiceJS**（Express / Node.js），推送配置、克隆远程仓库到可写层、在分层工作区中执行 `trae-cli run`（或 shell）、浏览层内文件与任务，并通过 SSE 订阅事件。

路径与字段名与任务云及历史约定对齐，便于编排与脚本复用；未列出的行为以 `src/server.mjs` 及对应模块实现为准。

## 环境变量

| 变量 | 说明 |
|------|------|
| `ACCESS_TOKEN` | **必填**。所有受保护接口须携带与此相同的令牌（查询参数或 Header）。未配置时受保护路由会拒绝访问。 |
| `REPO_ROOT` | 可选。Trae 仓库根目录，默认 **onlineServiceJS 的上一级目录**。 |
| `ONLINE_PROJECT_STATE_ROOT` | 可选。运行时状态根目录（其下含 `runtime`、`logs`、`reqLogs` 等），默认 `{REPO_ROOT}/onlineProject_state`。 |
| `TRAE_VENV` | 可选。含 `trae-cli` 的虚拟环境根路径，默认 `{REPO_ROOT}/.venv`；通过 `{TRAE_VENV}/bin/trae-cli`（及同目录 `python` / `python3` 的 `-m trae_agent.cli`）解析命令。 |
| `TRAE_CLI` | 可选。若设置，则 **`command_kind=trae`** 时直接以该可执行文件运行，参数形如：`<命令文本> --working-dir=<层目录>`（不再拼接 `--config-file`，由可执行文件自身或环境决定）。 |
| `ONLINE_PROJECT_LAYERS` | 可选。可写层根目录，默认 `{REPO_ROOT}/onlineProject_state/layers`。 |
| `PORT` | 可选。HTTP 监听端口，默认 **8765**。 |
| `CODE_SERVER_ENABLED` | 可选。设为 `1`/`true` 时在容器内后台启动 **code-server**（VS Code Web），监听 **8888**；工作目录见 `CODE_SERVER_WORKDIR`（默认 `/app`）。`--auth none`，仅适合受控环境。 |
| `CODE_SERVER_WORKDIR` | 可选。code-server 打开的根目录，默认 `/app`（含 `trae_agent` 与 `onlineServiceJS`）。 |

### 网络与宿主机端口（重要）

| 启动路径 | Docker 网络 | 宿主机如何访问容器内端口 |
|---------|-------------|-------------------------|
| **云 VM UserData**（镜像市场模板 → `/root/init_from_task2app.sh`） | 平台「生成容器脚本」硬编码 **`--network host`**，**无 `-p`** | 与宿主机同网卡命名空间；`HOST_PORT`/`BUSINESS_HOST_PORT`（默认 8765）只用于脚本内监听探测与 `BUSINESS_API_ENDPOINT=http://<公网IP>:端口/api` 推导，**不是** `docker -p` |
| `go_run_container` / `go_relayToTrae` 选镜像 | **`--network host`** | 同上（本地/模拟对齐云路径） |
| 本机 `run.sh` 且 `TRAE_ONLINE_JS_DOCKER=1` | bridge + **仅** `-p 127.0.0.1:${HOST_PORT}:${PORT}` | **只映射 onlineServiceJS 的 HTTP 口**；**不会**自动 publish 容器内再拉起的 runAll/业务端口（9999/8003 等） |

**UserData 核对要点**（机器节点真实启动面）：

1. 外层：cloud-init 执行包装脚本，把用户模板 + verify 写入并执行 `/root/init_from_task2app.sh`（见 `taskCloudService` `userdata_build.go` / Django `userdata_verification.py`）。
2. 内层 `docker run`：以绑定到该区域运行环境的 **`marketplace_userdatatemplate.content`** 为准；平台生成器在 `taskAiProvider/.../userDataScriptLinux.js`（及 Windows 对应文件）写死 `run -d --network host`。
3. RunInstances 前占位符替换（镜像/token/`__TASK2APP_TASK_CLOUD_PREFIX__` 等）**不会**改写 `--network` / 注入 `-p`。
4. **风险**：厂商手写/改过的模板若去掉 `--network host` 又未加 `-p`，则容器内 `curl 127.0.0.1:8003` 仍可能成功，但物理机公网 IP 访问不到——排查时先 `grep -E 'docker run|--network|-p ' /root/init_from_task2app.sh`。

因此：在任务云 / mockStart / relay / **标准 UserData** 场景下，日志里 health OK 并不代表「缺端口桥接」——桥接已由 host 网络完成；若从物理机访问失败，优先核对 **进程是否仍监听**、**安全组**，以及 **该节点 UserData 是否仍含 `--network host`**。

### 端口可达性诊断（OPT-20260718-024）

当容器内服务 health check 正常但外部无法访问时，可在 onlineServiceJS 控制台执行以下诊断：

1. **查看当前监听端口**：容器内 `ss -tlnp` 或 `netstat -tlnp`（需容器有对应工具）
2. **容器内自检**：`curl -sI http://127.0.0.1:<PORT>/healthz`（验证进程存活）
3. **宿主机可达性**：从宿主机执行 `curl -sI http://127.0.0.1:<PORT>/healthz`（host 网络下应可达）
4. **公网可达性**：从外部机器执行 `curl -sI http://<公网IP>:<PORT>/healthz`（验证安全组/防火墙）

已知证据：任务 `task_13464457269667337872` 上 agent 曾对 `*:9999/8003/8004` LISTEN 做 health OK；事后进程退出后公网仅剩 `8765/8888/9998/8796`。host 网络本身正常——问题在于端口对应的**进程生命周期**而非网络桥接。

未来可增加控制台「诊断端口可达性」按钮，一键执行上述步骤并展示结果。

Dockerfile 基于 **ubuntu:24.04**（可通过构建参数 `BASE_IMAGE` / 环境变量 `DOCKER_BASE_IMAGE` 覆盖；`buildDocker.sh` 在 docker.io 经损坏的 registry-mirror 解析失败时会自动回退到镜像站全限定名）。多阶段构建 Python venv；主软件源见 `onlineServiceJS/Dockerfile` 头部注释。系统 Python 为 3.12，业务 venv 为 `/app/.venv`。构建参数 `ENABLE_CODE_SERVER=0` 可跳过 code-server 以缩短构建时间。

容器换票、引导克隆等仍可使用：`TaskApiEndPoint`、`BusinessApiEndPoint`、`BUSINESS_API_ENDPOINT`、`tenantId`、`workspaceId`、`taskId`、`ACCESS_TOKEN`（与任务云约定一致；**完整协议**见 `task2app/Saas_project/skillList/machine_container.md`）。**`TaskApiEndPoint` 推荐**为 `…/api/tenant/…/workspace/…/task/…/cloud`；**容错**：`saasTaskCloud.mjs` 的 `taskApiPrefix()` 亦可从 pathname 解析 **`/tenant/…/task-detail/<task>/`**（浏览器任务详情页 URL）及 **`/api/…/task-detail/<task>`**，避免未设三环境变量时换票失败、`container_refresh_token` 不落库。**启动就绪日志**：标准输出含 **`[onlineServiceJS] server listening on http://0.0.0.0:<PORT>`**，供编排检测。监听成功后**先** `register-reachability`（写入 `server_url`）并启动 **SaaS 心跳**，再**异步**执行引导克隆与 `service_config.yaml` 写入，避免长时间 `git clone` 阻塞任务详情拉层图与心跳。

**功能参数 env 拉取与注入**：bootstrap 成功 POST `…/server-container-token/feature-params-env/` 后，将返回的 `env`：

1. **写入 `process.env`**（含用户 `extra_env_vars` 与只读 `TASK_FEATURE_PARAMS_SCOPE` / `CONFIG_ID` / `CONFIG_NAME`），供后续 `trae-cli` / bash 子进程继承
2. 快照追加写入 **`{ONLINE_PROJECT_STATE_ROOT}/logs/feature-params-env.log`**（单行 JSON，`event=onlineServiceJS.feature_params_env`）
3. 向标准输出打印两行：
   - **短摘要**（便于启动日志面板检索）：`[onlineServiceJS] feature-params-env pulled: keys=… count=N`
   - **完整快照**：`[onlineServiceJS] feature-params-env pulled: {…}`
4. 再转为 `service_config.yaml`

`go_relayToTrae` 会转发子进程 stdout 到 `/v1/status` 的 `logs`（及 SSE status-push），因此任务详情「启动日志」面板可直接看到上述行。写日志失败不阻断 YAML 落盘。启动时进程环境快照仍见 **`logs/init.log`**（可选白名单 `INIT_LOG_ENV_KEYS`）；注意 init.log 在 listen 时落盘，**早于** feature-params 拉取，故 SCOPE 等键以 `feature-params-env pulled` 行为准。

**可选脱敏**（默认关闭，与历史原值落盘一致）：

| 变量 | 作用 |
|------|------|
| `FEATURE_PARAMS_ENV_LOG_REDACT=1` | 仅脱敏 `feature-params-env.log` / 对应 stdout |
| `INIT_LOG_REDACT=1` | 仅脱敏 `init.log` |
| `ENV_LOG_REDACT=1` | 同时开启上述两类脱敏 |

开启后，`ACCESS_TOKEN` / `*_TOKEN` / `api_key` / `*_SECRET` 等键值记为 `(redacted len=N)`；`TASK_LLM_PROVIDERS_JSON` 内嵌 `api_key` 亦会打码。JSON 记录含 `"redact": true|false`。

运行时与任务行为还可通过环境变量调节（见 `src/jobsRuntime.mjs`、`src/bootstrap.mjs`）；克隆相关常见有 `GIT_CLONE_TIMEOUT_SEC` 等（以代码为准）。

配置文件固定路径：`onlineProject_state/runtime/service_config.yaml`（由 API 写入；内容与仓库根目录 `trae_config.yaml.example` 同结构）。任务状态持久化：`onlineProject_state/runtime/jobs_state.json`。Docker 镜像内示例：`/app/trae_config.yaml.example`。

## 推荐调用顺序

1. `POST /api/config`（或 `POST /api/config/raw`）推送有效 YAML。
2. 若需真实执行 Trae：确保存在 **`trae-cli`**（`TRAE_VENV` 或 `TRAE_CLI`）；否则 Node 版会对 **`command_kind=trae`** 走**占位 stub**（见下文「功能与限制」）。
3. `POST /api/repos/clone` 将远程仓库克隆到**新的**可写层（需系统已安装 `git`）。
4. 再 `POST /api/jobs` 创建任务（须满足任务门控；且 **必须** 提供 `parent_job_id` 或 `repo_layer_id` 之一，见下文）。

## 公开端点（无需令牌）

| 路径 | 说明 |
|------|------|
| `GET /skill.md` | 本 Skill 文档（Markdown，`text/markdown; charset=utf-8`）。 |
| `GET /healthz` | 探活。正常返回 `{ status: "ok", token_bootstrap: "ok" }`。容器换票失败且非 `TASK_API_BOOTSTRAP_STRICT_STARTUP` 时进入 **fail-closed**：本接口与受保护 `/api/*`、`/ui/*` 均返回 **503**，`error_code=TOKEN_BOOTSTRAP_FAILED`（进程仍监听端口，但不对外提供无效 token 下的业务 API）。无 TaskApi 前缀的本地 intentional skip **不**触发 fail-closed。 |

**说明**：本服务**不提供** `GET /docs`、`GET /openapi.json`；请以本文档与 `src/server.mjs` 为准。

## 受保护 API 的认证

以下任一方式：

- 查询参数：`?access_token=<ACCESS_TOKEN>`
- 请求头：`X-Access-Token: <ACCESS_TOKEN>`

换票失败 fail-closed 时，即使携带与 `ACCESS_TOKEN` 相同的值也会收到 **503** `TOKEN_BOOTSTRAP_FAILED`（避免平台 by-scope 有效 token 与容器无效 env 长期不一致、全线 401）。

## 配置

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/config` | `multipart/form-data`，字段名 `file`，内容为 YAML。校验通过后写入 `service_config.yaml`。 |
| `POST` | `/api/config/raw` | 查询参数 `yaml=`（仅适合较短内容；大文件请用 multipart）。 |
| `GET` | `/api/config` | 返回 `path`、`yaml` 与 `source`（`local` \| `saas`）。本地无 `service_config.yaml` 时回源 SaaS `feature-params-env` 落盘后再返回；回源不可用或失败则 404/502。 |

## 远程仓库克隆

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/repos/clone` | JSON：`url`（必填），`branch`、`depth`、`ssh_identity_file`、`ephemeral_ssh_private_key`、`parent_layer_id`（可选）。在新可写层目录内执行 `git clone`；成功返回 202 Accepted，响应体含 `accepted: true`、`status: "queued"`、`layer_id`、`layer_path`、`queue_position`。失败时 400，响应体可含 `exit_code`、`detail`。克隆过程与结果可通过 SSE 推送（见下文）。 |
| `GET` | `/api/repos/clone-status/:layer_id` | 查询克隆操作状态，返回 `layer_id` 和状态信息。 |

- **`ssh_identity_file`**（可选）：服务器本机可读 SSH **私钥文件路径**（绝对或相对路径经 `path.resolve`）。存在且为普通文件时，设置 `GIT_SSH_COMMAND`；HTTPS 远程会转为 `git@host:…` 以便走 SSH。路径无效时 **400**。
- **`ephemeral_ssh_private_key`**（可选）：单次请求 PEM/OpenSSH 私钥文本。仅当内容**同时**含 `-----BEGIN…PRIVATE KEY-----` 与 `-----END…KEY-----` 时才视为有效；**否则忽略**（避免 UI/localStorage 残留非 PEM 文本时误把公开 HTTPS 转成 `git@` 导致克隆失败）。有效时行为同前（临时文件、`GIT_SSH_COMMAND`、HTTPS 可转 SSH）。
- **`branch` / `depth`**：传入时分别对应 `git clone --branch`、`--depth`（正整数）；不传则由 `git` 默认行为决定。
- **`parent_layer_id`**（可选）：写入新层 `layer_meta.json` 的父指针。
- 容器引导多仓克隆（`task_api_bootstrap`）逻辑在 `src/bootstrap.mjs`；持有 PEM 时使用临时密钥与 `GIT_SSH_COMMAND`（细节以代码为准）。**nested 子仓**（`git_repo_entries[].parent_repo_url`）先克隆到 `.bootstrap-staging/`，成功后再移入 `{父仓目录}/{clone_alias path}`。克隆成功后按 task-detail 的 `target_branch` / `repo_branch_plans` 将各仓切换到工作分支（`bootstrapWorkBranch.mjs`）。**单仓/多仓克隆失败不阻断引导**：记录失败并继续 feature-params / `BOOTSTRAP_COMPLETE`，业务端点保持就绪；失败仓可 `POST /api/repos/reclone`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/repos/reclone` | JSON：`repo_url`（必填）、`clone_alias` / `parent_repo_url`（可选，子仓）、`ephemeral_ssh_private_key`（可选）。在引导层（或首个含 git 的层）内先 staging `git clone`，成功后再移入目标路径（子仓为 `{父仓目录}/{alias path}`）。SSH URL 在有 OAuth 凭证时规范为 `https_clone_url` 再 HTTPS 克隆（与 bootstrap 一致）。 |

## 执行流（Exec Streams）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/exec-streams/:kind/:resourceId/manifest` | 通用执行流总览，返回分片列表（JSON）。`kind` 和 `resourceId` 需符合验证规则。 |
| `GET` | `/api/exec-streams/:kind/:resourceId/segments/:seq` | 获取执行流指定序列的分片，返回分片内容（JSON）。 |

## 任务门控

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/requirements/task-gate` | 返回 `clone_done`（布尔）：可写层根下是否**至少存在一个含 `.git` 的层**。 |

## 任务（指令）

### 创建与查询

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/jobs` | JSON：`command`（必填）、`command_kind`（`trae` \| `shell`，默认 `trae`）、`parent_job_id`（可选）、`repo_layer_id`（可选）、`prior_context_job_id`（可选）、`git_branch`（可选）、`env`（可选）。 |
| `GET` | `/api/jobs` | 返回 `{ "jobs": [ ... ] }`。字段含 `git_destructive_locked`：**当前恒为 `false`**（未实现基线锁定）。 |
| `GET` | `/api/jobs/{job_id}` | 单条任务详情。 |
| `GET` | `/api/jobs/{job_id}/parent` | 父任务：`parent` 为对象或 `null`。 |
| `GET` | `/api/jobs/{job_id}/steps` | 仅从 **`ONLINE_PROJECT_STATE_ROOT`** 读取：`runtime/layer_artifacts/{layer_id}/.trajectories/trajectory_*.json`（`agent_steps`）与 `runtime/job_logs/trae_agent_json/{job_id}/step_*/agent_step_full.json`（或 `agent_step.json`）；**不**扫层工作区目录。无数据时 `steps` 为空并附 `note`。Query：`after_step`（仅 `step_number > after_step`）、`limit`（1–50；**省略则返回全部**，兼容旧客户端）。分页响应额外含 `total_steps` / `has_more` / `next_after_step`。SaaS 任务详情应按步拉取，勿依赖 `GET /api/jobs/{id}` 内嵌全量 `output`。 |

### `POST /api/jobs` 行为说明

- **前置**：`command_kind=trae` 时需存在有效 `service_config.yaml`；且全局已有至少一层含 `.git`。
- **必须且仅能**设置 `parent_job_id` 或 `repo_layer_id` 之一（二者都空或都非空会 400）。**不支持**在二者皆无时自动新建空根层再执行。
- **`parent_job_id`**：从父任务对应层**叠新层**（`createStackedLayer`）；叠层前会按与 Web 串行列表相同的 **created_at 序** 删除**该锚点层之后的全部可写层**（含其任务与目录），再 **purge** 该父层在磁盘上的直接子层。服务端会将 **`prior_context_job_id` 设为该父任务 id**（用于下文 Trae 上下文注入）。
- **`repo_layer_id`**：从指定层叠新层；同样先删串行序中该层**之后**的层，再清理该层的直接子层。可选 **`prior_context_job_id`**：指向任意已有任务 id；若该任务在 `runtime/layer_artifacts/{其 layer_id}/.trajectories/trajectory_{该任务 id}.json` 下有轨迹文件，则 **`command_kind=trae`** 时在启动前把轨迹摘要**前缀**拼入传给 CLI 的指令正文（任务记录里的 `command` 字段仍仅存用户原始指令）。队列「当前任务结束后」自动创建的下一任务会带上**刚结束任务**的 id 作为 `prior_context_job_id`。
- **`prior_context_job_id` 与旧数据**：若持久化任务缺少该字段但已有 `parent_job_id`，运行时仍会按 `parent_job_id` 尝试加载上一轨迹摘要。
- **`git_branch`**：请求体可携带，**当前未在启动前执行 `git checkout`**（字段预留）。
- **`command_kind=trae`**：优先 `TRAE_CLI`，否则 `{TRAE_VENV}/bin/trae-cli`，否则 venv 内 `python -m trae_agent.cli run …`；若均不可用，则 **stub**：`bash -lc` 输出占位说明并以 0 退出。
- **`command_kind=shell`**：在层工作目录 `bash -lc` 执行全文。

### 运行中控制与清理

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/jobs/{job_id}/interrupt` | 向子进程发送 `SIGTERM`；运行中记为 `interrupted`。 |
| `POST` | `/api/task-lifecycle/shutdown` | 终态优雅关停：中断 running/pending jobs → layer-graph-push → `request-machine-release` → 退出进程；立即 **202**。 |
| `POST` | `/api/jobs/{job_id}/redo` | **501**，正文含 `detail` 说明（未实现删层重建并重跑）。 |
| `POST` | `/api/jobs/{job_id}/continue` | **501**（未实现中断后继续）。 |
| `DELETE` | `/api/jobs/{job_id}` | 删除任务记录并删除该任务对应可写层目录（实现见 `deleteJob`）。 |
| `POST` | `/api/jobs/reset` | 清空任务、删除已知层目录；**未删除** `commands.json`、`job_events/`、`materialized*` 等；响应含 `jobs_cleared`、`layers_removed`。 |

任务状态取值：`pending`、`running`、`completed`、`failed`、`interrupted`。记录中含 `layer_id`、`layer_path`、`command`、`parent_job_id`、`repo_layer_id`、`prior_context_job_id`（可为 `null`）、`output`、`exit_code`、`created_at` 等。

## 可写层与文件

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/layers` | 列出可写层（**不含** `meta_kind=empty` 锚点）。每层含 `git_worktree_dirty` 与 `git_remote`（`is_git`/`ahead`/`no_upstream`/`upstream`/`current_branch`）。**网关转发**亦可使用 scoped 形态 `/api/tenant/{t}/workspace/{w}/task/{task}/layers`（入站 rewrite 到本路径；访问日志保留 scoped `originalUrl`）。 |
| `GET` | `/api/layers/empty-root` | 返回空层锚点 `layer_id`。 |
| `GET` | `/api/layers/{layer_id}/files` | 层内文件扁平列表。查询 `max_files`（1–5000）。响应 `{ files, truncated, max_files }`：先种子化全部顶层再 BFS 补齐，跳过 `node_modules` 等；空目录可为 `dirname/` 标记；触顶时 `truncated=true` 且顶层仍应可见。 |
| `GET` | `/api/layers/{layer_id}/files/{file_rel_posix}` | 读取单文件；支持 `max_bytes` 等（见路由实现）。 |
| `GET` | `/api/layers/{layer_id}/children` | 列目录子项；查询参数 `dir` 等。 |
| `GET` | `/api/layers/{layer_id}/diff/parent` | **未提供**该路由（无目录树全文 diff）；变动请用 `diff/parent/files` 与 `diff/parent/file`。 |
| `GET` | `/api/layers/{layer_id}/diff/parent/files` | 相对父层工作目录的条目对比列表（`added`/`removed`/`modified`），见 `layerParentDiff.mjs`；无父层时 `detail` 说明。可选查询 `offset`/`limit`（limit 上限 500）分页，响应含 `change_count`/`next_offset`/`has_more`；未传 `limit` 时仍返回全量。 |
| `GET` | `/api/layers/{layer_id}/diff/parent/file` | 查询参数 **`path`**：单路径文本 diff（或二进制提示）；无父层 **400**。 |
| `DELETE` | `/api/layers/{layer_id}` | 删除该层及其直接子层（自底向上顺序见 `deleteLayerTree`）。 |
| `POST` | `/api/layers/{layer_id}/queue` | 向指定层添加队列项，返回创建结果。 |

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/repos/clone-log/{layer_id}` | 克隆过程文本日志（内存缓冲）。 |
| `GET` | `/api/repos/bootstrap-clone-log` | 引导批量克隆日志。JSON：`text`（整段，与任务详情仓库顺序拼接）+ 多仓并行克隆进行中时另含 **`segments`**: `[{ repo_url, text }]`，与 SaaS/任务页按仓折叠对齐。浏览器/`api()` 调用须带 `X-Trace-Id` **且** `X-Parent-Span-Id`（或 `traceparent`）；仅 `X-Trace-Id` 会被 `traceMiddleware` 以 400 拒绝。 |
| `POST` | `/api/project/view` | JSON：`layer_id`。**仅返回 JSON** `status`/`active_tip_layer_id` 占位，**不保证**更新 `onlineProject` 符号链接。 |
| `GET` | `/api/project/active` | 返回 `bootstrap_layer_id` 与 `note`（简化实现）。 |

### 空层锚点（`layer_meta.kind=empty`）

- 服务启动时保证存在 **empty** 锚点目录；**`GET /api/layers` 不列出**这些层。
- 克隆通过 `GET /api/layers/empty-root` + `POST /api/repos/clone` 的 `parent_layer_id` 挂载到锚点。

## 层内 Git

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/layers/{layer_id}/git/log` | 提交日志文本。Query：`path`（文件树相对路径）、`limit`（1–100）。响应：`text`、`commits`（可空）、`is_repo_root`（点击目录是否为仓库根）、可选 `current_branch`（仅仓库根且读 HEAD 成功时）。 |
| `GET` | `/api/layers/{layer_id}/git/branches` | **未实现**（列分支）。 |
| `POST` | `/api/layers/{layer_id}/git/commit` | `git add -A` 与 `git commit -m`。 |
| `POST` | `/api/layers/{layer_id}/git/push` | `git push`；支持 `ephemeral_ssh_private_key`、`target_branch`（与 clone 类似）。 |
| `POST` | `/api/layers/{layer_id}/git/merge` | 本地将当前 HEAD（或 `source_ref`）合并进 `target_branch`（合并目标）。工作区须干净；冲突返回 409 并 abort。 |
| `GET` | `/api/layers/{layer_id}/git/commit/latest-log` | `git log -1 --stat` 文本。 |
| `POST` | `/api/layers/{layer_id}/git/diff-log` | 对指定文件列表生成当前不同于已提交内容的 diff 日志及 AI 总结。JSON 体：`files`（字符串数组，必填）。返回 `files`（每个文件的 diff 详情）、`log`（合并后的原始 diff 日志文本）、`summary`（AI 生成的变更总结，若未配置 LLM 则为启发式描述）、`changed_files_count`（变更文件数量）。支持多仓库路径前缀解析。 |
| `GET` | `/api/layers/{layer_id}/git/repo-identities` | **只读**：路径参数 `layer_id` 为当前选中的可写层（与任务详情层级图、`POST /api/jobs` 锚点一致）。响应 JSON：`layer_id`；`repos` 为数组，每项对应 `src/layerFs.mjs` 中 `layerGitWorkdirRootsForFileListing` 枚举的一个 Git 工作区（多仓并列时含 `rel_prefix` 目录名）：`rel_prefix`（顶层单仓时多为空字符串）、`origin_url`（`git config --get remote.origin.url`，无则空）、`repo_match_key`（由 `origin_url` 推导，与任务详情前端 `gitCloneRefMatchKey` 一致，用于与任务关联仓库 URL 对齐；无 `origin_url` 时为空）、`user_name` / `user_email`（`git config --get user.name` / `user.email`，未设置时为空字符串）、`error`（仅当该路径非有效 git 工作区或异常时存在）。层目录不存在时 **404** `{ "detail": "layer not found" }`。认证同其它受保护 API。SaaS 经 `GET /api/tenant/{tenant}/workspace/{workspace}/task/{task}/cloud/compute/container-layer-git-repo-identities/?layer_id=…` 转发到容器本路径。 |
| `POST` | `/api/layers/{layer_id}/git/repo-identities/sync` | **接口 A（层级多仓 Git 身份同步）**：将请求体中按 `repo_match_key` 指定的 `user.name` / `user.email` 写入该 `layer_id` 下各匹配 Git 工作区的 **本地** config（`git config --local`）。JSON 体：`repos` 为非空数组，每项须含非空字符串 `repo_match_key`（与 `GET …/repo-identities` 返回值及 `remote.origin.url` 推导键一致）、`user_name`、`user_email`。对层内每个存在 `.git` 且 `repoMatchKeyFromUrl(remote.origin.url)` 命中 `repos` 中某条的仓库执行写入；未命中任何工作区的键在 `results` 中返回 `ok: false` 及 `detail`。全部成功时 **200** JSON：`ok: true`、`layer_id`、`applied_count`、`results`（每项含 `repo_match_key`、`rel_prefix`、`ok`，失败时含 `detail`）。部分失败时 **207**（Multi-Status），`ok: false`，`results` 混合成功与失败。`repos` 非法或无法解析出任何有效条目时 **400**。层不存在 **404**。SaaS 经 `POST /api/tenant/{tenant}/workspace/{workspace}/task/{task}/cloud/compute/container-layer-git-repo-identities-sync/` 接收 `layer_id`、`repos: [{ repo_url, identity_id }]`（由后端校验身份归属并解析为上述 `repo_match_key` + 姓名邮箱后转发容器）。 |
| `GET` | `/api/git/identity` | **占位**：固定返回空 `user.name` / `user.email`。 |
| `POST` | `/api/git/identity` | **占位**：返回 `ok`，**未**持久化到 git config。 |

## 任务云（SaaS）`git-clone-progress` 与 `segment`

- **实现**：`src/saasTaskCloud.mjs` 中 `postCloneProgress` → `POST <TaskApi 前缀>/server-container-token/git-clone-progress/`。引导克隆见 `src/bootstrap.mjs`，单仓重克隆见 `src/server.mjs`（`POST /api/repos/reclone` 的后台任务）。
- **多路并行标记**：每份 POST 体除 `access_token`、`progress`（0–100）、`message` 外，含**顶层** `repo_url`（可选）与对象 **`segment`**。`segment` 与 `GET /api/repos/bootstrap-clone-log` 的 `segments[].repo_url` 使用**相同** URL 串，供 SaaS 与任务详情页、SSE 对齐。
- **`segment` 常用字段**（由容器填写，Django 白名单透传并规范化）：

| 字段 | 说明 |
|------|------|
| `kind` | `repo`：本事件绑定单一仓库；`global`：与单仓无关的总述（如「开始并行克隆」「全部完成」）。 |
| `repo_url` | 与 `segments` / 任务详情仓库列表一致；若顶层已传 `repo_url`，以顶层为准。 |
| `index` / `total` | 多仓时 1 基序号与总数（与日志里 `━━ (i/n)` 一致）。 |
| `phase` | `bootstrap`：引导多仓克隆；`reclone`：从任务页触发的重新克隆。 |

- SaaS 在任务 **SSE**（`status: container_git_clone_progress`）中除保留顶层 `repo_url` 外，**始终**附规范化后的 **`segment`**，协议见随 SaaS 发布的 **`machine_container.md`（§4.5）**。

## 实时事件（SSE）

- **路径**：`GET /api/events/stream?access_token=<ACCESS_TOKEN>`
- **格式**：`text/event-stream`，每条为 `data: <JSON>\n\n`。连接后首条一般为 `{"type":"connected"}`。
- **保活**：由 `sseHub.mjs` 定期发送注释行（如 `: ping`）。
- **浏览器**：`EventSource` 无法自定义 Header，**必须**用查询参数传令牌。

常见 `type` 包括：`connected`、`job_created`、`job_started`、`job_output`（含 `chunk`）、`job_finished`、`service_ready` 等；具体以 `broadcast(...)` 调用为准。客户端应兼容未知类型。

## Web 控制台

- **入口（规范）**：`GET /ui/tenant/{tenantId}/workspace/{workspaceId}/task/{taskId}/{access_token}` — path 含三 ID，与任务云 API scoped 前缀对齐；路径令牌须与当前 `ACCESS_TOKEN` 一致。
- **兼容入口**：`GET /ui/{access_token}` — 在能解析 `tenantId`/`workspaceId`/`taskId`（环境变量或 `TaskApiEndPoint`）时 **302** 到上述 scoped path；无 scope 时仍直接提供页面（本地 `ACCESS_TOKEN=dev-local-token` → `http://localhost:8765/ui/dev-local-token`）。
- **旧 token 自愈**：若路径为换票前已记住的 bootstrap/旧 token，则 **302** 到当前 token 的规范 path。未知 token 仍 **401**。
- **会话恢复**：`GET /api/session/ui-redirect`（query 或 `X-Access-Token`）在「当前或已记住旧 token」下返回 `{ access_token, ui_path, redirected }`（`ui_path` 为 scoped，有 scope 时），供打开中的控制台在 SSE 401 后自愈跳转。
- **富文本呈现声明（表驱动 + 编辑器契约）**：控制台步骤区等按 JSON **声明各字段如何渲染**（纯文本 / 富文本 iframe 等），数据来自 **`GET /api/ui/agent-render-hints`**（查询参数或 `X-Access-Token` 与受保护 API 一致）。响应内 **`rich_text_editor`** 块提供与 **`sanitizeMachineContainerHtml`（`src/htmlSanitize.mjs`）逐字段一致** 的 **`html_allowlist`**（标签与属性表），供富文本编辑器配置白名单、导出校验或与 `presentation_modes.rich_iframe` 对齐；人读约定仍以业务侧 `machine_container.md` §7 为准。浏览器可在 **`…/{access_token}/render-hints`** 新窗口查看格式化后的该 JSON（与上述 API 同源）。
- Docker 镜像从构建上下文复制 **`onlineServiceJS/static`**（与本包同源）；若缺少静态文件，返回简易 HTML 提示。
- **页眉**：展示 **`REPO_ROOT`** 宿主仓库未推送提交数依赖 `GET /api/dev/service-repo-git-push`。**当前为占位响应**（不跑 `git rev-list`）。
- **可写层变动**：依赖 `GET /api/layers/{layer_id}/diff/parent/files` 与 `GET /api/layers/{layer_id}/diff/parent/file?path=…`。由 `src/layerParentDiff.mjs` 对父层与当前层工作目录做递归条目对比（大目录有条目上限）；无父层时 JSON 带 `detail` 说明。
- 页面通过全局注入的访问令牌调用 API，并用 **`GET /api/events/stream?access_token=…`** 建立 `EventSource`。

### 该页实际调用的 HTTP 接口（与 `dev-local-token` 控制台一致）

| 方法 | 路径 | 用途摘要 |
|------|------|----------|
| `GET` | `/api/dev/service-repo-git-push` | 页眉：宿主仓库未推送提交数；**占位** |
| `GET` | `/api/ui/agent-render-hints` | 步骤等字段的呈现声明（表驱动）及 **`rich_text_editor`（富文本编辑器 HTML 白名单 JSON，与净化实现同源）**；页眉按钮「富文本呈现声明」新窗口同源展示。 |
| `GET` | `/api/events/stream` | SSE：`?access_token=` 必填。 |
| `POST` | `/api/config` | `multipart/form-data`，字段 `file`，上传 `service_config.yaml`。 |
| `GET` | `/api/config` | 拉取当前 YAML 到编辑区；本地缺失时回源 SaaS。 |
| `POST` | `/api/project/view` | JSON：`{"layer_id":"…"}`；**不保证写 symlink** |
| `GET` | `/api/requirements/task-gate` | 是否允许新建任务（`clone_done`）。 |
| `GET` | `/api/layers/empty-root` | 克隆前取空层锚点 `layer_id`。 |
| `POST` | `/api/repos/clone` | 克隆到新建可写层 |
| `GET` | `/api/repos/clone-log/{layer_id}` | 克隆日志轮询。 |
| `GET` | `/api/repos/bootstrap-clone-log` | 启动引导批量克隆日志。 |
| `GET` | `/api/jobs` | 任务列表与卡片。 |
| `GET` | `/api/jobs/{job_id}` | 单条任务刷新。 |
| `GET` | `/api/jobs/{job_id}/steps` | 步骤手风琴数据；**常为空** |
| `GET` | `/api/jobs/{job_id}/parent` | 「查询父任务」调试区。 |
| `POST` | `/api/jobs` | 创建任务；**须** `parent_job_id` 或 `repo_layer_id`；可选 `prior_context_job_id`（或叠父任务时由服务端自动写入，用于 Trae 轨迹摘要前缀）。 |
| `POST` | `/api/jobs/{job_id}/interrupt` | 中断。 |
| `POST` | `/api/jobs/{job_id}/redo` | 重新执行；**501** |
| `POST` | `/api/jobs/{job_id}/continue` | 继续；**501** |
| `DELETE` | `/api/jobs/{job_id}` | 删除任务。 |
| `POST` | `/api/jobs/reset` | 「重置」；**清理范围见上文** |
| `GET` | `/api/layers` | 下拉与层图（不含 `empty` 锚点）。 |
| `DELETE` | `/api/layers/{layer_id}` | zTree「删除该层」。 |
| `POST` | `/api/layers/{layer_id}/queue` | 运行中「加入队列」；**未实现** |
| `GET` | `/api/layers/{layer_id}/diff/parent/files` | 「可写层变动浏览」变动路径列表。 |
| `GET` | `/api/layers/{layer_id}/diff/parent/file` | 查询参数 **`path`**；选中路径的 diff 正文。 |
| `GET` | `/api/layers/{layer_id}/git/commit/latest-log` | 「最后一次提交」。 |
| `GET` | `/api/layers/{layer_id}/git/repo-identities` | 任务详情「关联项目」：按当前选中层级拉取各克隆仓 `user.name` / `user.email`。 |
| `POST` | `/api/layers/{layer_id}/git/repo-identities/sync` | 任务详情「关联项目」：**接口 A**，将各仓库所选身份批量写入容器层内对应克隆仓的 `git config`。 |
| `POST` | `/api/layers/{layer_id}/git/commit` | JSON：`message`（可选）；「提交」。 |
| `POST` | `/api/layers/{layer_id}/git/push` | 「推送」；可带 `ephemeral_ssh_private_key`。 |
| `POST` | `/api/layers/{layer_id}/git/merge` | 「合并到目标分支」；body 含 `target_branch`，可选 `source_ref`。 |
| `GET` | `/api/layers/{layer_id}/children` | 层内文件树分页。 |
| `GET` | `/api/layers/{layer_id}/files/{file_rel_posix}` | 读取选中文件内容。 |

未在 `index.html` 中直连的接口（如 `GET /api/layers/{layer_id}/files` 仅前缀列表、`GET /api/jobs/{job_id}/events`、`GET /api/layers/{layer_id}/git/branches` 等）**部分路由未实现**；本服务无 `/docs`、`/openapi.json`。

## 层命名

`layer_id` 形如 `YYYYMMDD_HHMMSS_xxxxxx`（时间戳 + 6 位十六进制后缀）。

## 本地启动示例

```bash
export ACCESS_TOKEN='your-secret'
export REPO_ROOT="/path/to/trae-agent"   # 可选；默认为 onlineServiceJS 的上一级
cp trae_config.yaml.example onlineProject_state/runtime/service_config.yaml   # 编辑密钥；或用 UI/API 上传

cd onlineServiceJS
npm install
node src/server.mjs
# 或: PORT=8765 node src/server.mjs
```

浏览器：`http://127.0.0.1:8765/ui/tenant/<tenantId>/workspace/<workspaceId>/task/<taskId>/<your-secret>`（无 scope 时可 `http://127.0.0.1:8765/ui/your-secret`）
本 Skill：`http://127.0.0.1:8765/skill.md`

## Docker 与多架构镜像

构建**上下文必须为 `trae-agent` 仓库根目录**：

```bash
docker build -f onlineServiceJS/Dockerfile -t your-registry/trae-online-js:latest .
docker run --rm -p 8765:8765 -e ACCESS_TOKEN=dev your-registry/trae-online-js:latest
```

构建时可经 `ARG`/`ENV` 传入 `ACCESS_TOKEN`、`TaskApiEndPoint` 等（见 `onlineServiceJS/Dockerfile`）。镜像内已含 `/app/trae_config.yaml.example`，可复制为运行时配置后再改密钥或通过 `/api/config` 上传。

**任务详情「模拟启动」（`mockStart`）**：租户已安装镜像若配置了 Docker 引用（**`image_url`**），SaaS 侧可 **`docker pull` + `docker run`** 该标签，并通过 `-e` 注入与云上 UserData / `init_from_task2app.sh` 一致的变量（无需在本机构建上述 Dockerfile）。无 **`image_url`** 时仍在本机用 **`trae-agent` 根目录** 构建 `onlineServiceJS/Dockerfile`。编排入口：Django 内联或独立 **`mock_trae_worker`**（`MOCK_TRAE_WORKER_URL`）；说明见 monorepo **`mock_trae_worker/README.md`**、**`task2app/conf/port_config.json.md`**（`mock_trae_worker`）、**`task2app/Saas_project/skillList/machine_container_ai_reference.md`** §4。

## 注意事项

- 任务输出在内存与 `jobs_state.json`；服务重启后原 `running` 会记为 `interrupted`（见 `loadState`）。
- 子层叠加通过符号链接共享父层 `.git`（`layerFs.mjs`）。
- **`git_destructive_locked`**：未实现防误操作语义，字段恒为 `false`。
- **`POST /api/jobs/reset`** 会删除层目录，慎用；清理范围见上文（不涵盖全部运行时旁路文件）。
- 配置、克隆日志与任务输出可能含敏感信息，请妥善保管 `ACCESS_TOKEN` 与运行时文件。

## 功能与限制（速查）

| 项目 | 说明 |
|------|------|
| OpenAPI `/docs` | 无 |
| `POST /api/jobs` 空根层 | 不支持；须 `parent_job_id` 或 `repo_layer_id` |
| `redo` / `continue` | **501** |
| `ssh_identity_file` / `branch` / `depth`（clone） | 已实现 |
| `GET .../diff/parent` 全文 | 未提供；`diff/parent/files` 与 `diff/parent/file` 已实现（`layerParentDiff.mjs`） |
| `POST .../queue` | 已实现 |
| `GET .../git/branches`、`GET .../jobs/.../events` | 未实现 |
| `project/view`、`project/active`、`dev/service-repo-git-push`、`git/identity` | 占位或简化 |
| `GET …/git/repo-identities` | 已实现（层级多仓 `git config` 只读汇总） |
| `POST …/git/repo-identities/sync` | 已实现（接口 A：按 `repo_match_key` 多仓写入 `user.name` / `user.email`） |
| `command_kind=trae` 无 venv | stub 成功退出 |
| 就绪日志 | `[onlineServiceJS] server listening ...` |

静态控制台资源位于 **`onlineServiceJS/static`**，构建镜像时由 Dockerfile 复制进镜像。
