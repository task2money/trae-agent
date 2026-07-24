#!/usr/bin/env bash
# 从 trae-agent 仓库根目录构建 onlineServiceJS 镜像（与 Dockerfile 的 COPY 路径一致），并可推送至镜像仓库。
# 默认使用 docker buildx；arch_timestamp 下每架构推送两个标签：<git_tag> 与 <cpu>-latest。
# 辅助函数见 docker/buildDocker.lib.sh；推送进度解析见 docker/buildDocker_push_progress.py。
#
# 用法：
#   ./buildDocker.sh              # 本地 load：默认仅 linux/amd64（不 push 时若多架构会回退本机架构）
#   DOCKER_PUSH=1 ./buildDocker.sh                 # 推送 x86（linux/amd64）
#   DOCKER_PLATFORMS=all DOCKER_PUSH=1 ./buildDocker.sh  # 推送全部架构（amd64+arm64）
#   DOCKER_REGISTRY_REPOSITORY=registry.example.com/ns/trae-online-js DOCKER_PUSH=1 ./buildDocker.sh
#
# 环境变量（摘要）：
#   DOCKER_PLATFORMS    默认 linux/amd64；all → linux/amd64,linux/arm64；亦可显式逗号列表。
#   REQUIRED_PUSH_PLATFORMS  默认与解析后的 DOCKER_PLATFORMS 相同。
#   DOCKER_PUSH=1 / --push  推送；DOCKER_IMAGE_TAG_SCHEME=arch_timestamp|literal；其余见历史注释与 lib。
#   DOCKER_PUSH_PROGRESS  默认 1；DOCKER_REGISTRY_AUTO_LOGIN 默认 1；DOCKER_BUILDX_CLEAR_PROXY 默认 1。
#   ENABLE_CODE_SERVER / NODE_VERSION / CODE_SERVER_VERSION / NPM_REGISTRY / SKIP_INTERNAL_APT_MIRROR /
#   DOCKER_BASE_IMAGE / DOCKER_BASE_IMAGE_MIRRORS / DOCKER_BUILDX_BUILDER / DOCKER_PUSH_IMAGE 等。
#
# 推送前请对目标 registry 主机 docker login（阿里云区域主机名互不共用登录态；脚本可跨 cn-*.aliyuncs.com 复用凭证）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=docker/buildDocker.lib.sh
source "${SCRIPT_DIR}/docker/buildDocker.lib.sh"

DO_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) DO_PUSH=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

if [[ "${DOCKER_PUSH:-0}" == "1" || "${DOCKER_PUSH:-false}" == "true" ]]; then
  DO_PUSH=1
fi

IMAGE="${DOCKER_IMAGE:-${TRAE_ONLINE_JS_IMAGE:-trae-online-js:local}}"
# 默认仅 x86；DOCKER_PLATFORMS=all 时展开为全部支持架构（避免本机 QEMU 编 arm64 拖慢日常推送）。
ALL_DOCKER_PLATFORMS="linux/amd64,linux/arm64"
_raw_platforms="${DOCKER_PLATFORMS:-linux/amd64}"
case "$(printf '%s' "${_raw_platforms}" | tr '[:upper:]' '[:lower:]')" in
  all) PLATFORMS="${ALL_DOCKER_PLATFORMS}" ;;
  *) PLATFORMS="${_raw_platforms}" ;;
esac
unset _raw_platforms
DOCKER_IMAGE_TAG_SCHEME="${DOCKER_IMAGE_TAG_SCHEME:-arch_timestamp}"
DOCKER_REGISTRY_REPOSITORY="${DOCKER_REGISTRY_REPOSITORY:-registry.cn-qingdao.aliyuncs.com/ruandao/task2app-trae}"
REQUIRED_PUSH_PLATFORMS="${REQUIRED_PUSH_PLATFORMS:-$PLATFORMS}"

for arg in "$@"; do
  case "$arg" in
    --print-platforms)
      printf '%s\n' "$PLATFORMS"
      exit 0
      ;;
  esac
done

