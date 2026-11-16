# Source after load-vault-secrets.sh in a "provider test" run: reads the
# provider-supplied test environment from the BENCHMARK_PROVIDER_TEST_ENV
# vault object (a JSON object of env vars, written by the platform when it
# dispatches the test run) and exports every entry over the vault-loaded
# values — e.g. a staging provider key, or the org's own
# BENCHMARKS_PLATFORM_API_KEY so the test run reports under the provider's
# org. No-op when the vault object is absent, so regular runs are unaffected.
if [ -z "${PROVIDER_TEST_ENV:-}" ]; then
  if nsc vault list --output json 2>/dev/null | jq -e '
      [ .[]
        | select((.deleted_at // null) == null)
        | ((.labels // [] | map(select(.name == "name")) | .[0].value) // .description // "")
        | select(. == "BENCHMARK_PROVIDER_TEST_ENV")
      ] | length > 0' >/dev/null; then
    . "$(dirname "${BASH_SOURCE[0]}")/load-vault-secrets.sh '^(BENCHMARK_PROVIDER_TEST_ENV=)'"
    PROVIDER_TEST_ENV="${BENCHMARK_PROVIDER_TEST_ENV:-}"
  fi
fi
if [ -n "${PROVIDER_TEST_ENV:-}" ]; then
  eval "$(printf '%s' "$PROVIDER_TEST_ENV" | jq -r 'to_entries[] | @sh "export \(.key)=\(.value)"')"
fi
