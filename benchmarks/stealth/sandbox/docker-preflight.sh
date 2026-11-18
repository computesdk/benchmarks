#!/usr/bin/env bash
# docker-preflight.sh — probe a compute environment: what it is (VM/container/
# microVM), what it can do (KVM, FUSE, tun, mknod, outbound net), and whether
# dockerd + containers will run on it.
#
# Layers probed: environment fingerprint, kernel, namespaces, cgroups,
# storage/overlayfs, devices (kvm/fuse/tun/loop/mknod), network primitives,
# netfilter NAT, sysctls, privileges/caps, syscall surface (io_uring/bpf/
# ptrace), mounts/limits, outbound reachability, runtime binaries.
#
# Functional tests (unshare, mount, rule insertion, fuse-overlayfs, mknod) are
# preferred over module-list checks, and always run inside private namespaces
# or scratch dirs so nothing on the host is touched.
#
# Exit code: 0 = no failures, 1 = one or more FAIL checks.
# Usage: ./docker-preflight.sh [-v]        (-v prints captured stderr on failure)

set -u
VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1

PASS=0; WARN=0; FAIL=0
LAST_ERR=""

c_reset=$'\033[0m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'
[ -t 1 ] || { c_reset=""; c_grn=""; c_yel=""; c_red=""; c_dim=""; }

ok()   { PASS=$((PASS+1)); printf '%sPASS%s %s\n' "$c_grn" "$c_reset" "$1"; }
warn() { WARN=$((WARN+1)); printf '%sWARN%s %s\n' "$c_yel" "$c_reset" "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '%sFAIL%s %s\n' "$c_red" "$c_reset" "$1"
        if [ "$VERBOSE" = 1 ] && [ -n "$LAST_ERR" ]; then printf '     %s%s%s\n' "$c_dim" "$LAST_ERR" "$c_reset"; fi; }
info() { printf '%s....%s %s\n' "$c_dim" "$c_reset" "$1"; }
sect() { printf '\n%s== %s ==%s\n' "$c_dim" "$1" "$c_reset"; }

have() { command -v "$1" >/dev/null 2>&1; }

# run a probe, capture stderr in LAST_ERR; returns the command's exit code
probe() { LAST_ERR="$("$@" 2>&1 >/dev/null)"; }

IS_ROOT=0; [ "$(id -u)" = "0" ] && IS_ROOT=1
UNSHARE_USERNS=0   # set by namespace probes, reused by later functional tests
UNSHARE_NETNS=0
NETNS_PREFIX=""    # "unshare --net" once we know it works

# -------------------------------------------------------- fingerprint ------
sect "Environment fingerprint"
VIRT=$(systemd-detect-virt 2>/dev/null || echo unknown)
info "virtualization: $VIRT"
[ -f /.dockerenv ] && info "/.dockerenv present (container)"
[ -f /run/.containerenv ] && info "/run/.containerenv present (container)"
grep -qwE 'docker|kubepods|containerd' /proc/1/cgroup 2>/dev/null && info "cgroup hints at container runtime"
PID1=$(cat /proc/1/comm 2>/dev/null)
info "PID 1: ${PID1:-?}   shell: ${SHELL:-?}   user: $(id -un 2>/dev/null) ($(id -u))"
[ "${PID1:-}" = "systemd" ] && info "systemd is PID 1 — dockerd cgroupdriver=systemd path available"

if have nproc; then
  info "cpus: $(nproc) (allowed)"
fi
CPUMAX=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null | awk '{print $1"/"$2}')
[ -n "$CPUMAX" ] && info "cgroup cpu.max: $CPUMAX"
MODEL=$(awk -F: '/model name/{gsub(/^ +/,"",$2); print $2; exit}' /proc/cpuinfo)
[ -n "$MODEL" ] && info "cpu: $MODEL"
if grep -qm1 -E ' vmx | svm ' /proc/cpuinfo; then
  ok "cpu exposes hardware virtualization (vmx/svm flag present)"
