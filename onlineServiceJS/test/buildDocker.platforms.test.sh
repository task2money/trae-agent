#!/usr/bin/env bash
# buildDocker.sh 平台解析：默认 amd64；DOCKER_PLATFORMS=all 展开双架构。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_SH="${SCRIPT_DIR}/../buildDocker.sh"

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL $label: got='$got' want='$want'" >&2
    exit 1
  fi
  echo "PASS $label"
}

assert_eq "$( "$BUILD_SH" --print-platforms )" "linux/amd64" "default"
assert_eq "$( DOCKER_PLATFORMS=all "$BUILD_SH" --print-platforms )" "linux/amd64,linux/arm64" "all"
assert_eq "$( DOCKER_PLATFORMS=ALL "$BUILD_SH" --print-platforms )" "linux/amd64,linux/arm64" "ALL"
assert_eq "$( DOCKER_PLATFORMS=linux/arm64 "$BUILD_SH" --print-platforms )" "linux/arm64" "explicit-arm64"
assert_eq "$( DOCKER_PLATFORMS=linux/amd64,linux/arm64 "$BUILD_SH" --print-platforms )" \
  "linux/amd64,linux/arm64" "explicit-both"
echo "OK buildDocker.platforms"
