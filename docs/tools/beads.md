# beads

> Op-based wrapper around the [`bd` (beads)](https://github.com/gastownhall/beads) CLI: a dependency-aware, Dolt-backed graph issue tracker that gives agents persistent structured memory across sessions.

## Source
- Entry: `packages/coding-agent/src/tools/beads.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/beads.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/index.ts` — registers the tool and gates it on `beads.enabled`.
  - `packages/coding-agent/src/tools/renderers.ts` — registers the TUI renderer.
  - `packages/coding-agent/src/config/settings-schema.ts` — `beads.enabled`, `beads.binary`.

## Availability

The tool activates only when **both** hold:

1. The `bd` binary is resolvable — `beads.binary` setting when set, else `bd` on `PATH`.
2. The workspace contains a `.beads/` database in the working directory or an ancestor (i.e. someone ran `bd init` for the project).

This makes it zero-config in beads-managed projects and entirely absent elsewhere. `beads.enabled` (default `true`) turns the tool off unconditionally; bootstrap an uninitialized project via `bash` with `bd init --quiet`.

Every invocation runs with `BD_JSON_ENVELOPE=1`; both the envelope (`{schema_version, data}`) and legacy raw JSON shapes are accepted, so any `bd` version with `--json` support works.

## Inputs

| Op | Required fields | Optional fields | Effect |
| --- | --- | --- | --- |
| `ready` | None | `limit` | Unblocked, claimable issues (dependency graph computed). |
| `blocked` | None | `limit` | Issues waiting on open dependencies, with their blockers. |
| `list` | None | `status`, `limit` | All issues; `status` filters `open`/`in_progress`/`closed`/`deferred`. |
| `show` | `id` or `ids` | None | Full detail: description, design, acceptance criteria, notes. |
| `create` | `title` | `description`, `issueType`, `priority`, `parent`, `deps`, `design`, `acceptance` | Creates an issue (`priority` defaults 2). `deps` entries are `type:id` (e.g. `discovered-from:bd-12`) or bare ids. |
| `update` | `id` + ≥1 change | `claim`, `title`, `description`, `notes`, `design`, `acceptance`, `priority` | Mutates fields; `claim: true` atomically assigns and marks in_progress. |
| `close` | `id` or `ids` | `reason` | Closes issues; the reason is the audit trail. |
| `dep_add` | `id`, `parent` | None | `id` (dependent) now depends on `parent` (blocker). |
| `dep_tree` | `id` | None | Dependency tree under an issue. |
| `prime` | None | None | Workflow context plus stored project memories. |
| `remember` | `text` | None | Stores a durable project insight. |
| `stats` | None | None | Issue counts and graph health. |
| `sync` | None | None | `bd dolt pull` then `bd dolt push` against the git remote. |

## Approval tiers

- `read`: `ready`, `blocked`, `list`, `show`, `dep_tree`, `prime`, `stats`
- `write`: `create`, `update`, `close`, `dep_add`, `remember`
- `exec`: `sync` (touches the network remote)

Override per policy key `tools.approval.beads`.

## Outputs

Issue lines render as `<glyph> <id> [P<n>] [<type>] <title>` using beads' own status glyphs (`○` open, `◐` in progress, `●` blocked, `✓` closed, `❄` deferred), with blocker/parent/claim annotations appended. `show` adds the prose fields. List-like ops cap at 50 rows (or `limit`) with a truncation marker; the full parsed issue objects ride in `details.issues` for renderers.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `beads.enabled` | `true` | Master switch; availability still requires the binary + `.beads/`. |
| `beads.binary` | `""` | Exact path to the `bd` executable; empty resolves from `PATH`. |

## Notes

- The session-local `todo` tool and beads are complementary: `todo` tracks the current turn's steps, beads tracks durable, multi-session work with dependencies.
- Commands run with a 120 s deadline and no shell — field values are passed as single argv entries, so backticks/quotes/`$vars` in descriptions need no escaping.
- bd JSON error payloads (`{error, hint}`) surface as tool errors with the hint attached.