else
  info "no vmx/svm cpu flag — nested virtualization not exposed to this guest"
fi
MEM=$(awk '/MemTotal/{printf "%.1fG", $2/1048576}' /proc/meminfo)
MEMAV=$(awk '/MemAvailable/{printf "%.1fG", $2/1048576}' /proc/meminfo)
info "memory: ${MEM:-?} total, ${MEMAV:-?} available"
MEMMAX=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)
[ -n "$MEMMAX" ] && info "cgroup memory.max: $MEMMAX"
DF=$(df -h / 2>/dev/null | awk 'NR==2{print $2" total, "$4" avail"}')
info "root fs: ${DF:-?}"
uname -a | sed 's/^/.... uname: /' | cut -c1-120 >/dev/null 2>&1 || true
info "arch: $(uname -m), kernel $(uname -r)"

# ---------------------------------------------------------------- kernel ---
sect "Kernel"
KV=$(uname -r)
case "$KV" in
  [0-2].*|3.*|4.[0-9].*|4.1[0-7].*) warn "kernel <4.18 — old; overlay2/userns quirks likely" ;;
  *) ok "kernel version looks modern" ;;
esac
if [ -d "/lib/modules/$(uname -r)" ]; then
  ok "module tree for running kernel exists (modprobe can load)"
else
  warn "no /lib/modules/$(uname -r) — kernel modules CANNOT be loaded here (typical for microVMs/containers); every needed feature must be builtin"
fi

# ------------------------------------------------------------ namespaces ---
sect "Namespaces"
for ns in mnt pid net uts ipc cgroup user; do
  if [ -e "/proc/self/ns/$ns" ]; then ok "namespace: $ns"
  else { [ "$ns" = "cgroup" ] || [ "$ns" = "user" ]; } && warn "namespace: $ns missing (needed only for cgroup-ns / rootless)" || bad "namespace: $ns missing"; fi
done

if have unshare; then
  # userns first: non-root ns creation goes through it
  probe unshare --user --map-root-user true
  [ $? = 0 ] && { ok "create user ns"; UNSHARE_USERNS=1; } || warn "create user ns (rootless docker / userns-remap unavailable)"

  # try_ns <name> <privileged-flag> — falls back to a user-ns wrapper when not
  # root, since plain unshare needs CAP_SYS_ADMIN otherwise. Distinguishes
  # "kernel can't" (FAIL) from "needs root or userns" (PASS via userns).
  try_ns() { # name, flag
    probe unshare "$2" true
    if [ $? = 0 ]; then ok "create $1 ns"; return 0; fi
    if [ "$UNSHARE_USERNS" = 1 ]; then
      probe unshare --user --map-root-user "$2" true
      if [ $? = 0 ]; then ok "create $1 ns (via user ns)"; return 0; fi
    fi
    bad "create $1 ns (fails privileged AND inside user ns — kernel lacks it)"
    return 1
  }

  try_ns mnt --mount
  try_ns uts --uts
  try_ns ipc --ipc
  # net ns: remember which wrapper worked for the functional net tests below
  probe unshare --net true
  if [ $? = 0 ]; then
    ok "create net ns"; UNSHARE_NETNS=1; NETNS_PREFIX="unshare --net"
  elif [ "$UNSHARE_USERNS" = 1 ]; then
    probe unshare --user --map-root-user --net true
    if [ $? = 0 ]; then
      ok "create net ns (via user ns)"; UNSHARE_NETNS=1; NETNS_PREFIX="unshare --user --map-root-user --net"
    else
      bad "create net ns (fails privileged AND inside user ns)"
    fi
  else
    bad "create net ns"
  fi
  probe unshare --pid --fork --mount-proc true
  if [ $? = 0 ]; then ok "create pid ns"
  elif [ "$UNSHARE_USERNS" = 1 ]; then
    probe unshare --user --map-root-user --pid --fork --mount-proc true
    [ $? = 0 ] && ok "create pid ns (via user ns)" || warn "create pid ns (blocked even inside user ns)"
  else
    warn "create pid ns"
  fi
