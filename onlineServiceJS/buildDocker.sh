#!/usr/bin/env bash
# 从 trae-agent 仓库根目录构建 onlineServiceJS 镜像（与 Dockerfile 的 COPY 路径一致），并可推送至镜像仓库。
# 默认使用 docker buildx；arch_timestamp 下每架构推送两个标签：<git_tag> 与 <cpu>-latest
# （git_tag 即当前 commit 已有的首个 git tag，否则按 "${Arch}_%Y-%m-%d_%H-%M" 在 HEAD 上新建；
#  显式设置 DOCKER_IMAGE_TAG_VERSION 时回退到旧命名 <cpu>-<VER>）。
#
# 用法：
#   ./buildDocker.sh              # 本地 load：默认同名镜像 arm64-… / x86_64-…（仅本机架构）
#   DOCKER_REGISTRY_REPOSITORY=registry.example.com/ns/trae-online-js DOCKER_PUSH=1 ./buildDocker.sh
#
# 环境变量：
#   DOCKER_IMAGE        本地构建镜像名（不含 tag 或含 tag；arch_timestamp 下本地打 <cpu>-<TS> 与 <cpu>-latest）。默认 trae-online-js:local。
#   DOCKER_REGISTRY_REPOSITORY  镜像仓库地址 + 仓库名（同一变量），不含 tag。
#                               默认 registry.cn-qingdao.aliyuncs.com/ruandao/task2app-trae（可被环境变量覆盖）。
#   DOCKER_IMAGE_TAG_SCHEME  arch_timestamp（默认）| literal。
#                            arch_timestamp：每架构两条标签 <cpu>-<VER> 与 <cpu>-latest（VER 见下）。
#                            literal：单标签 DOCKER_IMAGE_TAG（默认 latest），可单次推送多架构清单。
#   DOCKER_IMAGE_TAG_VERSION    覆盖版本片段；未设置时启用"git tag → docker tag"流程：
#                                  1) 若当前 HEAD 已有任意 git tag，复用首个；
#                                  2) 否则按 "${Arch}_%Y-%m-%d_%H-%M" 在 HEAD 上新建 git tag
#                                     （%Y-%m-%d %H:%M 中的空格、冒号在 git/docker tag 中均非法，
#                                      已分别替换为 "_" 与 "-"）；
#                                  3) 该 git tag 经 docker 字符集净化后直接作为 docker tag（${base}:<git_tag>）。
#                                显式设置时则按旧行为：作为 ${slug}-${VER} 中的版本片段，不打 git tag。
#                                未在 git 仓库中时，回退到 ${Arch}_$(date +%Y-%m-%d_%H-%M)（仅生成名字、不打 tag）。
#   DOCKER_IMAGE_TAG_TIMESTAMP  兼容旧名，等价于 DOCKER_IMAGE_TAG_VERSION（前者优先级更高）。
#   DOCKER_IMAGE_TAG    仅在 literal 下作为仓库 tag（默认 latest）。
#   DOCKER_PUSH_IMAGE   若设置：整条镜像引用（含 tag），单次推送，忽略 arch_timestamp 命名。
#   推送说明：literal 且 PUSH_REF 与 DOCKER_IMAGE 为短名时仍仅推 PUSH_REF；见前文。
#   DOCKER_PLATFORMS    逗号分隔，默认 linux/amd64,linux/arm64（arch_timestamp 下逐项构建推送）。
#   DOCKER_BUILDX_BUILDER  可选，传给 docker buildx build --builder。
#   DOCKER_PUSH         设为 1 / true 时推送（可与 --push 二选一）。
#   DOCKER_PUSH_PROGRESS  推送（含 --push）时在 stderr 底部单行刷新：阶段、百分比（来自 plain 日志里的 X/Y）、已用时与预计剩余时间。
#                         默认 1；设为 0 / false / off 关闭。需 python3；关闭后恢复不经管道、由 Docker 自带进度显示。
#                         启用时为保留完整构建日志会注入 --progress=plain；无 X/Y 行时剩余时间为基于阶段耗时的粗估并随时间更新。
#   ENABLE_CODE_SERVER / NODE_VERSION / CODE_SERVER_VERSION  传给 Dockerfile。
#   启用 code-server 时，构建前会自动下载 tarball 至 onlineServiceJS/docker/code-server/（亦见 docker/fetch-code-server-bundles.sh）。
#   NPM_REGISTRY  可选，传给 Dockerfile（例：https://registry.npmmirror.com），减轻 npm ci 时 ECONNRESET。
#   SKIP_INTERNAL_APT_MIRROR  默认 1：从 apt sources 去掉 192.168.3.25 内网源（笔记本/CI）。
#                             在内网构建且需要该源时设为 0/false。
#   DOCKER_BASE_IMAGE         覆盖 Dockerfile BASE_IMAGE（例：docker.m.daocloud.io/library/ubuntu:24.04）。
#                             未设置时脚本会探测可用引用：短名 ubuntu:24.04 失败则回退镜像站全限定名。
#   DOCKER_BASE_IMAGE_MIRRORS 逗号分隔的回退候选（默认含 daocloud / 1ms.run / dockerhub.icu）。
#   DOCKER_BUILDX_CLEAR_PROXY 默认 1：对 buildx 子进程去掉 http(s)_proxy/all_proxy，避免失效的本地
#                             SOCKS（如 127.0.0.1:1234）导致 registry metadata / token 解析失败。
#   DOCKER_REGISTRY_AUTO_LOGIN 默认 1：推送前检查目标 registry 是否已 docker login。
#                             若目标为 *.aliyuncs.com 且本机仅登录了其它 cn-*.aliyuncs.com 区域，
#                             则复用该区域凭证自动 docker login 到目标主机（阿里云 ACR 账号跨区域通用，
#                             但每个 registry 主机名须分别登录，否则会 insufficient_scope）。
#
#   推送与代理：docker buildx --push 由守护进程向仓库上传大块层。若用 proxychains4 包裹整条脚本，或 Docker Desktop
#   代理指向易断连的 HTTP 代理（日志里常见 host:3128），易出现 Put blob EOF、broken pipe、TLS handshake timeout。
#   对国内 registry（如 *.aliyuncs.com）建议直连推送：不要 proxychains 包裹本脚本；或在 Docker Desktop「Proxies」里把
#   目标 registry 主机名加入 bypass / NO_PROXY。需代理访问外网时，可只对 curl/npm 等单独配置，避免代理截断 registry 长上传。
#
# 推送前请对「目标 registry 主机」执行 docker login（阿里云杭州/青岛等区域主机名不同，互不共用登录态）。
# 本脚本在 DOCKER_REGISTRY_AUTO_LOGIN=1 时可从已登录的其它 cn-*.aliyuncs.com 复用凭证，不代替交互输入密码。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DO_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) DO_PUSH=1 ;;
    -h|--help)
      sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

