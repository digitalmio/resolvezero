# Rule Artifacts — Format & Pipeline

**Status:** implemented. The **Node** worker (`resolvezero-artifacts`) is the
active hosted producer (`COMPILER_SHADOW=0`). The Rust compiler
(`resolvezero-compiler`) is scaled to 0 and kept for rollback. Production edge
and artifacts both run Node.
**Last updated:** 2026-11-17

Compiled, content-addressed blocklist artifacts shared by the Node and Rust
edges. The binary format is deliberately tiny: no strings, no parse on the
data plane.

---

## 1. Binary layout

All integers little-endian.

```
offset  size  field
0       4     magic "RZA1"
4       1     format version (1)
5       1     flags        bit0 = allow table present
6       2     header bytes (24)
8       4     allow count  (u32)
12      4     block count  (u32)
16      4     total rules = allow + block
20      4     reserved (0)
24      …     allow: u64 × allowCount, sorted ascending
…       …     block: u64 × blockCount, sorted ascending
```

- Each entry is the **xxhash64 (seed 0)** of a normalized domain, implemented
  in `packages/rules/src/fingerprint.ts`.
- Rules are stored exactly as written; the query side probes every label
  suffix, which preserves subtree semantics.
- Allow entries are checked before block entries, across all lists.
- There are no timestamps or URLs in the file, so the bytes are deterministic
  for the same rule set. **Artifact id = sha256(file).**

Size: `24 + 8 × rules`. A 500k-rule list is 4.0 MB (vs ~15 MB of source text).

## 2. Sidecar

`<sha256>.json` (the `compiler` field differs by runtime):

```json
{
  "id": "…",
  "source": "https://…",
  "allow": 0,
  "block": 200230,
  "rules": 200230,
  "bytes": 1601864,
  "compiler": "rz-compile-node/0.1",
  "hash": "xxhash64/seed0",
  "createdAt": "2026-11-07T11:14:00Z"
}
```

`hash` is an invariant check: if the fingerprint function ever changes, the
loader must reject the artifact rather than silently serve unfiltered answers.

## 3. Storage layout

```
artifacts/<sha256>.bin
artifacts/<sha256>.json
```

Private bucket (iDrive E2): custom-rule overlays can reveal blocked domains,
so artifacts are never public. The prefix is `ARTIFACT_PREFIX` (default
`artifacts`).

Postgres is the manifest:

- `rule_artifacts`: hash, source URL, byte size, allow/block counts, compiler,
  created_at.
- `profile_blocklists.artifact_hash` / `artifact_rules` / `compiled_at`:
  which artifact this subscription should load.

## 4. Compiler

The active hosted worker is Node (`apps/artifacts`), sharing `packages/rules`
with the production Node edge:

```sh
pnpm exec tsx apps/artifacts/src/cli.ts --url https://example/list.txt --out ./artifacts
pnpm exec tsx apps/artifacts/src/cli.ts --file ./list.txt --format hosts --out ./artifacts
```

It uses the same parser, xxhash64 seed 0, sorted/deduped arrays, and `RZA1`
encoder as the Rust compiler; byte-for-byte parity is covered by tests and was
verified against the live Hagezi/AdGuard lists. Output is the `.bin` + `.json`;
the sidecar is also printed to stdout.

The Rust edge/compiler source is archived in the `rust-fallback-2026-11-17`
tag; it is not in the current tree and has no Fly machines. The Node worker
writes `compiler_status` and advances `blocklist_version` itself.

## 5. Publishing

`scripts/artifacts.ts`:

```sh
pnpm exec tsx scripts/artifacts.ts --all
pnpm exec tsx scripts/artifacts.ts --status
```

The active worker (`apps/artifacts/src/main.ts`) performs this loop every
`COMPILE_POLL_SECONDS` and refreshes artifacts older than
`COMPILE_INTERVAL_SECONDS`. The manual script remains useful for one-off
publishes. For every distinct enabled `profile_blocklists.url` it:

1. compiles in-process with `@resolvezero/rules`,
2. uploads `<hash>.bin` + `<hash>.json` to E2,
3. upserts `rule_artifacts`,
4. sets `artifact_hash` / `artifact_rules` / `compiled_at` on the rows,
5. bumps `edge_config_state.blocklist_version` once.

The bump is explicit because the blocklist trigger intentionally excludes
status columns (`artifact_hash` was added after) to avoid sync loops.

`.github/workflows/artifacts.yml` wraps this for CI, gated on
`vars.ARTIFACTS_ENABLED == 'true'` and manual dispatch only.

## 6. Loading

- **Node edge** (production, `apps/edge-node/src/artifact.ts` +
  `blocklists.ts`): if `artifact_hash` is set, GET the object, verify sha256,
  and decode it into the rule store. Lazy loading fetches only the profiles
  queried since the last `blocklist_version` bump.
- **Rust edge** (archived in `rust-fallback-2026-11-17`): the same artifact
  path with a small SigV4 client. It is no longer deployed; the tag is the
  parity/rollback reference.
- On any artifact failure the Node edge keeps the list pending/failed and
  reports it in `/readyz`; artifact-only mode does not parse raw text as a
  fallback.

`/readyz` exposes `lazyLists`, `artifactLists`, `pendingLists`, `failedBlocklists`,
and `remoteLists`; the Rust edge also exposed `rawLists`/`rz_artifact_lists`.

## 7. What to watch

- Artifact failures are non-fatal but silent-ish: search logs for
  `artifact load failed`.
- A wrong `hash`/seed would make every rule miss; the sidecar invariant and
  the loader's sha256 check are the guards.
- Old artifacts are immutable. Delete unreferenced hashes after 30 days.