else
  warn "unshare not found — install util-linux to run functional namespace tests"
fi

for f in /proc/sys/kernel/unprivileged_userns_clone \
         /proc/sys/kernel/apparmor_restrict_unprivileged_userns \
         /proc/sys/user/max_user_namespaces; do
  if [ -r "$f" ]; then
    v=$(cat "$f" 2>/dev/null)
    case "$f:$v" in
      *unprivileged_userns_clone:0|*apparmor_restrict_unprivileged_userns:1|*max_user_namespaces:0)
        warn "$f = $v (blocks unprivileged user namespaces)" ;;
      *) info "$f = $v" ;;
    esac
  fi
done

# --------------------------------------------------------------- cgroups ---
sect "cgroups"
CG_FSTYPE=$(stat -f -c %T /sys/fs/cgroup 2>/dev/null)
if [ "$CG_FSTYPE" = "cgroup2fs" ]; then
  ok "cgroup v2 (unified) mounted at /sys/fs/cgroup"
  CTRL=$(cat /sys/fs/cgroup/cgroup.controllers 2>/dev/null)
  info "available controllers: ${CTRL:-none readable}"
  for c in cpu memory io pids cpuset; do
    case " $CTRL " in *" $c "*) ok "controller: $c" ;; *) warn "controller: $c not available — resource limits for it won't work" ;; esac
  done
  SUBTREE=$(cat /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null)
  info "root subtree_control: ${SUBTREE:-unreadable}"
elif [ "$CG_FSTYPE" = "tmpfs" ]; then
  ok "cgroup v1 (or hybrid) layout at /sys/fs/cgroup"
  for c in cpu memory pids blkio cpuset devices; do
    [ -d "/sys/fs/cgroup/$c" ] && ok "v1 controller: $c" || warn "v1 controller: $c missing"
  done
else
  bad "no cgroup filesystem at /sys/fs/cgroup (fstype: ${CG_FSTYPE:-unknown})"
fi
if [ -w /sys/fs/cgroup ]; then info "/sys/fs/cgroup is writable"
else warn "/sys/fs/cgroup not writable (need a delegated slice for rootless; fully-ro breaks dockerd)"; fi

# ------------------------------------------------------------- devices -----
sect "Devices"
# KVM
if [ -c /dev/kvm ]; then
  if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then
    ok "/dev/kvm readable+writable — can run KVM (nested microVMs possible)"
  else
    warn "/dev/kvm exists but not usable by this user (perms: $(stat -c %a /dev/kvm 2>/dev/null), owner $(stat -c %U:%G /dev/kvm 2>/dev/null))"
  fi
else
  if grep -qm1 -E ' vmx | svm ' /proc/cpuinfo; then
    warn "no /dev/kvm although cpu has vmx/svm — kvm module not loaded/usable here"
  else
    info "no /dev/kvm (and no virt cpu flag) — nested virtualization unavailable"
  fi
fi
ls /sys/module/kvm 2>/dev/null >/dev/null && info "kvm module loaded" || true

# FUSE
if [ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]; then
  ok "/dev/fuse accessible"
else
  warn "/dev/fuse missing or inaccessible — FUSE filesystems (fuse-overlayfs, s3fs, blobfuse…) won't work"
fi
FUSERMNT=""; for b in fusermount3 fusermount; do have "$b" && { FUSERMNT=$b; break; }; done
[ -n "$FUSERMNT" ] && ok "found: $FUSERMNT" || warn "no fusermount — can't mount FUSE filesystems"
# functional fuse mount if fuse-overlayfs is around
if have fuse-overlayfs; then
  FDIR=$(mktemp -d); mkdir -p "$FDIR"/{l,u,w,m}
  probe fuse-overlayfs -o "lowerdir=$FDIR/l,upperdir=$FDIR/u,workdir=$FDIR/w" "$FDIR/m"
  if [ $? = 0 ]; then
    ok "functional fuse-overlayfs mount works"
    ${FUSERMNT:-fusermount3} -u "$FDIR/m" >/dev/null 2>&1 || umount "$FDIR/m" >/dev/null 2>&1
  else
    warn "fuse-overlayfs mount failed"
  fi
  rm -rf "$FDIR"
