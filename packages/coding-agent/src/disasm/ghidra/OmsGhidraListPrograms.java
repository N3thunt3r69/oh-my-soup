// OMS-owned helper for enumerating programs in an existing Ghidra project.
// @category OMS

import ghidra.app.script.GhidraScript;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

public class OmsGhidraListPrograms extends GhidraScript {
	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length != 1) {
			throw new IllegalArgumentException("OmsGhidraListPrograms requires: <output-file>");
		}
		if (currentProgram == null) return;
		Path output = Path.of(args[0]).toAbsolutePath().normalize();
		Files.writeString(
			output,
			currentProgram.getDomainFile().getPathname() + System.lineSeparator(),
			StandardCharsets.UTF_8,
			StandardOpenOption.CREATE,
			StandardOpenOption.APPEND
		);
	}
}
