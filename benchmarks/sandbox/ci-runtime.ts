/**
 * In-sandbox Actions runtime bring-up, ported from benchmarks-platform's
 * `lib/ci/executor/act-runtime.ts` and `lib/ci/executor/shell.ts` — the exact
 * scripts the CI executor runs inside a provider's sandbox. Keep them in
 * sync: when the product's bring-up changes, this file must change the same
 * way or the benchmark stops proving what the product does.
 *
 * The bench runs these verbatim over `runCommand`; only the platform-only
 * legs are dropped (action-source seeding, cache/mirror/egress shims,
 * sccache, supervisor) because they need control-plane infrastructure a
 * benchmark does not have.
 */

/** Single-quotes a value for `sh`, so no metacharacter in it is live. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const STATIC_DOCKER_VERSION = '27.4.1';
export const DEFAULT_ACT_VERSION = 'v0.2.89';

/** Under `/tmp` so the install survives a step but not the sandbox. */
export const ACT_DIR = '/tmp/act';
/** act's built-in artifact server writes here until the sandbox is destroyed. */
export const ACT_ARTIFACTS_DIR = `${ACT_DIR}/artifacts`;
export const ACT_ARTIFACT_SERVER_PORT = 34_567;
/**
 * act's action-source cache (`--action-cache-path`). Pinned instead of act's
 * `~/.cache/act` default so the path does not depend on the exec user's HOME.
 */
export const ACT_ACTION_CACHE_DIR = '/tmp/ci-action-cache';
/** Where a statically installed Docker lands, and so on every later `PATH`. */
export const DOCKER_BIN_DIR = '/tmp/act/docker';
/** The daemon's own tools — `iptables` above all — live here, not in `bin`. */
const SBIN_DIRS = '/usr/local/sbin:/usr/sbin:/sbin';

/**
 * The image act runs a job in for a given `runs-on:` label.
 * `catthehacker/ubuntu` is what act's own documentation recommends for a
 * workflow that expects a GitHub-hosted runner.
 */
export const RUNNER_IMAGES: Readonly<Record<string, string>> = {
  'ubuntu-latest': 'catthehacker/ubuntu:act-latest',
  'ubuntu-24.04': 'catthehacker/ubuntu:act-24.04',
  'ubuntu-22.04': 'catthehacker/ubuntu:act-22.04',
  'ubuntu-20.04': 'catthehacker/ubuntu:act-20.04',
};

/**
 * The runner image every ubuntu label maps to on blaxel: its ~1GB rootfs
 * overlay cannot hold catthehacker's 1.4GB+ toolchain image, so a slim
 * node+bash+git image is built in-sandbox instead.
 */
export const BLAXEL_RUNNER_IMAGE = 'localhost/ci-blaxel-runner:latest';

/** Build the blaxel runner image inside the sandbox (node:22-alpine + bash + git). */
export function buildBlaxelRunnerImageScript(image: string): string {
  return [
    `if ! docker image inspect ${shellQuote(image)} >/dev/null 2>&1; then`,
    `  echo "Building runner image ${image} (node:22-alpine + bash + git)"`,
    '  docker system prune -af >/dev/null 2>&1 || true',
    `  echo '--- host resolv.conf ---'; cat /etc/resolv.conf || true`,
    `  docker network inspect bridge --format 'bridge ipv6={{.EnableIPv6}}' 2>/dev/null || true`,
    `  printf 'FROM node:22-alpine\\nRUN apk add --no-cache bash git\\n' | docker build -t ${shellQuote(image)} - || printf 'FROM node:22-alpine\\nRUN apk add --no-cache bash git\\n' | docker build --network=host -t ${shellQuote(image)} -`,
    `  if ! docker image inspect ${shellQuote(image)} >/dev/null 2>&1; then`,
    `    echo "Runner image ${image} failed to build" >&2`,
    '    exit 1',
    '  fi',
    '  docker builder prune -af >/dev/null 2>&1 || true',
    '  df -h /var/lib/docker || true',
    'fi',
  ].join('\n');
}