fi

# tun
if [ -c /dev/net/tun ] && [ -r /dev/net/tun ]; then
  ok "/dev/net/tun exists (VPN/tap users; dockerd itself doesn't need it)"
else
  info "/dev/net/tun absent or unreadable"
fi

# loop devices (needed for some image builders / mounts)
if [ -c /dev/loop-control ]; then
  if have losetup; then
    LO=$(losetup -f 2>/dev/null)
    [ -n "$LO" ] && ok "loop devices usable (next free: $LO)" || warn "loop-control exists but losetup -f failed (busy or denied)"
  else
    info "/dev/loop-control present, losetup not installed to verify"
  fi
else
  info "no /dev/loop-control — loop mounts unavailable"
fi

# mknod — device cgroup gate for runtimes building rootfs
TDIR=$(mktemp -d)
probe mknod "$TDIR/nulltest" c 1 3
if [ $? = 0 ] && [ -c "$TDIR/nulltest" ]; then
  ok "mknod works (CAP_MKNOD + permissive device cgroup)"
else
  warn "mknod failed — device cgroup blocks it or no CAP_MKNOD (rootfs building inside containers needs it)"
fi
rm -rf "$TDIR"

# /dev/shm
SHM=$(df -h /dev/shm 2>/dev/null | awk 'NR==2{print $2}')
[ -n "$SHM" ] && info "/dev/shm size: $SHM" || info "no /dev/shm"

# ------------------------------------------------------ storage/overlay ----
sect "Storage (overlayfs)"
if grep -qw overlay /proc/filesystems; then
  ok "overlayfs supported by kernel"
else
  if [ "$IS_ROOT" = 1 ] && have modprobe && modprobe overlay 2>/dev/null && grep -qw overlay /proc/filesystems; then
    ok "overlayfs loaded via modprobe"
  else
    bad "overlayfs not supported/loadable — overlay2 driver won't work (vfs fallback is very slow)"
  fi
fi
if [ "$UNSHARE_USERNS" = 1 ] || [ "$IS_ROOT" = 1 ]; then
  ODIR=$(mktemp -d); mkdir -p "$ODIR"/{l,u,w,m}
  if [ "$UNSHARE_USERNS" = 1 ]; then
    probe unshare --user --map-root-user --mount mount -t overlay overlay -o "lowerdir=$ODIR/l,upperdir=$ODIR/u,workdir=$ODIR/w" "$ODIR/m"
  else
    probe unshare --mount mount -t overlay overlay -o "lowerdir=$ODIR/l,upperdir=$ODIR/u,workdir=$ODIR/w" "$ODIR/m"
  fi
  [ $? = 0 ] && ok "functional overlay mount works" || warn "overlay mount failed — kernel may lack overlay-in-userns (needs >=5.11 for unprivileged)"
  rm -rf "$ODIR"
fi
VDIR=/var/lib/docker; [ -d "$VDIR" ] || VDIR=/var/lib; [ -d "$VDIR" ] || VDIR=/
BACK_FS=$(stat -f -c %T "$VDIR" 2>/dev/null)
info "backing fs for $VDIR: ${BACK_FS:-unknown}"
case "$BACK_FS" in
  nfs|nfs4|cifs|smb2|fuse*|overlayfs) warn "backing fs '$BACK_FS' is problematic for docker's graph driver" ;;
esac
# tmpfs mount (unprivileged inside userns+mntns)
if [ "$UNSHARE_USERNS" = 1 ] || [ "$IS_ROOT" = 1 ]; then
  MDIR=$(mktemp -d)
  if [ "$UNSHARE_USERNS" = 1 ]; then
    probe unshare --user --map-root-user --mount mount -t tmpfs none "$MDIR"
  else
    probe unshare --mount mount -t tmpfs none "$MDIR"
  fi
  [ $? = 0 ] && ok "tmpfs mount works" || warn "tmpfs mount failed"
  rm -rf "$MDIR"
