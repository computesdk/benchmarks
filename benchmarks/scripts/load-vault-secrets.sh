#!/usr/bin/env bash
#
# Load a filtered subset of Namespace vault entries into the current shell.
#
# Usage:
#   . benchmarks/scripts/load-vault-secrets.sh          # KEYS env var required
#   . benchmarks/scripts/load-vault-secrets.sh 'regex'  # pass regex as $1
#   bash benchmarks/scripts/load-vault-secrets.sh 'regex'  # standalone; one fatal exit on `set` issues
#
# Sourcing (.) runs in the caller's shell so the eval'd `export KEY=value` and
# the `::add-mask::$v` workflow-command registrations propagate naturally —
# no $GITHUB_ENV bridge, no `set -a` wrapper. Each script invocation is what
# the team's canonical recipe describes (`nsc version ensure` -> `nsc vault
# list | jq | grep > envdef` -> `nsc vault export --shell=bash` -> eval), just
# with the env-var-shaped jq projection, the per-mode KEYS filter, the
# privacy-safe diagnostic, and the post-eval mask registration all routed to
# one place.
#
# After this script returns successfully:
#   - every KEY in KEYS that the vault carries is exported into the caller.
#   - each exported value is registered with GH Actions `::add-mask::` so a
#     downstream echo or error message is redacted.

set -uo pipefail

KEYS="${1:-${KEYS-}}"
if [ -z "${KEYS}" ]; then
  echo "::error::load-vault-secrets.sh: KEYS regex required (pass as \$1 or export KEYS=)" >&2
  return 1 2>/dev/null || exit 1
fi

nsc version ensure --at_least 0.0.550 >/dev/null

# Pull env-var names from `name=` labels (or `description` as a fallback) and
# project to KEY=<object_id>. Object_ids are random handles; secret VALUES only
# materialise via the subsequent `nsc vault export`.
nsc vault list --output json | jq -r '
  .[]
  | (.labels // []) as $l
  | (($l | map(select(.name=="name")) | .[0].value) // .description // "") as $name
  | select($name | test("^[A-Z][A-Z0-9_]*$"))
  | "\($name)=\(.object_id)"
' | grep -E "$KEYS" > /tmp/vault.envdef

# Diagnostic — surface "did the filter match anything" without leaking the
# actual KEY=<object_id> mappings into CI logs.
echo "::notice::envdef line count: $(wc -l < /tmp/vault.envdef)"
if [ ! -s /tmp/vault.envdef ]; then
  echo "::error::envdef is empty after grep — no vault entries matched KEYS pattern" >&2
  return 1 2>/dev/null || exit 1
fi

# Eval exports each resolved secret into the current shell.
eval "$(nsc vault export --envdef /tmp/vault.envdef --shell=bash)"

# Re-mask each loaded value with GH Actions workflow-command masking. Bare
# `export KEY=value` (from the eval'd `cat /tmp/X` heredoc) is NOT auto-redacted
# the way `${{ secrets.X }}`-resolved values are, so any downstream echo that
# happens to include the value (e.g. a stack trace printing GCS_PRIVATE_KEY) is
# masked here. Multi-line values like PEM keys register as one `::add-mask::`
# call; GH Actions splits the value internally so each line gets masked.
awk -F= '{print $1}' /tmp/vault.envdef | while IFS= read -r key; do
  [ -n "$key" ] || continue
  v="${!key-}"
  if [ -n "$v" ]; then
    echo "::add-mask::$v"
  fi
done
