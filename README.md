# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/taufik-hidayat/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/taufik-hidayat/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard
library only — no dependencies, no git binary, no network beyond the suite
that drives it.

## What it serves

- **git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2
  (capability advertisement, `ls-refs`, `fetch` with shallow/deepen) and
  receive-pack v0 (fast-forward-only pushes, per-ref `report-status`,
  side-band-64k framing). The object store, packfile reader/writer and
  reachability walk are implemented from scratch on `node:zlib` and
  `node:crypto`.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments and pull requests with squash merges, plus
  Link-header pagination and the `X-GitHub-Request-Id` discipline.
- **GraphQL v4** at `/api/graphql`: the documents `gh` and
  `github-mcp-server` actually send — viewer, repository and issue reads,
  `__type` introspection, cursor pagination, `node(id:)` and the
  create/close/merge/add-comment mutations, including batched operations.
- **MCP** at `/mcp`: streamable-HTTP JSON-RPC 2.0, `server/discover`
  (revision `2026-07-28`) with the `initialize` handshake fallback, and six
  tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as
  REST.

## Running it

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL`,
serves until the env says done, then exits 0. Without `MAKEFUN_ENV_URL`
it listens on `$PORT` (or an ephemeral port) and stays up, for local
grading with the kit's runner:

```sh
MAKEFUN_SHOP_TOKEN=shpat_test node --experimental-strip-types main.ts
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token shpat_test --perf
```

## Determinism

No wall clock and no unseeded randomness anywhere a request can see:
timestamps come from `MAKEFUN_TRIAL_NOW`, ids and cursors are deterministic
functions of the request sequence, and the whole store lives in memory.

## Layout

- `main.ts` — the entry ↔ env lifecycle (bind, register, poll done, exit).
- `lib/git-objects.ts` — object hashing, trees, commits, tags, reachability.
- `lib/pack.ts` — pkt-lines, packfile read/write, git deltas.
- `lib/store.ts` — the in-memory forge: repos, refs, issues, pulls, merges.
- `lib/smart-http.ts` — the git smart-HTTP wire protocol.
- `lib/rest.ts` — the REST v3 adapter.
- `lib/graphql.ts` — the GraphQL v4 executor.
- `lib/mcp.ts` — the MCP endpoint and its tools.
- `lib/http.ts` — the HTTP server, routing and auth.
- `lib/determinism.ts` — the trial clock and seed.

## License

MIT — see [LICENSE](LICENSE).

---

Built for the [github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01?ref=2z9vc20p) on [make.fun](https://make.fun/r/2z9vc20p).