fi

# ---------------------------------------------------------- net building ---
sect "Network primitives"
# only run inside a private netns — never touch host interfaces
if [ "$UNSHARE_NETNS" = 1 ]; then
  if have ip; then
    probe $NETNS_PREFIX ip link add pfv0 type veth peer name pfv1
    [ $? = 0 ] && ok "veth pair creatable" || bad "veth pair creatable (veth module missing?)"
    probe $NETNS_PREFIX ip link add pfbr0 type bridge
    [ $? = 0 ] && ok "bridge creatable" || bad "bridge creatable (bridge module missing?)"
  else
    warn "iproute2 ('ip') not found — can't functionally test veth/bridge"
  fi
else
  warn "can't create a net ns to test veth/bridge — need root or a working unshare --net"
fi
grep -qw vxlan /proc/modules 2>/dev/null && info "vxlan loaded (only needed for swarm overlay networks)"

# ----------------------------------------------------------- netfilter -----
sect "netfilter / NAT"
IPT=""
for b in iptables iptables-nft iptables-legacy nft; do have "$b" && { IPT=$b; break; }; done
if [ -n "$IPT" ]; then
  info "using $IPT ($($IPT --version 2>/dev/null | head -1))"
  [ "$IPT" = nft ] && warn "only nft CLI found — dockerd needs iptables or iptables-nft; install iptables"
  # rule tests only inside a private netns — never mutate host tables
  if [ "$UNSHARE_NETNS" = 1 ]; then
    CH="PREFLIGHT_$$"
    probe $NETNS_PREFIX $IPT -t nat -N "$CH"
    [ $? = 0 ] && ok "create NAT chain" || bad "create NAT chain (iptable_nat missing or no CAP_NET_ADMIN)"
    probe $NETNS_PREFIX $IPT -t nat -A POSTROUTING -s 10.99.0.0/24 -j MASQUERADE
    [ $? = 0 ] && ok "MASQUERADE rule (container egress NAT)" || bad "MASQUERADE rule — docker bridge egress NAT won't work"
    probe $NETNS_PREFIX $IPT -t nat -A PREROUTING -p tcp --dport 12399 -j DNAT --to-destination 127.0.0.1:80
    [ $? = 0 ] && ok "DNAT rule (-p port publishing)" || bad "DNAT rule — 'docker run -p' won't work"
    probe $NETNS_PREFIX $IPT -t nat -A OUTPUT -p udp --dport 53 -j DNAT --to-destination 127.0.0.11:53
    [ $? = 0 ] && ok "DNS redirect rule (embedded resolver 127.0.0.11)" || warn "DNS redirect — docker's embedded DNS may fail on custom networks"
    probe $NETNS_PREFIX $IPT -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
    [ $? = 0 ] && ok "conntrack match" || warn "conntrack match failed (nf_conntrack missing?)"
    probe $NETNS_PREFIX $IPT -A FORWARD -p tcp -m tcp -j ACCEPT
    [ $? = 0 ] && ok "filter table + FORWARD chain" || bad "filter/FORWARD — docker can't route bridge traffic"
    $NETNS_PREFIX $IPT -t nat -X "$CH" >/dev/null 2>&1
  else
    warn "no netns/root — skipping iptables rule tests (can't verify CAP_NET_ADMIN)"
  fi
else
  bad "no iptables/nftables binary — dockerd cannot program NAT or port publishing"
fi

