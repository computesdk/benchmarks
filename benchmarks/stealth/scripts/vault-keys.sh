#!/usr/bin/env bash
#
# Print the KEYS regex that load-vault-secrets.sh expects, derived from the
# providers file the bench runs so the alternation cannot drift from it:
#
#   vault-keys.sh <providers.ts> [--provider <name>] [EXTRA_KEY ...]
#
# The key set is every `requiredEnvVars` entry plus every `process.env.<NAME>`
# referenced in the file (optional vars like GMN_API_HOST are still loaded
# when the vault has them), plus any EXTRA_KEY arguments for keys the bench
# uses outside the providers file (e.g. BENCHMARKS_PLATFORM_API_KEY).
#
# --provider <name> limits the provider keys to that provider's entry, so a
# one-provider matrix leg never receives other providers' credentials.
#
#   . benchmarks/stealth/scripts/load-vault-secrets.sh \
#     "$(benchmarks/stealth/scripts/vault-keys.sh benchmarks/stealth/sandbox/providers.ts --provider e2b BENCHMARKS_PLATFORM_API_KEY)"

set -euo pipefail

file="${1:?usage: vault-keys.sh <providers.ts> [--provider <name>] [EXTRA_KEY ...]}"
shift || true

provider=""
extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --provider) provider="${2:?--provider needs a name}"; shift 2 ;;
    *) extra+=("$1"); shift ;;
  esac
done

node -e '
  const fs = require("fs");
  const [file, provider, ...extra] = process.argv.slice(1);
  let src = fs.readFileSync(file, "utf8");
  if (provider) {
    // Keep only the `{ ... }` entry whose `name:` is the provider. Comment
    // lines are dropped first so a commented-out entry never matches.
    src = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    const esc = provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp("^\\s*name:\\s*\x27" + esc + "\x27", "m").exec(src);
    if (!m) {
      console.error(`vault-keys.sh: provider ${provider} not found in ${file}`);
      src = "";
    } else {
      let start = m.index, depth = 0;
      for (; start >= 0; start--) {
        if (src[start] === "}") depth++;
        else if (src[start] === "{" && depth-- === 0) break;
      }
      let end = start;
      for (depth = 0; end < src.length; end++) {
        if (src[end] === "{") depth++;
        else if (src[end] === "}" && --depth === 0) break;
      }
      src = src.slice(start, end + 1);
    }
  }
  const keys = new Set();
  for (const m of src.matchAll(/requiredEnvVars:\s*\[([^\]]*)\]/g))
    for (const k of m[1].matchAll(/\x27([^\x27]+)\x27/g)) keys.add(k[1]);
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1]);
  for (const k of extra) keys.add(k);
  const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  process.stdout.write("^(" + [...keys].map(esc).sort().join("|") + ")=");
' "$file" "$provider" "${extra[@]}"
