# beads

> OMS-native dependency-aware issue tracking and persistent project memory. No `bd`, Dolt, or other tracker executable is required.

## Source

- Tool and renderer: `packages/coding-agent/src/tools/beads.ts`
- Store: `packages/coding-agent/src/beads/repository.ts`
- Git synchronization: `packages/coding-agent/src/beads/sync.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/beads.md`
- Settings: `packages/coding-agent/src/config/settings-schema.ts`

## Availability and initialization

The tool is discoverable whenever `beads.enabled` is `true` (the default), including before a project is initialized and when no `bd` executable exists.

Run `init` once. It creates `.beads/` at the nearest Git repository root, or at the current working directory when no repository is found. Ancestor discovery deliberately stops before the user's home directory so a global `~/.beads` cannot capture unrelated projects.

## Storage and migration

Native Beads owns three files:

- `.beads/oms-beads.sqlite` — authoritative local SQLite store. WAL mode, a busy timeout, and immediate write transactions provide safe concurrent agent access. The database and its WAL files are added to `.beads/.gitignore`.
- `.beads/issues.jsonl` — deterministic issue/dependency interchange.
- `.beads/oms-memories.jsonl` — deterministic persistent-memory interchange.

Existing `.beads/issues.jsonl` data is imported once during initialization. OMS refuses to create an empty store over a detected legacy Dolt database when no JSONL export is available; export the legacy database first.

## Inputs

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `init` | None | `prefix` | Initialize native storage; `prefix` controls generated root issue IDs. |
| `ready` | None | `limit`, `offset` | Unblocked open issues, ordered by priority and age. At most 50 rows per page. |
| `blocked` | None | `limit`, `offset` | Open/in-progress issues waiting on open blocking dependencies. At most 50 rows per page. |
| `list` | None | `status`, `limit`, `offset` | List issues; `status` filters `open`/`in_progress`/`closed`/`deferred`. At most 50 rows per page. |
| `show` | `id` or `ids` | `field`, `offset` | Preview detail for at most five issues. With one `id`, select `field` and follow character `offset` to retrieve the complete field. |
| `create` | `title` | `description`, `issueType`, `priority`, `parent`, `deps`, `design`, `acceptance` | Create an issue. `deps` entries are `type:id` or bare blocking IDs. |
| `update` | `id` plus a change | `claim`, `title`, `description`, `notes`, `design`, `acceptance`, `priority` | Mutate fields. `claim: true` atomically assigns the issue to the current OMS session and marks it in progress. |
| `close` | `id` or `ids` | `reason` | Atomically close one or more issues. |
| `dep_add` | `id`, `parent` | None | Make `id` depend on `parent`; blocking cycles are rejected. |
| `dep_tree` | `id` | `offset` | Render an issue's dependency tree, paged by character offset. |
| `prime` | None | `query`, `limit`, `offset` | Return ready work plus at most 20 persistent memories per page. |
| `memory` | `key` | `offset` | Retrieve a persistent memory value, paged by character offset. |
| `remember` | `text` | None | Store a content-addressed durable project insight. |
| `stats` | None | None | Return issue, readiness, dependency, memory, and cycle counts. |
| `sync` | None | None | Merge and push deterministic snapshots through the configured Git remote. |

## Approval tiers

- `read`: `ready`, `blocked`, `list`, `show`, `dep_tree`, `prime`, `memory`, `stats`
- `write`: `init`, `create`, `update`, `close`, `dep_add`, `remember`
- `exec`: `sync`

Override per policy key `tools.approval.beads`.

## Synchronization

`sync` uses an isolated temporary Git repository and the dedicated `refs/heads/oms-beads` branch. It never stages, commits, checks out, rebases, or resets the user's working branch. Remote and local JSONL records merge by `updated_at`, with deterministic tie-breaking; compare-and-swap push races fetch, merge, and retry up to three times. Each Git process has a 120-second deadline and cannot prompt interactively. The temporary repository preserves the caller's object format, resolved fetch/push URLs, and relevant per-remote proxy/transport settings while disabling hooks, attributes, excludes, filesystem monitors, and ambient author/repository overrides.

Each snapshot file is capped at 16 MiB. Temporary Git object storage is capped at 80 MiB during fetch, lazy promisor reads, and push; crossing the limit terminates the managed Git process tree and rejects the sync.

Only `.beads/issues.jsonl` and `.beads/oms-memories.jsonl` are synchronized. The local SQLite database remains untracked. Multiple configured push URLs are preserved.

## Outputs

Issue lines render as `<glyph> <id> [P<n>] [<type>] <title>` (`O` open, `>` in progress, `!` blocked, `X` closed, `~` deferred), followed by claim, blocker, and parent annotations. Inline `show` output previews large prose; use `field` and character `offset` for lossless retrieval. List-like operations page at no more than 50 rows, while `prime` pages at no more than 20 memories.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `beads.enabled` | `true` | Master availability switch. |
| `beads.remote` | `"origin"` | Git remote used for the isolated snapshot branch. |

Both controls appear in `/settings` under **Memory → Beads** and **Tools → Available Tools**.

The session-local `todo` tool remains complementary: `todo` tracks the current turn; Beads tracks durable multi-session work and dependencies.