if [[ "${DOCKER_PUSH:-0}" == "1" || "${DOCKER_PUSH:-false}" == "true" ]]; then
  DO_PUSH=1
fi

IMAGE="${DOCKER_IMAGE:-${TRAE_ONLINE_JS_IMAGE:-trae-online-js:local}}"
PLATFORMS="${DOCKER_PLATFORMS:-linux/amd64,linux/arm64}"
DOCKER_IMAGE_TAG_SCHEME="${DOCKER_IMAGE_TAG_SCHEME:-arch_timestamp}"
DOCKER_REGISTRY_REPOSITORY="${DOCKER_REGISTRY_REPOSITORY:-registry.cn-qingdao.aliyuncs.com/ruandao/task2app-trae}"
# 推送时默认强制双架构齐全，避免只推单架构导致线上拉取失败。
REQUIRED_PUSH_PLATFORMS="${REQUIRED_PUSH_PLATFORMS:-linux/amd64,linux/arm64}"

# Docker tag 允许的字符集为 [A-Za-z0-9_.-]，首字符须为 [A-Za-z0-9_]，长度 <=128。
sanitize_docker_tag() {
  local s="$1"
  s="$(printf '%s' "$s" | LC_ALL=C tr -c 'A-Za-z0-9_.-' '-')"
  case "$s" in
    [A-Za-z0-9_]*) ;;
    *) s="_${s}" ;;
  esac
  printf '%s' "${s:0:128}"
}

