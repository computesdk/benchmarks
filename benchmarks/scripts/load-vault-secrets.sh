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

# Platform sandboxes can mount a Namespace workload token at
# /var/run/nsc/token.json (read-only; `id-token: write` jobs) whose grants stop
# at the container registry — vault reads need the org token instead. Point nsc
# at a copy of it when it's in env; the mounted file cannot be overwritten.
if [ -n "${NSC_TOKEN:-}" ]; then
  _nsc_org_token_file="$(mktemp)"
  case "$NSC_TOKEN" in
    \{*) printf '%s\n' "$NSC_TOKEN" > "$_nsc_org_token_file" ;;
    *) printf '{"bearer_token":"%s"}\n' "$NSC_TOKEN" > "$_nsc_org_token_file" ;;
  esac
  chmod 600 "$_nsc_org_token_file"
  export NSC_TOKEN_FILE="$_nsc_org_token_file"
fi

nsc version ensure --at_least 0.0.550 >/dev/null

# Pull env-var names from `name=` labels (or `description` as a fallback) and
# project to KEY=<object_id>. Object_ids are random handles; secret VALUES only
# materialise via the subsequent `nsc vault export`.
vault_json=$(nsc vault list --output json)
KEYS_REGEX="$KEYS"

# Diagnostic count of deleted vault objects that match the requested keys.
# If this is >0, `nsc vault list` is returning deleted entries for active
# env-vars and that should be reported to Namespace.
deleted_count=$(jq --arg KEYS "$KEYS_REGEX" '
  [ .[]
    | select((.deleted_at // null) != null)
    | (.labels // []) as $l
    | (($l | map(select(.name=="name")) | .[0].value) // .description // "") as $name
    | select($name | test("^[A-Z][A-Z0-9_]*$"))
    | select(($name + "=") | test($KEYS))
  ]
  | length
' <<< "$vault_json")

# Count active entries before deduplication so we can detect duplicates.
active_raw_count=$(jq --arg KEYS "$KEYS_REGEX" '
  [ .[]
    | select((.deleted_at // null) == null)
    | (.labels // []) as $l
    | (($l | map(select(.name=="name")) | .[0].value) // .description // "") as $name
    | select($name | test("^[A-Z][A-Z0-9_]*$"))
    | select(($name + "=") | test($KEYS))
  ]
  | length
' <<< "$vault_json")

# Build the envdef from the newest active object per env-var name.
jq -r --arg KEYS "$KEYS_REGEX" '
  [ .[]
    | select((.deleted_at // null) == null)
    | (.labels // []) as $l
    | (($l | map(select(.name=="name")) | .[0].value) // .description // "") as $name
    | select($name | test("^[A-Z][A-Z0-9_]*$"))
    | select(($name + "=") | test($KEYS))
    | {name: $name, object_id: .object_id}
  ]
  | group_by(.name)
  | map(last)
  | .[]
  | "\(.name)=\(.object_id)"
' <<< "$vault_json" > /tmp/vault.envdef

active_unique_count=$(wc -l < /tmp/vault.envdef)
duplicate_count=$((active_raw_count - active_unique_count))

# Diagnostic — surface counts without leaking KEY=<object_id> mappings.
echo "::notice::load-vault-secrets.sh: active_raw=${active_raw_count} active_unique=${active_unique_count} duplicates=${duplicate_count} deleted=${deleted_count}"
if [ ! -s /tmp/vault.envdef ]; then
  echo "::error::envdef is empty after filtering — no vault entries matched KEYS pattern" >&2
  return 1 2>/dev/null || exit 1
fi

# Eval exports each resolved secret into the current shell.
if ! vault_exported=$(nsc vault export --envdef /tmp/vault.envdef --shell=bash); then
  echo "::error::nsc vault export failed to resolve secrets" >&2
  return 1 2>/dev/null || exit 1
fi
eval "$vault_exported"

# Re-mask each loaded value with GH Actions workflow-command masking. Bare
# `export KEY=value` (from the eval'd `cat /tmp/X` heredoc) is NOT auto-redacted
# the way `${{ secrets.X }}`-resolved values are, so any downstream echo that
# happens to include the value (e.g. a stack trace printing GCS_PRIVATE_KEY) is
# masked here. Multi-line values like PEM keys register as one `::add-mask::`
# call; GH Actions splits the value internally so each line gets masked.
resolved_count=0
missing_count=0
missing_keys=""
while IFS= read -r line; do
  key="${line%%=*}"
  object_id="${line#*=}"
  v="${!key-}"
  if [ -n "$v" ]; then
    echo "::add-mask::$v"
    resolved_count=$((resolved_count + 1))
  else
    missing_count=$((missing_count + 1))
    missing_keys="${missing_keys}${missing_keys:+, }${key} (object_id=${object_id})"
  fi
done < /tmp/vault.envdef
if [ -n "$missing_keys" ]; then
  echo "::error::load-vault-secrets.sh: missing ${missing_count} key(s): ${missing_keys}" >&2
fi
echo "::notice::load-vault-secrets.sh: resolved=${resolved_count} missing=${missing_count}"
if [ -n "$missing_keys" ]; then
  return 1 2>/dev/null || exit 1
fi
