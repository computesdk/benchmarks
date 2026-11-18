/**
 * Shell function emitting a nanosecond epoch/monotonic timestamp for
 * in-sandbox step timing. `date +%s%N` only works with GNU coreutils —
 * BusyBox `date` (Alpine) emits whole seconds or a literal "%N", collapsing
 * every delta to 0 and failing "invalid nonpositive or nonfinite NS" checks.
 * Detection mirrors dax-benchmark.sh: a valid %N result is 19+ digits.
 * Fallbacks: bash's $EPOCHREALTIME when bash exists (stock Alpine has none),
 * then /proc/uptime — a µs monotonic clock that needs only busybox `sh`.
 * Fraction parts are stripped of leading zeros: POSIX `$((...))` reads
 * zero-prefixed values as octal, rejecting 8 and 9.
 */
export const NOW_NS_FN = `now_ns() {
  ns=$(date +%s%N 2>/dev/null)
  case "$ns" in ''|*[!0-9]*) ns='' ;; *) [ "\${#ns}" -ge 19 ] || ns='' ;; esac
  if [ -z "$ns" ] && command -v bash >/dev/null 2>&1; then
    ns=$(bash -c 'r=\${EPOCHREALTIME/,/.}; f=\${r#*.}; while [ "\${f#0}" != "$f" ]; do f=\${f#0}; done; printf "%s%09d" "\${r%.*}" "$(( \${f:-0} * 1000 ))"' 2>/dev/null)
  fi
  if [ -z "$ns" ]; then
    read -r up _ < /proc/uptime
    f=\${up#*.}
    while [ "\${f#0}" != "$f" ]; do f=\${f#0}; done
    ns=$(printf '%s%09d' "\${up%.*}" "$(( \${f:-0} * 10000000 ))")
  fi
  printf '%s' "$ns"
}`;
