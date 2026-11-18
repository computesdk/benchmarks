#!/usr/bin/env bash
# CPU throughput benchmark for a fresh sandbox. Two CPU-bound measurements:
#   single - one `dd | sha256sum` pipe: per-core hashing speed.
#   multi  - nproc parallel copies of the same pipe: whole-box throughput.
# Protocol (parsed by cpu.bench.ts):
#   BENCH_PHASE <name> <ms> / BENCH_BYTES <name> <bytes> /
#   BENCH_META <key> <value> / BENCH_DONE / BENCH_ERROR <where> <detail> (stderr)
# Every line is also appended to $RESULTS inside the sandbox: exec streams on
# some providers drop mid-stream chunks, and cpu.bench.ts re-reads the file to
# recover lines the streamed stdout lost.
# NOTE: some providers cap exec-command size (miosa: 4096 bytes) — keep this
# script under 4000 bytes. Check `wc -c` after editing.
set -euo pipefail

RESULTS=/tmp/cpu-bench-results.txt
: > "$RESULTS"
out() { printf "$@" | tee -a "$RESULTS"; }
err() { printf "$@" | tee -a "$RESULTS" >&2; }

SHA256=""
if command -v sha256sum >/dev/null 2>&1; then SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then SHA256="shasum -a 256"
else err 'BENCH_ERROR\tprepare\tno_sha256_tool\n'; exit 1; fi
command -v dd >/dev/null 2>&1 || { err 'BENCH_ERROR\tprepare\tno_dd\n'; exit 1; }

# nproc honors cgroup affinity where available; fall back to cpu.max / cpuinfo.
NPROC=""
if command -v nproc >/dev/null 2>&1; then NPROC="$(nproc)"
elif [ -r /sys/fs/cgroup/cpu.max ]; then
  read -r QUOTA PERIOD < /sys/fs/cgroup/cpu.max || true
  if [ "${QUOTA:-}" != "max" ] && [ -n "${QUOTA:-}" ] && [ "${PERIOD:-0}" -gt 0 ] 2>/dev/null; then
    NPROC=$(( (QUOTA + PERIOD - 1) / PERIOD ))
  fi
fi
if [ -z "${NPROC:-}" ] || [ "$NPROC" -lt 1 ] 2>/dev/null; then
  NPROC="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)"
fi

SINGLE_MB="${BENCH_SINGLE_MB:-4096}"
CHUNK_MB="${BENCH_CHUNK_MB:-2048}"
BS=1048576
# /proc/uptime is monotonic; EPOCHREALTIME is wall clock and can step forward
# mid-run when a provider boots a snapshot whose guest clock is stale (e.g.
# codesandbox restores jump ~days, NTP corrects during the first seconds).
now_us() {
  read -r up _ < /proc/uptime 2>/dev/null || up=""
  if [ -n "$up" ]; then
    printf '%s' "${up/./}0000"
  else
    printf '%s' "${EPOCHREALTIME/./}"
  fi
}

# cpuinfo formats differ (x86 "model name", ARM "Model"/nothing); use uname as fallback.
model="$(grep -m1 -E '^(model name|Model|cpu model)\b' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | xargs || true)"
[ -z "${model:-}" ] && model="$(uname -m)"
out 'BENCH_META\tcpu_model\t%s\n' "$model"
out 'BENCH_META\tarchitecture\t%s\n' "$(uname -m)"
out 'BENCH_META\tkernel\t%s\n' "$(uname -sr)"
out 'BENCH_META\tlogical_cpus\t%s\n' "$NPROC"
out 'BENCH_META\tmemory_kib\t%s\n' "$(grep -m1 '^MemTotal:' /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)"

t0=$(now_us)
dd if=/dev/zero bs=$BS count="$SINGLE_MB" 2>/dev/null | $SHA256 >/dev/null
t1=$(now_us)
out 'BENCH_PHASE\tsingle\t%s\n' $(( (10#$t1 - 10#$t0) / 1000 ))
out 'BENCH_BYTES\tsingle\t%s\n' $(( SINGLE_MB * BS ))

# Wall time covers the slowest worker — unfair scheduling or throttling is
# measured, not hidden. `wait` per pid: bare `wait` always exits 0.
t0=$(now_us)
pids=()
for _ in $(seq 1 "$NPROC"); do
  dd if=/dev/zero bs=$BS count="$CHUNK_MB" 2>/dev/null | $SHA256 >/dev/null &
  pids+=("$!")
done
fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
t1=$(now_us)
if [ "$fail" -ne 0 ]; then err 'BENCH_ERROR\tmulti\tworker_failed\n'; exit 1; fi
out 'BENCH_PHASE\tmulti\t%s\n' $(( (10#$t1 - 10#$t0) / 1000 ))
out 'BENCH_BYTES\tmulti\t%s\n' $(( NPROC * CHUNK_MB * BS ))
out 'BENCH_DONE\n'
