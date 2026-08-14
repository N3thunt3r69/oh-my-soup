# frida

> Attach to or spawn live processes, inject Frida JavaScript agents, inspect modules and memory, and capture function calls through persistent instrumentation sessions.

## Source

- Entry: `packages/coding-agent/src/tools/frida.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/frida.md`
- Host client: `packages/coding-agent/src/frida/client.ts`
- Runtime provisioning: `packages/coding-agent/src/frida/runtime.ts`
- Python worker and resident JavaScript agent: `packages/coding-agent/src/frida/worker.py`
- Result contracts: `packages/coding-agent/src/frida/types.ts`
- Timeout policy: `packages/coding-agent/src/tools/tool-timeouts.ts`

## Relationship to `debug` and `disasm`

- `frida` instruments a running process without requiring source code or a language-specific debugger. Use it for injected JavaScript, native function hooks, runtime module/export discovery, and direct memory access.
- `debug` drives a DAP adapter and owns source-level breakpoints, stack frames, scopes, stepping, and debugger evaluation.
- `disasm` owns static and interactive binary analysis in IDA, Ghidra, or Binary Ninja.

The three tools do not share sessions or target identifiers.

## Runtime

`frida.enabled` defaults to `true`; set it to `false` to hide the tool. On the first action, OMS resolves Python 3.9 or newer, creates an OMS-owned virtual environment under the OMS config root, and installs the pinned Frida Python package. Configure `frida.python` when the intended interpreter is not discoverable. The `python` call field overrides that setting for worker startup.

One process-wide Python worker owns all Frida devices, sessions, scripts, hooks, and buffered messages. The worker persists across tool calls. `action: "stop"`, normal OMS postmortem cleanup, or process termination retires it and detaches its sessions. A timed-out or aborted request also retires the worker because the state of an in-flight target mutation is unknowable.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string enum | Yes | Operation listed below. |
| `device` | `string` | No | `local` (default), `usb`, `remote`, or an explicit Frida device id. |
| `pid` | `number` | Attach only | Existing process id. `attach` accepts `pid` or `name`. |
| `name` | `string` | No | Process name for `attach`; script label for `load`. |
| `program` | `string` | Spawn only | Executable path or application identifier. |
| `args` | `string[]` | No | Spawn argv. |
| `cwd` | `string` | No | Spawn working directory. |
| `env` | `Record<string, string>` | No | Spawn environment overrides. |
| `session` | `string` | Most target actions | Session id returned by `attach` or `spawn`. |
| `script` | `string` | `call`, `unload` | Script id returned by `load`. |
| `source` | `string` | `load`, `eval` | Agent source or target-side expression. |
| `method` | `string` | Call only | Name from the script's `rpc.exports`. |
| `call_args` | `unknown[]` | No | JSON arguments forwarded to the RPC method. |
| `target` | `string` | Address actions | Hex address, `module!symbol`, or bare exported/debug symbol. |
| `module` | `string` | `exports`, `symbols` | Loaded module name. |
| `filter` | `string` | No | Case-insensitive substring for supported list actions. |
| `limit` | `number` | No | Maximum rows or messages returned. |
| `protection` | `string` | No | Range protection mask such as `r-x`; default `r--`. |
| `size` | `number` | `read`, `scan` | Byte count. Reads are capped at 1 MiB. |
| `data` | `string` | Write only | Hex bytes, with optional spaces or colons. |
| `pattern` | `string` | Scan only | Frida memory pattern such as `48 8b ?? ??`. |
| `nargs` | `number` | No | Hook argument pointers captured on entry, clamped to 0–8. |
| `strings` | `number[]` | No | Captured argument indices also probed as UTF-8/UTF-16 strings. |
| `backtrace` | `boolean` | No | Capture up to 16 frames on hook entry. |
| `retval` | `boolean` | No | Capture hook return values; default `true`. |
| `hook` | `string` | Unhook only | Hook id returned by `hook`; hook ids are session-scoped. |
| `since` | `number` | No | Message cursor; only records with a greater sequence are returned. |
| `clear` | `boolean` | No | Remove exactly the returned messages from the worker buffer. |
| `python` | `string` | No | One-call worker interpreter override. |
| `timeout` | `number` | No | Seconds; default 60, clamped to 5–600 and `tools.maxTimeout`. |

## Actions

### Discovery and lifecycle

- `devices` — enumerate Frida devices.
- `processes` — enumerate processes on a device; supports `filter`.
- `applications` — enumerate installed applications where the device supports it.
- `attach` — attach by `pid` or `name` and return a session id.
- `spawn` — spawn suspended, attach, and return a session id. Install instrumentation before `resume` when entry-point coverage matters.
- `resume` — start a process created by `spawn`.
- `kill` — terminate the process owned by a session.
- `detach` — unload user scripts and the resident agent, then detach the session.
- `sessions` — list sessions, loaded scripts, active hooks, and buffered-message count.
- `stop` — detach every session and stop the worker.

### Target inspection

- `modules` — list loaded modules.
- `exports` / `symbols` — list a module's exports or symbols.
- `ranges` — list memory ranges matching a protection mask.
- `threads` — list target threads and states.
- `resolve` — resolve an address expression and report its symbol when available.
- `read` — return an address, byte count, and hex dump.
- `scan` — scan a bounded address range using Frida's pattern syntax.
- `write` — decode a hex payload and write it at the resolved address.

### Scripts and hooks

- `load` — create and load arbitrary Frida JavaScript. `send()` records are buffered as messages.
- `call` — synchronously invoke a loaded script's `rpc.exports` method.
- `eval` — evaluate one expression in the resident agent's target context.
- `unload` — unload a user script.
- `hook` — install an `Interceptor.attach` listener through the resident agent.
- `hooks` — list hooks in one session.
- `unhook` — detach one session-scoped hook.
- `messages` — page buffered `send`, `error`, `hook`, `detached`, and spawned-process `output` records in sequence order.

## Examples

Attach and inspect modules:

```json
{"action":"processes","filter":"sample"}
```

```json
{"action":"attach","pid":4242}
```

```json
{"action":"modules","session":"session-1","filter":"crypto"}
```

Hook a native export, capture two pointer arguments, and drain events:

```json
{
  "action": "hook",
  "session": "session-1",
  "target": "kernel32.dll!CreateFileW",
  "nargs": 2,
  "strings": [0],
  "backtrace": true
}
```

```json
{"action":"messages","session":"session-1","clear":true}
```

Load an RPC agent and call it:

```json
{
  "action": "load",
  "session": "session-1",
  "name": "probe",
  "source": "rpc.exports = { arch() { return Process.arch; } };"
}
```

```json
{"action":"call","script":"script-2","method":"arch"}
```

## Limits and failure behavior

- The worker buffers at most 4096 asynchronous records. `messages` reports overwritten-record count and returns records oldest-first so `since` can paginate without gaps.
- `read` rejects sizes above 1 MiB. The host caps large textual tool output and stores the original in an output artifact when available.
- Frida target exceptions, RPC exceptions, invalid addresses, detach races, and process crashes are returned as tool errors; they are not replaced with fallback values.
- Agent JavaScript and memory writes execute inside another process. Their approval tier is `exec`; inspection actions use `read` approval.
- Spawns remain suspended until `resume`. `detach` does not kill an attached process; `kill` does.
