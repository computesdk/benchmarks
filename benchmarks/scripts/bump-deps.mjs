#!/usr/bin/env node
/**
 * Bump every runtime dependency in package.json to its latest npm release.
 *
 * Skips:
 *   - devDependencies (toolchain bumps are done by hand)
 *   - non-registry specs: workspace:*, npm: aliases like playwright-native-core
 *     (the stealth Playwright suite attests a frozen client/server version)
 *   - nested pnpm overrides ("ink>es-toolkit") — pinned for a reason
 *
 * Spec style is preserved per package: ^x.y.z -> ^latest, ~x.y.z -> ~latest,
 * exact -> exact (e.g. tensorlake, kept in lockstep with its pnpm override).
 *
 * BUMP_SCOPE selects which bumps to apply, so they can ship through separate PRs:
 *   compatible (default) — latest stays caret-compatible with the current version
 *                          (same major, or same minor/patch on 0.x)
 *   breaking             — latest crosses that boundary and needs a human review
 *
 * Writes a markdown report to $BUMP_REPORT (default: stdout only).
 * Exits 0 with no edits when everything is already current.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SCOPE = process.env.BUMP_SCOPE ?? 'compatible';
if (SCOPE !== 'compatible' && SCOPE !== 'breaking') throw new Error(`Unknown BUMP_SCOPE: ${SCOPE}`);

const path = 'package.json';
const pkg = JSON.parse(readFileSync(path, 'utf8'));

async function latestVersion(name) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${name}`);
  return (await res.json()).version;
}

function isCompatible(spec, version) {
  const [a0, a1, a2] = spec.replace(/^[\^~]/, '').split(/[-+]/)[0].split('.').map(Number);
  const [b0, b1, b2] = version.split(/[-+]/)[0].split('.').map(Number);
  if (a0 !== b0) return false;
  if (a0 > 0) return true;
  if (a1 !== b1) return false;
  return a1 > 0 || a2 === b2;
}

function inScope(spec, version) {
  return isCompatible(spec, version) === (SCOPE === 'compatible');
}

function bumpSpec(spec, version) {
  if (spec.startsWith('^')) return `^${version}`;
  if (spec.startsWith('~')) return `~${version}`;
  return version;
}

const changes = [];
const skipped = [];

for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  // Allowlist: only plain semver specs get bumped — anything else (workspace:/npm:/
  // file:/link:, git or URL deps, dist-tags, wildcard/range specs) is left alone.
  if (!/^[\^~]?\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(spec)) {
    skipped.push(name);
    continue;
  }
  const latest = await latestVersion(name);
  const next = bumpSpec(spec, latest);
  if (next !== spec && inScope(spec, latest)) {
    pkg.dependencies[name] = next;
    changes.push({ name, from: spec, to: next });
  }
}

for (const [name, spec] of Object.entries(pkg.pnpm?.overrides ?? {})) {
  if (name.includes('>') || name.includes(' ')) { skipped.push(name); continue; }
  const latest = await latestVersion(name);
  const next = bumpSpec(spec, latest);
  if (next !== spec && inScope(spec, latest)) {
    pkg.pnpm.overrides[name] = next;
    changes.push({ name: `pnpm override ${name}`, from: spec, to: next });
  }
}

if (changes.length) {
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}

const report = changes.length
  ? `Bumped ${changes.length} packages to their latest ${SCOPE} npm releases.\n\n| Package | From | To |\n|---|---|---|\n` +
    changes.map(c => `| \`${c.name}\` | \`${c.from}\` | \`${c.to}\` |`).join('\n') +
    `\n\nSkipped (frozen / non-registry): ${skipped.join(', ') || 'none'}. Dev dependencies are out of scope.`
  : `No ${SCOPE} npm releases to apply.`;

if (process.env.BUMP_REPORT) writeFileSync(process.env.BUMP_REPORT, report + '\n');
console.log(report);
