import { describe, expect, it } from "bun:test";
import { resolveDaemonSpawnOptions } from "../../src/launch/spawn-options";

describe("resolveDaemonSpawnOptions", () => {
	it("hides Windows daemons when the host has no console", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: false,
				surviveParentExit: false,
			}),
		).toEqual({ detached: false, windowsHide: true });
	});

	it("inherits the Windows host console instead of detaching", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: true,
				surviveParentExit: false,
			}),
		).toEqual({ detached: false, windowsHide: false });
	});

	it("hides and detaches Windows processes that must survive their parent", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				surviveParentExit: true,
			}),
		).toEqual({ detached: true, windowsHide: true });
	});

	it("keeps POSIX daemons in their own session", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "linux",
				hostHasInheritableConsole: false,
				surviveParentExit: false,
			}),
		).toEqual({ detached: true });
	});
});