# 优先用 git describe（含 tag/commit/dirty 信息），不在 git 仓库时落回时间戳。
compute_image_version() {
  local desc=""
  if command -v git >/dev/null 2>&1 \
     && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    desc="$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || true)"
  fi
  if [[ -z "$desc" ]]; then
    desc="$(date +%Y%m%d%H%M%S)"
  fi
  sanitize_docker_tag "$desc"
}

# 查询或创建当前 commit 的「按架构」git tag。
# - 当前 HEAD 已有匹配该架构前缀（${arch}_）的 tag：复用首个匹配项。
# - 否则按 "${arch}_%Y-%m-%d_%H-%M" 在 HEAD 上新建 git tag 并返回。
# - 不在 git 仓库 / git 不可用：仅生成同形名字（不打 tag）。
# 注：用户原指定格式为 "${Arch}_%Y-%m-%d %H:%M"，但空格与冒号在 git/docker tag 中均非法，
# 这里将空格替换为 "_"、冒号替换为 "-"，等价为 "${arch}_%Y-%m-%d_%H-%M"。
ensure_commit_git_tag() {
  local arch="$1"
  local existing="" candidate=""
  candidate="${arch}_$(date '+%Y-%m-%d_%H-%M')"
  if ! command -v git >/dev/null 2>&1 \
     || ! git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '%s' "$candidate"
    return 0
  fi
  existing="$(git -C "$REPO_ROOT" tag --points-at HEAD 2>/dev/null | awk -v pfx="^${arch}_" '$0 ~ pfx { print; exit }' || true)"
  if [[ -n "$existing" ]]; then
    printf '%s' "$existing"
    return 0
  fi
  if git -C "$REPO_ROOT" rev-parse --verify "refs/tags/${candidate}" >/dev/null 2>&1; then
    echo "[buildDocker.sh] 复用同名 git tag（未指向当前 HEAD，按 docker tag 用途使用）: $candidate" >&2
    printf '%s' "$candidate"
    return 0
  fi
  if git -C "$REPO_ROOT" tag "$candidate" >/dev/null 2>&1; then
    echo "[buildDocker.sh] 当前 commit 无 git tag，已新建: $candidate" >&2
  else
    echo "[buildDocker.sh] 警告: 创建 git tag 失败: $candidate（仅作为 docker tag 使用）" >&2
  fi
  printf '%s' "$candidate"
}

# DOCKER_IMAGE_TAG_VERSION 为新名，DOCKER_IMAGE_TAG_TIMESTAMP 为兼容旧名。
TAG_TS="${DOCKER_IMAGE_TAG_VERSION:-${DOCKER_IMAGE_TAG_TIMESTAMP:-$(compute_image_version)}}"

# 未显式指定版本片段时，启用"git tag → docker tag"流程（按架构生成/复用 git tag 并直接作为 docker tag）。
USE_GIT_TAG_AS_DOCKER_TAG=0
if [[ -z "${DOCKER_IMAGE_TAG_VERSION:-}" && -z "${DOCKER_IMAGE_TAG_TIMESTAMP:-}" ]]; then
  USE_GIT_TAG_AS_DOCKER_TAG=1
fi

native_platform() {
  case "$(uname -m)" in
    x86_64|amd64) printf '%s' linux/amd64 ;;
    aarch64|arm64) printf '%s' linux/arm64 ;;
    *) printf '%s' linux/amd64 ;;
  esac
}

trim_spaces() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

csv_contains_platform() {
  local csv="$1"
  local target="$2"
  local _oifs="$IFS"
  IFS=','
  for _entry in $csv; do
    IFS="$_oifs"
    if [[ "$(trim_spaces "$_entry")" == "$target" ]]; then
      return 0
    fi
    IFS=','
  done
  IFS="$_oifs"
  return 1
}

