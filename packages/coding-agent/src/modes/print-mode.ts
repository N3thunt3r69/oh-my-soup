/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `oms -p "prompt"` - text output
 * - `oms --mode json "prompt"` - JSON event stream
 */
import type { ImageContent } from "@oh-my-soup/pi-ai";
import { logger, sanitizeText } from "@oh-my-soup/pi-utils";
import { type AgentSession, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { serializeAgentSessionEvent } from "../session/event-serialization";
import { isSilentAbort } from "../session/messages";
import { flushTelemetryExport } from "../telemetry-export";
import { initializeExtensions } from "./runtime-init";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** If true, include thinking blocks in text output */
	printThoughts?: boolean;
	/** Whether the caller explicitly started the headless plan flow. */
	planYolo?: boolean;
}

/** Matches the longest built-in provider request deadline while bounding tool-loop stalls. */
export const PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS = 10 * 60_000;
/** Error exits cannot hold automation for the full normal drain budget. */
export const PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS = 30_000;

export const printableEvent = serializeAgentSessionEvent;

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(session: AgentSession, options: PrintModeOptions): Promise<void> {
	const { mode, messages = [], initialMessage, initialImages, printThoughts, planYolo = false } = options;

	// process.stdout.write is fire-and-forget: a large final record (e.g. a
	// multi-MB agent_end) can be dropped when the process exits before the pipe
	// drains, truncating the record mid-line while the process still exits 0.
	// Serialize every stdout write on the previous write's completion callback so
	// records stay ordered and honor backpressure, then block shutdown on the
	// tail before dispose/exit. Same truncation class as issue #5309 (issue #7635).
	let stdoutTail: Promise<void> = Promise.resolve();
	const writeStdoutLine = (text: string): void => {
		stdoutTail = stdoutTail.then(() => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			process.stdout.write(text, err => {
				if (err) reject(err);
				else resolve();
			});
			return promise;
		});
	};

	// Emit session header for JSON mode
	if (mode === "json") {
		const header = session.sessionManager.getHeader();
		if (header) {
			writeStdoutLine(`${JSON.stringify(header)}\n`);
		}
	}
	// Set up extensions for print mode (no UI, no command context)
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			process.stderr.write(
				`Extension ${action === "extension_send" ? "sendMessage" : "sendUserMessage"} failed: ${err.message}\n`,
			);
		},
		reportRuntimeError: err => {
			process.stderr.write(`Extension error (${err.extensionPath}): ${err.error}\n`);
		},
	});

	// `plan.defaultOnStartup` opens fresh *interactive* sessions in plan mode so a
	// human can review the plan before it executes. Headless print mode has no
	// surface to review, approve, or exit a plan from, and the turn carries no
	// deterministic way out of plan mode — the model must voluntarily emit a valid
	// `xd://propose` execute-dispatch, and when it does not the run strands until
	// the deadline (issue #8272). So do not honor the startup default here; the
	// supported headless plan flow is `--plan-yolo` (auto-approve → implement),
	// which is wired independently through the prewalk coordinator.
	const planStartupIgnored =
		session.settings.get("plan.defaultOnStartup") &&
		session.settings.get("plan.enabled") &&
		session.sessionManager.buildSessionContext().messages.length === 0 &&
		!session.sessionManager.getEntries().some(entry => entry.type === "mode_change") &&
		!planYolo;
	if (planStartupIgnored) {
		process.stderr.write(
			"Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.\n",
		);
	}

	// Always subscribe to enable session persistence via _handleAgentEvent
	session.subscribe(event => {
		// In JSON mode, output all events
		if (mode === "json") {
			writeStdoutLine(`${JSON.stringify(printableEvent(event))}\n`);
		}
	});

	let wroteTextWorkingIndicator = false;
	const writeTextWorkingIndicator = (): void => {
		if (mode !== "text" || wroteTextWorkingIndicator) return;
		process.stderr.write("Working...\n");
		wroteTextWorkingIndicator = true;
	};

	// Send initial message with attachments
	if (initialMessage !== undefined) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:initial", () => session.prompt(initialMessage, { images: initialImages }));
	}

	// Send remaining messages
	for (const message of messages) {
		writeTextWorkingIndicator();
		if (mode === "text") session.setTextOutputCommitted(false);
		await logger.time("print:prompt:next", () => session.prompt(message));
	}

	// From this point onward a late blocker must be recorded without starting a
	// primary turn whose response print mode would never emit.
	session.prepareForHeadlessAdvisorDrain();

	// In text mode, output final response
	if (mode === "text") {
		// Read via the session accessor, not the raw state tail: a classifier
		// refusal is pruned from active context at settle, and an aborted turn
		// can trail synthetic tool results — both would hide the terminal
		// assistant message (and its error) from a last-element read.
		const assistantMsg = session.getLastAssistantMessage();

		if (assistantMsg) {
			// Check for error/aborted — skip silent-abort (plan-mode compaction transition)
			if (
				(assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") &&
				!isSilentAbort(assistantMsg)
			) {
				const errorLine = sanitizeText(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
				// This branch hard-exits, bypassing the `await session.dispose()` at
				// the end of runPrintMode. Flush telemetry and dispose the session
				// HERE so error spans reach the exporter (the postmortem `exit`
				// handler can't await) and the browser reaper installed in
				// `dispose()` (releaseTabsForOwner) actually runs — otherwise an
				// OMS-owned Chromium survives this exit (issue #5643). `dispose()`
				// is idempotent, so the unreachable call below is a harmless no-op.
				await session.waitForAdvisorCatchup(PRINT_MODE_ERROR_ADVISOR_DRAIN_TIMEOUT_MS);
				await flushTelemetryExport();
				await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
				const flushed = process.stderr.write(`${errorLine}\n`);
				if (flushed) {
					process.exit(1);
				} else {
					process.stderr.once("drain", () => process.exit(1));
				}
			}

			if (
				assistantMsg.errorMessage &&
				assistantMsg.stopReason !== "error" &&
				assistantMsg.stopReason !== "aborted"
			) {
				process.stderr.write(`${sanitizeText(assistantMsg.errorMessage)}\n`);
			}

			// Output text content
			for (const content of assistantMsg.content) {
				if (content.type === "text") {
					writeStdoutLine(`${sanitizeText(content.text)}\n`);
				} else if (printThoughts && content.type === "thinking" && content.thinking.trim().length > 0) {
					writeStdoutLine(`${sanitizeText(content.thinking)}\n`);
				}
			}
		}
		session.setTextOutputCommitted(true);
	}

	await session.waitForAdvisorCatchup(PRINT_MODE_ADVISOR_DRAIN_TIMEOUT_MS);

	// Block shutdown until every serialized stdout write (including the final
	// agent_end and late JSON advisor events) has drained; process.exit would
	// otherwise discard the buffered tail and truncate the last record.
	await stdoutTail;
	await session.dispose({ mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS });
}