/** The label→image table act is given, with the env overrides the product honors. */
export function runnerImages(
  provider?: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const images = { ...RUNNER_IMAGES };
  if (provider === 'blaxel') {
    for (const label of Object.keys(images)) images[label] = BLAXEL_RUNNER_IMAGE;
  }
  const providerOverride =
    provider === undefined
      ? undefined
      : env[`CI_${provider.toUpperCase().replace(/-/g, '_')}_ACT_IMAGE`];
  const override = providerOverride ?? env.CI_ACT_IMAGE;
  if (override) images['ubuntu-latest'] = override;
  return images;
}

/**
 * `docker pull` for the images the job's container will run. act hides pull
 * errors (their detail travels inside the streamed response body logged at
 * debug level), so the pull runs in the open here instead.
 */
export function buildRunnerImagePullScript(
  images: readonly string[],
): string {
  return Array.from(new Set(images))
    .flatMap((image) => [
      `if docker image inspect ${shellQuote(image)} >/dev/null 2>&1; then`,
      `  echo "Runner image ${image} is already present"`,
      'else',
      `  echo "Pulling runner image ${image}"`,
      `  if ! docker pull --quiet ${shellQuote(image)}; then`,
      `    docker system prune -af >/dev/null 2>&1 || true`,
      `    echo "Retrying pull of ${image} after docker system prune"`,
      `    if ! docker pull --quiet ${shellQuote(image)}; then`,
      `      echo "Failed to pull ${image}" >&2`,
      `      docker system df >&2 || true`,
      `      df -h >&2 || true`,
      '      exit 1',
      '    fi',
      '  fi',
      'fi',
    ])
    .join('\n');
}

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
 * A SHA-256 hex digest of $1 through whichever hasher the image carries —
 * sha256sum, shasum, or openssl — or nothing when it has none.
 */
export const SHA256_FN = [
  'ci_sha256() {',
  '  ci_sha_line=',
  '  if command -v sha256sum >/dev/null 2>&1; then',
  '    ci_sha_line=$(sha256sum "$1" 2>/dev/null)',
  '  elif command -v shasum >/dev/null 2>&1; then',
  '    ci_sha_line=$(shasum -a 256 "$1" 2>/dev/null)',
  '  elif command -v openssl >/dev/null 2>&1; then',
  '    ci_sha_line=$(openssl dgst -sha256 "$1" 2>/dev/null)',
  '  fi',
  '  [ -z "$ci_sha_line" ] && return 1',
  '  case "$ci_sha_line" in',
  '    *=*) printf "%s\\n" "${ci_sha_line##*= }" ;;',
  '    *) printf "%s\\n" "${ci_sha_line%% *}" ;;',
  '  esac',
  '}',
] as const;

/** Marker holding the digest of a successfully installed act binary. */
export const ACT_SHA256_PATH = `${ACT_DIR}/.act.sha256`;

export function actBinaryPath(): string {
  return `${ACT_DIR}/act`;
}

/**
 * `-P label=image` for every label we map, so act never reaches its
 * interactive "which image size?" prompt.
 */
export function actImageArgs(
  provider?: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.entries(runnerImages(provider, env)).map(
    ([label, image]) => `-P ${shellQuote(`${label}=${image}`)}`,
  );
}

/** The image act pulls for the default label. */
export function runnerImage(provider?: string, env: NodeJS.ProcessEnv = process.env): string {
  return runnerImages(provider, env)['ubuntu-latest'];
}

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

/** Shell lines pointing every docker client (and act, via DOCKER_HOST) at the executor's daemon on providers that need it. */
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
    prePullImages?: readonly string[];
  } = {},
): string {
  const version = env.CI_ACT_DOCKER_VERSION ?? STATIC_DOCKER_VERSION;
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
    ...prePullLines(opts.prePullImages ?? []),
  ].join('\n');
}