assert_required_push_platforms() {
  local actual="$1"
  local required_csv="$2"
  local missing=()
  local _oifs="$IFS"
  IFS=','
  for _entry in $required_csv; do
    IFS="$_oifs"
    req="$(trim_spaces "$_entry")"
    [[ -z "$req" ]] && { IFS=','; continue; }
    if ! csv_contains_platform "$actual" "$req"; then
      missing+=("$req")
    fi
    IFS=','
  done
  IFS="$_oifs"
  if [[ "${#missing[@]}" -gt 0 ]]; then
    echo "[buildDocker.sh] 错误: 推送模式要求同时构建并推送以下架构: $required_csv" >&2
    echo "[buildDocker.sh] 当前 DOCKER_PLATFORMS=$actual，缺失: ${missing[*]}" >&2
    echo "[buildDocker.sh] 如需覆盖默认要求，请显式设置 REQUIRED_PUSH_PLATFORMS" >&2
    exit 1
  fi
}

# 非本机架构需要 QEMU/binfmt；缺省时提前失败，避免跑到 RUN 才报 exec format error。
ensure_cross_platform_emulation() {
  local platforms_csv="$1"
  local native base_img
  native="$(native_platform)"
  base_img="${RESOLVED_BASE_IMAGE:-ubuntu:24.04}"
  local _oifs=$IFS
  local plat
  IFS=','
  for plat in $platforms_csv; do
    IFS=$_oifs
    plat="$(trim_spaces "$plat")"
    [[ -z "$plat" || "$plat" == "$native" ]] && continue
    if ! docker run --rm --platform "$plat" "$base_img" true >/dev/null 2>&1; then
      echo "[buildDocker.sh] 错误: 本机无法执行平台 $plat 的容器（exec format error / 缺少 QEMU binfmt）" >&2
      echo "[buildDocker.sh] 修复建议:" >&2
      echo "[buildDocker.sh]   1) sudo apt-get install -y qemu-user-static binfmt-support" >&2
      echo "[buildDocker.sh]      或: docker run --privileged --rm tonistiigi/binfmt --install all" >&2
      echo "[buildDocker.sh]   2) 仅推送本机架构: DOCKER_PLATFORMS=${native} REQUIRED_PUSH_PLATFORMS=${native} DOCKER_PUSH=1 ./buildDocker.sh" >&2
      return 1
    fi
  done
  IFS=$_oifs
  return 0
}

platform_to_arch_slug() {
  case "$(trim_spaces "$1")" in
    linux/arm64) printf '%s' arm64 ;;
    linux/amd64) printf '%s' x86_64 ;;
    *)
      echo "[buildDocker.sh] 错误: 不支持的架构 \"$(trim_spaces "$1")\"（arch_timestamp 仅支持 linux/amd64、linux/arm64）" >&2
      return 1
      ;;
  esac
}

