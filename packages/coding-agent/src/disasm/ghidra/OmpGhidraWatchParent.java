// OMP-owned pre-analysis parent watchdog.
//@category OMP

import ghidra.app.script.GhidraScript;

import java.util.concurrent.atomic.AtomicBoolean;

public class OmpGhidraWatchParent extends GhidraScript {
	private static final String PARENT_PID_ENV = "OMP_GHIDRA_PARENT_PID";
	private static final String OWNER_PROPERTY_PREFIX = "omp.ghidra.parent-watch.";
	private static final AtomicBoolean STARTED = new AtomicBoolean();

	@Override
	public void run() {
		if (!STARTED.compareAndSet(false, true)) return;
		String[] args = getScriptArgs();
		if (args.length != 1 || args[0].isBlank()) {
			throw new IllegalArgumentException("OmpGhidraWatchParent requires a lifecycle ID");
		}
		String rawPid = System.getenv(PARENT_PID_ENV);
		if (rawPid == null || rawPid.isBlank()) return;
		final long parentPid;
		try {
			parentPid = Long.parseLong(rawPid);
		}
		catch (NumberFormatException exception) {
			throw new IllegalArgumentException(PARENT_PID_ENV + " must contain a process ID", exception);
		}
		String ownerProperty = OWNER_PROPERTY_PREFIX + args[0];
		Thread watcher = new Thread(() -> {
			try {
				while (true) {
					if ("bridge".equals(System.getProperty(ownerProperty))) return;
					if (!ProcessHandle.of(parentPid).map(ProcessHandle::isAlive).orElse(false)) {
						if ("bridge".equals(System.getProperty(ownerProperty))) return;
						Runtime.getRuntime().halt(143);
					}
					Thread.sleep(1_000);
				}
			}
			catch (InterruptedException exception) {
				Thread.currentThread().interrupt();
			}
		}, "omp-ghidra-early-parent-watch");
		watcher.setDaemon(true);
		watcher.start();
	}
}