function prePullLines(images: readonly string[]): string[] {
  const unique = [...new Set(images)].filter((image) => image !== '');
  if (unique.length === 0) return [];
  return [
    `for ci_pre_pull_image in ${unique.map((image) => shellQuote(image)).join(' ')}; do`,
    '  if docker image inspect "$ci_pre_pull_image" >/dev/null 2>&1; then',
    '    echo "Runner image $ci_pre_pull_image is already local"',
    '  else',
    '    echo "Pre-pulling $ci_pre_pull_image in the background"',
    '    nohup setsid docker pull "$ci_pre_pull_image" >>/tmp/ci-pre-pull.log 2>&1 </dev/null &',
    '  fi',
    'done',
  ];
}

/** The `act` binary at a pinned version, downloaded once per sandbox. */
export function buildActInstallScript(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const version = env.CI_ACT_VERSION ?? DEFAULT_ACT_VERSION;
  const quotedVersion = shellQuote(version);
  return [
    ...FETCH_FN,
    ...SHA256_FN,
    `act_version=${quotedVersion}`,
    'act_candidate=',
    'act_requested_normalized=${act_version#v}',
    `if [ -x ${shellQuote(`${ACT_DIR}/act`)} ]; then`,
    `  act_candidate=${shellQuote(`${ACT_DIR}/act`)}`,
    'else',
    '  act_candidate=$(command -v act 2>/dev/null || true)',
    '  if [ -n "$act_candidate" ] && [ ! -x "$act_candidate" ]; then act_candidate=; fi',
    'fi',
    `if [ -n "$act_candidate" ] && [ "$act_candidate" = ${shellQuote(`${ACT_DIR}/act`)} ] && [ -f ${shellQuote(ACT_SHA256_PATH)} ]; then`,
    `  act_expected_sha=$(cat ${shellQuote(ACT_SHA256_PATH)} 2>/dev/null || true)`,
    `  act_actual_sha=$(ci_sha256 ${shellQuote(`${ACT_DIR}/act`)} 2>/dev/null || true)`,
    '  if [ -n "$act_expected_sha" ] && [ -n "$act_actual_sha" ] && [ "$act_expected_sha" != "$act_actual_sha" ]; then',
    '    echo "Cached workflow runner checksum mismatch; downloading the workflow runner $act_version"',
    '    act_candidate=',
    '  fi',
    'fi',
    'if [ -n "$act_candidate" ]; then',
    '  act_reported=$("$act_candidate" --version 2>/dev/null || true)',
    '  act_found_version=$(printf \'%s\\n\' "$act_reported" | awk \'{ for (i = 1; i <= NF; i++) if ($i == "version") { print $(i + 1); exit } }\')',
    '  act_found_version=${act_found_version:-unreported}',
    '  act_found_normalized=${act_found_version#v}',
    '  if [ "$act_found_normalized" = "$act_requested_normalized" ]; then',
    '    echo "Reusing workflow runner $act_found_version"',
    `    if [ "$act_candidate" != ${shellQuote(`${ACT_DIR}/act`)} ]; then`,
    `      mkdir -p ${shellQuote(ACT_DIR)}`,
    `      ln -sf "$act_candidate" ${shellQuote(`${ACT_DIR}/act`)}`,
    '    fi',
    '  else',
    '    echo "Workflow runner version mismatch: requested $act_version, found $act_found_version; downloading the requested version"',
    '    act_candidate=',
    '  fi',
    'else',
    '  echo "Downloading workflow runner $act_version"',
    'fi',
    'if [ -z "$act_candidate" ]; then',
    '  arch=$(uname -m)',
    '  case "$arch" in',
    '    x86_64) asset=act_Linux_x86_64.tar.gz ;;',
    '    aarch64|arm64) asset=act_Linux_arm64.tar.gz ;;',
    '    *) echo "The workflow runner is not available for $arch"; exit 1 ;;',
    '  esac',
    `  mkdir -p ${shellQuote(ACT_DIR)}`,
    `  mkdir -p ${shellQuote(ACT_ARTIFACTS_DIR)}`,
    `  rm -f ${shellQuote(`${ACT_DIR}/act`)}`,
    '  act_download_attempt=1',
    '  while :; do',
    `    if ci_fetch "https://github.com/nektos/act/releases/download/$act_version/$asset" ${shellQuote(`${ACT_DIR}/act.tar.gz`)}; then`,
    '      break',
    '    fi',
    '    if [ "$act_download_attempt" -ge 3 ]; then',
    '      echo "Failed to download the workflow runner $act_version"',
    '      exit 1',
    '    fi',
    '    echo "Runner download attempt $act_download_attempt failed; retrying" >&2',
    '    act_download_attempt=$((act_download_attempt + 1))',
    '    sleep $((act_download_attempt * 3))',
    '  done',
    `  if ! tar -xzf ${shellQuote(`${ACT_DIR}/act.tar.gz`)} -C ${shellQuote(ACT_DIR)} act; then`,
    '    echo "Failed to extract the workflow runner $act_version"',
    '    exit 1',
    '  fi',
    `  rm -f ${shellQuote(`${ACT_DIR}/act.tar.gz`)}`,
    `  if ! chmod +x ${shellQuote(`${ACT_DIR}/act`)}; then`,
    '    echo "Failed to make the workflow runner $act_version executable"',
    '    exit 1',
    '  fi',
    `  if ! act_reported=$(${shellQuote(`${ACT_DIR}/act`)} --version 2>/dev/null); then`,
    '    echo "The downloaded workflow runner could not report a version"',
    '    exit 1',
    '  fi',
    '  act_installed_version=$(printf \'%s\\n\' "$act_reported" | awk \'{ for (i = 1; i <= NF; i++) if ($i == "version") { print $(i + 1); exit } }\')',
    '  act_installed_normalized=${act_installed_version#v}',
    '  if [ -z "$act_installed_version" ] || [ "$act_installed_normalized" != "$act_requested_normalized" ]; then',
    '    echo "Downloaded workflow runner version mismatch: requested $act_version, installed ${act_installed_version:-unknown}"',
    '    exit 1',
    '  fi',
    `  ci_sha256 ${shellQuote(`${ACT_DIR}/act`)} > ${shellQuote(ACT_SHA256_PATH)} 2>/dev/null || rm -f ${shellQuote(ACT_SHA256_PATH)}`,
    '  echo "Workflow runner $act_version ready"',
    'fi',
  ].join('\n');
}

