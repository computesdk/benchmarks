/**
 * In-sandbox Docker daemon bring-up, ported from benchmarks-platform's
 * `lib/ci/executor/act-runtime.ts` and `lib/ci/executor/shell.ts` — the exact
 * dockerd script the CI executor runs inside a provider's sandbox. Keep it in
 * sync: when the product's bring-up changes, this file must change the same
 * way or the benchmark stops proving what the product does.
 *
 * The bench runs this verbatim over `runCommand`; the act install, runner
 * image, and artifact/bridge helpers are dropped — the benchmark validates
 * "can run containerized CI jobs" with plain docker instead.
 */

/** Single-quotes a value for `sh`, so no metacharacter in it is live. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const STATIC_DOCKER_VERSION = '27.4.1';

/** Where a statically installed Docker lands, and so on every later `PATH`. */
export const DOCKER_BIN_DIR = '/tmp/ci/docker';
/** The daemon's own tools — `iptables` above all — live here, not in `bin`. */
const SBIN_DIRS = '/usr/local/sbin:/usr/sbin:/sbin';

/**
 * One fetch verb for the downloads below. A minimal image may ship none of
 * the usual tools, so the helper walks what is actually installed: curl,
 * wget, busybox's wget applet, then python3's stdlib.
 */
export const FETCH_FN = [
  'ci_fetch() {',
  '  ci_fetch_url=$1',
  '  ci_fetch_out=$2',
  '  ci_fetch_timeout=${3:-}',
  '  if command -v curl >/dev/null 2>&1; then',
  '    curl -fsSL ${ci_fetch_timeout:+--max-time "$ci_fetch_timeout"} "$ci_fetch_url" -o "$ci_fetch_out"; return',
  '  fi',
  '  if command -v wget >/dev/null 2>&1; then',
  '    wget -q ${ci_fetch_timeout:+--timeout="$ci_fetch_timeout"} -O "$ci_fetch_out" "$ci_fetch_url"; return',
  '  fi',
  '  if command -v busybox >/dev/null 2>&1; then',
  '    ci_fetch_has_wget=',
  '    for ci_fetch_applet in $(busybox --list 2>/dev/null); do',
  '      [ "$ci_fetch_applet" = wget ] && ci_fetch_has_wget=1',
  '    done',
  '    if [ "$ci_fetch_has_wget" = 1 ]; then',
  '      busybox wget -q ${ci_fetch_timeout:+-T "$ci_fetch_timeout"} -O "$ci_fetch_out" "$ci_fetch_url"; return',
  '    fi',
  '  fi',
  '  if command -v python3 >/dev/null 2>&1; then',
  "    python3 -c 'import shutil, sys, urllib.request",
  'with urllib.request.urlopen(sys.argv[1], timeout=float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else None) as r, open(sys.argv[2], "wb") as f:',
  "    shutil.copyfileobj(r, f)' \"$ci_fetch_url\" \"$ci_fetch_out\" \"$ci_fetch_timeout\"; return",
  '  fi',
  '  echo "Cannot fetch $ci_fetch_url: the image has none of curl, wget, busybox or python3" >&2',
  '  return 1',
  '}',
] as const;

/**
 * Socket and data-root for the executor's own dockerd, used on providers that
 * boot a managed daemon of their own (blaxel's docker-in-sandbox image runs
 * one at sandbox start — killing it severed the sandbox's exec channel
 * entirely, so their daemon is left untouched).
 */
const EXECUTOR_DOCKER_SOCKET = 'unix:///var/run/docker-ce.sock';
const EXECUTOR_DOCKER_DATA_ROOT = '/var/lib/docker/executor';
const EXECUTOR_DOCKER_BRIDGE = 'ci-docker0';
const EXECUTOR_DOCKER_CIDR = '172.31.0.1/24';
const EXECUTOR_DOCKER_PIDFILE = '/var/run/docker-ce.pid';
const EXECUTOR_DOCKER_EXEC_ROOT = '/var/run/docker-ce';

/** Shell lines pointing every docker client at the executor's daemon on providers that need it. */
export function dockerdClientEnv(provider: string | undefined): string[] {
  return providerNeedsOwnDockerd(provider)
    ? [`export DOCKER_HOST=${shellQuote(EXECUTOR_DOCKER_SOCKET)}`]
    : [];
}

/**
 * Whether the provider needs the executor's own dockerd rather than whatever
 * daemon (or none) the sandbox image ships.
 */
export function providerNeedsOwnDockerd(provider: string | undefined): boolean {
  return provider === 'blaxel';
}

/**
 * Extra dockerd flags for providers whose sandbox network needs more than
 * defaults. Blaxel is IPv6-only; Cloudflare cannot touch iptables and has a
 * read-only ip_forward sysctl.
 */
