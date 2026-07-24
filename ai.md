# trae-agent Companion 规则

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
- 描述：在本仓库（`trae-agent`）完成代码变更并 **git commit** 后，若变更会影响运行中的 online 镜像（含 `onlineServiceJS/`、`trae_agent/`、Dockerfile / 依赖 / 启动与配置相关文件等），**必须**在提交完成后于 `onlineServiceJS/` 目录执行：

  ```bash
  DOCKER_PUSH=1 ./buildDocker.sh
  ```

  禁止只提交代码却不推送镜像，以免仓库镜像落后于已提交源码。仅文档/纯测试/不影响镜像内容的改动可跳过推送，但须在交付说明中写明原因。
- 适用场景：对本目录下任意源文件完成实现类改动并提交时；用户要求 commit / ship / 交付时
- 优先级：高

##### 工作目录与命令原文
- 描述：`buildDocker.sh` 位于 `onlineServiceJS/`。执行推送时 **cwd 必须为** `trae-agent/onlineServiceJS`，命令保持用户约定原文：`DOCKER_PUSH=1 ./buildDocker.sh`（亦可用等价的 `--push`，但默认按上述环境变量形式执行）。**默认仅推送 linux/amd64**；需 amd64+arm64 时用 `DOCKER_PLATFORMS=all DOCKER_PUSH=1 ./buildDocker.sh`。脚本默认仓库见 `buildDocker.sh` 头部注释中的 `DOCKER_REGISTRY_REPOSITORY`。
- 适用场景：执行镜像构建与推送时
- 优先级：高

### 最佳实践（一级分类）
> 提升交付可靠性的建议

#### 推送时机（二级分类）
##### 先提交再推送
- 描述：`buildDocker.sh` 在 arch_timestamp 方案下可能按当前 HEAD 打 git tag 并用作 docker tag。宜先完成 git commit，再执行 `DOCKER_PUSH=1 ./buildDocker.sh`，使镜像标签与已提交内容一致。
- 适用场景：提交与镜像发布连续进行时
- 优先级：中

##### 推送失败须显式记录
- 描述：若 registry 登录失败、网络中断或 buildx 报错导致推送未完成，不得静默当作已交付；须在回复中标明阻塞原因与已尝试的命令，并在可恢复后重跑同一推送命令。
- 适用场景：推送未成功结束时
- 优先级：中

### 风格指南（一级分类）
> 统一说明与引用方式

#### 文档引用（二级分类）
##### 推送命令写法
- 描述：在意图文档、交付清单、会话回复中写推送步骤时，统一写为 `` `DOCKER_PUSH=1 ./buildDocker.sh` ``（相对 `onlineServiceJS/`），避免省略 `DOCKER_PUSH=1` 导致只本地 build 未推仓库。
- 适用场景：文档与交付说明
- 优先级：低

## 规则冲突处理
- 当规则冲突时，遵循以下优先级：
  1. 核心规则 > 最佳实践 > 风格指南
  2. 文件级规则 > 目录级规则 > 全局规则
  3. 新版本规则覆盖旧版本规则

## 变更日志
- 2026-07-23：说明默认仅推 x86；全架构需 `DOCKER_PLATFORMS=all`
- 2026-07-12：版本 1.0.0 - 初始创建，要求 trae-agent 提交后使用 `DOCKER_PUSH=1 ./buildDocker.sh` 推送镜像
