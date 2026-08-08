import { describe, expect, it } from "bun:test";
import {
	buildRestoreCode,
	buildSnapshotCode,
	DEFAULT_SNAPSHOT_MAX_BYTES,
	formatRestoreNotice,
	KERNEL_BASELINE_SKIP_NAMES,
	manifestPathIn,
	parseMarkerError,
	parseRestoreResult,
	parseSnapshotResult,
	snapshotPathIn,
} from "@oh-my-pi/pi-coding-agent/eval/py/state-snapshot";

const MARKER = "__OMP_PY_KERNEL_STATE__";
const OUT = "C:\\tmp\\artifacts\\py-kernel-snapshot\\kernel-state.dill";
const MANIFEST = "C:\\tmp\\artifacts\\py-kernel-snapshot\\kernel-state.json";

describe("buildSnapshotCode", () => {
	const code = buildSnapshotCode(OUT, MANIFEST, DEFAULT_SNAPSHOT_MAX_BYTES);

	it("embeds the size cap and skips over-cap variables", () => {
		expect(code).toContain(`> ${DEFAULT_SNAPSHOT_MAX_BYTES} or total + _b.len(blob) > ${DEFAULT_SNAPSHOT_MAX_BYTES}`);
		expect(code).toContain('"exceeds snapshot size cap"');
	});

	it("skips and reports unpicklable variables instead of aborting", () => {
		expect(code).toContain("except _b.BaseException as _err:");
		expect(code).toContain('skipped.append({"name": name, "reason": _b.type(_err).__name__');
	});

	it("skips underscore, hidden, and bootstrap baseline names", () => {
		expect(code).toContain('if name.startswith("_") or name in hidden or name in always_skip:');
		for (const name of KERNEL_BASELINE_SKIP_NAMES) {
			expect(code).toContain(JSON.stringify(name));
		}
	});

	it("writes atomically via temp file + os.replace and cleans up on failure", () => {
		const escapedOut = JSON.stringify(OUT);
		expect(code).toContain(`tmp = ${escapedOut} + ".tmp"`);
		expect(code).toContain(`os.replace(tmp, ${escapedOut})`);
		expect(code).toContain("os.remove(tmp)");
	});

	it("writes a JSON manifest with names, sizes, and versions", () => {
		expect(code).toContain(JSON.stringify(MANIFEST));
		expect(code).toContain('"savedNames": saved');
		expect(code).toContain('"pythonVersion": sys.version.split()[0]');
		expect(code).toContain('"version": 1');
	});

	it("degrades to a marker error when dill is unavailable", () => {
		expect(code).toContain('"error": "dill unavailable: "');
		expect(code).toContain(MARKER);
	});

	it("escapes Windows path separators as valid Python string literals", () => {
		expect(code).toContain('"C:\\\\tmp\\\\artifacts\\\\py-kernel-snapshot\\\\kernel-state.dill"');
		expect(code).not.toContain("C:\\tmp\\artifacts");
	});

	it("cleans up its helper from the namespace", () => {
		expect(code).toContain("del _omp_snapshot_kernel_state");
	});
});

describe("buildRestoreCode", () => {
	const code = buildRestoreCode(OUT);

	it("reports an empty restore when the snapshot file is missing", () => {
		expect(code).toContain(`if not os.path.exists(${JSON.stringify(OUT)}):`);
		expect(code).toContain('{"restored": [], "failed": []}');
	});

	it("tolerates missing dill and corrupt payloads without raising", () => {
		expect(code).toContain('"error": "dill unavailable: "');
		expect(code).toContain('"error": "load failed: "');
		expect(code).toContain('"error": "corrupt snapshot: not a dict"');
	});

	it("revives each name independently and reports failures", () => {
		expect(code).toContain("ns[name] = dill.loads(blob)");
		expect(code).toContain('failed.append({"name": name, "reason": _b.type(_err).__name__');
	});

	it("never overwrites names the fresh kernel bootstrap defined", () => {
		expect(code).toContain("if name in ns:");
		expect(code).toContain('"already defined by kernel bootstrap"');
	});

	it("cleans up its helper from the namespace", () => {
		expect(code).toContain("del _omp_restore_kernel_state");
	});
});

describe("marker-line parsing", () => {
	it("parses a snapshot result from surrounding stdout noise", () => {
		const stdout = `user output\n${MARKER}{"saved":["x","y"],"skipped":[{"name":"sock","reason":"TypeError: cannot pickle"}],"bytes":123}\n`;
		const result = parseSnapshotResult(stdout, OUT);
		expect(result).toEqual({
			saved: ["x", "y"],
			skipped: [{ name: "sock", reason: "TypeError: cannot pickle" }],
			bytes: 123,
			path: OUT,
		});
	});

	it("parses a restore result and drops malformed entries", () => {
		const stdout = `${MARKER}{"restored":["x"],"failed":[{"name":"y","reason":"boom"},{"bogus":true},42]}`;
		const result = parseRestoreResult(stdout, OUT);
		expect(result).toEqual({
			restored: ["x"],
			failed: [{ name: "y", reason: "boom" }],
			path: OUT,
		});
	});

	it("returns null for absent marker, garbage JSON, and reported errors", () => {
		expect(parseSnapshotResult("no marker here", OUT)).toBeNull();
		expect(parseSnapshotResult(`${MARKER}not-json`, OUT)).toBeNull();
		expect(parseSnapshotResult(`${MARKER}{"error":"dill unavailable: nope"}`, OUT)).toBeNull();
		expect(parseRestoreResult(`${MARKER}{"error":"load failed: eof"}`, OUT)).toBeNull();
	});

	it("exposes the reported error for debug logging", () => {
		expect(parseMarkerError(`${MARKER}{"error":"dill unavailable: nope"}`)).toBe("dill unavailable: nope");
		expect(parseMarkerError(`${MARKER}{"restored":[]}`)).toBeNull();
		expect(parseMarkerError("nothing")).toBeNull();
	});

	it("uses the last marker line when several are present", () => {
		const stdout = `${MARKER}{"saved":["old"],"skipped":[],"bytes":1}\n${MARKER}{"saved":["new"],"skipped":[],"bytes":2}\n`;
		expect(parseSnapshotResult(stdout, OUT)?.saved).toEqual(["new"]);
	});
});

describe("snapshot paths and notices", () => {
	it("derives payload and manifest paths from the snapshot dir", () => {
		expect(snapshotPathIn("/state/py-kernel-snapshot")).toContain("kernel-state.dill");
		expect(manifestPathIn("/state/py-kernel-snapshot")).toContain("kernel-state.json");
	});

	it("formats a one-line notice with restored and skipped counts", () => {
		expect(formatRestoreNotice({ restored: ["a", "b", "c"], failed: [{ name: "d", reason: "x" }], path: OUT })).toBe(
			"[kernel] restored 3 variables from the previous session's snapshot, 1 skipped\n",
		);
		expect(formatRestoreNotice({ restored: ["a"], failed: [], path: OUT })).toBe(
			"[kernel] restored 1 variable from the previous session's snapshot\n",
		);
	});
});
