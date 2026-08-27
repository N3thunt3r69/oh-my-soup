/** Minimal model identity carried by a failed assistant turn. */
export interface FailedAssistantModelInfo {
	provider?: string;
	model?: string;
}

/** Attributes a subagent failure with the provider/model that produced it. */
export function attributeSubagentError(
	message: string | undefined,
	source: FailedAssistantModelInfo | undefined,
	fallback = "Subagent failed",
): string {
	const text = message?.trim() ? message : fallback;
	const provider = source?.provider?.trim() || undefined;
	const model = source?.model?.trim() || undefined;
	const identity = provider && model ? `${provider}/${model}` : (provider ?? model);
	if (!identity) return text;
	if (provider && text.toLowerCase().includes(provider.toLowerCase())) return text;
	return `[${identity}] ${text}`;
}
