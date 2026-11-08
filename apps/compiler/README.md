# resolvezero-compiler

Artifact compiler for ResolveZero. It turns blocklists into content-addressed
`RZA1` files, uploads them to S3-compatible storage, and updates
`profile_blocklists.artifact_hash` / `compiled_at`.

Two binaries:

| Binary | Purpose |
|---|---|
| `rz-compiler` | Long-running worker deployed as the `resolvezero-compiler` Fly app |
| `rz-compile` | One-shot URL/file → artifact compiler used by the manual fallback |

Both share the artifact parser, fingerprint format, SSRF guard, and database
access with the edge through `crates/rz-core` and `crates/rz-db`.

## Worker behavior

`rz-compiler` is a resident loop, not a cron:

- Every **10 s** (`COMPILE_POLL_SECONDS`): query enabled lists and compile any
  with `artifact_hash IS NULL` or `compiled_at` older than 6 h.
- Every **6 h** per list: re-fetch and re-parse. Upload only when the SHA-256
  changes; bump `blocklist_version` once per cycle if anything changed.
- On process start: `FORCE_COMPILE=1` forces one full pass.
- Writes a heartbeat every 15 s and a per-cycle status row to `compiler_status`;
  `sentinel.yml` alerts if the heartbeat/artifacts go stale.

## Run locally

```sh
set -a
source .env
set +a

cargo run --release -p resolvezero-compiler --bin rz-compiler
```

Required env: `DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. Optional:
`ARTIFACT_PREFIX`, `COMPILE_INTERVAL_SECONDS`, `COMPILE_POLL_SECONDS`,
`FORCE_COMPILE`, `BLOCKLIST_MAX_LIST_BYTES`.

## One-shot compiler

```sh
cargo run --release -p resolvezero-compiler --bin rz-compile -- \
  --url https://example.com/hosts.txt --out artifacts
```

The manual GitHub Actions fallback (`artifacts.yml`) builds `rz-compile` and
uses `scripts/artifacts.ts` to upload and record the result. Runtime
freshness does not depend on Actions.

## Deploy

- Image: `Dockerfile.compiler`
- Fly config: `fly.compiler.toml` (app `resolvezero-compiler`, region `fra`,
  1 shared CPU / 512 MB, no public ingress)
- Workflow: `.github/workflows/deploy-compiler.yml` (manual)
