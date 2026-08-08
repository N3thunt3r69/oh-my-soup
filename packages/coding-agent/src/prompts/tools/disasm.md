Disassembler/decompiler access, separate from the live-process `debug` tool.

Use the backend-neutral model:
- `backends` — list native adapters.
- `list` — discover connected targets before choosing `target`.
- `query` — preferred shared SQL interface for disassembly, decompilation, xrefs, symbols, types, search, and scoped database edits.
- `execute` — backend-native code only when SQL cannot express the operation (IDAPython for `ida`; future adapters define their own language).
- `reset`, `save`, and `close` — target lifecycle operations when supported.

`backend` defaults to the configured backend (`ida`). `endpoint` overrides that adapter's configured endpoint for one call.

For IDA, start ida-bridge and a headless idalib runner. The built-in adapter discovers only idalib clients and never launches IDA. Prefer bounded SQL queries; broad virtual-table scans can decompile or walk the entire database. SQL writes mutate the IDB and are not transactionally rolled back. Stateful execution exclusively claims a target: use it only when later calls need the same in-memory namespace, always supply your own `session_id`, and release it with `reset` + `release`. Never use `takeover` unless the user explicitly directs it. Save before `close` when changes must persist.
