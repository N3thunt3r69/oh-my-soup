/**
 * /refine — audited, rollback-able trajectory-review loop over reusable agent
 * state (prompt notes, memories, skill descriptions, subagent specs).
 *
 * `/refine [instructions]` runs one refiner pass; `/refine log` lists passes;
 * `/refine rollback <id>` reverse-applies a logged pass.
 */
import { serializeConversation } from "@oh-my-pi/pi-agent-core/compaction";
import {
	formatRefinementLog,
	loadRefinementLog,
	resolveRefinementStorePaths,
	rollbackRefinement,
	runRefinementPass,
} from "../refinement";
import { convertToLlm } from "../session/messages";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_REFINE_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "refine",
		description: "Refine reusable agent state (prompt notes, memories, skills, subagent specs) from the trajectory",
		acpDescription: "Refine reusable agent state from the current trajectory",
		allowArgs: true,
		subcommands: [
			{ name: "log", description: "Show recent refinement passes" },
			{ name: "rollback", description: "Reverse-apply a logged refinement pass", usage: "<id>" },
		],
		acpInputHint: "[log|rollback <id>|focus instructions]",
		handle: async (command, runtime) => {
			const args = command.args.trim();
			const paths = resolveRefinementStorePaths(runtime.sessionManager.getCwd());

			if (args === "log") {
				await runtime.output(formatRefinementLog(await loadRefinementLog(paths)));
				return commandConsumed();
			}

			if (args === "rollback" || args.startsWith("rollback ")) {
				const id = args.slice("rollback".length).trim();
				if (!id) return usage("Usage: /refine rollback <id> (see /refine log for ids)", runtime);
				try {
					const entry = await rollbackRefinement(paths, id);
					await runtime.output(`Rolled back ${id}: ${entry.summary}. Logged as ${entry.id}.`);
				} catch (err) {
					return usage(`Rollback failed: ${errorMessage(err)}`, runtime);
				}
				return commandConsumed();
			}

			const model = runtime.session.model;
			if (!model) {
				return usage("/refine needs an active model for the refiner pass.", runtime);
			}
			try {
				const entry = await runRefinementPass({
					paths,
					trigger: "manual",
					conversationText: serializeConversation(convertToLlm(runtime.session.messages)),
					model,
					apiKey: runtime.session.modelRegistry.resolver(model, runtime.session.sessionId),
					instructions: args || undefined,
				});
				const ok = entry.ops.filter(op => op.applied);
				const failed = entry.ops.filter(op => !op.applied);
				const lines = [`Refinement ${entry.id}: ${entry.summary}`];
				for (const op of ok) lines.push(`  applied ${op.action} ${op.kind}:${op.id}`);
				for (const op of failed) lines.push(`  refused ${op.action} ${op.kind}:${op.id} — ${op.error}`);
				if (ok.length === 0 && failed.length === 0) lines.push("  no ops proposed (nothing worth persisting)");
				if (ok.length > 0) {
					lines.push(
						`Undo with /refine rollback ${entry.id}. Prompt notes apply on the next session or /reload-plugins.`,
					);
				}
				await runtime.output(lines.join("\n"));
			} catch (err) {
				return usage(`Refinement failed: ${errorMessage(err)}`, runtime);
			}
			return commandConsumed();
		},
	},
];
