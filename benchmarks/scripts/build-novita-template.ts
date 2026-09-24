import 'dotenv/config';
import { Novita, defaultBuildLogger } from 'novita-sandbox';

/** Must match dax-benchmark.sh's BENCH_NODE_VERSION default. */
const NODE_VERSION = '24.14.1';
/** The diagnostic reported x86_64 for this template. */
const NODE_ARCH = 'linux-x64';

async function main() {
  const apiKey = process.env.NOVITA_API_KEY;
  if (!apiKey) {
    throw new Error('NOVITA_API_KEY environment variable is not set');
  }

  const novita = new Novita({ apiKey });

  // TTI executes `node -v` in a fresh, non-interactive sandbox. Install Node
  // on the system PATH at build time instead of relying on shell/NVM setup.
  //
  // Pin the same version as dax-benchmark.sh's BENCH_NODE_VERSION default, and
  // install it the same way (official tarball under /opt + symlinks into
  // /usr/local/bin). That script skips its own Node install when `node` is
  // already on PATH, so a mismatched version here would silently run the whole
  // dax workload on the wrong Node: Debian's `nodejs` package is 20.x, and
  // native deps like tree-sitter-powershell have no prebuilt binary for that
  // ABI, which fails the install phase.
  const template = novita.template
    .new()
    .fromTemplate('base')
    .runCmd(
      [
        'set -eu',
        `archive="node-v${NODE_VERSION}-${NODE_ARCH}.tar.gz"`,
        `prefix="/opt/node-v${NODE_VERSION}-${NODE_ARCH}"`,
        `curl -fsSL "https://nodejs.org/download/release/v${NODE_VERSION}/$archive" -o "/tmp/$archive"`,
        'rm -rf "$prefix" && mkdir -p "$prefix"',
        'tar -xzf "/tmp/$archive" --strip-components=1 -C "$prefix"',
        'rm -f "/tmp/$archive"',
        'for exe in node npm npx corepack; do ln -sfn "$prefix/bin/$exe" "/usr/local/bin/$exe"; done',
      ],
      { user: 'root' },
    )
    // Fail the build rather than ship an image where TTI's first command cannot
    // run or dax would pick up an unexpected version.
    .runCmd(`node -v && test "$(node -v)" = "v${NODE_VERSION}"`);

  // Rebuild the alias; an existing template does not prove Node is available.
  // Let build errors propagate so we cannot silently reuse an unsuitable image.
  await novita.template.build(template, 'base-8c-16g', {
    cpuCount: 8,
    memoryMB: 16384,
    onBuildLogs: defaultBuildLogger(),
  });
  console.log('Novita template base-8c-16g built successfully (node -v verified)');
}

main().catch((error) => {
  console.error('Failed to build Novita template:', error);
  process.exit(1);
});
