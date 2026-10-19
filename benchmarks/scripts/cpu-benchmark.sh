#!/usr/bin/env bash
# CPU throughput benchmark for a fresh sandbox.
#
# Two measurements, both CPU-bound with no network, disk, or package installs:
#   single  - one `dd if=/dev/zero | sha256sum` pipe: per-core hashing speed.
#   multi   - nproc parallel copies of the same pipe: whole-box throughput.
#
# SHA-256 hashing is CPU-bound (the kernel serves /dev/zero faster than any
# hasher consumes it) and engages SHA-NI / ARMv8 SHA extensions where the CPU
# has them — a real hardware feature we want the grade to reflect. Providers
# that throttle vCPUs via cgroup quotas score lower, which is the point.
#
# Output protocol (parsed by cpu.bench.ts):
#   BENCH_PHASE <name> <ms>       wall time of each measured phase
#   BENCH_BYTES <name> <bytes>    bytes hashed in that phase
#   BENCH_META  <key> <value>     cpu model, arch, kernel, logical_cpus, memory_kib
#   BENCH_DONE                    both phases completed
#   BENCH_ERROR <where> <detail>  printed to stderr; script exits non-zero

set -euo pipefail

# Dependencies: bash, dd, nproc (with fallbacks), and a SHA-256 hasher. Every
# provider image we run has coreutils; refuse loudly rather than silently
# substituting a different workload that would make scores incomparable.
SHA256=""
if command -v sha256sum >/dev/null 2>&1; then
  SHA256="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA256="shasum -a 256"
else
  printf 'BENCH_ERROR\tprepare\tno_sha256_tool\n' >&2
  exit 1
fi
if ! command -v dd >/dev/null 2>&1; then
  printf 'BENCH_ERROR\tprepare\tno_dd\n' >&2
  exit 1
fi

# Logical CPU count: nproc honors cgroup affinity where available.
NPROC=""
if command -v nproc >/dev/null 2>&1; then
  NPROC="$(nproc)"
elif [ -r /sys/fs/cgroup/cpu.max ]; then
  # cgroup v2 quota: "MAX period" or "<quota> <period>" in microseconds.
  read -r QUOTA PERIOD < /sys/fs/cgroup/cpu.max || true
  if [ "${QUOTA:-}" != "max" ] && [ -n "${QUOTA:-}" ] && [ -n "${PERIOD:-}" ] && [ "$PERIOD" -gt 0 ] 2>/dev/null; then
    NPROC=$(( (QUOTA + PERIOD - 1) / PERIOD ))
  fi
fi
if [ -z "${NPROC:-}" ] || [ "$NPROC" -lt 1 ] 2>/dev/null; then
  NPROC="$(grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo 1)"
fi

# Fixed-work phases sized so a fast core takes ~2s and a weak one ~20s.
SINGLE_MB="${BENCH_SINGLE_MB:-4096}"        # bytes hashed by the single-core phase
CHUNK_MB="${BENCH_CHUNK_MB:-2048}"          # bytes hashed per worker in the multi phase
BS=1048576                                  # dd block size (1 MiB; busybox-safe)

now_us() {
  # EPOCHREALTIME is bash >= 5: "seconds.ffffff" — strip the dot for microseconds.
  printf '%s' "${EPOCHREALTIME/./}"
}

emit_meta() {
  # cpuinfo formats differ (x86 "model name", ARM "Model"/nothing); degrade to uname.
  local model
  model="$(grep -m1 -E '^(model name|Model|cpu model)\b' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | xargs || true)"
  if [ -z "${model:-}" ]; then
    model="$(uname -m)"
  fi
  local mem_kib
  mem_kib="$(grep -m1 '^MemTotal:' /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)"
  printf 'BENCH_META\tcpu_model\t%s\n' "$model"
  printf 'BENCH_META\tarchitecture\t%s\n' "$(uname -m)"
  printf 'BENCH_META\tkernel\t%s\n' "$(uname -sr)"
  printf 'BENCH_META\tlogical_cpus\t%s\n' "$NPROC"
  printf 'BENCH_META\tmemory_kib\t%s\n' "$mem_kib"
}

emit_meta

# --- single-core phase -------------------------------------------------------
t0=$(now_us)
dd if=/dev/zero bs=$BS count="$SINGLE_MB" 2>/dev/null | $SHA256 >/dev/null
t1=$(now_us)
single_ms=$(( (t1 - t0) / 1000 ))
printf 'BENCH_PHASE\tsingle\t%s\n' "$single_ms"
printf 'BENCH_BYTES\tsingle\t%s\n' $(( SINGLE_MB * BS ))

# --- multi-core phase --------------------------------------------------------
# One independent pipe per logical CPU, started together. Wall time covers the
# slowest worker, so unfair scheduling or cgroup throttling is measured, not
# hidden. Aggregate throughput = total bytes / wall time.
t0=$(now_us)
for _ in $(seq 1 "$NPROC"); do
  dd if=/dev/zero bs=$BS count="$CHUNK_MB" 2>/dev/null | $SHA256 >/dev/null &
done
wait
t1=$(now_us)
multi_ms=$(( (t1 - t0) / 1000 ))
printf 'BENCH_PHASE\tmulti\t%s\n' "$multi_ms"
printf 'BENCH_BYTES\tmulti\t%s\n' $(( NPROC * CHUNK_MB * BS ))

printf 'BENCH_DONE\n'
