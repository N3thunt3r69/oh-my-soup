import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox, isWorkerHostSelector } from "@oh-my-soup/pi-utils/worker-host";
import type { ComputerWorkerInbound, ComputerWorkerTransport } from "./protocol";
import { ComputerWorkerCore } from "./worker";

let started = false;

/** Starts the computer worker once when running inside a Bun worker thread. */
export function startComputerWorker(): void {
	if (started || !parentPort) return;
	started = true;
	const port = parentPort;
	const inbox = consumeWorkerInbox();
	const transport: ComputerWorkerTransport = {
		send(message, transfer) {
			port.postMessage(message, transfer ?? []);
		},
		onMessage(handler) {
			if (inbox) return inbox.bind(message => handler(message as ComputerWorkerInbound));
			const listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
			port.on("message", listener);
			return () => port.off("message", listener);
		},
		close() {
			port.close();
		},
	};

	new ComputerWorkerCore(transport);
}

// Direct-source fallback: loaded as a worker's entry module outside a CLI
// host there is no selector argv, so start immediately. A CLI-host worker
// imports this module only after the computer selector dispatches; the guard
// still prevents direct imports under another declared selector from
// hijacking that worker's message port.
if (!Bun.argv.some(isWorkerHostSelector)) {
	startComputerWorker();
}
