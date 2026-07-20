# onlineServiceJS Companion 规则

## 基本信息
- 版本：1.0.0
- 创建日期：2026-07-12
- 最后修改：2026-07-12
- 维护者：Trae AI 团队

## 规则分类

### 核心规则（一级分类）
> 影响交付完整性的关键规则，必须严格遵守

#### 镜像发布（二级分类）
##### 提交后必须推送 Docker 镜像
- 描述：对本目录（`onlineServiceJS/`）或会影响本镜像内容的变更完成 **git commit** 后，**必须**在本目录执行：

  ```bash
  DOCKER_PUSH=1 ./buildDocker.sh
  ```

  父目录总则见 [`../ai.md`](../ai.md)。禁止只提交不推送导致 registry 镜像落后于源码。
- 适用场景：修改本目录源码/Dockerfile/依赖并提交或交付时
- 优先级：高

### 最佳实践（一级分类）
> 提升交付可靠性的建议

#### 凭据续签（二级分类）
##### access 主动 refresh-access
- 描述：长跑进程在 TTL 将尽（默认 skew 5m）时须主动 `refresh-access`（`src/proactiveAccessRefresh.mjs`），与 go_relay 对称。可用 `TRAE_SKIP_PROACTIVE_ACCESS_REFRESH=1` 关闭；skew/poll 见 `TRAE_ACCESS_TOKEN_REFRESH_SKEW_SEC` / `TRAE_ACCESS_TOKEN_REFRESH_POLL_SEC`。
- 适用场景：容器 access 1h TTL、SaaS by-scope / 转发
- 优先级：高

#### 推送时机（二级分类）
##### 先提交再推送
- 描述：先 git commit，再 `DOCKER_PUSH=1 ./buildDocker.sh`，以便镜像 tag 与 HEAD 一致。
- 适用场景：提交与推送连续进行时
- 优先级：中

#### 源码进容器路径（二级分类）
##### 镜像烘焙 vs 本地 overlay
- 描述：`Dockerfile` 以 `COPY onlineServiceJS /app/onlineServiceJS/` **整树打入镜像**（`.dockerignore` 仅排除 `node_modules`）；**公网/云任务容器无 bind-mount**，新增 `src/*.mjs`（如 `layerFileContent.mjs`）必须重建并推送镜像后，**新建或重启任务容器**才有精确二进制属性。本地 `go_relayToTrae` selected_image 模式默认把 monorepo `trae-agent/onlineServiceJS/src` **整目录**挂到 `/app/onlineServiceJS/src:ro`（`RELAY_OVERLAY_ONLINE_SERVICE_SRC=0` 可关），无需等 registry。
- 适用场景：改 onlineServiceJS 源码后判断「本地能否立刻生效 / 公网是否需推镜像」
- 优先级：高
- 验收（公网容器内）：
  ```bash
  docker exec <cid> test -f /app/onlineServiceJS/src/layerFileContent.mjs && echo ok
  docker exec <cid> node --check /app/onlineServiceJS/src/server.mjs
  ```

### 风格指南（一级分类）
> 统一命令写法

#### 文档引用（二级分类）
##### 推送命令写法
- 描述：统一写 `` `DOCKER_PUSH=1 ./buildDocker.sh` ``，勿省略 `DOCKER_PUSH=1`。
- 适用场景：文档与交付说明
- 优先级：低

## 规则冲突处理
- 当规则冲突时，遵循以下优先级：
  1. 核心规则 > 最佳实践 > 风格指南
  2. 文件级规则 > 目录级规则 > 全局规则
  3. 新版本规则覆盖旧版本规则

## 变更日志
- 2026-07-19：补充 access 主动 refresh-access 最佳实践（proactiveAccessRefresh）
- 2026-07-12：版本 1.0.0 - 初始创建，强化提交后 Docker 推送提醒
