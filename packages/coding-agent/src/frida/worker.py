#!/usr/bin/env python3
"""OMS Frida worker.

One long-lived process hosts every Frida session so device handles, spawned
children, and injected agents share coherent state across tool calls. The host
speaks newline-delimited JSON on stdio:

  host -> worker   {"id": "<str>", "op": "<name>", ...args}
  worker -> host   {"id": "<str>", "ok": true, "result": <json>}
                   {"id": "<str>", "ok": false, "error": "...", "traceback": "..."}
  worker -> host   {"event": "message"|"detached"|"output", ...}   (no id)

Event frames carry no `id` and may interleave with responses at any time;
they are buffered worker-side and drained by the `messages` action.

In-process instrumentation (modules, memory, interceptors) is delegated to a
resident JS agent loaded lazily per session -- Frida's Python API only covers
process/session lifecycle. The agent targets Frida 17, where
`Module.findExportByName` and `Memory.readByteArray` no longer exist.
"""

from __future__ import annotations

import base64
import json
import sys
import threading
import time
import traceback
from collections import deque
from typing import Any

import frida

PROTOCOL_VERSION = 1
MAX_BUFFERED_MESSAGES = 4096
MAX_READ_BYTES = 1024 * 1024

# Resident instrumentation agent. Frida 17 API notes baked in:
#   * `Module.findExportByName(mod, sym)` was removed -> use
#     `Process.findModuleByName(mod).findExportByName(sym)`.
#   * `Memory.readByteArray` was removed -> use `NativePointer#readByteArray`.
#   * Module/Range objects expose prototype getters, so `Object.keys()` is
#     empty; every field must be copied explicitly.
AGENT_SOURCE = r"""
'use strict';

const hooks = new Map();
let nextHookId = 1;

function hex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function unhex(text) {
  const clean = text.replace(/[\s:]/g, '');
  if (clean.length % 2 !== 0) throw new Error('hex payload must have an even number of digits');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 2) {
    const byte = parseInt(clean.substr(i, 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex payload');
    bytes.push(byte);
  }
  return bytes;
}

function describeModule(m) {
  return { name: m.name, base: m.base.toString(), size: m.size, path: m.path };
}

function matches(text, filter) {
  return !filter || text.toLowerCase().includes(filter.toLowerCase());
}

/** Resolve "0x1234" | "module!symbol" | "symbol" to a NativePointer. */
function resolveTarget(spec) {
  const trimmed = String(spec).trim();
  if (/^(0x)?[0-9a-f]+$/i.test(trimmed) && /[0-9]/.test(trimmed)) {
    const p = ptr(trimmed.startsWith('0x') ? trimmed : '0x' + trimmed);
    if (!p.isNull()) return p;
  }
  if (trimmed.includes('!')) {
    const idx = trimmed.indexOf('!');
    const moduleName = trimmed.slice(0, idx);
    const symbol = trimmed.slice(idx + 1);
    const mod = Process.findModuleByName(moduleName);
    if (mod === null) throw new Error(`module not found: ${moduleName}`);
    const direct = mod.findExportByName(symbol);
    if (direct !== null) return direct;
    const found = mod.enumerateSymbols().find(s => s.name === symbol);
    if (found) return found.address;
    throw new Error(`symbol not found in ${moduleName}: ${symbol}`);
  }
  const global = Module.findGlobalExportByName(trimmed);
  if (global !== null) return global;
  try {
    const sym = DebugSymbol.fromName(trimmed);
    if (sym && !sym.address.isNull()) return sym.address;
  } catch (_e) {
    // fall through to the uniform error below
  }
  throw new Error(`could not resolve: ${spec}`);
}

function symbolFor(address) {
  try {
    const sym = DebugSymbol.fromAddress(address);
    return sym && sym.name ? sym.name : undefined;
  } catch (_e) {
    return undefined;
  }
}

rpc.exports = {
  modules(filter, limit) {
    const out = [];
    for (const m of Process.enumerateModules()) {
      if (!matches(m.name, filter) && !matches(m.path || '', filter)) continue;
      out.push(describeModule(m));
      if (limit && out.length >= limit) break;
    }
    return out;
  },

  exports(moduleName, filter, limit) {
    const mod = Process.findModuleByName(moduleName);
    if (mod === null) throw new Error(`module not found: ${moduleName}`);
    const out = [];
    for (const e of mod.enumerateExports()) {
      if (!matches(e.name, filter)) continue;
      out.push({ type: e.type, name: e.name, address: e.address.toString() });
      if (limit && out.length >= limit) break;
    }
    return out;
  },

  symbols(moduleName, filter, limit) {
    const mod = Process.findModuleByName(moduleName);
    if (mod === null) throw new Error(`module not found: ${moduleName}`);
    const out = [];
    for (const s of mod.enumerateSymbols()) {
      if (!matches(s.name, filter)) continue;
      out.push({ type: s.type, name: s.name, address: s.address.toString() });
      if (limit && out.length >= limit) break;
    }
    return out;
  },

  ranges(protection, limit) {
    const out = [];
    for (const r of Process.enumerateRanges(protection || 'r--')) {
      const entry = { base: r.base.toString(), size: r.size, protection: r.protection };
      if (r.file && r.file.path) entry.path = r.file.path;
      out.push(entry);
      if (limit && out.length >= limit) break;
    }
    return out;
  },

  threads() {
    return Process.enumerateThreads().map(t => ({ id: t.id, state: t.state }));
  },

  resolve(spec) {
    const address = resolveTarget(spec);
    return { spec: String(spec), address: address.toString(), symbol: symbolFor(address) };
  },

  read(spec, size) {
    const address = resolveTarget(spec);
    const buffer = address.readByteArray(size);
    if (buffer === null) throw new Error(`unreadable memory at ${address}`);
    return { address: address.toString(), size, hex: hex(buffer) };
  },

  write(spec, hexPayload) {
    const address = resolveTarget(spec);
    const bytes = unhex(hexPayload);
    address.writeByteArray(bytes);
    return { address: address.toString(), size: bytes.length };
  },

  scan(spec, size, pattern, limit) {
    const address = resolveTarget(spec);
    const matchesFound = Memory.scanSync(address, size, pattern);
    const capped = limit ? matchesFound.slice(0, limit) : matchesFound;
    return capped.map(m => ({ address: m.address.toString(), size: m.size }));
  },

  hook(spec, options) {
    const opts = options || {};
    const address = resolveTarget(spec);
    const id = String(nextHookId++);
    const nargs = Math.max(0, Math.min(opts.nargs || 0, 8));
    const stringArgs = Array.isArray(opts.strings) ? opts.strings : [];
    const wantBacktrace = opts.backtrace === true;
    const wantRetval = opts.retval !== false;
    const label = String(spec);

    const listener = Interceptor.attach(address, {
      onEnter(args) {
        const record = { hook: id, spec: label, phase: 'enter', thread: this.threadId };
        if (nargs > 0) {
          record.args = [];
          for (let i = 0; i < nargs; i++) {
            const value = args[i];
            const entry = { index: i, value: value.toString() };
            if (stringArgs.includes(i)) {
              try {
                entry.utf8 = value.readUtf8String();
              } catch (_e) {
                try {
                  entry.utf16 = value.readUtf16String();
                } catch (_e2) {
                  // not a readable string; the raw pointer is already recorded
                }
              }
            }
            record.args.push(entry);
          }
        }
        if (wantBacktrace) {
          record.backtrace = Thread.backtrace(this.context, Backtracer.ACCURATE)
            .map(a => {
              const s = DebugSymbol.fromAddress(a);
              return s && s.name ? `${a} ${s.name}` : a.toString();
            })
            .slice(0, 16);
        }
        send({ __oms_hook: true, ...record });
      },
      onLeave(retval) {
        if (!wantRetval) return;
        send({ __oms_hook: true, hook: id, spec: label, phase: 'leave', retval: retval.toString() });
      },
    });

    hooks.set(id, { listener, spec: label, address: address.toString() });
    return { id, spec: label, address: address.toString(), symbol: symbolFor(address) };
  },

  unhook(id) {
    const entry = hooks.get(String(id));
    if (!entry) throw new Error(`unknown hook: ${id}`);
    entry.listener.detach();
    hooks.delete(String(id));
    return { id: String(id) };
  },

  hooks() {
    return Array.from(hooks.entries()).map(([id, e]) => ({ id, spec: e.spec, address: e.address }));
  },

  evaluate(source) {
    // Indirect eval keeps the agent's own lexical scope out of reach while
    // still exposing every Frida global.
    const result = (0, eval)(source);
    if (result === undefined) return null;
    if (result === null || typeof result !== 'object') return result;
    try {
      JSON.stringify(result);
      return result;
    } catch (_e) {
      return String(result);
    }
  },
};
"""


