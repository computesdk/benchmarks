#!/usr/bin/env bash
# Cold OpenCode clone/install/typecheck benchmark for a fresh VM (Debian/Ubuntu x86_64 or aarch64).

set -euo pipefail

REPO_URL="${BENCH_REPO_URL:-https://github.com/anomalyco/opencode.git}"
COMMIT="${BENCH_COMMIT:-08fb47373509ba64b13441061314eeacf4264f51}"
BUN_VERSION="${BENCH_BUN_VERSION:-1.3.14}"
NODE_VERSION="${BENCH_NODE_VERSION:-24.14.1}"
ROOT="${BENCH_ROOT:-/tmp/opencode-provider-benchmark}"
KEEP_ROOT="${BENCH_KEEP_ROOT:-false}"
PROVIDER="${BENCH_PROVIDER:-unknown}"
REGION="${BENCH_REGION:-unknown}"

# Detect architecture for Node.js and Bun downloads.
# x86_64  -> Node: linux-x64, Bun: bun-linux-x64-baseline.zip (path: bun-linux-x64-baseline/bun)
# aarch64 -> Node: linux-arm64, Bun: bun-linux-aarch64.zip   (path: bun-linux-aarch64/bun)
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)
    NODE_ARCH="linux-x64"
    BUN_ARCH="x64"
    BUN_BASELINE_SUFFIX="-baseline"
    ;;
  aarch64|arm64)
    NODE_ARCH="linux-arm64"
    BUN_ARCH="aarch64"
    BUN_BASELINE_SUFFIX=""
    ;;
  *)
    printf 'BENCH_ERROR\tprepare\tunsupported_arch_%s\n' "$ARCH" >&2
    exit 1
    ;;
esac
BUN_FILENAME="bun-linux-${BUN_ARCH}${BUN_BASELINE_SUFFIX}.zip"
BUN_INTERNAL_PATH="bun-linux-${BUN_ARCH}${BUN_BASELINE_SUFFIX}/bun"

# Detect the available package manager (apt-get on Debian/Ubuntu, dnf on RHEL/Fedora).
PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MANAGER="dnf"
else
  printf 'BENCH_ERROR\tprepare\tno_package_manager_found\n' >&2
  exit 1
fi

declare -A PHASE_MS=()

timestamp() {
  date +%s%N
}

phase() {
  local name="$1"
  shift
  local start end
  start="$(timestamp)"
  set +e
  "$@"
  local status=$?
  set -e
  end="$(timestamp)"
  PHASE_MS["$name"]="$(( (end - start) / 1000000 ))"
  printf 'BENCH_PHASE\t%s\t%s\n' "$name" "${PHASE_MS[$name]}"
  return "$status"
}

seconds() {
  awk -v milliseconds="${1:-0}" 'BEGIN { printf "%.3fs", milliseconds / 1000 }'
}

render_table() {
  local result="$1"
  local typecheck="—"
  local workload="—"
  if [[ -n "${PHASE_MS[typecheck]:-}" ]]; then
    typecheck="$(seconds "${PHASE_MS[typecheck]}")"
  fi
  if [[ "$result" == "✅" ]]; then
    workload="$(seconds "$(( ${PHASE_MS[clone]} + ${PHASE_MS[install]} + ${PHASE_MS[typecheck]} ))")"
  elif [[ -n "${PHASE_MS[typecheck]:-}" ]]; then
    typecheck="${typecheck} (failed)"
  fi
  local memory
  memory="$(awk '/MemTotal/{printf "%.2f GiB", $2 / 1048576}' /proc/meminfo)"
  local cpu_model
  cpu_model="$(awk -F: '/model name/{gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
  printf '\n| Provider | CPU / RAM | Region / CPU | Clone | Install | Typecheck | Workload total | Result |\n'
  printf '|---|---|---|---:|---:|---:|---:|---|\n'
  printf '| **%s** | %s CPU / %s | %s, %s | %s | %s | %s | %s | %s |\n' \
    "$PROVIDER" \
    "$(getconf _NPROCESSORS_ONLN)" \
    "$memory" \
    "$REGION" \
    "$cpu_model" \
    "$(seconds "${PHASE_MS[clone]:-0}")" \
    "$(seconds "${PHASE_MS[install]:-0}")" \
    "$typecheck" \
    "$workload" \
    "$result"
}

if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null; then
  SUDO=(sudo)
else
  printf 'BENCH_ERROR\tprepare\troot_or_sudo_required\n' >&2
  exit 1
fi

