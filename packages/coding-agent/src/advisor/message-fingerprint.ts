import type { AgentMessage } from "@oh-my-soup/pi-agent-core";

/**
 * Field-selective identity hash for an advisor-visible message.
 *
 * Hashes every top-level field the advisor renderer reads while excluding
 * provider metadata that changes across equivalent re-deliveries.
 */
export function fingerprintMessage(message: AgentMessage): bigint | undefined {
	try {
		const candidate = message as unknown as Record<string, unknown>;
		const payload = JSON.stringify({
			r: candidate.role ?? null,
			c: candidate.content ?? null,
			toolCallId: candidate.toolCallId ?? null,
			toolName: candidate.toolName ?? null,
			err: candidate.isError ?? null,
			ct: candidate.customType ?? null,
			disp: candidate.display ?? null,
			cancel: candidate.cancelled ?? null,
			exit: candidate.exitCode ?? null,
			out: candidate.output ?? null,
			det: candidate.details ?? null,
			xfc: candidate.excludeFromContext ?? null,
			cmd: candidate.command ?? null,
			code: candidate.code ?? null,
			sum: candidate.summary ?? null,
			from: candidate.fromId ?? null,
			files: candidate.files ?? null,
		});
		if (payload === undefined) return undefined;
		return Bun.hash.wyhash(payload);
	} catch {
		return undefined;
	}
}