# 从镜像引用取出 registry 主机名（registry.example.com/ns/name[:tag] → registry.example.com）。
registry_host_from_ref() {
  local ref="${1%%@*}"
  ref="${ref%%:*}"
  case "$ref" in
    */*) printf '%s' "${ref%%/*}" ;;
    *) printf '%s' "" ;;
  esac
}

# 推送前确保目标 registry 已登录；阿里云跨区域可复用已有 cn-*.aliyuncs.com 凭证。
ensure_registry_push_auth() {
  local ref="$1"
  local host
  host="$(registry_host_from_ref "$ref")"
  if [[ -z "$host" || "$host" != *.* ]]; then
    return 0
  fi

  local auto="${DOCKER_REGISTRY_AUTO_LOGIN:-1}"
  local cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  local has_auth=0
  if [[ -f "$cfg" ]] && command -v python3 >/dev/null 2>&1; then
    if DOCKER_CFG_PATH="$cfg" REGISTRY_HOST="$host" python3 -c \
      'import json,os,sys; c=json.load(open(os.environ["DOCKER_CFG_PATH"])); sys.exit(0 if os.environ["REGISTRY_HOST"] in c.get("auths",{}) else 1)'; then
      has_auth=1
    fi
  fi
  if [[ "$has_auth" -eq 1 ]]; then
    echo "[buildDocker.sh] 推送鉴权: 已登录 $host" >&2
    return 0
  fi

  if [[ "$auto" == "0" || "$auto" == "false" || "$auto" == "FALSE" || "$auto" == "off" ]]; then
    echo "[buildDocker.sh] 错误: 未登录 $host。请先执行: docker login $host" >&2
    echo "[buildDocker.sh] 说明: 阿里云杭州/青岛等区域 registry 主机名不同，登录态不共享。" >&2
    return 1
  fi

  # 尝试从其它已登录的阿里云 ACR 主机复用账号密码。
  if [[ "$host" == *.aliyuncs.com ]] && [[ -f "$cfg" ]] && command -v python3 >/dev/null 2>&1; then
    local donor="" user_file=""
    donor="$(DOCKER_CFG_PATH="$cfg" TARGET_HOST="$host" python3 -c '
import json, os, base64, sys
c = json.load(open(os.environ["DOCKER_CFG_PATH"]))
target = os.environ["TARGET_HOST"]
for h, v in c.get("auths", {}).items():
    if h == target or not h.endswith(".aliyuncs.com"):
        continue
    auth = v.get("auth") or ""
    if not auth:
        continue
    try:
        raw = base64.b64decode(auth).decode()
    except Exception:
        continue
    if ":" not in raw:
        continue
    print(h)
    sys.exit(0)
sys.exit(1)
' 2>/dev/null || true)"
    if [[ -n "$donor" ]]; then
      echo "[buildDocker.sh] 推送鉴权: $host 未登录，尝试复用 $donor 的阿里云凭证…" >&2
      user_file="$(mktemp "${TMPDIR:-/tmp}/buildDocker-reguser.XXXXXX")" || return 1
      if ! DOCKER_CFG_PATH="$cfg" DONOR_HOST="$donor" USER_OUT="$user_file" python3 -c '
import json, os, base64
c = json.load(open(os.environ["DOCKER_CFG_PATH"]))
raw = base64.b64decode(c["auths"][os.environ["DONOR_HOST"]]["auth"]).decode()
user, _pw = raw.split(":", 1)
open(os.environ["USER_OUT"], "w").write(user)
' ; then
        rm -f "$user_file"
        echo "[buildDocker.sh] 警告: 无法从 $donor 解析凭证" >&2
      elif DOCKER_CFG_PATH="$cfg" DONOR_HOST="$donor" python3 -c '
import json, os, base64, sys
c = json.load(open(os.environ["DOCKER_CFG_PATH"]))
raw = base64.b64decode(c["auths"][os.environ["DONOR_HOST"]]["auth"]).decode()
_user, pw = raw.split(":", 1)
sys.stdout.buffer.write(pw.encode())
' | docker login "$host" -u "$(cat "$user_file")" --password-stdin >/dev/null 2>&1; then
        rm -f "$user_file"
        echo "[buildDocker.sh] 推送鉴权: 已自动登录 $host（凭证来自 $donor）" >&2
        return 0
      else
        rm -f "$user_file"
        echo "[buildDocker.sh] 警告: 复用 $donor 凭证登录 $host 失败" >&2
      fi
    fi
  fi

  echo "[buildDocker.sh] 错误: 未登录推送目标 registry: $host" >&2
  echo "[buildDocker.sh] 请先执行: docker login $host" >&2
  echo "[buildDocker.sh] 说明: 仅登录 registry.cn-hangzhou.aliyuncs.com 不能推送到 registry.cn-qingdao.aliyuncs.com（insufficient_scope）。" >&2
  return 1
}

# 对 buildx 去掉易失效的 shell HTTP/SOCKS 代理（daemon 拉镜像不走该代理；buildkit 会继承 env）。
run_docker_buildx() {
  local clear="${DOCKER_BUILDX_CLEAR_PROXY:-1}"
  if [[ "$clear" == "0" || "$clear" == "false" || "$clear" == "FALSE" || "$clear" == "off" ]]; then
    docker buildx "$@"
    return $?
  fi
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
    docker buildx "$@"
}

# 解析可用的 ubuntu:24.04 基础镜像。
# 若 registry-mirrors 首项是非 pull-through 私有仓，短名 ubuntu:24.04 的 metadata 会 not found；
# 此时改用镜像站全限定名，绕过 docker.io mirror 链。
ensure_docker_base_image() {
  RESOLVED_BASE_IMAGE=""
  local default_ref="ubuntu:24.04"
  local pull_timeout_sec="${DOCKER_BASE_IMAGE_PULL_TIMEOUT_SEC:-45}"

  if [[ -n "${DOCKER_BASE_IMAGE:-}" ]]; then
    RESOLVED_BASE_IMAGE="$DOCKER_BASE_IMAGE"
    echo "[buildDocker.sh] 使用 DOCKER_BASE_IMAGE=$RESOLVED_BASE_IMAGE" >&2
    return 0
  fi

  # 优先全限定镜像站（绕过损坏的 docker.io registry-mirror）；短名放最后且限时，避免长时间挂起。
  local candidates=()
  local extra="${DOCKER_BASE_IMAGE_MIRRORS:-docker.m.daocloud.io/library/ubuntu:24.04,docker.1ms.run/library/ubuntu:24.04,dockerhub.icu/library/ubuntu:24.04}"
  local _oifs=$IFS
  IFS=','
  local _c
  for _c in $extra; do
    IFS=$_oifs
    _c="$(trim_spaces "$_c")"
    [[ -n "$_c" ]] && candidates+=("$_c")
  done
  IFS=$_oifs
  candidates+=("$default_ref")

  local ref
  for ref in "${candidates[@]}"; do
    echo "[buildDocker.sh] 探测基础镜像: $ref …" >&2
    # daemon 侧 pull（不走 shell 代理）；timeout 防止短名经坏 mirror 长时间挂起。
    if command -v timeout >/dev/null 2>&1; then
      if timeout "$pull_timeout_sec" docker pull "$ref" >/dev/null 2>&1; then
        RESOLVED_BASE_IMAGE="$ref"
        if [[ "$ref" != "$default_ref" ]]; then
          docker tag "$ref" "$default_ref" >/dev/null 2>&1 || true
        fi
        echo "[buildDocker.sh] 基础镜像可用: $RESOLVED_BASE_IMAGE" >&2
        return 0
      fi
    else
      if docker pull "$ref" >/dev/null 2>&1; then
        RESOLVED_BASE_IMAGE="$ref"
        if [[ "$ref" != "$default_ref" ]]; then
          docker tag "$ref" "$default_ref" >/dev/null 2>&1 || true
        fi
        echo "[buildDocker.sh] 基础镜像可用: $RESOLVED_BASE_IMAGE" >&2
        return 0
      fi
    fi
  done

  if docker image inspect "$default_ref" >/dev/null 2>&1; then
    # 本机有短名，但 buildx 经坏 mirror 仍可能 metadata not found → 若有任一镜像站本地 tag 则优先用之
    for ref in "${candidates[@]}"; do
      [[ "$ref" == "$default_ref" ]] && continue
      if docker image inspect "$ref" >/dev/null 2>&1; then
        RESOLVED_BASE_IMAGE="$ref"
        echo "[buildDocker.sh] 远程拉取失败，改用本机已有 $RESOLVED_BASE_IMAGE" >&2
        return 0
      fi
    done
    RESOLVED_BASE_IMAGE="$default_ref"
    echo "[buildDocker.sh] 远程拉取失败，改用本机已有 $default_ref（若仍失败请设 DOCKER_BASE_IMAGE）" >&2
    return 0
  fi

  echo "[buildDocker.sh] 错误: 无法解析或拉取基础镜像 ubuntu:24.04。" >&2
  echo "[buildDocker.sh] 可设置 DOCKER_BASE_IMAGE=docker.m.daocloud.io/library/ubuntu:24.04 后重试。" >&2
  echo "[buildDocker.sh] 若 /etc/docker/daemon.json 的 registry-mirrors 首项是非 pull-through 私有仓，建议将其移出或后置。" >&2
  return 1
}

# 在宿主机拉取 code-server tarball 到 onlineServiceJS/docker/code-server/，供 Dockerfile COPY。
ensure_code_server_bundles() {
  local platforms_csv="$1"
  local ena="${ENABLE_CODE_SERVER:-1}"
  if [[ "$ena" != "1" && "$ena" != "true" && "$ena" != "TRUE" ]]; then
    return 0
  fi
  local fetch_sh="${SCRIPT_DIR}/docker/fetch-code-server-bundles.sh"
  if [[ ! -f "$fetch_sh" ]]; then
    echo "[buildDocker.sh] 错误: 未找到 ${fetch_sh}" >&2
    exit 1
  fi
  [[ -x "$fetch_sh" ]] || chmod +x "$fetch_sh"
  local args=()
  local _oifs=$IFS
  IFS=','
  for _entry in $platforms_csv; do
    IFS=$_oifs
    _p="$(trim_spaces "$_entry")"
    [[ -z "$_p" ]] && continue
    args+=("$_p")
  done
  IFS=$_oifs
  echo "[buildDocker.sh] 确保 code-server 本地 tarball（docker/code-server/）…" >&2
  if [[ "${#args[@]}" -eq 0 ]]; then
    "$fetch_sh"
  else
    "$fetch_sh" "${args[@]}"
  fi
}

native_arch_slug() {
  platform_to_arch_slug "$(native_platform)"
}

resolve_push_ref() {
  if [[ -n "${DOCKER_PUSH_IMAGE:-}" ]]; then
    printf '%s' "$DOCKER_PUSH_IMAGE"
    return 0
  fi
  if [[ -n "${DOCKER_REGISTRY_REPOSITORY:-}" ]]; then
    local base="${DOCKER_REGISTRY_REPOSITORY%/}"
    local tag="${DOCKER_IMAGE_TAG:-latest}"
    printf '%s:%s' "$base" "$tag"
    return 0
  fi
  printf '%s' "$IMAGE"
}

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
if [[ -n "${NODE_VERSION:-}" ]]; then
  BUILD_ARGS+=( --build-arg "NODE_VERSION=${NODE_VERSION}" )
fi
if [[ -n "${CODE_SERVER_VERSION:-}" ]]; then
  BUILD_ARGS+=( --build-arg "CODE_SERVER_VERSION=${CODE_SERVER_VERSION}" )
fi
if [[ -n "${NPM_REGISTRY:-}" ]]; then
  BUILD_ARGS+=( --build-arg "NPM_REGISTRY=${NPM_REGISTRY}" )
fi

BX=( run_docker_buildx build )
if [[ -n "${DOCKER_BUILDX_BUILDER:-}" ]]; then
  BX+=( --builder "${DOCKER_BUILDX_BUILDER}" )
fi

# 推送/导出阶段：使用 --progress=plain 保留完整日志；由 python 解析 X/Y 传输与阶段，在 stderr 单行刷新进度与 ETA。
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
  local -a injected=()
  local seen_build=0
  local arg
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
  # 不可使用 `docker … | python3 <<'PY'`：heredoc 会占用 python 的 stdin，管道无人读，docker 很快 SIGPIPE/失败。
  local progress_py=""
  progress_py="$(mktemp "${TMPDIR:-/tmp}/buildDocker-progress.XXXXXX")" || return 1
  # 不用 trap RETURN：macOS /bin/bash 3.2 不支持 RETURN。
  cat >"$progress_py" <<'PYCODE'
import re, select, sys, time

_FRAC = re.compile(
    r"([\d.]+)\s*([KMGTPk]?[bB]|[KMGTP]B)\s*/\s*([\d.]+)\s*([KMGTPk]?[bB]|[KMGTP]B)"
)


