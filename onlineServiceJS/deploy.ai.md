# Deploy — onlineServiceJS

## 部署命令

在 `trae-agent/onlineServiceJS/` 目录执行：

```bash
DOCKER_PUSH=1 ./buildDocker.sh
```

默认构建并推送 **linux/amd64 (x86)** 镜像到 `registry.cn-qingdao.aliyuncs.com/ruandao/task2app-trae`。

## 变体

```bash
# 推送全部架构（amd64 + arm64）
DOCKER_PLATFORMS=all DOCKER_PUSH=1 ./buildDocker.sh

# 推送到自定义 registry
DOCKER_REGISTRY_REPOSITORY=<your-registry>/<ns>/<repo> DOCKER_PUSH=1 ./buildDocker.sh
```

## 前置条件

- Docker（含 buildx）已安装
- 已登录目标 registry（`docker login`）

## 更多信息

构建细节见 [buildDocker.sh](./buildDocker.sh) 注释头，运行规则见 [ai.md](./ai.md)。
