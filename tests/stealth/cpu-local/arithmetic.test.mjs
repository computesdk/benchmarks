import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Execute only these extracted pieces, never the production script's top-level
// setup, dd, hashing, parallel workers, result-file writes, or metadata probes.
const candidateSource = readFileSync(
  new URL('../../../benchmarks/stealth/scripts/cpu-benchmark.sh', import.meta.url),
  'utf8',
);

function extractTimer(source) {
  const nowUsMatches = [...source.matchAll(/^now_us\(\) \{\n[\s\S]*?^\}/gm)];
  assert.equal(nowUsMatches.length, 1, 'extract exactly one actual now_us function');
  const phaseLines = [...source.matchAll(
    /^out 'BENCH_PHASE\\t(single|multi)\\t%s\\n' (\$\(\([^\n]+\)\))$/gm,
  )].map((match) => ({ phase: match[1], line: match[0], expression: match[2] }));
  assert.deepEqual(phaseLines.map(({ phase }) => phase), ['single', 'multi'],
    'extract both actual phase expressions; source drift must not silently skip one');
  return { nowUs: nowUsMatches[0][0], phaseLines };
}

const candidate = extractTimer(candidateSource);

const fixtures = [
  { name: 'leading 0290000', clock: 'uptime', start: '0.29', end: '6.29', ms: '6000', baseError: true },
  { name: 'leading 0780000', clock: 'uptime', start: '0.78', end: '6.78', ms: '6000', baseError: true },
  { name: 'second boundary with leading 0990000', clock: 'uptime', start: '0.99', end: '1.01', ms: '20', baseError: true },
  { name: 'silent octal 32ms instead of 100ms', clock: 'uptime', start: '0.10', end: '0.20', ms: '100', baselineMs: '32' },
  { name: 'silent octal 4ms instead of 10ms', clock: 'uptime', start: '0.00', end: '0.01', ms: '10', baselineMs: '4' },
  { name: 'nonzero integer seconds control', clock: 'uptime', start: '1.20', end: '1.30', ms: '100', baselineMs: '100' },
  { name: 'cross 32-bit seconds boundary', clock: 'uptime', start: '4294967295.99', end: '4294967296.01', ms: '20', baselineMs: '20' },
  { name: 'large uptime exceeds JS safe integer microseconds', clock: 'uptime', start: '12345678901.20', end: '12345678901.30', ms: '100', baselineMs: '100' },
  { name: 'EPOCHREALTIME fallback positive', clock: 'epoch', start: '1762128000.100000', end: '1762128000.200000', ms: '100', baselineMs: '100' },
  { name: 'EPOCHREALTIME fallback second boundary', clock: 'epoch', start: '1762128000.990000', end: '1762128001.010000', ms: '20', baselineMs: '20' },
  { name: 'EPOCHREALTIME fallback zero step', clock: 'epoch', start: '1762128000.200000', end: '1762128000.200000', ms: '0', baselineMs: '0' },
  { name: 'EPOCHREALTIME fallback negative step', clock: 'epoch', start: '1762128000.200000', end: '1762128000.100000', ms: '-100', baselineMs: '-100' },
  { name: 'EPOCHREALTIME negative sub-ms step truncates to zero', clock: 'epoch', start: '1762128000.200500', end: '1762128000.200000', ms: '0', baselineMs: '0' },
];

