#!/usr/bin/env bash
#
# Print the KEYS regex that load-vault-secrets.sh expects, derived from the
# providers file the bench runs so the alternation cannot drift from it:
#
#   vault-keys.sh <providers.ts> [EXTRA_KEY ...]
#
# The key set is every `requiredEnvVars` entry plus every `process.env.<NAME>`
# referenced in the file (optional vars like GMN_API_HOST are still loaded
# when the vault has them), plus any EXTRA_KEY arguments for keys the bench
# uses outside the providers file (e.g. BENCHMARKS_PLATFORM_API_KEY).
#
#   . benchmarks/stealth/scripts/load-vault-secrets.sh \
#     "$(benchmarks/stealth/scripts/vault-keys.sh benchmarks/stealth/sandbox/providers.ts BENCHMARKS_PLATFORM_API_KEY)"

set -euo pipefail

file="${1:?usage: vault-keys.sh <providers.ts> [EXTRA_KEY ...]}"
shift || true

node -e '
  const fs = require("fs");
  const [file, ...extra] = process.argv.slice(1);
  const src = fs.readFileSync(file, "utf8");
  const keys = new Set();
  for (const m of src.matchAll(/requiredEnvVars:\s*\[([^\]]*)\]/g))
    for (const k of m[1].matchAll(/\x27([^\x27]+)\x27/g)) keys.add(k[1]);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1]);
  for (const k of extra) keys.add(k);
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  process.stdout.write("^(" + [...keys].map(esc).sort().join("|") + ")=");
' "$file" "$@"
