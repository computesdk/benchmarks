#!/usr/bin/env bash
# Cold git-repo workload benchmark for a fresh VM: clone vercel/next.js at a
# pinned commit, pnpm install, pnpm build. Measures each phase so the gap
# between "sandbox reports ready" and "sandbox can actually do real work" is
# visible per provider.
# Supports Debian/Ubuntu (apt), RHEL/Fedora (dnf), and Alpine (apk) on x86_64 or aarch64.

set -euo pipefail

REPO_URL="${BENCH_REPO_URL:-https://github.com/vercel/next.js.git}"
COMMIT="${BENCH_COMMIT:-a6d4c15991fd2f69c14eea4e8b655b596bc162bf}"
NODE_VERSION="${BENCH_NODE_VERSION:-24.14.1}"
ROOT="${BENCH_ROOT:-/tmp/nextjs-provider-benchmark}"
KEEP_ROOT="${BENCH_KEEP_ROOT:-false}"
PROVIDER="${BENCH_PROVIDER:-unknown}"
REGION="${BENCH_REGION:-unknown}"

# Detect architecture for Node.js downloads.
# x86_64  -> Node: linux-x64
# aarch64 -> Node: linux-arm64
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)
    NODE_ARCH="linux-x64"
    ;;
  aarch64|arm64)
    NODE_ARCH="linux-arm64"
    ;;
  *)
    printf 'BENCH_ERROR\tprepare\tunsupported_arch_%s\n' "$ARCH" >&2
    exit 1
    ;;
esac

# Detect the available package manager (apt-get on Debian/Ubuntu, dnf on
# RHEL/Fedora, apk on Alpine).
PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MANAGER="dnf"
elif command -v apk >/dev/null 2>&1; then
  PKG_MANAGER="apk"
else
  printf 'BENCH_ERROR\tprepare\tno_package_manager_found\n' >&2
  exit 1
fi

declare -A PHASE_MS=()

# Return a nanosecond epoch timestamp. GNU coreutils `date` supports %N and
# yields a 19-digit value. BusyBox `date` (Alpine) does not expand %N, emitting
# only the 10-digit seconds (or a literal "N"), which would collapse every phase
# delta to 0. In that case fall back to bash's builtin EPOCHREALTIME
# (seconds.microseconds, locale radix normalized to a dot), padded to ns.
timestamp() {
  local ns="$(date +%s%N 2>/dev/null)"
  if [[ "$ns" == *[!0-9]* || ${#ns} -lt 19 ]]; then
    local real="${EPOCHREALTIME/,/.}"
    ns="${real%.*}${real#*.}000"
  fi
  printf '%s' "$ns"
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
  if [[ "$status" -ne 0 ]]; then printf 'BENCH_FAIL\t%s\n' "$name"; fi
  return "$status"
}

seconds() {
  awk -v milliseconds="${1:-0}" 'BEGIN { printf "%.3fs", milliseconds / 1000 }'
}

render_table() {
  local result="$1"
  local build="—"
  local workload="—"
  if [[ -n "${PHASE_MS[build]:-}" ]]; then
    build="$(seconds "${PHASE_MS[build]}")"
  fi
  if [[ "$result" == "✅" ]]; then
    workload="$(seconds "$(( ${PHASE_MS[clone]} + ${PHASE_MS[toolchain]} + ${PHASE_MS[install]} + ${PHASE_MS[build]} ))")"
  elif [[ -n "${PHASE_MS[build]:-}" ]]; then
    build="${build} (failed)"
  fi
  local memory
  memory="$(awk '/MemTotal/{printf "%.2f GiB", $2 / 1048576}' /proc/meminfo)"
  local cpu_model
  cpu_model="$(awk -F: '/model name/{gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
  printf '\n| Provider | CPU / RAM | Region / CPU | Clone | Install | Build | Workload total | Result |\n'
  printf '|---|---|---|---:|---:|---:|---:|---|\n'
  printf '| **%s** | %s CPU / %s | %s, %s | %s | %s | %s | %s | %s |\n' \
    "$PROVIDER" \
    "$(getconf _NPROCESSORS_ONLN)" \
    "$memory" \
    "$REGION" \
    "$cpu_model" \
    "$(seconds "${PHASE_MS[clone]:-0}")" \
    "$(seconds "${PHASE_MS[install]:-0}")" \
    "$build" \
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
        bash build-essential ca-certificates curl git python3 python3-setuptools
      ;;
    dnf)
      "${SUDO[@]}" dnf makecache --quiet
      "${SUDO[@]}" dnf install -y --allowerasing \
        bash gcc gcc-c++ make ca-certificates curl git python3 python3-setuptools
      ;;
    apk)
      # build-base is Alpine's meta-package for gcc/g++/make/libc-dev.
      "${SUDO[@]}" apk add --no-cache \
        bash build-base ca-certificates curl git python3 py3-setuptools
      ;;
  esac

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

clone_repo() {
  mkdir "$ROOT/repo"
  cd "$ROOT/repo"
  git init -q
  git remote add origin "$REPO_URL"
  git fetch -q --depth=1 origin "$COMMIT"
  git checkout -q --detach FETCH_HEAD
  test "$(git rev-parse HEAD)" = "$COMMIT"
}

install_toolchain() {
  cd "$ROOT/repo"
  # The repo pins its pnpm version via the packageManager field. corepack's
  # shim needs a prepare/activate dance that fails on several sandbox images,
  # so install that exact pnpm globally through npm instead — universal.
  local spec
  spec="$(node -p "require('./package.json').packageManager")"
  case "$spec" in
    pnpm@*) ;;
    *) printf 'BENCH_ERROR\ttoolchain\tunexpected_package_manager_%s\n' "$spec" >&2; return 1 ;;
  esac
  # Install into a workspace prefix: non-root users can't write /usr/local.
  npm i -g --prefix "$ROOT/pnpm-global" "$spec" --silent
  export PATH="$ROOT/pnpm-global/bin:$PATH"
}

