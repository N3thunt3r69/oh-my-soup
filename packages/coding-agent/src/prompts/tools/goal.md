Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal and enables goal mode. Requires `objective`; optional `token_budget` must be positive; optional `gates` lists shell commands that must all exit 0 before the goal can complete. Use only when no goal exists and no goal is paused.
- `get` returns the current goal (active or paused) and remaining token budget.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence. When quality gates are configured they run first; if any gate fails, completion is rejected with the gate output.
- `drop` discards the current goal without completing it.

NEVER call `complete` because a budget is low or a turn is ending. Call it only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
