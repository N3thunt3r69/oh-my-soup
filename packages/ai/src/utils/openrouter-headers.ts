import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `Oh-My-Soup/${packageJson.version}`,
		"HTTP-Referer": "https://github.com/pickpocket/oh-my-soup",
		"X-OpenRouter-Title": "Oh-My-Soup",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
