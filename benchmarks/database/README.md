# Database CRUD benchmark

This benchmark measures a create → read → update → read → delete cycle against
each configured database provider. Postgres is currently the only provider.

## Configuration

Required:

- `DATABASE_POSTGRES_URL`

Optional:

- `DATABASE_BENCH_TABLE` — table name, default `benchmark_crud`

Run a local Postgres target with:

```bash
docker run --rm --name database-benchmark-postgres -p 5433:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=benchmark postgres:16
```

Then run the benchmark:

```bash
DATABASE_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5433/benchmark \
  pnpm bench:database:postgres
```

The payload defaults to 1 KiB and can be changed with `--payload-size`, for
example `--payload-size 4096`.

Results are written to `results/database/<YYYY-MM-DD>.json` and
`results/database/latest.json`.

To add a provider, add one entry to `providers.ts` and implement its
`DatabaseClient` in a client module.
