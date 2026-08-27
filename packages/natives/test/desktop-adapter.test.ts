import { describe, expect, it } from "bun:test";
import { adaptDesktopSession } from "../native/desktop-adapter.js";

class LegacyDesktopSession {
	static instances: LegacyDesktopSession[] = [];

	readonly actions: Array<Record<string, unknown>> = [];
	readonly options: Record<string, unknown>;
	readonly capabilities = {
		backend: "unavailable",
		capture: true,
		input: true,
		capturePermission: "unknown",
		inputPermission: "unknown",
		displayCount: 0,
	};
	closed = false;

	constructor(options: Record<string, unknown>) {
		this.options = options;
		LegacyDesktopSession.instances.push(this);
	}

	async capture() {
		return {
			width: (this.options.maxWidth as number | undefined) ?? 20,
			height: (this.options.maxHeight as number | undefined) ?? 10,
			data: new Uint8Array(),
		};
	}

	async execute(actions: Array<Record<string, unknown>>) {
		this.actions.push(...actions);
	}

	async close() {
		this.closed = true;
	}
}

describe("legacy DesktopSession adapter", () => {
	it("passes current native classes through unchanged", () => {
		class CurrentDesktopSession {
			click() {}
		}

		const adapted: unknown = adaptDesktopSession(CurrentDesktopSession);
		expect(adapted).toBe(CurrentDesktopSession);
	});

	it("fills conservative capabilities and translates default foreground input", async () => {
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });
		const legacy = LegacyDesktopSession.instances.at(-1);
		expect(legacy).toBeDefined();

		expect(session.capabilities).toMatchObject({
			ax: false,
			backgroundWindowInput: false,
			deliveryModes: ["foreground"],
			axPermission: "unavailable",
		});
		await expect(session.listWindows()).rejects.toThrow(/^CaptureFailed: /);
		const capture = await session.capture("desktop");
		expect(capture).toMatchObject({ width: 20, height: 10, sourceWidth: 20, sourceHeight: 10, target: "desktop" });
		await session.click("desktop", 1.4, 2.6);

		expect(legacy?.actions).toEqual([{ type: "click", x: 1, y: 3, keys: [], button: "left" }]);
	});

	it("preserves capture caps and pointer semantics for legacy sessions", async () => {
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });
		const capture = await session.capture("desktop", { maxWidth: 10, maxHeight: 5 });
		const legacy = LegacyDesktopSession.instances.at(-1);

		expect(capture).toMatchObject({ width: 10, height: 5, target: "desktop" });
		expect(legacy?.options).toMatchObject({ display: "all", maxWidth: 10, maxHeight: 5 });
		await session.click("desktop", 1, 2, { button: "middle", count: 3 });
		await session.click("desktop", 1, 2, { button: "right", count: 2 });
		expect(legacy?.actions).toEqual([
			{ type: "click", x: 1, y: 2, keys: [], button: "wheel" },
			{ type: "click", x: 1, y: 2, keys: [], button: "wheel" },
			{ type: "click", x: 1, y: 2, keys: [], button: "wheel" },
			{ type: "click", x: 1, y: 2, keys: [], button: "right" },
			{ type: "click", x: 1, y: 2, keys: [], button: "right" },
		]);
	});

	it("fails closed for unsupported targets, background input, and closed sessions", async () => {
		const DesktopSession = adaptDesktopSession(LegacyDesktopSession);
		const session = new DesktopSession({ display: "all" });

		await expect(session.capture("window-name")).rejects.toThrow(/^InvalidTarget: /);
		await expect(session.capture("42")).rejects.toThrow(/^CaptureFailed: /);
		await session.capture("desktop");
		await expect(session.click("desktop", 1, 1, { deliveryMode: "background" })).rejects.toThrow(
			/^BackgroundUnavailable: /,
		);
		await session.close();
		await session.close();
		await expect(session.capture("desktop")).rejects.toThrow(/^Closed: /);
	});
});
