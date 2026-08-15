import * as path from "node:path";
import { getDaemonRuntimeDir } from "@oh-my-soup/pi-utils";

/** Resolve the private runtime directory shared by oms processes in one project directory. */
export { getDaemonRuntimeDir as daemonRuntimeDir };

/** Resolve the Unix socket or Windows named pipe used by one daemon broker scope. */
export function daemonBrokerEndpoint(_projectDir: string, runtimeDir: string): string {
	if (process.platform === "win32") {
		// Key off the runtime dir (profile-scoped, already case-folded per project)
		// so pipe names are case-stable and profile-scoped, matching POSIX where
		// the socket lives inside runtimeDir.
		const key = Bun.hash.wyhash(runtimeDir.toLowerCase()).toString(16).padStart(16, "0");
		return `\\\\.\\pipe\\oms-daemon-${key}`;
	}
	return path.join(runtimeDir, "broker.sock");
}
