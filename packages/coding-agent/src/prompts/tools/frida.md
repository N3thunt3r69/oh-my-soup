Dynamic instrumentation of live processes through a managed Frida worker.

Use a session-oriented flow:

- `devices`, `processes`, and `applications` discover targets.
- `attach` connects to an existing process; `spawn` starts a process suspended and returns a session. After installing scripts or hooks, use `resume`.
- `sessions` lists live sessions and scripts; `detach`, `kill`, and `stop` release them.
- `modules`, `exports`, `symbols`, `ranges`, `threads`, and `resolve` inspect the target.
- `read`, `scan`, and `write` access target memory. Addresses may be hexadecimal, `module!symbol`, or bare symbols.
- `load` injects JavaScript, `call` invokes one of its `rpc.exports`, `eval` evaluates an expression in the target, and `unload` removes a script.
- `hook` attaches a managed `Interceptor` hook; `messages` drains captured enter/leave events and agent `send()` payloads; `unhook` removes it.

`attach` accepts either `pid` or `name`. `spawn` leaves the process suspended so instrumentation can be installed before its entry point runs. Sessions and scripts persist across tool calls in the OMS process. Frida callbacks are asynchronous: use `messages` with `since` as a cursor, or `clear: true` after consuming records.

The first call resolves a Python 3 interpreter, creates an OMS-owned virtual environment, and installs the pinned `frida` Python package. Configure `frida.python` or pass `python` when automatic discovery cannot find the intended interpreter. The worker and all attached sessions stop with OMS or `action: "stop"`.

Treat target-side JavaScript and memory mutation as process execution. Prefer bounded enumeration and scans. A bad address, invalid hook, or target crash is surfaced directly; the tool does not hide target failures or automatically resume spawned processes.
