import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFileSync(path.join(root, file), 'utf8');
function files(directory) {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(name) : [name];
  });
}

test('moved suites resolve their relative imports from their new locations', () => {
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler, resolveJsonModule: true, allowJs: true };
  for (const name of files('benchmarks/stealth').filter((name) => name.endsWith('.ts'))) {
    const file = path.join(root, name);
    const source = ts.createSourceFile(file, read(name), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      const specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      assert.ok(ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule,
        `${name}: cannot resolve ${specifier.text}`);
    }
  }
});

test('imported workflows point to existing suites and keep scheduled execution gated', () => {
  const workflows = files('.github/workflows').filter((name) => /\/stealth-.*\.yml$/.test(name));
  const referenced = new Set();
  for (const file of workflows) {
    const source = read(file);
    for (const [name] of source.matchAll(/benchmarks\/stealth\/[\w./-]+\.bench\.ts/g)) {
      assert.ok(existsSync(path.join(root, name)), `${file}: missing ${name}`);
      referenced.add(name);
    }
    if (file.endsWith('harness-tests.yml')) continue;
    const jobs = source.split('\njobs:\n')[1].split(/(?=^  [\w-]+:\n)/m).filter((job) => job.trim());
    for (const job of jobs) {
      assert.match(job, /^    if: .*vars\.STEALTH_BENCHMARKS_ENABLED == 'true'/m, `${file}: ungated job`);
    }
    assert.doesNotMatch(source, /^  collect:/m, file);
    if (!file.endsWith('oci-tti.yml')) {
      assert.doesNotMatch(source, /uses: actions\/upload-artifact@/, `${file}: public result artifact`);
    }
  }
  for (const suite of files('benchmarks/stealth').filter((name) => name.endsWith('.bench.ts'))) {
    // Reliability is intentionally a manual/local suite in the source repository.
    if (suite.endsWith('/sandbox-reliability.bench.ts')) continue;
    assert.ok(referenced.has(suite), `no workflow references ${suite}`);
  }
});

test('workflows do not publish legacy results or generated charts to Git', () => {
  for (const file of files('.github/workflows')) {
    const source = read(file);
    assert.doesNotMatch(source, /git add[^\n]*(?:results\/|\.svg)/, file);
    assert.doesNotMatch(source, /pnpm (?:run )?generate-[\w-]*svg/, file);
    assert.doesNotMatch(source, /svgScript|svgFile|Post results to merged PR/, file);
  }
  const ignored = read('.gitignore');
  assert.match(ignored, /^results\/$/m);
  assert.match(ignored, /^\*\*\/results\/$/m);
});