/**
 * Shell lines that set `$varName` to the docker bridge gateway only when the
 * gateway is one of this sandbox's own interface addresses, else empty.
 * The gateway doubles as a *bind* address for act's artifact/cache servers,
 * so it must be local.
 */
export function dockerLocalBridgeGatewayScript(varName: string): string[] {
  return [
    `for attempt in $(seq 1 30); do`,
    `  docker network inspect bridge >/dev/null 2>&1 && break`,
    `  ip -o link show dev docker0 >/dev/null 2>&1 && break`,
    `  sleep 1`,
    `done`,
    `${varName}="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)"`,
    `case "$${varName}" in`,
    `  *.*.*.*) ;;`,
    `  *) ${varName}="$(ip -o -4 addr show dev docker0 2>/dev/null | awk '{split($4,a,"/");print a[1]}' | head -n 1)" ;;`,
    `esac`,
    `local_addrs="$(hostname -I 2>/dev/null || true)"`,
    `if [ -z "$local_addrs" ]; then`,
    `  local_addrs="$(awk '$1=="|--"||$1=="+--"{prev=$2} /32 host LOCAL/{print prev}' /proc/net/fib_trie 2>/dev/null | sort -u | tr '\\n' ' ')"`,
    `fi`,
    `case " $local_addrs " in`,
    `  *" $${varName} "*) ;;`,
    `  *) echo "docker bridge gateway '$${varName}' not among local addrs '$local_addrs'" >&2; ${varName}="" ;;`,
    `esac`,
  ];
}

/**
 * Shell lines that set `$varName` to the sandbox's primary non-loopback
 * IPv4 — the fallback bind address when the bridge gateway is remote.
 */
export function sandboxPrimaryAddrScript(varName: string): string[] {
  return [
    `${varName}="$(printf '%s\\n' "$local_addrs" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/ && $i !~ /^127\\./) {print $i; exit}}')"`,
  ];
}
