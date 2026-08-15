import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-soup/pi-ai";
import { providerImageBudget } from "@oh-my-soup/snapcompact";

const TOOL_RESULT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/**
 * Replacement block for images dropped from user/developer messages. Dropping
 * the block outright silently shrank the content array; the placeholder tells
 * the model an attachment is missing AND keeps the message shape stable. The
 * text MUST stay byte-identical across turns — it sits deep in the cached
 * prefix, so any variance would invalidate the provider prompt cache.
 */
const USER_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: over provider image budget]",
};

/**
 * Hysteresis batch: when the image count exceeds the provider budget, trim
 * down to `budget - IMAGE_DROP_BATCH` instead of exactly to budget. The
 * overshoot means the next BATCH new images change nothing about the drop
 * set, so the cached prefix survives those turns untouched.
 */
const IMAGE_DROP_BATCH = 4;

/**
 * Per-session drop frontier for {@link clampProviderContextImages}.
 *
 * The clamp is a per-request transform over persisted history, so without
 * memory every new image would shift the "oldest N dropped" frontier and
 * invalidate the provider prompt cache deep in the prefix. The watermark makes
 * the frontier monotonic: once a slot is dropped it stays dropped. Create one
 * per session next to the `transformProviderContext` closure (see sdk.ts) —
 * that closure is the session-identity seam the transform itself lacks.
 *
 * A shrinking total image count means history was rewritten (compaction,
 * branch switch); the prefix cache is already invalidated then, so the
 * frontier resets and re-derives from the new history.
 */
export interface ImageBudgetWatermark {
	/** Oldest-image drop count already applied to this session's history. */
	droppedImages: number;
	/** Total images seen on the previous request; a decrease signals a history rewrite. */
	lastTotalImages: number;
}

export function createImageBudgetWatermark(): ImageBudgetWatermark {
	return { droppedImages: 0, lastTotalImages: 0 };
}

function countImages(context: Context): number {
	let count = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "image") count++;
		}
	}
	return count;
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
	placeholder?: TextContent,
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			if (placeholder) clamped.push(placeholder);
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

function clampUserMessage(message: UserMessage, state: { remainingDrops: number }): UserMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state, USER_IMAGE_OMISSION);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: { remainingDrops: number }): DeveloperMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state, USER_IMAGE_OMISSION);
	return content ? { ...message, content, providerPayload: undefined } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: content.length > 0 ? content : [TOOL_RESULT_IMAGE_OMISSION] };
}

/**
 * Drops oldest transient image blocks so outgoing vision requests fit the
 * active provider's image cap. With a `watermark` the drop frontier is
 * hysteretic (over budget trims down to `budget - IMAGE_DROP_BATCH`) and
 * monotonic per session (previously dropped slots stay dropped), keeping the
 * provider prompt cache stable across image-heavy turns.
 */
export function clampProviderContextImages(context: Context, model: Model, watermark?: ImageBudgetWatermark): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const totalImages = countImages(context);

	if (watermark && totalImages < watermark.lastTotalImages) {
		// History rewrite (compaction, branch switch): the old frontier indexes
		// slots that no longer exist, and the prefix cache is already gone.
		watermark.droppedImages = 0;
	}
	if (watermark) watermark.lastTotalImages = totalImages;

	let drops = Math.min(watermark?.droppedImages ?? 0, totalImages);
	// Re-trim only when the SURVIVING images exceed the cap. With a watermark
	// the trim overshoots to `limit - IMAGE_DROP_BATCH` so the next BATCH new
	// images ride inside the overshoot and leave the frontier — and the cached
	// prefix — untouched; without one there is no state to stabilize, so the
	// clamp stays exact.
	if (totalImages - drops > limit) {
		const target = watermark ? Math.max(0, limit - IMAGE_DROP_BATCH) : limit;
		drops = Math.max(drops, totalImages - target);
	}
	if (watermark) watermark.droppedImages = drops;
	if (drops <= 0) return context;

	const state = { remainingDrops: drops };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}