function dockerdExtraArgs(
  provider: string | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const dns = (env.CI_DOCKER_DNS ?? '')
    .split(',')
    .map((server) => server.trim())
    .filter((server) => server.length > 0);
  return [
    ...dns.flatMap((server) => ['--dns', server]),
    ...(provider === 'blaxel'
      ? [
          '--ipv6',
          '--fixed-cidr-v6',
          env.CI_DOCKER_BRIDGE_IPV6 ?? 'fd00:c1:0:1::/64',
        ]
      : []),
    ...(provider === 'cloudflare'
      ? ['--iptables=false', '--ip6tables=false', '--ip-forward=false']
      : []),
  ];
}

/**
 * Docker, ready to use, or a non-zero exit. Ordered cheapest-first: a daemon
 * already running costs one `docker info`, a daemon installed but stopped
 * costs a start, and only a box with no Docker at all pays for the download.
 */
export function buildDockerBringUpScript(
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    provider?: string;
  } = {},
): string {
  const version = env.CI_DOCKER_VERSION ?? env.CI_ACT_DOCKER_VERSION ?? STATIC_DOCKER_VERSION;
  const quotedVersion = shellQuote(version);
  const ownDaemon = providerNeedsOwnDockerd(opts.provider);
  const routeArgs = ownDaemon
    ? ` -H ${shellQuote(EXECUTOR_DOCKER_SOCKET)} --data-root ${shellQuote(EXECUTOR_DOCKER_DATA_ROOT)} --bridge ${shellQuote(EXECUTOR_DOCKER_BRIDGE)} --fixed-cidr ${shellQuote(EXECUTOR_DOCKER_CIDR)} --pidfile ${shellQuote(EXECUTOR_DOCKER_PIDFILE)} --exec-root ${shellQuote(EXECUTOR_DOCKER_EXEC_ROOT)}`
    : '';
  const dnsArgs = dockerdExtraArgs(opts.provider, env)
    .map((arg) => ` ${shellQuote(arg)}`)
    .join('');
  return [
    ...FETCH_FN,
    `export PATH="${DOCKER_BIN_DIR}:$PATH:${SBIN_DIRS}"`,
    `docker_version=${quotedVersion}`,
    `dockerd_route_args='${routeArgs.trim()}'`,
    `dockerd_extra_args='${dnsArgs.trim()}'`,
    ...(ownDaemon
      ? [
          `export DOCKER_HOST=${shellQuote(EXECUTOR_DOCKER_SOCKET)}`,
          `mkdir -p ${shellQuote(EXECUTOR_DOCKER_DATA_ROOT)}`,
          `ip link add name ${EXECUTOR_DOCKER_BRIDGE} type bridge 2>/dev/null || busybox ip link add name ${EXECUTOR_DOCKER_BRIDGE} type bridge 2>/dev/null || true`,
          `ip link set ${EXECUTOR_DOCKER_BRIDGE} up 2>/dev/null || busybox ip link set ${EXECUTOR_DOCKER_BRIDGE} up 2>/dev/null || true`,
        ]
      : []),
    'if docker info >/dev/null 2>&1; then',
    '  docker_server_version=$(docker version --format \'{{.Server.Version}}\' 2>/dev/null || true)',
    '  echo "Docker daemon is already running (server ${docker_server_version:-unknown})"',
    '  docker_server_normalized=${docker_server_version#v}',
    '  docker_requested_normalized=${docker_version#v}',
    '  if [ "$docker_server_normalized" != "$docker_requested_normalized" ]; then',
    '    echo "Docker version drift: requested $docker_version, running server ${docker_server_version:-unknown}; reusing the running daemon"',
    '  fi',
    'else',
    '  docker_binary_version=',
    '  if dockerd_path=$(command -v dockerd 2>/dev/null) && docker_path=$(command -v docker 2>/dev/null); then',
    '    docker_binary_version=$(dockerd --version 2>/dev/null | sed -n \'s/.*Docker version \\([^, ]*\\).*/\\1/p\')',
    '    docker_binary_normalized=${docker_binary_version#v}',
    '    if [ "$docker_binary_normalized" = "${docker_version#v}" ]; then',
    '      echo "Reusing Docker binary $docker_binary_version at $dockerd_path"',
    '    else',
    '      echo "Docker binary version drift: requested $docker_version, installed ${docker_binary_version:-unknown}; reusing the installed binary"',
    '    fi',
    '  else',
    '    echo "Docker binary is not present; installing Docker $docker_version"',
    '  fi',
    '  if [ -z "$docker_binary_version" ]; then',
    '    arch=$(uname -m)',
    '    case "$arch" in',
    '      x86_64) docker_arch=x86_64 ;;',
    '      aarch64|arm64) docker_arch=aarch64 ;;',
    '      *) echo "Docker is not available for $arch"; exit 1 ;;',
    '    esac',
    `    mkdir -p ${shellQuote(DOCKER_BIN_DIR)}`,
    '    rm -rf /tmp/docker && mkdir -p /tmp/docker',
    `    if ! ci_fetch "https://download.docker.com/linux/static/stable/$docker_arch/docker-$docker_version.tgz" /tmp/docker.tgz; then`,
    '      echo "Failed to download Docker $docker_version"',
    '      exit 1',
    '    fi',
    '    if ! tar -xzf /tmp/docker.tgz -C /tmp/docker --strip-components=1; then',
    '      echo "Failed to extract Docker $docker_version"',
    '      exit 1',
    '    fi',
    `    if ! cp -a /tmp/docker/. ${shellQuote(DOCKER_BIN_DIR)}/; then`,
    '      echo "Failed to install Docker $docker_version"',
    '      exit 1',
    '    fi',
    '    rm -rf /tmp/docker',
    '    rm -f /tmp/docker.tgz',
    `    if ! docker_binary_report=$(${shellQuote(`${DOCKER_BIN_DIR}/dockerd`)} --version 2>/dev/null); then`,
    '      echo "Installed Docker binary could not report a version"',
    '      exit 1',
    '    fi',
    '    docker_binary_version=$(printf \'%s\\n\' "$docker_binary_report" | sed -n \'s/.*Docker version \\([^, ]*\\).*/\\1/p\')',
    '    docker_binary_normalized=${docker_binary_version#v}',
    '    if [ -z "$docker_binary_version" ] || [ "$docker_binary_normalized" != "${docker_version#v}" ]; then',
    '      echo "Installed Docker binary version mismatch: requested $docker_version, installed ${docker_binary_version:-unknown}"',
    '      exit 1',
    '    fi',
    '  fi',
    ...(opts.provider === 'cloudflare'
      ? []
      : [
          '  if command -v iptables >/dev/null 2>&1; then',
          '    echo "iptables is already present"',
          '  else',
          '    echo "Installing iptables"',
          '    if [ "$(id -u)" = 0 ]; then as_root=""; else as_root="sudo -n"; fi',
          '    if command -v apt-get >/dev/null 2>&1; then',
          '      $as_root apt-get update -qq >/dev/null 2>&1',
          '      $as_root apt-get install -y -qq iptables >/dev/null 2>&1 || true',
          '    elif command -v dnf >/dev/null 2>&1; then',
          '      $as_root dnf install -y -q iptables >/dev/null 2>&1 || true',
          '    elif command -v yum >/dev/null 2>&1; then',
          '      $as_root yum install -y -q iptables >/dev/null 2>&1 || true',
          '    elif command -v apk >/dev/null 2>&1; then',
          '      $as_root apk add --no-cache iptables >/dev/null 2>&1 || true',
          '    fi',
          '    if ! command -v iptables >/dev/null 2>&1; then',
          '      echo "iptables is missing and could not be installed, so the Docker daemon cannot network a container"',
          '      exit 1',
          '    fi',
          '  fi',
        ]),
    '  if [ "$(id -u)" = 0 ]; then',
    '    dockerd_base="dockerd"',
    '  elif sudo -n true >/dev/null 2>&1; then',
    '    dockerd_base="sudo -n env PATH=$PATH dockerd --group $(id -g)"',
    '  else',
    '    echo "Docker needs root in this sandbox and sudo is not available"',
    '    exit 1',
    '  fi',
    '  echo "Starting Docker daemon $docker_binary_version"',
    '  dockerd_cmd="$dockerd_base $dockerd_route_args $dockerd_extra_args"',
    '  eval "nohup setsid $dockerd_cmd >/tmp/dockerd.log 2>&1 </dev/null &"',
    '  for attempt in $(seq 1 60); do',
    '    if docker info >/dev/null 2>&1; then break; fi',
    '    if [ "$attempt" -ge 5 ] && [ -S /var/run/docker.sock ]; then',
    '      sudo -n chgrp "$(id -g)" /var/run/docker.sock >/dev/null 2>&1 || true',
    '      sudo -n chmod 660 /var/run/docker.sock >/dev/null 2>&1 || true',
    '    fi',
    '    sleep 1',
    '  done',
    '  if ! docker info >/dev/null 2>&1; then',
    '    echo "The Docker daemon did not start:"',
    '    tail -20 /tmp/dockerd.log',
    '    if [ -n "$dockerd_extra_args" ]; then',
    '      echo "Retrying without the provider flags"',
    '      dockerd_cmd="$dockerd_base $dockerd_route_args"',
    '      eval "nohup setsid $dockerd_cmd >/tmp/dockerd.log 2>&1 </dev/null &"',
    '      for attempt in $(seq 1 60); do',
    '        docker info >/dev/null 2>&1 && break',
    '        sleep 1',
    '      done',
    '    fi',
    '  fi',
    '  if ! docker info >/dev/null 2>&1; then',
    '    echo "The Docker daemon did not start:"',
    '    tail -20 /tmp/dockerd.log',
    '    exit 1',
    '  fi',
    'fi',
  ].join('\n');
}