install_dependencies() {
  cd "$ROOT/repo"
  pnpm install --frozen-lockfile || return $?
  git diff --exit-code -- pnpm-lock.yaml package.json
}

build_repo() {
  cd "$ROOT/repo"
  pnpm build
}

disk() {
  # No -x: the workspace can sit on a different mount than the rest of the
  # root filesystem (e2b), and "how much did the workload write" is the point.
  du -sk "$ROOT" | awk '{print $1 * 1024}'
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
  printf 'BENCH_CACHE\tpnpm\tempty\n'
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
mkdir -p "$ROOT/home" "$ROOT/pnpm-store" "$ROOT/turbo-cache"
export HOME="$ROOT/home"
export PNPM_HOME="$ROOT/pnpm-home"
export COREPACK_HOME="$ROOT/corepack-home"
export TURBO_CACHE_DIR="$ROOT/turbo-cache"
export PATH="$PNPM_HOME:$PATH"
export CI=true
export TURBO_TELEMETRY_DISABLED=1
export NEXT_TELEMETRY_DISABLED=1

printf 'BENCH_META\tcommit\t%s\n' "$COMMIT"
printf 'BENCH_META\tarchitecture\t%s\n' "$(uname -m)"
printf 'BENCH_META\tkernel\t%s\n' "$(uname -sr)"
printf 'BENCH_META\tlogical_cpus\t%s\n' "$(getconf _NPROCESSORS_ONLN)"
printf 'BENCH_META\tcpu_model\t%s\n' "$(awk -F: '/model name/{gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
printf 'BENCH_META\tmemory_kib\t%s\n' "$(awk '/MemTotal/{print $2}' /proc/meminfo)"

if ! phase clone clone_repo; then
  render_table "❌ clone"
  exit 1
fi
printf 'BENCH_DISK\tafter_clone\t%s\n' "$(disk)"
if ! phase toolchain install_toolchain; then
  render_table "❌ toolchain"
  exit 1
fi
printf 'BENCH_META\tpnpm_version\t%s\n' "$(pnpm --version)"
printf 'BENCH_META\tnode_version\t%s\n' "$(node --version)"
if ! phase install install_dependencies; then
  render_table "❌ install"
  exit 1
fi
printf 'BENCH_DISK\tafter_install\t%s\n' "$(disk)"
if ! phase build build_repo; then
  render_table "❌ build"
  exit 1
fi
printf 'BENCH_DISK\tafter_build\t%s\n' "$(disk)"
printf 'BENCH_DONE\t%s\n' "$(git -C "$ROOT/repo" rev-parse HEAD)"
total_end="$(timestamp)"
printf 'BENCH_PHASE\ttotal\t%s\n' "$(( (total_end - total_start) / 1000000 ))"
render_table "✅"