prepare() {
  case "$PKG_MANAGER" in
    apt)
      "${SUDO[@]}" apt-get update -qq
      "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
        bash build-essential ca-certificates curl git python3 python3-setuptools unzip
      ;;
    dnf)
      "${SUDO[@]}" dnf makecache --quiet
      "${SUDO[@]}" dnf install -y --allowerasing \
        bash gcc gcc-c++ make ca-certificates curl git python3 python3-setuptools unzip
      ;;
  esac

  # setuptools is optional - only needed for node-gyp native module compilation,
  # not for the clone/install/typecheck benchmark. Skip the check entirely.

  # Install Node.js only if it's not already available. Some sandboxes (e.g.
  # Vercel) ship Node.js pre-installed; respect that rather than trying to
  # override it (the symlink may not take precedence in PATH).
  if ! command -v node >/dev/null 2>&1; then
    local archive="node-v${NODE_VERSION}-${NODE_ARCH}.tar.gz"
    local prefix="/opt/node-v${NODE_VERSION}-${NODE_ARCH}"
    if ! curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"; then
      printf 'BENCH_ERROR\tprepare\tnode_download_failed\n' >&2
      return 1
    fi
    "${SUDO[@]}" rm -rf "$prefix"
    "${SUDO[@]}" mkdir -p "$prefix"
    if ! "${SUDO[@]}" tar -xzf "/tmp/${archive}" --strip-components=1 -C "$prefix"; then
      printf 'BENCH_ERROR\tprepare\tnode_extract_failed\n' >&2
      return 1
    fi
    for executable in node npm npx corepack; do
      "${SUDO[@]}" ln -sfn "$prefix/bin/$executable" "/usr/local/bin/$executable"
    done
  fi
  if ! command -v node >/dev/null 2>&1; then
    printf 'BENCH_ERROR\tprepare\tnode_not_found\n' >&2
    return 1
  fi
}

download_bun() {
  curl -fsSL \
    "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_FILENAME}" \
    -o "$ROOT/bun.zip"
}

unpack_bun() {
  unzip -q -j "$ROOT/bun.zip" "$BUN_INTERNAL_PATH" -d "$BUN_INSTALL/bin"
  chmod +x "$BUN_INSTALL/bin/bun"
}

clone_repo() {
  mkdir "$ROOT/repo"
  cd "$ROOT/repo"
  git init -q
  git remote add origin "$REPO_URL"
  git fetch -q --depth=1 origin "$COMMIT"
  git checkout -q --detach FETCH_HEAD
  test "$(git rev-parse HEAD)" = "$COMMIT"
}

install_dependencies() {
  cd "$ROOT/repo"
  bun install
  git diff --exit-code -- bun.lock package.json
}

typecheck() {
  cd "$ROOT/repo"
  bun typecheck
}

disk() {
  du -sx --block-size=1 "$ROOT" | awk '{print $1}'
}

clear_caches() {
  rm -rf "$ROOT"
  "${SUDO[@]}" sync
  if "${SUDO[@]}" sh -c 'echo 3 > /proc/sys/vm/drop_caches' 2>/dev/null; then
    printf 'BENCH_CACHE\tguest_page_cache\tdropped\n'
  else
    printf 'BENCH_CACHE\tguest_page_cache\tunavailable\n'
  fi
  printf 'BENCH_CACHE\tworkspace\tfresh\n'
  printf 'BENCH_CACHE\tbun\tempty\n'
  printf 'BENCH_CACHE\tturbo\tempty\n'
}

cleanup() {
  local status=$?
  if [[ "$KEEP_ROOT" != "true" ]]; then
    rm -rf "$ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

total_start="$(timestamp)"
if ! phase prepare prepare; then
  render_table "❌ prepare"
  exit 1
fi

phase cache_clear clear_caches
mkdir -p "$ROOT/bun/bin" "$ROOT/home" "$ROOT/bun-cache"
export HOME="$ROOT/home"
export BUN_INSTALL="$ROOT/bun"
export BUN_INSTALL_CACHE_DIR="$ROOT/bun-cache"
export PATH="$BUN_INSTALL/bin:$PATH"
export CI=true
export OPENCODE_DISABLE_SHARE=true
export TURBO_TELEMETRY_DISABLED=1

printf 'BENCH_META\tcommit\t%s\n' "$COMMIT"
printf 'BENCH_META\tarchitecture\t%s\n' "$(uname -m)"
printf 'BENCH_META\tkernel\t%s\n' "$(uname -sr)"
printf 'BENCH_META\tlogical_cpus\t%s\n' "$(getconf _NPROCESSORS_ONLN)"
printf 'BENCH_META\tcpu_model\t%s\n' "$(awk -F: '/model name/{gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
printf 'BENCH_META\tmemory_kib\t%s\n' "$(awk '/MemTotal/{print $2}' /proc/meminfo)"

if ! phase bun_download download_bun; then
  render_table "❌ Bun download"
  exit 1
fi
if ! phase bun_unpack unpack_bun; then
  render_table "❌ Bun unpack"
  exit 1
fi
printf 'BENCH_META\tbun_version\t%s\n' "$(bun --version)"
printf 'BENCH_META\tnode_version\t%s\n' "$(node --version)"

if ! phase clone clone_repo; then
  render_table "❌ clone"
  exit 1
fi
printf 'BENCH_DISK\tafter_clone\t%s\n' "$(disk)"
if ! phase install install_dependencies; then
  render_table "❌ install"
  exit 1
fi
printf 'BENCH_DISK\tafter_install\t%s\n' "$(disk)"
if ! phase typecheck typecheck; then
  render_table "❌ typecheck"
  exit 1
fi
printf 'BENCH_DISK\tafter_typecheck\t%s\n' "$(disk)"
printf 'BENCH_DONE\t%s\n' "$(git -C "$ROOT/repo" rev-parse HEAD)"
total_end="$(timestamp)"
printf 'BENCH_PHASE\ttotal\t%s\n' "$(( (total_end - total_start) / 1000000 ))"
render_table "✅"