TAG_TS="${DOCKER_IMAGE_TAG_VERSION:-${DOCKER_IMAGE_TAG_TIMESTAMP:-$(compute_image_version)}}"
USE_GIT_TAG_AS_DOCKER_TAG=0
if [[ -z "${DOCKER_IMAGE_TAG_VERSION:-}" && -z "${DOCKER_IMAGE_TAG_TIMESTAMP:-}" ]]; then
  USE_GIT_TAG_AS_DOCKER_TAG=1
fi

if [[ ! -f "$REPO_ROOT/pyproject.toml" ]]; then
  echo "[buildDocker.sh] 错误: 未在预期仓库根找到 pyproject.toml: $REPO_ROOT" >&2
  exit 1
fi
if [[ ! -f "$SCRIPT_DIR/Dockerfile" ]]; then
  echo "[buildDocker.sh] 错误: 缺少 Dockerfile: $SCRIPT_DIR/Dockerfile" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  echo "[buildDocker.sh] 错误: 未找到 docker 命令" >&2
  exit 1
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "[buildDocker.sh] 错误: 当前 Docker 不支持 buildx" >&2
  exit 1
fi

docker buildx inspect --bootstrap >/dev/null 2>&1 || true
ensure_docker_base_image || exit 1

BUILD_ARGS=( -f "$SCRIPT_DIR/Dockerfile" --build-arg "ENABLE_CODE_SERVER=${ENABLE_CODE_SERVER:-1}" )
BUILD_ARGS+=( --build-arg "BASE_IMAGE=${RESOLVED_BASE_IMAGE}" )
SKIP_INT="${SKIP_INTERNAL_APT_MIRROR:-1}"
if [[ "$SKIP_INT" == "1" || "$SKIP_INT" == "true" || "$SKIP_INT" == "TRUE" ]]; then
  SKIP_INT=1
else
  SKIP_INT=0