if [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
  ok "br_netfilter sysctls present (bridge-nf-call-iptables=$(cat /proc/sys/net/bridge/bridge-nf-call-iptables))"
elif grep -qw br_netfilter /proc/modules; then
  ok "br_netfilter module loaded"
else
  warn "br_netfilter not loaded — dockerd tries to load it at startup; containers on custom networks lose dns/resolution if it's unavailable in the kernel"
fi
grep -qw nf_conntrack /proc/modules && info "nf_conntrack loaded" || info "nf_conntrack not listed in /proc/modules (may be builtin)"

# -------------------------------------------------------------- sysctls ----
sect "sysctls"
IPFWD=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)
if [ "$IPFWD" = "1" ]; then ok "net.ipv4.ip_forward=1"
else info "net.ipv4.ip_forward=${IPFWD:-?} (dockerd sets it itself)"; fi
if [ "$UNSHARE_NETNS" = 1 ]; then
  probe $NETNS_PREFIX sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  [ $? = 0 ] && ok "ip_forward writable inside a netns (dockerd sets it itself)" || warn "cannot set ip_forward even in a fresh netns"
else
  # no private netns: probe writability by writing back the existing value
  probe sh -c "cat /proc/sys/net/ipv4/ip_forward > /proc/sys/net/ipv4/ip_forward"
  [ $? = 0 ] && ok "can write ip_forward in this netns" || warn "cannot write ip_forward in this netns (dockerd will warn; pre-set it on the host/vm)"
fi
UPSTART=$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start 2>/dev/null)
[ -n "$UPSTART" ] && info "ip_unprivileged_port_start=$UPSTART"
[ -e /proc/net/if_inet6 ] && info "IPv6 configured" || info "no IPv6"

# ------------------------------------------------------ privileges / caps --
sect "Privileges"
if [ "$IS_ROOT" = 1 ]; then ok "running as root"
else warn "not root — dockerd needs root OR a working rootless setup (userns + newuidmap + slirp4netns + fuse-overlayfs)"; fi

CAPEFF=$(awk '/CapEff/{print $2}' /proc/self/status)
if have python3; then
  capcheck() { python3 -c "import sys; v=int('$CAPEFF',16); sys.exit(0 if v & (1<<$1) else 1)" 2>/dev/null; }
  for cap in "CAP_SYS_ADMIN 21" "CAP_NET_ADMIN 12" "CAP_SYS_RESOURCE 24" "CAP_MKNOD 27" "CAP_NET_RAW 13" "CAP_SETUID 7" "CAP_SETGID 6" "CAP_DAC_OVERRIDE 1" "CAP_SYS_PTRACE 19" "CAP_CHOWN 0" "CAP_SYS_MODULE 16"; do
    set -- $cap; capcheck "$2" && ok "capability: $1" || warn "capability: $1 missing"
  done
else
  info "no python3 — skipping capability decode (CapEff=$CAPEFF)"
fi

if [ "$IS_ROOT" = 0 ]; then
  for b in newuidmap newgidmap slirp4netns fuse-overlayfs; do
    have "$b" && ok "rootless dep: $b" || warn "rootless dep: $b missing"
  done
  grep -Eq "$(id -un):" /etc/subuid 2>/dev/null && ok "/etc/subuid entry" || warn "no /etc/subuid entry for this user"
fi

# ----------------------------------------------------- syscall surface -----
sect "Syscall / LSM surface"
SECCOMP=$(awk '/Seccomp/{print $2}' /proc/self/status)
case "$SECCOMP" in
  2) warn "this process is under a seccomp filter — clone3/unshare may also be blocked for workloads" ;;
  1) info "seccomp strict mode (unusual host)" ;;
  0) info "no seccomp on this process" ;;
esac
[ -r /proc/sys/kernel/io_uring_disabled ] && info "io_uring_disabled=$(cat /proc/sys/kernel/io_uring_disabled) (0=enabled,1=unpriv-only,2=disabled)"
[ -r /proc/sys/kernel/unprivileged_bpf_disabled ] && info "unprivileged_bpf_disabled=$(cat /proc/sys/kernel/unprivileged_bpf_disabled)"
[ -r /proc/sys/kernel/yama/ptrace_scope ] && info "ptrace_scope=$(cat /proc/sys/kernel/yama/ptrace_scope)"
[ -r /sys/kernel/security/lsm ] && info "LSMs: $(cat /sys/kernel/security/lsm)"
# clone3 smoke test: EINVAL(22) = implemented, ENOSYS(38) = absent
if have python3; then
  C3=$(python3 -c 'import ctypes; libc=ctypes.CDLL(None,use_errno=True); libc.syscall(435,0,0); print(ctypes.get_errno())' 2>/dev/null)
  case "$C3" in
    38) warn "clone3 not implemented in kernel" ;;
    "") info "clone3 probe inconclusive" ;;
    *)  ok "clone3 syscall present (errno $C3 on null args)" ;;
  esac
