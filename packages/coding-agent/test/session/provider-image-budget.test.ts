import { describe, expect, it } from "bun:test";
import type { Context, ImageContent, TextContent } from "@oh-my-soup/pi-ai";
import { buildModel } from "@oh-my-soup/pi-catalog/build";
import {
	clampProviderContextImages,
	createImageBudgetWatermark,
} from "@oh-my-soup/pi-coding-agent/session/provider-image-budget";

// umans has a provider image budget of 10; the hysteresis batch is 4, so an
// over-budget trim drops down to 6 surviving images.
const UMANS_MODEL = buildModel({
	id: "umans-glm-5.2",
	name: "umans-glm-5.2",
	api: "anthropic-messages",
	provider: "umans",
	baseUrl: "https://api.code.umans.ai",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const USER_IMAGE_OMISSION_TEXT = "[image omitted: over provider image budget]";

function image(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

function imageData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") data.push(part.data);
		}
	}
	return data;
}

function textData(context: Context): string[] {
	const data: string[] = [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			data.push(message.content);
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") data.push(part.text);
		}
	}
	return data;
}

function userImageContext(count: number): Context {
	return {
		systemPrompt: ["system"],
		tools: [],
		messages: Array.from({ length: count }, (_, index) => ({
			role: "user",
			content: [text(`text-${index}`), image(`image-${index}`)],
			timestamp: index,
		})),
	};
}

