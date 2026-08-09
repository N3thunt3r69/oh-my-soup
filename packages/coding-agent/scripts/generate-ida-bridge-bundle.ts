#!/usr/bin/env bun

import * as path from "node:path";
import { gzipSync } from "node:zlib";

const UPSTREAM_REPOSITORY = "cellebrite-labs/ida-bridge";
const UPSTREAM_REVISION = "585eb2f43c7a1a4e59184362599113c5d6939b94";
const outputPath = path.join(import.meta.dir, "..", "src", "disasm", "ida", "ida-bridge.bundle.txt");

interface GitTreeEntry {
	path: string;
	type: "blob" | "tree";
}

interface GitTreeResponse {
	tree: GitTreeEntry[];
}

function applyOmsPatches(sourcePath: string, content: string): string {
	if (sourcePath !== "src/ida_bridge/idalib_runner.py") return content;
	const importAnchor = "import fcntl\n";
	if (!content.includes(importAnchor)) throw new Error("ida-bridge fcntl import changed upstream");
	let patched = content.replace(
		importAnchor,
		`try:
    import fcntl
except ModuleNotFoundError:
    fcntl = None
    import msvcrt
`,
	);
	const lockFunction = /def _is_locked\(path: Path\) -> bool:\n.*?(?=\n\ndef _locked_companion)/s;
	if (!lockFunction.test(patched)) throw new Error("ida-bridge lock probe changed upstream");
	patched = patched.replace(
		lockFunction,
		`def _is_locked(path: Path) -> bool:
    """True if *path* is currently held under an exclusive OS advisory lock."""
    if not path.exists():
        return False
    try:
        fd = os.open(str(path), os.O_RDONLY)
    except OSError:
        # Windows denies the open itself when another process disallows sharing.
        return os.name == "nt"
    try:
        if fcntl is not None:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            else:
                fcntl.flock(fd, fcntl.LOCK_UN)
                return False
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        else:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            return False
    finally:
        os.close(fd)
`,
	);
	return patched;
}

const treeResponse = await fetch(
	`https://api.github.com/repos/${UPSTREAM_REPOSITORY}/git/trees/${UPSTREAM_REVISION}?recursive=1`,
	{ headers: { Accept: "application/vnd.github+json", "User-Agent": "oh-my-soup-build" } },
);
if (!treeResponse.ok) {
	throw new Error(`Failed to read ida-bridge tree: HTTP ${treeResponse.status}`);
}
const tree = (await treeResponse.json()) as GitTreeResponse;
const paths = tree.tree
	.filter(entry => entry.type === "blob" && /^src\/ida_bridge\/.*\.py$/.test(entry.path))
	.map(entry => entry.path)
	.sort();
if (paths.length === 0) throw new Error("The pinned ida-bridge revision contains no Python sources");

const files = Object.fromEntries(
	await Promise.all(
		paths.map(async sourcePath => {
			const response = await fetch(
				`https://raw.githubusercontent.com/${UPSTREAM_REPOSITORY}/${UPSTREAM_REVISION}/${sourcePath}`,
			);
			if (!response.ok) throw new Error(`Failed to read ${sourcePath}: HTTP ${response.status}`);
			return [sourcePath.slice("src/".length), applyOmsPatches(sourcePath, await response.text())] as const;
		}),
	),
);
const bundle = {
	format: 1,
	repository: `https://github.com/${UPSTREAM_REPOSITORY}`,
	revision: UPSTREAM_REVISION,
	license: "MIT",
	files,
};
const compressed = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"), { level: 9 });
await Bun.write(outputPath, `${compressed.toString("base64")}\n`);
console.log(
	`Embedded ${paths.length} ida-bridge Python files from ${UPSTREAM_REVISION.slice(0, 12)} (${compressed.length} compressed bytes)`,
);
