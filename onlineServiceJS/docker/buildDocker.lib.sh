#!/usr/bin/env bash
# Sourced by ../buildDocker.sh — helpers for image tag/platforms/registry/base image.
# Requires SCRIPT_DIR, REPO_ROOT in caller.

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
      echo "[buildDocker.sh]   2) 仅推送本机/单架构: DOCKER_PLATFORMS=${native} DOCKER_PUSH=1 ./buildDocker.sh" >&2
      echo "[buildDocker.sh]      （默认已是 linux/amd64；全架构请用 DOCKER_PLATFORMS=all）" >&2
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

