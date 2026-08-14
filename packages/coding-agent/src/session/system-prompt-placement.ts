/**
 * Per-request system-prompt placement.
 *
 * Some models reject the provider's system/developer channel outright (no
 * `system` role, no `instructions` field). For those, the effective system
 * prompt — default harness prompt, `--system-prompt` file, SYSTEM.md, appends —
 * still has to reach the model, and the only channel left is the conversation
 * itself: a synthetic first user turn.
 *
 * The transform is applied at `transformProviderContext` time, never persisted:
 * the canonical prompt stays in `AgentState.systemPrompt`, so switching to a
 * system-capable model mid-session restores the native channel with no
 * double-prompting, and session files never contain the relocated copy.
 */

import type { Context, Model, UserMessage } from "@oh-my-soup/pi-ai";

export type SystemPromptPlacementSetting = "auto" | "system" | "first-turn";

/**
 * Deterministic timestamp keeps the synthetic turn byte-stable across
 * requests: append-only prefix diffing and provider prompt caches both key
 * off message bytes, and a fresh `Date.now()` per request would churn them.
 */
const PLACEMENT_MESSAGE_TIMESTAMP = 0;

/** Resolve the effective placement for a model under the configured policy. */
export function resolveSystemPromptPlacement(
	setting: SystemPromptPlacementSetting,
	model: Pick<Model, "supportsSystemPrompt">,
): "system" | "first-turn" {
	if (setting === "system" || setting === "first-turn") return setting;
	return model.supportsSystemPrompt === false ? "first-turn" : "system";
}

/**
 * Relocate `context.systemPrompt` into a synthetic first user message when
 * the resolved placement is `first-turn`. Returns the context unchanged when
 * the system channel applies or there is no prompt content to move.
 */
export function applySystemPromptPlacement(
	context: Context,
	model: Pick<Model, "supportsSystemPrompt">,
	setting: SystemPromptPlacementSetting,
): Context {
	if (resolveSystemPromptPlacement(setting, model) === "system") return context;
	const blocks = context.systemPrompt?.filter(block => block.trim().length > 0) ?? [];
	if (blocks.length === 0) return context;
	const opener: UserMessage = {
		role: "user",
		content: blocks.join("\n\n"),
		synthetic: true,
		timestamp: PLACEMENT_MESSAGE_TIMESTAMP,
	};
	return { ...context, systemPrompt: undefined, messages: [opener, ...context.messages] };
}