fi

# --------------------------------------------------------- mounts/limits ---
sect "Mounts & limits"
for d in / /tmp /var /var/lib $HOME /dev/shm; do
  [ -e "$d" ] || continue
  if [ -w "$d" ]; then info "writable: $d"; else warn "read-only: $d"; fi
done
[ -w /etc/resolv.conf ] && info "/etc/resolv.conf writable (can fix container DNS)" || info "/etc/resolv.conf not writable"
info "ulimit -n (nofile): $(ulimit -n), ulimit -u (nproc): $(ulimit -u 2>/dev/null || echo n/a)"
NF=$(ulimit -n); [ "${NF:-0}" -lt 1024 ] 2>/dev/null && warn "nofile <1024 — dockerd needs a high fd limit" || true

# ------------------------------------------------------ reachability -------
sect "Outbound reachability"
if have getent; then
  probe getent hosts registry-1.docker.io
  [ $? = 0 ] && ok "DNS resolves (registry-1.docker.io)" || warn "DNS resolution failed"
fi
if have curl; then
  CODE=$(timeout 8 curl -s -o /dev/null -w '%{http_code}' https://registry-1.docker.io/v2/ 2>/dev/null)
  if [ "$CODE" = "401" ] || [ "$CODE" = "200" ]; then
    ok "outbound HTTPS works (docker hub reachable, got $CODE)"
  elif [ -n "$CODE" ] && [ "$CODE" != "000" ]; then
    warn "outbound HTTPS reachable but docker hub returned $CODE"
  else
    warn "no outbound HTTPS — image pulls will fail (airgapped/proxied env?)"
  fi
else
  info "no curl — skipping outbound test"
fi
if have python3; then
  probe python3 -c 'import socket; s=socket.socket(); s.bind(("0.0.0.0",80)); s.close()'
  [ $? = 0 ] && ok "can bind privileged port :80" || info "cannot bind :80 (normal when unprivileged_port_start=1024)"
fi

# ------------------------------------------------------------- binaries ----
sect "Runtime binaries"
for b in dockerd docker containerd containerd-shim-runc-v2 runc; do
  have "$b" && ok "found: $b ($($b --version 2>/dev/null | head -1))" || warn "missing: $b"
done
for b in tar xz unshare mount ip iptables; do have "$b" || warn "missing util: $b"; done

if have docker && docker info >/dev/null 2>&1; then
  ok "docker daemon reachable"
  DR=$(docker info --format '{{.Driver}}/{{.CgroupDriver}} {{.ServerVersion}}' 2>/dev/null)
  info "daemon: $DR"
  if docker run --rm --network none hello-world >/dev/null 2>&1 || docker run --rm busybox true >/dev/null 2>&1; then
    ok "functional: docker run works"
  else
    warn "daemon reachable but 'docker run' failed (pull blocked?)"
  fi
else
  info "no running docker daemon (or socket not reachable) — that's fine for a preflight"
fi

# --------------------------------------------------------------- summary ---
printf '\n%s== Summary ==%s %d pass, %d warn, %d fail\n' "$c_dim" "$c_reset" "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '%sdockerd will NOT work on this host until the FAILs are fixed%s\n' "$c_red" "$c_reset"
  exit 1
elif [ "$WARN" -gt 0 ]; then
  printf '%sdockerd should work; WARNs are degraded paths (rootless bits, optional modules, nesting caveats)%s\n' "$c_yel" "$c_reset"
else
  printf '%shost looks fully dockerd-capable%s\n' "$c_grn" "$c_reset"
fi
exit 0
