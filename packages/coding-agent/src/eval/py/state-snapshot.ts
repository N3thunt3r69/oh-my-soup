// Serialize the Python kernel's user namespace so it can be revived when a
// session resumes. The kernel is otherwise spawned fresh on resume, leaving the
// model believing it still has access to variables/imports it defined earlier.
//
// Snapshotting is best-effort and per-variable: each top-level name is pickled
// with `dill` independently, so a single unpicklable object (open file, socket,
// GPU tensor, …) is skipped and reported rather than aborting the whole snapshot.
// When `dill` is not installed in the target interpreter, both paths degrade to
// a marker-line error the host logs at debug level — shutdown/boot never break.
import { join } from "node:path";

/** Default ceiling on a snapshot payload. Over-cap variables are skipped + reported. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

/** Directory under the session's artifacts dir that holds the kernel snapshot. */
export const SNAPSHOT_DIR_NAME = "py-kernel-snapshot";

/** Base filename for the kernel snapshot within the snapshot directory. */
const KERNEL_STATE_BASENAME = "kernel-state";

/** Marker the Python helpers print so the host can recover the JSON result line. */
const RESULT_MARKER = "__OMP_PY_KERNEL_STATE__";

/**
 * Names re-created by the runner bootstrap (`runner.py`'s `_install_builtins`)
 * and the OMS prelude on every kernel start. Snapshotting them would pickle
 * stale bridge closures that must never shadow the fresh ones after restore.
 * The restore path additionally refuses to overwrite any name that already
 * exists in the fresh namespace, so drift in this list stays harmless.
 */
export const KERNEL_BASELINE_SKIP_NAMES: readonly string[] = [
	// runner.py bootstrap
	"display",
	// prelude.py helpers
	"env",
	"read",
	"write",
	"output",
	"tool",
	"completion",
	"agent",
	"parallel",
	"pipeline",
	"log",
	"phase",
	"budget",
	"INTENT_FIELD",
	// prelude.py module imports (re-imported on every start)
	"Path",
	"unquote",
	"os",
	"json",
	"math",
	"re",
	"urllib",
	// IPython-compat / interpreter-injected names
	"In",
	"Out",
	"get_ipython",
	"exit",
	"quit",
	"open",
	"asyncio",
];

export interface SnapshotResult {
	/** Top-level names successfully serialized into the payload. */
	saved: string[];
	/** Names that could not be serialized, with a short reason. */
	skipped: { name: string; reason: string }[];
	/** Payload size on disk, in bytes. */
	bytes: number;
	path: string;
}

export interface RestoreResult {
	/** Names successfully revived into the kernel namespace. */
	restored: string[];
	/** Names present in the snapshot that failed to revive, with a short reason. */
	failed: { name: string; reason: string }[];
	path: string;
}

/** Absolute path to the dill payload within a snapshot directory. */
export function snapshotPathIn(snapshotDir: string): string {
	return join(snapshotDir, `${KERNEL_STATE_BASENAME}.dill`);
}

/** Absolute path to the JSON manifest within a snapshot directory. */
export function manifestPathIn(snapshotDir: string): string {
	return join(snapshotDir, `${KERNEL_STATE_BASENAME}.json`);
}

/** Render a JS string as a Python string literal (JSON's escaping is a valid subset). */
function pyStr(value: string): string {
	return JSON.stringify(value);
}

/**
 * Python that serializes the user namespace to `outPath` (atomic temp-rename
 * write) and a sibling `.json` manifest, then prints a single marker line with
 * the result. Never raises: every failure mode reports through the marker.
 */
export function buildSnapshotCode(
	outPath: string,
	manifestPath: string,
	maxBytes: number = DEFAULT_SNAPSHOT_MAX_BYTES,
): string {
	// All builtins are sourced via the locally-imported _b alias so the helper keeps
	// working even when the user namespace shadows names like list/open/print/len.
	return `
def _oms_snapshot_kernel_state():
    import builtins as _b, json, os, sys, datetime
    try:
        import dill
    except _b.Exception as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"error": "dill unavailable: " + _b.str(_err)}))
        return
    dill.settings["recurse"] = True

    ip = None
    try:
        ip = get_ipython()  # noqa: F821 (present only under IPython)
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()
    hidden = _b.set(_b.getattr(ip, "user_ns_hidden", {}) or {}) if ip is not None else _b.set()
    # Prelude/runner bootstrap names are re-created on every kernel start;
    # never snapshot them.
    always_skip = {${KERNEL_BASELINE_SKIP_NAMES.map(pyStr).join(", ")}}

    payload = {}
    skipped = []
    total = 0
    for name in _b.list(ns.keys()):
        # Skip internals (dunder/underscore), hidden names, and bootstrap
        # helpers. Modules are pickled by reference and re-imported on restore.
        if name.startswith("_") or name in hidden or name in always_skip:
            continue
        value = ns[name]
        try:
            blob = dill.dumps(value)
        except _b.BaseException as _err:
            skipped.append({"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]})
            continue
        if _b.len(blob) > ${maxBytes} or total + _b.len(blob) > ${maxBytes}:
            skipped.append({"name": name, "reason": "exceeds snapshot size cap"})
            continue
        payload[name] = blob
        total += _b.len(blob)

    os.makedirs(os.path.dirname(${pyStr(outPath)}), exist_ok=True)
    tmp = ${pyStr(outPath)} + ".tmp"
    try:
        with _b.open(tmp, "wb") as fh:
            dill.dump(payload, fh)
        os.replace(tmp, ${pyStr(outPath)})
    except _b.Exception as _err:
        try:
            os.remove(tmp)
        except _b.Exception:
            pass
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"error": "write failed: " + _b.str(_err)}))
        return

    bytes_written = os.path.getsize(${pyStr(outPath)})
    saved = _b.sorted(payload.keys())
    manifest = {
        "version": 1,
        "savedNames": saved,
        "skipped": skipped,
        "bytes": bytes_written,
        "pythonVersion": sys.version.split()[0],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    try:
        with _b.open(${pyStr(manifestPath)}, "w") as fh:
            json.dump(manifest, fh)
    except _b.Exception:
        pass
    _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"saved": saved, "skipped": skipped, "bytes": bytes_written}))


try:
    _oms_snapshot_kernel_state()
finally:
    del _oms_snapshot_kernel_state
`.trim();
}

