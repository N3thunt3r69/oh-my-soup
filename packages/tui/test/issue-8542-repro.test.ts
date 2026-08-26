import { afterEach, describe, expect, it, vi } from "bun:test";
import { ProcessTerminal } from "@oh-my-soup/pi-tui/terminal";
import { setTerminalHeadless } from "@oh-my-soup/pi-utils";

// #8542: a terminal Device-Attributes reply to the startup capability probe
// leaks into the composer as literal text (`1;22;...;52c`) when it arrives
// after the DA1 sentinel FIFO has already drained. The extra SSH+zmx PTY hops
// slow the query->response round-trip enough to make the race observable.
//
// Contract: `CSI ? … c` is exclusively a terminal-to-host report, never a
// keystroke, so it must be consumed for the whole session lifetime and never
// forwarded to the input handler that feeds the composer.

const DA1_REPLY = "\x1b[?1;22;23;24;28;32;42;52c";

describe("issue #8542: late DA response must not leak into the composer", () => {
	let terminal: ProcessTerminal | undefined;
	let previousHeadless = false;
	let spies: Array<{ mockRestore(): void }> = [];
	const captured: string[] = [];

	function setup(): void {
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: vi.fn(), configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		spies = [
			vi.spyOn(process.stdin, "resume").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin),
			vi.spyOn(process.stdout, "write").mockImplementation(() => true),
			vi.spyOn(process, "kill").mockImplementation(() => true),
		];
		captured.length = 0;
		terminal = new ProcessTerminal();
		terminal.start(
			data => captured.push(data),
			() => {},
		);
	}

	afterEach(() => {
		terminal?.stop();
		terminal = undefined;
		for (const spy of spies) spy.mockRestore();
		spies = [];
		Reflect.deleteProperty(process.stdin, "isTTY");
		Reflect.deleteProperty(process.stdout, "isTTY");
		Reflect.deleteProperty(process.stdin, "setRawMode");
		Reflect.deleteProperty(process.stdout, "columns");
		Reflect.deleteProperty(process.stdout, "rows");
		setTerminalHeadless(previousHeadless);
	});

	it("swallows a single-event DA reply that arrives after the sentinel FIFO drains", () => {
		setup();
		// Over-supply complete replies: startup sentinels consume the first few;
		// the remainder model a slow reply arriving after the FIFO is empty.
		for (let i = 0; i < 32; i++) process.stdin.emit("data", DA1_REPLY);

		expect(captured.join("")).toBe("");
	});

	it("reassembles and swallows a split DA reply arriving with an empty FIFO", async () => {
		setup();
		for (let i = 0; i < 32; i++) process.stdin.emit("data", "\x1b[?62c");
		captured.length = 0;

		// StdinBuffer's internal partial-hold timeout is wall-clock driven; fake
		// timers cannot advance that private flush path. Let it flush the prefix,
		// then deliver the tail as ordinary scalar input for terminal reassembly.
		process.stdin.emit("data", "\x1b[?1;22;23");
		await Bun.sleep(200);
		process.stdin.emit("data", ";24;28;32;42;52c");

		expect(captured.join("")).toBe("");
	});
});
