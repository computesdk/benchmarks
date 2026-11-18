#!/usr/bin/env bash
#
# Load a filtered subset of Namespace vault entries into the current shell.
#
# Usage:
#   . scripts/load-vault-secrets.sh          # KEYS env var required
#   . scripts/load-vault-secrets.sh 'regex'  # pass regex as $1
#   bash scripts/load-vault-secrets.sh 'regex'  # standalone
#
# Sourcing (.) runs in the caller's shell so the eval'd `export KEY=value` and
# the `::add-mask::$v` workflow-command registrations propagate naturally.

set -uo pipefail

KEYS="${1:-${KEYS-}}"
if [ -z "${KEYS}" ]; then
  echo "::error::load-vault-secrets.sh: KEYS regex required (pass as \$1 or export KEYS=)" >&2
  return 1 2>/dev/null || exit 1
fi

nsc version ensure --at_least 0.0.550 >/dev/null

vault_json=$(nsc vault list --output json)
KEYS_REGEX="$KEYS"

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

active_unique_count=$(wc -l < /tmp/vault.envdef)
duplicate_count=$((active_raw_count - active_unique_count))

echo "::notice::load-vault-secrets.sh: active_raw=${active_raw_count} active_unique=${active_unique_count} duplicates=${duplicate_count} deleted=${deleted_count}"
if [ ! -s /tmp/vault.envdef ]; then
  echo "::error::envdef is empty after filtering -- no vault entries matched KEYS pattern" >&2
  return 1 2>/dev/null || exit 1
fi

if ! vault_exported=$(nsc vault export --envdef /tmp/vault.envdef --shell=bash); then
  echo "::error::nsc vault export failed to resolve secrets" >&2
  return 1 2>/dev/null || exit 1
fi
eval "$vault_exported"

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