/**
 * Python that loads the payload at `inPath` (if present) into the user
 * namespace, reviving each name independently, then prints a single marker
 * line with the result. Tolerant of a missing or corrupt file: reports an
 * empty restore, never raises. Refuses to overwrite names the fresh kernel
 * bootstrap already defined (prelude helpers, bridge proxies).
 */
export function buildRestoreCode(inPath: string): string {
	// Builtins via the local _b alias so a shadowed name in the user namespace
	// (list/open/print/…) can't break the restore path.
	return `
def _oms_restore_kernel_state():
    import builtins as _b, json, os
    if not os.path.exists(${pyStr(inPath)}):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": []}))
        return
    try:
        import dill
    except _b.Exception as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "dill unavailable: " + _b.str(_err)}))
        return

    try:
        with _b.open(${pyStr(inPath)}, "rb") as fh:
            payload = dill.load(fh)
    except _b.BaseException as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "load failed: " + _b.str(_err)}))
        return
    if not _b.isinstance(payload, _b.dict):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "corrupt snapshot: not a dict"}))
        return

    ip = None
    try:
        ip = get_ipython()  # noqa: F821
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()

    restored = []
    failed = []
    for name, blob in payload.items():
        if name in ns:
            failed.append({"name": name, "reason": "already defined by kernel bootstrap"})
            continue
        try:
            ns[name] = dill.loads(blob)
            restored.append(name)
        except _b.BaseException as _err:
            failed.append({"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]})
    _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": _b.sorted(restored), "failed": failed}))


try:
    _oms_restore_kernel_state()
finally:
    del _oms_restore_kernel_state
`.trim();
}

interface RawSnapshot {
	saved?: unknown;
	skipped?: unknown;
	bytes?: unknown;
	error?: unknown;
}

interface RawRestore {
	restored?: unknown;
	failed?: unknown;
	error?: unknown;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asReasonArray(value: unknown): { name: string; reason: string }[] {
	if (!Array.isArray(value)) return [];
	const entries: { name: string; reason: string }[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") continue;
		const reason = "reason" in entry && typeof entry.reason === "string" ? entry.reason : "";
		entries.push({ name: entry.name, reason });
	}
	return entries;
}

/** Pull the marker line out of cell stdout and parse it, or null if absent/invalid. */
function parseMarkerLine<T>(stdout: string): T | null {
	const index = stdout.lastIndexOf(RESULT_MARKER);
	if (index === -1) return null;
	const rest = stdout.slice(index + RESULT_MARKER.length);
	const line = rest.split("\n", 1)[0]?.trim();
	if (!line) return null;
	try {
		return JSON.parse(line) as T;
	} catch {
		return null;
	}
}

/** Error string reported through the marker line, or null when none. */
export function parseMarkerError(stdout: string): string | null {
	const raw = parseMarkerLine<{ error?: unknown }>(stdout);
	return raw && typeof raw.error === "string" ? raw.error : null;
}

export function parseSnapshotResult(stdout: string, path: string): SnapshotResult | null {
	const raw = parseMarkerLine<RawSnapshot>(stdout);
	if (!raw || raw.error) return null;
	return {
		saved: asStringArray(raw.saved),
		skipped: asReasonArray(raw.skipped),
		bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
		path,
	};
}

export function parseRestoreResult(stdout: string, path: string): RestoreResult | null {
	const raw = parseMarkerLine<RawRestore>(stdout);
	if (!raw || raw.error) return null;
	return {
		restored: asStringArray(raw.restored),
		failed: asReasonArray(raw.failed),
		path,
	};
}

/** One-line notice surfaced through the first cell after a successful restore. */
export function formatRestoreNotice(result: RestoreResult): string {
	const restored = result.restored.length;
	const skipped = result.failed.length;
	const skippedSuffix = skipped > 0 ? `, ${skipped} skipped` : "";
	return `[kernel] restored ${restored} variable${restored === 1 ? "" : "s"} from the previous session's snapshot${skippedSuffix}\n`;
}