function decimalMicroseconds(value) {
  assert.match(value, /^\d+\.\d{2}(?:\d{4})?$/);
  const [seconds, fraction] = value.split('.');
  return BigInt(seconds) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

// This is an oracle for the fixture data, not an implementation under test.
function referenceMilliseconds({ start, end }) {
  return (decimalMicroseconds(end) - decimalMicroseconds(start)) / 1000n;
}

function runSnippet({ nowUs }, fixture, statement) {
  // Override read, rather than rewriting now_us or requiring /proc mutation.
  // Its actual redirection opens local /proc/uptime, but read supplies fixtures.
  // Unsetting Bash's dynamic EPOCHREALTIME first makes fallback deterministic.
  const snippet = `
set -euo pipefail
export LC_ALL=C
read() {
  if [ "$CLOCK_KIND" = uptime ]; then
    builtin printf -v up '%s' "$CLOCK_TEXT"
    return 0
  fi
  return 1
}
out() { builtin printf "$@"; }
unset EPOCHREALTIME
${nowUs}
CLOCK_KIND=$1
CLOCK_TEXT=$2
EPOCHREALTIME=$2
t0=$(now_us)
CLOCK_TEXT=$3
EPOCHREALTIME=$3
t1=$(now_us)
printf 'TOKENS\\t%s\\t%s\\n' "$t0" "$t1"
${statement}
`;
  const result = spawnSync('bash', [
    '--noprofile', '--norc', '-c', snippet, 'cpu-local-arithmetic',
    fixture.clock, fixture.start, fixture.end,
  ], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 64 * 1024,
    // No inherited BASH_ENV, exported functions, credentials, or shell options.
    env: { PATH: process.env.PATH, LC_ALL: 'C' },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, 'tiny snippet must not time out or be signaled');
  return result;
}

function tokenLine(fixture) {
  // Expected strings deliberately preserve the uptime leading zero.
  const token = (value) => value.replace('.', '') + (fixture.clock === 'uptime' ? '0000' : '');
  return `TOKENS\t${token(fixture.start)}\t${token(fixture.end)}\n`;
}

for (const [name, { nowUs, phaseLines }] of Object.entries({ candidate })) {
  test(`${name} source extraction is limited to the timer and both elapsed sites`, () => {
    assert.match(nowUs, /read -r up _ < \/proc\/uptime/);
    assert.match(nowUs, /\$\{EPOCHREALTIME\/\.\/\}/);
    assert.doesNotMatch(nowUs, /\b(?:dd|sha256sum|shasum|nproc|tee)\b/);
    for (const { expression } of phaseLines) {
      assert.match(expression, /\bt1\b/);
      assert.match(expression, /\bt0\b/);
      assert.match(expression, /1000/);
    }
  });
}

for (const { phase, line } of candidate.phaseLines) {
  for (const fixture of fixtures) {
    test(`candidate ${phase}: ${fixture.name}`, () => {
      assert.equal(referenceMilliseconds(fixture).toString(), fixture.ms);
      const actual = runSnippet(candidate, fixture, line);
      assert.equal(actual.status, 0, actual.stderr);
      assert.equal(actual.stderr, '');
      // The shell still emits nonpositive fallback-clock values; strict parser
      // rejection is covered separately, not replaced with a shell-only guard.
      assert.equal(actual.stdout,
        `${tokenLine(fixture)}BENCH_PHASE\t${phase}\t${fixture.ms}\n`);
    });

    test(`test-only decimal reference ${phase}: ${fixture.name}`, () => {
      // Intentionally NOT a patched production expression: test data +
      // extracted now_us feed an explicitly base-10 reference and positivity
      // guard. Passing this test does not prove any candidate patch correct.
      const reference = runSnippet(candidate, fixture, `
elapsed=$(( (10#$t1 - 10#$t0) / 1000 ))
if [ "$elapsed" -le 0 ]; then
  printf 'REFERENCE_CLOCK_REJECTED\\t%s\\n' "$elapsed" >&2
  exit 65
fi
out 'BENCH_PHASE\\t${phase}\\t%s\\n' "$elapsed"
`);
      const expected = referenceMilliseconds(fixture);
      assert.equal(expected.toString(), fixture.ms);
      if (expected <= 0n) {
        assert.equal(reference.status, 65);
        assert.equal(reference.stdout, tokenLine(fixture));
        assert.equal(reference.stderr, `REFERENCE_CLOCK_REJECTED\t${expected}\n`);
      } else {
        assert.equal(reference.status, 0, reference.stderr);
        assert.equal(reference.stderr, '');
        assert.equal(reference.stdout,
          `${tokenLine(fixture)}BENCH_PHASE\t${phase}\t${expected}\n`);
      }
    });
  }
}
