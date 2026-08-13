Op-based `bd` (beads) wrapper: the project's dependency-aware issue graph and persistent agent memory. Issues live in `.beads/` (Dolt-backed) and survive across sessions; prefer it over ad-hoc plan files for durable, multi-session work tracking. The session-local `todo` tool still tracks the current turn's steps.

<instruction>
Pick op via `op`. Beyond the field descriptions, per op:
- `ready` — unblocked, claimable issues; check this before asking what to work on. `limit` bounds results.
- `blocked` — issues waiting on open dependencies, with their blockers.
- `list` — all issues; `status` filters (`open`/`in_progress`/`closed`/`deferred`).
- `show` — full detail (description, design, acceptance, notes) for `id` or `ids`.
- `create` — requires `title`; `priority` 0 (critical) … 4 (backlog, default 2), `issueType` defaults to task. Attach to an epic via `parent`. Link provenance with `deps: ["discovered-from:<id>"]` when work is discovered mid-task.
- `update` — requires `id` plus at least one change. `claim: true` atomically assigns and marks in_progress — claim before starting work.
- `close` — requires `id`/`ids`; give a substantive `reason` (it is the audit trail).
- `dep_add` — `id` (dependent) now depends on `parent` (blocker). Prefer one call per edge.
- `dep_tree` — dependency tree under `id`.
- `prime` — workflow context + stored memories; run once when starting a beads-managed work session.
- `remember` — store a durable project insight (`text`); replaces MEMORY.md-style files.
- `stats` — issue counts and graph health.
- `sync` — pull then push the beads database to the git remote (`bd dolt pull` + `push`).
</instruction>

<output>
Issue lines as `<status-glyph> <id> [P<n>] [<type>] <title>` (○ open, ◐ in progress, ● blocked, ✓ closed, ❄ deferred); `show` adds the prose fields.
</output>

<critical>
Claim (`update` + `claim`) before working an issue and `close` it when done — unclosed finished work strands the graph. Discovered follow-up work gets a linked `create`, not a markdown TODO.
</critical>