class WorkerError(Exception):
    """Operational failure reported to the host without a traceback."""


class ScriptRecord:
    def __init__(self, script_id: str, name: str, script: Any) -> None:
        self.id = script_id
        self.name = name
        self.script = script


class SessionRecord:
    def __init__(self, sid: str, session: Any, device_id: str, pid: int, name: str | None) -> None:
        self.id = sid
        self.session = session
        self.device_id = device_id
        self.pid = pid
        self.name = name
        self.scripts: dict[str, ScriptRecord] = {}
        self.agent: Any = None
        self.detached: str | None = None
        self.pending_resume = False


class Worker:
    def __init__(self) -> None:
        self._stdout_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._sessions: dict[str, SessionRecord] = {}
        self._script_owner: dict[str, str] = {}
        self._messages: deque[dict[str, Any]] = deque(maxlen=MAX_BUFFERED_MESSAGES)
        self._dropped = 0
        self._seq = 0
        self._counter = 0
        self._devices_by_id: dict[str, Any] = {}
        self._output_hooked: set[str] = set()

    # ---------- plumbing ----------

    def _next_id(self, prefix: str) -> str:
        with self._state_lock:
            self._counter += 1
            return f"{prefix}-{self._counter}"

    def _emit(self, frame: dict[str, Any]) -> None:
        line = json.dumps(frame, default=str)
        with self._stdout_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def _buffer(self, kind: str, session_id: str, payload: Any, script_id: str | None = None,
                data: bytes | None = None) -> None:
        with self._state_lock:
            if len(self._messages) == MAX_BUFFERED_MESSAGES:
                self._dropped += 1
            self._seq += 1
            record = {
                "seq": self._seq,
                "kind": kind,
                "session": session_id,
                "payload": payload,
                "timestamp": int(time.time() * 1000),
            }
            if script_id:
                record["script"] = script_id
            if data:
                record["data"] = base64.b64encode(data).decode("ascii")
            self._messages.append(record)
        self._emit({"event": "message", "record": record})

    # ---------- devices ----------

    def _device(self, device_id: str | None) -> Any:
        key = device_id or "local"
        with self._state_lock:
            cached = self._devices_by_id.get(key)
        if cached is not None:
            return cached
        try:
            if key == "local":
                device = frida.get_local_device()
            elif key == "usb":
                device = frida.get_usb_device(timeout=5)
            elif key == "remote":
                device = frida.get_remote_device()
            else:
                device = frida.get_device(key, timeout=5)
        except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the model
            raise WorkerError(f"could not open frida device '{key}': {exc}") from exc
        with self._state_lock:
            self._devices_by_id[key] = device
        return device

    def _hook_output(self, device: Any, device_key: str) -> None:
        if device_key in self._output_hooked:
            return
        self._output_hooked.add(device_key)

        def on_output(pid: int, fd: int, data: bytes) -> None:
            text = data.decode("utf-8", errors="replace")
            target = None
            with self._state_lock:
                for rec in self._sessions.values():
                    if rec.pid == pid:
                        target = rec.id
                        break
            self._buffer("output", target or f"pid-{pid}", {"pid": pid, "fd": fd, "text": text})

        device.on("output", on_output)

    # ---------- sessions ----------

    def _require_session(self, session_id: str | None) -> SessionRecord:
        if not session_id:
            raise WorkerError("session is required")
        with self._state_lock:
            record = self._sessions.get(session_id)
        if record is None:
            raise WorkerError(f"unknown session: {session_id}")
        if record.detached:
            raise WorkerError(f"session {session_id} is detached ({record.detached})")
        return record

    def _register_session(self, session: Any, device_id: str, pid: int, name: str | None) -> SessionRecord:
        sid = self._next_id("session")
        record = SessionRecord(sid, session, device_id, pid, name)

        def on_detached(reason: str, crash: Any = None) -> None:
            with self._state_lock:
                record.detached = str(reason)
                record.pending_resume = False
                for script_id in list(record.scripts):
                    self._script_owner.pop(script_id, None)
                record.scripts.clear()
                record.agent = None
            detail: dict[str, Any] = {"reason": str(reason)}
            if crash is not None:
                detail["crash"] = str(crash)
            self._buffer("detached", sid, detail)

        session.on("detached", on_detached)
        with self._state_lock:
            self._sessions[sid] = record
        return record

    def _agent(self, record: SessionRecord) -> Any:
        """Lazily inject the resident instrumentation agent."""
        if record.agent is not None:
            return record.agent
        script = record.session.create_script(AGENT_SOURCE, name="oms-agent")
        script.on("message", self._script_listener(record.id, "agent"))
        script.load()
        record.agent = script
        return script

    def _script_listener(self, session_id: str, script_id: str):
        def listener(message: dict[str, Any], data: bytes | None) -> None:
            kind = "send"
            payload: Any = message
            if message.get("type") == "send":
                payload = message.get("payload")
                if isinstance(payload, dict) and payload.get("__oms_hook"):
                    kind = "hook"
                    payload = {k: v for k, v in payload.items() if k != "__oms_hook"}
            elif message.get("type") == "error":
                kind = "error"
            self._buffer(kind, session_id, payload, script_id=script_id, data=data)

        return listener

    def _session_info(self, record: SessionRecord) -> dict[str, Any]:
        return {
            "id": record.id,
            "pid": record.pid,
            "name": record.name,
            "device": record.device_id,
            "scripts": list(record.scripts.keys()),
            "detached": record.detached,
            "pendingResume": record.pending_resume,
        }

    # ---------- operations ----------

    def op_ping(self, _req: dict[str, Any]) -> dict[str, Any]:
        return {
            "protocol": PROTOCOL_VERSION,
            "fridaVersion": frida.__version__,
            "python": sys.version.split()[0],
            "executable": sys.executable,
        }

    def op_devices(self, _req: dict[str, Any]) -> Any:
        return [
            {"id": d.id, "name": d.name, "type": str(d.type)}
            for d in frida.enumerate_devices()
        ]

    def op_processes(self, req: dict[str, Any]) -> Any:
        device = self._device(req.get("device"))
        needle = (req.get("filter") or "").lower()
        out = []
        for p in device.enumerate_processes():
            if needle and needle not in p.name.lower() and needle != str(p.pid):
                continue
            out.append({"pid": p.pid, "name": p.name})
        return out

    def op_applications(self, req: dict[str, Any]) -> Any:
        device = self._device(req.get("device"))
        out = []
        for app in device.enumerate_applications():
            entry = {"identifier": app.identifier, "name": app.name}
            if getattr(app, "pid", 0):
                entry["pid"] = app.pid
            out.append(entry)
        return out

    def op_attach(self, req: dict[str, Any]) -> Any:
        device_key = req.get("device") or "local"
        device = self._device(device_key)
        target: Any = req.get("pid") if req.get("pid") is not None else req.get("name")
        if target is None:
            raise WorkerError("attach requires pid or name")
        try:
            session = device.attach(target)
        except Exception as exc:  # noqa: BLE001
            raise WorkerError(f"attach failed for {target!r}: {exc}") from exc
        pid = session.pid if hasattr(session, "pid") else (target if isinstance(target, int) else 0)
        name = req.get("name") if isinstance(target, str) else None
        record = self._register_session(session, device_key, pid, name)
        return self._session_info(record)

    def op_spawn(self, req: dict[str, Any]) -> Any:
        device_key = req.get("device") or "local"
        device = self._device(device_key)
        program = req.get("program")
        if not program:
            raise WorkerError("spawn requires program")
        argv = req.get("args") or []
        spawn_target: Any = [program, *argv] if argv else program
        kwargs: dict[str, Any] = {}
        if req.get("cwd"):
            kwargs["cwd"] = req["cwd"]
        if req.get("env"):
            kwargs["env"] = req["env"]
        self._hook_output(device, device_key)
        try:
            pid = device.spawn(spawn_target, stdio="pipe", **kwargs)
        except Exception as exc:  # noqa: BLE001
            raise WorkerError(f"spawn failed for {program!r}: {exc}") from exc
        session = device.attach(pid)
        record = self._register_session(session, device_key, pid, str(program))
        record.pending_resume = True
        return self._session_info(record)

    def op_resume(self, req: dict[str, Any]) -> Any:
        record = self._require_session(req.get("session"))
        self._device(record.device_id).resume(record.pid)
        record.pending_resume = False
        return self._session_info(record)

    def op_kill(self, req: dict[str, Any]) -> Any:
        record = self._require_session(req.get("session"))
        self._device(record.device_id).kill(record.pid)
        return {"killed": record.pid}

    def op_detach(self, req: dict[str, Any]) -> Any:
        record = self._require_session(req.get("session"))
        for script_record in list(record.scripts.values()):
            try:
                script_record.script.unload()
            except Exception:  # noqa: BLE001 - teardown is best-effort
                pass
        if record.agent is not None:
            try:
                record.agent.unload()
            except Exception:  # noqa: BLE001
                pass
        record.session.detach()
        with self._state_lock:
            record.detached = "detached by request"
            record.pending_resume = False
            for script_id in list(record.scripts):
                self._script_owner.pop(script_id, None)
            record.scripts.clear()
            record.agent = None
        return {"detached": record.id}

    def op_sessions(self, _req: dict[str, Any]) -> Any:
        with self._state_lock:
            records = list(self._sessions.values())
            sessions = [self._session_info(record) for record in records]
            scripts = [
                {"id": script.id, "session": record.id, "name": script.name}
                for record in records
                for script in record.scripts.values()
            ]
            pending = len(self._messages)
        hooks = []
        for record in records:
            if record.agent is None or record.detached:
                continue
            try:
                for hook in record.agent.exports_sync.hooks():
                    hook["session"] = record.id
                    hooks.append(hook)
            except Exception:  # noqa: BLE001 - snapshot remains useful if one target races detach
                pass
        return {
            "fridaVersion": frida.__version__,
            "python": sys.executable,
            "sessions": sessions,
            "scripts": scripts,
            "hooks": hooks,
            "pendingMessages": pending,
        }

    def op_load(self, req: dict[str, Any]) -> Any:
        record = self._require_session(req.get("session"))
        source = req.get("source")
        if not source:
            raise WorkerError("load requires source")
        script_id = self._next_id("script")
        name = req.get("name") or script_id
        script = record.session.create_script(source, name=name)
        script.on("message", self._script_listener(record.id, script_id))
        script.load()
        with self._state_lock:
            record.scripts[script_id] = ScriptRecord(script_id, str(name), script)
            self._script_owner[script_id] = record.id
        return {"id": script_id, "session": record.id, "name": name}

    def op_unload(self, req: dict[str, Any]) -> Any:
        script_id = req.get("script")
        with self._state_lock:
            owner = self._script_owner.get(script_id or "")
            record = self._sessions.get(owner or "")
            script_record = record.scripts.get(script_id) if record else None
        if script_record is None or record is None:
            raise WorkerError(f"unknown script: {script_id}")
        script_record.script.unload()
        with self._state_lock:
            record.scripts.pop(script_id, None)
            self._script_owner.pop(script_id, None)
        return {"unloaded": script_id}

    def op_call(self, req: dict[str, Any]) -> Any:
        script_id = req.get("script")
        method = req.get("method")
        if not method:
            raise WorkerError("call requires method")
        with self._state_lock:
            owner = self._script_owner.get(script_id or "")
            record = self._sessions.get(owner or "")
            script_record = record.scripts.get(script_id) if record else None
        if script_record is None:
            raise WorkerError(f"unknown script: {script_id}")
        args = req.get("args") or []
        try:
            fn = getattr(script_record.script.exports_sync, method)
        except AttributeError as exc:
            raise WorkerError(f"script {script_id} exports no rpc method '{method}'") from exc
        return fn(*args)

    def _agent_call(self, req: dict[str, Any], method: str, *args: Any) -> Any:
        record = self._require_session(req.get("session"))
        agent = self._agent(record)
        try:
            return getattr(agent.exports_sync, method)(*args)
        except frida.core.RPCException as exc:
            raise WorkerError(str(exc)) from exc

    def op_modules(self, req: dict[str, Any]) -> Any:
        return self._agent_call(req, "modules", req.get("filter"), req.get("limit") or 0)

    def op_exports(self, req: dict[str, Any]) -> Any:
        module = req.get("module")
        if not module:
            raise WorkerError("exports requires module")
        return self._agent_call(req, "exports", module, req.get("filter"), req.get("limit") or 0)

    def op_symbols(self, req: dict[str, Any]) -> Any:
        module = req.get("module")
        if not module:
            raise WorkerError("symbols requires module")
        return self._agent_call(req, "symbols", module, req.get("filter"), req.get("limit") or 0)

    def op_ranges(self, req: dict[str, Any]) -> Any:
        return self._agent_call(req, "ranges", req.get("protection"), req.get("limit") or 0)

    def op_threads(self, req: dict[str, Any]) -> Any:
        return self._agent_call(req, "threads")

    def op_resolve(self, req: dict[str, Any]) -> Any:
        spec = req.get("target")
        if not spec:
            raise WorkerError("resolve requires target")
        return self._agent_call(req, "resolve", spec)

    def op_read(self, req: dict[str, Any]) -> Any:
        spec = req.get("target")
        size = int(req.get("size") or 0)
        if not spec:
            raise WorkerError("read requires target")
        if size <= 0:
            raise WorkerError("read requires a positive size")
        if size > MAX_READ_BYTES:
            raise WorkerError(f"read size {size} exceeds the {MAX_READ_BYTES} byte cap")
        return self._agent_call(req, "read", spec, size)

    def op_write(self, req: dict[str, Any]) -> Any:
        spec = req.get("target")
        data = req.get("data")
        if not spec:
            raise WorkerError("write requires target")
        if not data:
            raise WorkerError("write requires data (hex)")
        return self._agent_call(req, "write", spec, data)

    def op_scan(self, req: dict[str, Any]) -> Any:
        spec = req.get("target")
        pattern = req.get("pattern")
        size = int(req.get("size") or 0)
        if not spec or not pattern:
            raise WorkerError("scan requires target and pattern")
        if size <= 0:
            raise WorkerError("scan requires a positive size")
        return self._agent_call(req, "scan", spec, size, pattern, req.get("limit") or 0)

    def op_hook(self, req: dict[str, Any]) -> Any:
        spec = req.get("target")
        if not spec:
            raise WorkerError("hook requires target")
        options = {
            "nargs": req.get("nargs") or 0,
            "strings": req.get("strings") or [],
            "backtrace": bool(req.get("backtrace")),
            "retval": req.get("retval") is not False,
        }
        result = self._agent_call(req, "hook", spec, options)
        result["session"] = req.get("session")
        return result

    def op_unhook(self, req: dict[str, Any]) -> Any:
        hook_id = req.get("hook")
        if not hook_id:
            raise WorkerError("unhook requires hook")
        return self._agent_call(req, "unhook", str(hook_id))

    def op_hooks(self, req: dict[str, Any]) -> Any:
        hooks = self._agent_call(req, "hooks")
        for hook in hooks:
            hook["session"] = req.get("session")
        return hooks

    def op_eval(self, req: dict[str, Any]) -> Any:
        source = req.get("source")
        if not source:
            raise WorkerError("eval requires source")
        return self._agent_call(req, "evaluate", source)

    def op_messages(self, req: dict[str, Any]) -> Any:
        limit = max(1, min(int(req.get("limit") or 200), MAX_BUFFERED_MESSAGES))
        session_filter = req.get("session")
        since = int(req.get("since") or 0)
        with self._state_lock:
            selected = [
                message
                for message in self._messages
                if message["seq"] > since and (not session_filter or message["session"] == session_filter)
            ]
            trimmed = selected[:limit]
            dropped = self._dropped
            if req.get("clear"):
                returned_sequences = {message["seq"] for message in trimmed}
                keep = [message for message in self._messages if message["seq"] not in returned_sequences]
                self._messages.clear()
                self._messages.extend(keep)
                self._dropped = 0
        return {
            "messages": trimmed,
            "returned": len(trimmed),
            "matched": len(selected),
            "dropped": dropped,
            "cursor": trimmed[-1]["seq"] if trimmed else since,
        }

    def op_shutdown(self, _req: dict[str, Any]) -> Any:
        with self._state_lock:
            records = list(self._sessions.values())
        for record in records:
            try:
                record.session.detach()
            except Exception:  # noqa: BLE001
                pass
        return {"shutdown": True}

    # ---------- dispatch ----------

    def dispatch(self, request: dict[str, Any]) -> Any:
        op = request.get("op")
        handler = getattr(self, f"op_{op}", None) if isinstance(op, str) else None
        if handler is None:
            raise WorkerError(f"unknown op: {op}")
        return handler(request)

    def serve(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                self._emit({"id": None, "ok": False, "error": f"malformed request: {exc}"})
                continue
            request_id = request.get("id")
            try:
                result = self.dispatch(request)
                self._emit({"id": request_id, "ok": True, "result": result})
            except WorkerError as exc:
                self._emit({"id": request_id, "ok": False, "error": str(exc)})
            except Exception as exc:  # noqa: BLE001 - report and keep serving
                self._emit(
                    {
                        "id": request_id,
                        "ok": False,
                        "error": f"{type(exc).__name__}: {exc}",
                        "traceback": traceback.format_exc(limit=8),
                    }
                )
            if request.get("op") == "shutdown":
                return


def main() -> None:
    worker = Worker()
    worker._emit({"event": "ready", "protocol": PROTOCOL_VERSION, "fridaVersion": frida.__version__})
    worker.serve()


if __name__ == "__main__":
    main()
