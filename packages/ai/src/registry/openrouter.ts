import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * OpenRouter login: Sign in with OpenRouter (OAuth PKCE) that mints a durable
 * `sk-or-…` API key, with the manual-input race accepting a pasted existing
 * key (validated via `/api/v1/auth/key`). Both paths return the durable key as
 * a string so AuthStorage persists it as an `api_key` credential.
 */

export const openrouterProvider = {
	id: "openrouter",
	name: "OpenRouter",
	login: async (cb: OAuthLoginCallbacks) => {
		const { loginOpenRouterOAuth } = await import("./oauth/openrouter");
		const credentials = await loginOpenRouterOAuth(cb);
		return credentials.access;
	},
	callbackPort: 54549,
	pasteCodeFlow: true,
} as const satisfies ProviderDefinition;
