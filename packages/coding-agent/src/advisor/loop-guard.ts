import type { AgentMessage, AgentTurnEndContext } from "@oh-my-soup/pi-agent-core";
import type { UserMessage } from "@oh-my-soup/pi-ai";
import { ToolCallLoopGuard } from "@oh-my-soup/pi-ai/utils/tool-call-loop-guard";
import { logger } from "@oh-my-soup/pi-utils";
import type { Settings } from "../config/settings";
import { renderToolCallLoopRedirect } from "../session/tool-call-loop-redirect";

export interface AdvisorLoopGuardHost {
	settings: Settings;
	name: string;
	liveMessages(): AgentMessage[];
	appendMessage(message: AgentMessage): void;
	abort(reason: Error): void;
}

/** Bounds repeated identical tool calls inside an advisor's private agent loop. */
export class AdvisorLoopGuard {
	readonly #host: AdvisorLoopGuardHost;
	#guard: ToolCallLoopGuard | undefined;
	#guardSettingsKey: string | undefined;
	#redirectIssued = false;

	constructor(host: AdvisorLoopGuardHost) {
		this.#host = host;
	}

	/** Clear detector and escalation state at an update or context boundary. */
	reset(): void {
		this.#guard = undefined;
		this.#guardSettingsKey = undefined;
		this.#redirectIssued = false;
	}

	recordTurn(messages: AgentMessage[], context: AgentTurnEndContext | undefined): void {
		if (context?.message.role !== "assistant") return;
		const detection = this.#activeGuard()?.recordTurn({
			message: context.message,
			toolResults: context.toolResults,
		});
		if (!detection) return;
		if (this.#redirectIssued) {
			logger.warn("advisor ignored tool-call loop redirect; aborting update", {
				advisor: this.#host.name,
				toolName: detection.toolName,
				count: detection.count,
			});
			this.#host.abort(new Error(`Advisor repeated ${detection.toolName} after a loop redirect`));
			this.reset();
			return;
		}
		logger.warn("advisor tool-call loop detected", {
			advisor: this.#host.name,
			toolName: detection.toolName,
			count: detection.count,
		});
		this.#redirectIssued = true;
		this.#guard = undefined;
		this.#guardSettingsKey = undefined;
		const redirect: UserMessage = {
			role: "user",
			content: [{ type: "text", text: renderToolCallLoopRedirect(detection) }],
			synthetic: true,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirect);
		if (this.#host.liveMessages() !== messages) this.#host.appendMessage(redirect);
	}

	#activeGuard(): ToolCallLoopGuard | undefined {
		if (this.#host.settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.reset();
			return undefined;
		}
		const threshold = this.#host.settings.get("model.toolCallLoopGuard.threshold");
		const exemptTools = this.#host.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#guard || this.#guardSettingsKey !== settingsKey) {
			this.#guard = new ToolCallLoopGuard({ threshold, exemptTools });
			this.#guardSettingsKey = settingsKey;
		}
		return this.#guard;
	}
}