def fmt_sec(sec):
    if sec is None or sec < 0:
        return "--"
    sec = int(sec + 0.5)
    if sec >= 3600:
        return "%dh%02dm" % (sec // 3600, (sec % 3600) // 60)
    if sec >= 60:
        return "%dm%02ds" % (sec // 60, sec % 60)
    return "%ds" % sec


def to_bytes(val, unit):
    u = unit.replace("kB", "KB").replace("mB", "MB").upper()
    mult = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4, "PB": 1024**5}
    return float(val) * mult.get(u, 1024**2)


def main():
    start = time.monotonic()
    phase = {"t_export": None, "t_push": None, "name": "构建"}
    last_cur = last_tot = 0.0
    samples = []
    last_draw = 0.0

    def note_phase(line):
        low = line.lower()
        if "pushing layer" in low or "pushing layers" in low or "pushing manifest" in low:
            phase["name"] = "推送"
            if phase["t_push"] is None:
                phase["t_push"] = time.monotonic()
            return
        if "exporting to image" in low or "exporting layers" in low:
            phase["name"] = "导出镜像"
            if phase["t_export"] is None:
                phase["t_export"] = time.monotonic()
            return
        if "transferring context" in low or "resolve " in low:
            phase["name"] = "解析/上下文"
            return
        if "load build definition" in low or "load .dockerignore" in low:
            phase["name"] = "加载定义"
            return

    def ingest_line(line, now):
        nonlocal last_cur, last_tot
        note_phase(line)
        m = _FRAC.search(line)
        if not m:
            return
        try:
            c = to_bytes(m.group(1), m.group(2))
            t = to_bytes(m.group(3), m.group(4))
        except (ValueError, TypeError):
            return
        if t <= 0:
            return
        cur_b = min(c, t)
        if last_tot > 0 and abs(t - last_tot) / max(last_tot, 1) > 0.02:
            samples.clear()
        last_cur, last_tot = cur_b, t
        samples.append((now, cur_b))
        while len(samples) > 16:
            samples.pop(0)

    def draw(now, force=False):
        nonlocal last_draw
        if not force and now - last_draw < 0.2:
            return
        last_draw = now
        elapsed = now - start
        export_t, push_t = phase["t_export"], phase["t_push"]
        pname = phase["name"]

        pct_s = pname
        eta = None
        if last_tot > 0:
            pct = min(100.0, 100.0 * last_cur / last_tot)
            pct_s = "%s %.1f%%" % (pname, pct)
            if last_cur < last_tot and len(samples) >= 2:
                t0, c0 = samples[-2]
                t1, c1 = samples[-1]
                dt, dc = t1 - t0, c1 - c0
                if dt > 0.08 and dc > 0:
                    rate = dc / dt
                    if rate > 0:
                        eta = (last_tot - last_cur) / rate

        if eta is None and (push_t is not None or export_t is not None or pname in ("推送", "导出镜像")):
            phase_anchor = push_t or export_t or start
            ep = now - phase_anchor
            if ep >= 2:
                eta = max(15.0, ep * 1.5)

        line = (
            "[buildDocker.sh] 进度 %s | 已用时 %s | 预计剩余 %s"
            % (pct_s, fmt_sec(elapsed), fmt_sec(eta))
        )
        sys.stderr.write("\r\033[2K" + line)
        sys.stderr.flush()

    try:
        while True:
            r, _, _ = select.select([sys.stdin], [], [], 0.8)
            now = time.monotonic()
            if not r:
                draw(now)
                continue
            raw = sys.stdin.readline()
            if raw == "":
                break
            sys.stdout.write(raw)
            sys.stdout.flush()
            ingest_line(raw, now)
            draw(now)
    except KeyboardInterrupt:
        sys.stderr.write("\n")
        sys.stderr.flush()
        raise
    now = time.monotonic()
    draw(now, force=True)
    sys.stderr.write("\n")
    sys.stderr.flush()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(0)
PYCODE
  "${injected[@]}" 2>&1 | python3 -u "$progress_py"
  # 须在一条 local 里同时读 PIPESTATUS：第一个 local 执行后会覆盖 PIPESTATUS，set -u 下再读 [1] 会报错。
  local dock="${PIPESTATUS[0]}" py="${PIPESTATUS[1]}"
  rm -f "$progress_py"
  progress_py=""
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
    # 快照版本：避免 Bash 3.2 在含全角括号的 echo 等处误解析 $TAG_TS；循环内仅用快照。
    _tag_ts="${TAG_TS}"
    # macOS /bin/bash 为 3.2，无 read -a；用 IFS 拆分 PLATFORMS。
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
