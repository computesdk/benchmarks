import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoDir = fileURLToPath(new URL('../../../../', import.meta.url));

export function benchmarkResultsDir(suite: string): string {
  return path.resolve(repoDir, process.env.BENCH_RESULTS_DIR || 'results', suite);
}

export function recordResultArtifacts(files: string[]): void {
  const output = process.env.GITHUB_OUTPUT;
  if (output && files.length > 0) {
    fs.appendFileSync(output, `artifact_paths<<BENCH_ARTIFACTS\n${files.join('\n')}\nBENCH_ARTIFACTS\n`);
  }
}