fi
BUILD_ARGS+=( --build-arg "SKIP_INTERNAL_APT_MIRROR=${SKIP_INT}" )
[[ -n "${NODE_VERSION:-}" ]] && BUILD_ARGS+=( --build-arg "NODE_VERSION=${NODE_VERSION}" )
[[ -n "${CODE_SERVER_VERSION:-}" ]] && BUILD_ARGS+=( --build-arg "CODE_SERVER_VERSION=${CODE_SERVER_VERSION}" )
[[ -n "${NPM_REGISTRY:-}" ]] && BUILD_ARGS+=( --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" )

BX=( run_docker_buildx build )
[[ -n "${DOCKER_BUILDX_BUILDER:-}" ]] && BX+=( --builder "${DOCKER_BUILDX_BUILDER}" )

# 推送进度：--progress=plain + docker/buildDocker_push_progress.py（勿把 heredoc 接到 python stdin）。
docker_buildx_push_with_progress() {
  local pp="${DOCKER_PUSH_PROGRESS:-1}"
  if [[ "$pp" == "0" || "$pp" == "false" || "$pp" == "FALSE" || "$pp" == "off" ]]; then
    "$@"
    return $?
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    echo "[buildDocker.sh] 警告: 未找到 python3，跳过推送进度行（可安装 python3 或设 DOCKER_PUSH_PROGRESS=0）" >&2
    "$@"
    return $?
  fi
  local progress_py="${SCRIPT_DIR}/docker/buildDocker_push_progress.py"
  if [[ ! -f "$progress_py" ]]; then
    echo "[buildDocker.sh] 错误: 缺少进度脚本: $progress_py" >&2
    return 1
  fi
  local -a injected=()
  local seen_build=0 arg
  for arg in "$@"; do
    injected+=( "$arg" )
    if [[ "$seen_build" -eq 0 && "$arg" == "build" ]]; then
      injected+=( --progress=plain )
      seen_build=1
    fi
  done
  if [[ "$seen_build" -eq 0 ]]; then
    echo "[buildDocker.sh] 内部错误: 未在参数中找到 build，无法注入 --progress=plain" >&2
    "$@"
    return $?
  fi
  "${injected[@]}" 2>&1 | python3 -u "$progress_py"
  local dock="${PIPESTATUS[0]}" py="${PIPESTATUS[1]}"
  if [[ "$py" -ne 0 ]]; then
    return "$py"
  fi
  return "$dock"
}

if [[ "$DO_PUSH" -eq 1 ]]; then
  assert_required_push_platforms "$PLATFORMS" "$REQUIRED_PUSH_PLATFORMS"
  ensure_cross_platform_emulation "$PLATFORMS" || exit 1

  if [[ -n "${DOCKER_PUSH_IMAGE:-}" ]]; then
    PUSH_REF="$(resolve_push_ref)"
    ensure_registry_push_auth "$PUSH_REF" || exit 1
    ensure_code_server_bundles "$PLATFORMS"
    echo "[buildDocker.sh] 构建上下文: $REPO_ROOT" >&2
    echo "[buildDocker.sh] Dockerfile: $SCRIPT_DIR/Dockerfile" >&2
    echo "[buildDocker.sh] 推送引用（仅此标签）: $PUSH_REF" >&2
    echo "[buildDocker.sh] 平台（单条清单）: $PLATFORMS" >&2
    docker_buildx_push_with_progress "${BX[@]}" -t "$PUSH_REF" "${BUILD_ARGS[@]}" --platform "$PLATFORMS" --push "$REPO_ROOT"
    echo "[buildDocker.sh] 已推送: $PUSH_REF" >&2
    exit 0
  fi

  if [[ "$DOCKER_IMAGE_TAG_SCHEME" == arch_timestamp ]]; then
    if [[ -z "${DOCKER_REGISTRY_REPOSITORY:-}" ]]; then
      echo "[buildDocker.sh] 错误: arch_timestamp 推送需要设置 DOCKER_REGISTRY_REPOSITORY（不含 tag），或改用 DOCKER_PUSH_IMAGE / DOCKER_IMAGE_TAG_SCHEME=literal" >&2
      exit 1
    fi
    base="${DOCKER_REGISTRY_REPOSITORY%/}"
    ensure_registry_push_auth "$base" || exit 1
    echo "[buildDocker.sh] 构建上下文: $REPO_ROOT" >&2
    echo "[buildDocker.sh] Dockerfile: $SCRIPT_DIR/Dockerfile" >&2
    ensure_code_server_bundles "$PLATFORMS"
    if [[ "$USE_GIT_TAG_AS_DOCKER_TAG" == "1" ]]; then
      echo "[buildDocker.sh] 标签方案: arch_timestamp（按架构使用 git tag 作为 docker tag）" >&2
    else
      printf '[buildDocker.sh] 标签方案: arch_timestamp，版本: %s\n' "${TAG_TS}" >&2
    fi
    echo "[buildDocker.sh] 仓库路径（不含 tag）: $base" >&2
    echo "[buildDocker.sh] 平台: $PLATFORMS" >&2
    _tag_ts="${TAG_TS}"
    _oifs=$IFS
    IFS=','
    for _plat_entry in $PLATFORMS; do
      IFS=$_oifs
      plat="$(trim_spaces "$_plat_entry")"
      [[ -z "${plat}" ]] && continue
      slug="$(platform_to_arch_slug "${plat}")" || exit 1
      if [[ "$USE_GIT_TAG_AS_DOCKER_TAG" == "1" ]]; then
        git_tag="$(ensure_commit_git_tag "${slug}")"
        ref_ts="${base}:$(sanitize_docker_tag "${git_tag}")"
      else
        ref_ts="${base}:${slug}-${_tag_ts}"
      fi
      ref_latest="${base}:${slug}-latest"
      printf '[buildDocker.sh] 构建并推送: %s 与 %s （平台 %s）\n' "${ref_ts}" "${ref_latest}" "${plat}" >&2
      docker_buildx_push_with_progress "${BX[@]}" -t "$ref_ts" -t "$ref_latest" "${BUILD_ARGS[@]}" --platform "${plat}" --push "$REPO_ROOT"
    done
    IFS=$_oifs
    if [[ "$USE_GIT_TAG_AS_DOCKER_TAG" == "1" ]]; then
      echo "[buildDocker.sh] 已完成按架构推送（docker tag = 各架构 git tag）。" >&2
    else
      printf '[buildDocker.sh] 已完成按架构推送（版本 %s）。\n' "${_tag_ts}" >&2
    fi
    exit 0
  fi

  PUSH_REF="$(resolve_push_ref)"
  ensure_registry_push_auth "$PUSH_REF" || exit 1
  ensure_code_server_bundles "$PLATFORMS"
  echo "[buildDocker.sh] 构建上下文: $REPO_ROOT" >&2
  echo "[buildDocker.sh] Dockerfile: $SCRIPT_DIR/Dockerfile" >&2
  echo "[buildDocker.sh] 推送引用（literal / 单清单）: $PUSH_REF" >&2
  [[ "$PUSH_REF" != "$IMAGE" ]] && echo "[buildDocker.sh] 说明: DOCKER_IMAGE=$IMAGE 未标记到本次构建，避免误推 docker.io/library/*" >&2
  echo "[buildDocker.sh] 平台: $PLATFORMS" >&2
  docker_buildx_push_with_progress "${BX[@]}" -t "$PUSH_REF" "${BUILD_ARGS[@]}" --platform "$PLATFORMS" --push "$REPO_ROOT"
  echo "[buildDocker.sh] 已推送多架构清单: $PUSH_REF" >&2
  exit 0
fi

# ---- 本地 load ----
USE_PLATFORMS="$PLATFORMS"
OUTPUT=( --load )
if [[ "$DOCKER_IMAGE_TAG_SCHEME" == arch_timestamp ]]; then
  slug="$(native_arch_slug)"
  img_base="${IMAGE%:*}"
  [[ "$img_base" == "$IMAGE" ]] && img_base="$IMAGE"
  if [[ "$USE_GIT_TAG_AS_DOCKER_TAG" == "1" ]]; then
    git_tag="$(ensure_commit_git_tag "${slug}")"
    LOAD_REF_TS="${img_base}:$(sanitize_docker_tag "${git_tag}")"
  else
    LOAD_REF_TS="${img_base}:${slug}-${TAG_TS}"
  fi
  LOAD_REF_LATEST="${img_base}:${slug}-latest"
  TAGS=( -t "$LOAD_REF_TS" -t "$LOAD_REF_LATEST" )
  if [[ "$PLATFORMS" == *","* ]]; then
    echo "[buildDocker.sh] 未使用 --push：无法载入多架构清单，改为仅构建本机架构 $(native_platform)" >&2
    USE_PLATFORMS="$(native_platform)"
  fi
else
  TAGS=( -t "$IMAGE" )
  if [[ "$PLATFORMS" == *","* ]]; then
    echo "[buildDocker.sh] 未使用 --push：无法将多架构清单载入本机 Docker，改为仅构建本机架构 $(native_platform)" >&2
    USE_PLATFORMS="$(native_platform)"
  fi
fi

echo "[buildDocker.sh] 构建上下文: $REPO_ROOT" >&2
echo "[buildDocker.sh] Dockerfile: $SCRIPT_DIR/Dockerfile" >&2
if [[ "$DOCKER_IMAGE_TAG_SCHEME" == arch_timestamp ]]; then
  printf '[buildDocker.sh] 标签: %s 与 %s\n' "${LOAD_REF_TS}" "${LOAD_REF_LATEST}" >&2
else
  echo "[buildDocker.sh] 标签: ${TAGS[1]}" >&2
fi
echo "[buildDocker.sh] 平台: $USE_PLATFORMS" >&2

ensure_code_server_bundles "$USE_PLATFORMS"
"${BX[@]}" "${TAGS[@]}" "${BUILD_ARGS[@]}" --platform "$USE_PLATFORMS" "${OUTPUT[@]}" "$REPO_ROOT"
echo "[buildDocker.sh] 已完成本地构建。" >&2
