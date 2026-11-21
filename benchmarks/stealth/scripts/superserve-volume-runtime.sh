#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ] || [ "$(id -u)" != 0 ]; then
  echo 'Build the volume guest runtime as root on Linux amd64.' >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl python3 fuse3 util-linux coreutils
python3 - <<'PYTHON_RUNTIME_CHECK'
import ctypes
import os
import sys
value = ctypes.c_int()
if sys.version_info < (3, 9) or not hasattr(os, 'waitid') or not hasattr(os, 'WNOWAIT') or ctypes.CDLL(None).prctl(2, ctypes.byref(value), 0, 0, 0) != 0:
    raise SystemExit('The volume guest runtime requires Python 3.9+ with Linux child supervision support.')
PYTHON_RUNTIME_CHECK
for tool in fusermount3 findmnt mountpoint sync; do
  command -v "$tool" >/dev/null
done

temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
  --connect-timeout 30 --max-time 180 --retry 2 \
  --output "$temporary/client.tar.gz" \
  https://github.com/juicedata/juicefs/releases/download/v1.4.2/juicefs-1.4.2-linux-amd64.tar.gz
printf '%s  %s\n' 79648a0a67145bf42ca4e8336578c13a5bbc9a0bd34df340b3b93dac1e975247 "$temporary/client.tar.gz" | sha256sum -c -
tar -xzf "$temporary/client.tar.gz" -C "$temporary" juicefs
printf '%s  %s\n' 6d450d3c151b6affede364d9a198d2505111b0612a5fb4d31613444c635174cc "$temporary/juicefs" | sha256sum -c -
install -d -m 0700 /opt/superserve-volumes
install -d -m 0755 /opt/superserve-volumes/bin
install -m 0755 "$temporary/juicefs" /opt/superserve-volumes/bin/juicefs
/opt/superserve-volumes/bin/juicefs --version
test "$(id -u node)" = 1000
test "$(id -g node)" = 1000
