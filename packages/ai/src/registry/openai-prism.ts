/**
 * Prism login stores a full browser Cookie header and an existing project UUID
 * together as API-key JSON. Both session identity and project access are checked
 * before the credential is persisted.
 */

import * as AIError from "../error";
import { PRISM_BASE_URL, PrismHttpClient, parsePrismCredentials } from "../providers/openai-prism-client";
import type { OAuthController } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const loginPrism = async (options: OAuthController): Promise<string> => {
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError("OpenAI Prism");
	}
	const checkCancellation = () => {
		if (options.signal?.aborted) throw new AIError.LoginCancelledError("Prism login cancelled.");
	};
	try {
		checkCancellation();
		options.onAuth?.({
			url: `${PRISM_BASE_URL}/`,
			instructions:
				"Sign in to Prism with your ChatGPT account and open a dedicated existing project. In DevTools → Network, copy the full Cookie header from a prism.openai.com request. You will also need that project's URL or UUID.",
		});
		const cookie = await options.onPrompt({
			message: "Paste the full Cookie header from your signed-in prism.openai.com tab",
			placeholder: "prism_session_token=...; cf_clearance=...",
		});
		checkCancellation();
		const projectId = await options.onPrompt({
			message: "Paste a dedicated existing Prism project URL or UUID",
			placeholder: "https://prism.openai.com/?u=<project-uuid>",
		});
		checkCancellation();
		const client = new PrismHttpClient(parsePrismCredentials(cookie, projectId), { fetch: options.fetch });
		await client.authenticate(options.signal);
		checkCancellation();
		return client.serializeCredentials();
	} catch (error) {
		checkCancellation();
		throw error;
	}
};

export const openaiPrismProvider = {
	id: "openai-prism",
	name: "OpenAI Prism (prism.openai.com)",
	login: loginPrism,
} as const satisfies ProviderDefinition;
