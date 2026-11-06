#!/usr/bin/env node
// Regenerates cli-manifest.json from the built `bench __manifest`.
// Run `pnpm --filter @benchsdk/runner run manifest` (it rebuilds dist first);
// pass `--released` when the manifest describes versions published to npm.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(packageRoot, 'cli-manifest.json');

const json = execFileSync(
  process.execPath,
  [join(packageRoot, 'dist', 'bin.cjs'), '__manifest', ...process.argv.slice(2)],
  { encoding: 'utf8' },
);
const manifest = JSON.parse(json);
writeFileSync(outPath, json);
console.log(`Wrote ${outPath} (${manifest.commands.length} commands, bench ${manifest.version}, @benchsdk/cli ${manifest.cli.version})`);