describe("provider context image budgets", () => {
	it("drops oldest images down to budget minus the hysteresis batch while preserving text", () => {
		const context = userImageContext(31);

		const clamped = clampProviderContextImages(context, UMANS_MODEL, createImageBudgetWatermark());

		// 31 images over a cap of 10 trims down to 10 - 4 = 6 survivors.
		expect(imageData(clamped)).toEqual(Array.from({ length: 6 }, (_, index) => `image-${index + 25}`));
		// Every dropped user image is replaced by the byte-stable placeholder,
		// so the message keeps its shape and the model sees the omission.
		expect(textData(clamped)).toEqual(
			Array.from({ length: 31 }, (_, index) => index).flatMap(index =>
				index < 25 ? [`text-${index}`, USER_IMAGE_OMISSION_TEXT] : [`text-${index}`],
			),
		);
		expect(clamped).not.toBe(context);
		expect(imageData(context)).toEqual(Array.from({ length: 31 }, (_, index) => `image-${index}`));
	});

	it("keeps image-only tool results meaningful when every image block is dropped", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: Array.from({ length: 11 }, (_, index) => ({
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "inspect_image",
				content: [image(`image-${index}`)],
				isError: false,
				timestamp: index,
			})),
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL, createImageBudgetWatermark());
		const firstMessage = clamped.messages[0];

		// 11 over a cap of 10 trims down to 6 survivors (hysteresis batch 4).
		expect(imageData(clamped)).toEqual(Array.from({ length: 6 }, (_, index) => `image-${index + 5}`));
		expect(firstMessage?.role).toBe("toolResult");
		expect(firstMessage?.content).toEqual([text("[image omitted: provider image limit]")]);
	});

	it("invalidates native replay payloads when user or developer images are clamped", () => {
		const userPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "user", content: [{ type: "input_image", image_url: "user-native" }] }],
		};
		const developerPayload = {
			type: "openaiResponsesHistory" as const,
			items: [{ type: "message", role: "developer", content: [{ type: "input_image", image_url: "dev-native" }] }],
		};
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{ role: "user", content: [image("user-image")], providerPayload: userPayload, timestamp: 0 },
				{ role: "developer", content: [image("developer-image")], providerPayload: developerPayload, timestamp: 1 },
				...Array.from({ length: 10 }, (_, index) => ({
					role: "user" as const,
					content: [image(`kept-image-${index}`)],
					timestamp: index + 2,
				})),
			],
		};

		const clamped = clampProviderContextImages(context, UMANS_MODEL);
		const clampedUser = clamped.messages[0];
		const clampedDeveloper = clamped.messages[1];
		const originalUser = context.messages[0];
		const originalDeveloper = context.messages[1];

		expect(clampedUser?.role).toBe("user");
		expect(clampedDeveloper?.role).toBe("developer");
		if (
			clampedUser?.role !== "user" ||
			clampedDeveloper?.role !== "developer" ||
			originalUser?.role !== "user" ||
			originalDeveloper?.role !== "developer"
		) {
			throw new Error("Expected clamped user and developer messages");
		}
		expect(clampedUser.providerPayload).toBeUndefined();
		expect(clampedDeveloper.providerPayload).toBeUndefined();
		expect(originalUser.providerPayload).toBe(userPayload);
		expect(originalDeveloper.providerPayload).toBe(developerPayload);
		expect(imageData(clamped)).toEqual(Array.from({ length: 10 }, (_, index) => `kept-image-${index}`));
	});

	it("preserves context identity when the provider cap is not exceeded", () => {
		const context: Context = {
			systemPrompt: [],
			tools: [],
			messages: [
				{
					role: "user",
					content: [text("ok"), ...Array.from({ length: 10 }, (_, index) => image(`image-${index}`))],
					timestamp: 1,
				},
			],
		};

		expect(clampProviderContextImages(context, UMANS_MODEL)).toBe(context);
	});

	it("keeps the drop frontier stable for the next BATCH images after a trim", () => {
		const watermark = createImageBudgetWatermark();

		// 11 images exceed the cap of 10: trim down to 6 (drop the oldest 5).
		const first = clampProviderContextImages(userImageContext(11), UMANS_MODEL, watermark);
		expect(imageData(first)).toEqual(Array.from({ length: 6 }, (_, index) => `image-${index + 5}`));
		expect(watermark.droppedImages).toBe(5);

		// The next 4 new images ride inside the overshoot: same 5 oldest slots
		// dropped, no frontier movement, so the cached prefix stays intact.
		for (let total = 12; total <= 15; total++) {
			const clamped = clampProviderContextImages(userImageContext(total), UMANS_MODEL, watermark);
			expect(watermark.droppedImages).toBe(5);
			expect(imageData(clamped)).toEqual(Array.from({ length: total - 5 }, (_, index) => `image-${index + 5}`));
		}

		// The 5th image past the trim exceeds the cap again: re-trim to 6 survivors.
		const retrimmed = clampProviderContextImages(userImageContext(16), UMANS_MODEL, watermark);
		expect(watermark.droppedImages).toBe(10);
		expect(imageData(retrimmed)).toEqual(Array.from({ length: 6 }, (_, index) => `image-${index + 10}`));
	});

	it("keeps previously dropped slots dropped even when the count is back under the cap", () => {
		const watermark = createImageBudgetWatermark();
		clampProviderContextImages(userImageContext(11), UMANS_MODEL, watermark);
		expect(watermark.droppedImages).toBe(5);

		// Same history replayed (nothing new): the frontier holds.
		const replayed = clampProviderContextImages(userImageContext(11), UMANS_MODEL, watermark);
		expect(watermark.droppedImages).toBe(5);
		expect(imageData(replayed)).toEqual(Array.from({ length: 6 }, (_, index) => `image-${index + 5}`));
	});

	it("resets the frontier when history shrinks (compaction rewrote the prefix)", () => {
		const watermark = createImageBudgetWatermark();
		clampProviderContextImages(userImageContext(16), UMANS_MODEL, watermark);
		expect(watermark.droppedImages).toBe(10);

		// Post-compaction history carries only 3 images: the old frontier would
		// eat all of them, and the prefix cache is already invalidated anyway.
		const context = userImageContext(3);
		expect(clampProviderContextImages(context, UMANS_MODEL, watermark)).toBe(context);
		expect(watermark.droppedImages).toBe(0);
	});

	it("replaces dropped user images with a byte-identical placeholder across turns", () => {
		const watermark = createImageBudgetWatermark();
		const first = clampProviderContextImages(userImageContext(11), UMANS_MODEL, watermark);
		const second = clampProviderContextImages(userImageContext(12), UMANS_MODEL, watermark);

		const firstMessage = first.messages[0];
		const secondMessage = second.messages[0];
		if (!Array.isArray(firstMessage?.content) || !Array.isArray(secondMessage?.content)) {
			throw new Error("Expected array content");
		}
		expect(firstMessage.content).toEqual([text("text-0"), text(USER_IMAGE_OMISSION_TEXT)]);
		// Same slot, same bytes on the next turn — the cached prefix is untouched.
		expect(secondMessage.content).toEqual(firstMessage.content);
	});
});
