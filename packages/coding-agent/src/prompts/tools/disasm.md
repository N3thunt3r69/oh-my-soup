Disassembler/decompiler access, separate from the live-process `debug` tool.

Use the backend-neutral model:
- `backends` — list native adapters.
- `open` — open a binary or existing database in a managed headless worker and return its immediately queryable target ID.
- `list` — discover active targets before choosing `target`.
- `query` — preferred shared SQL interface for disassembly, decompilation, xrefs, symbols, types, search, and scoped database edits.
- `execute` — backend-native code only when SQL cannot express the operation (IDAPython for `ida`; future adapters define their own language).
- `reset`, `save`, and `close` — target lifecycle operations when supported.

`backend` defaults to the configured backend (`ida`). `endpoint` overrides that adapter's configured endpoint for one call.

For IDA, `open` resolves the configured IDA installation and Python executable, starts ida-bridge automatically, spawns one idalib worker per file, waits for analysis, and returns the new target ID. No manual server startup or binary loading is required. Configure `disasm.ida.installDir` and `disasm.ida.python`, or use the `ida_dir` and `python` one-call overrides. A raw binary without `output_idb` uses a temporary database that is deleted on `close`; pass `output_idb` when analysis must persist. The adapter accepts only headless idalib clients. Prefer bounded SQL queries; broad virtual-table scans can decompile or walk the entire database. SQL writes mutate the IDB and are not transactionally rolled back. Stateful execution exclusively claims a target: use it only when later calls need the same in-memory namespace, always supply your own `session_id`, and release it with `reset` + `release`. Never use `takeover` unless the user explicitly directs it. Save before `close` when changes must persist.
