import { GhidraDisassemblerAdapter } from "./ghidra/adapter";
import { IdaDisassemblerAdapter } from "./ida/adapter";
import type { DisassemblerAdapter, DisassemblerAdapterFactory, DisassemblerAdapterOptions } from "./types";

const factories = new Map<string, DisassemblerAdapterFactory>([
	[
		"ida",
		{
			id: "ida",
			label: "IDA Pro",
			create: options => new IdaDisassemblerAdapter(options),
		},
	],
	[
		"ghidra",
		{
			id: "ghidra",
			label: "Ghidra",
			create: options => new GhidraDisassemblerAdapter(options),
		},
	],
]);

export function listDisassemblerBackends(): Array<{ id: string; label: string }> {
	return [...factories.values()].map(factory => ({ id: factory.id, label: factory.label }));
}

export function createDisassemblerAdapter(
	backend: string,
	options: DisassemblerAdapterOptions = {},
): DisassemblerAdapter {
	const id = backend.trim().toLowerCase();
	const factory = factories.get(id);
	if (!factory) {
		const available = listDisassemblerBackends()
			.map(entry => entry.id)
			.join(", ");
		throw new Error(`Unknown disassembler backend '${backend}'. Available backends: ${available || "none"}`);
	}
	return factory.create(options);
}

/** Register an additional native backend adapter. */
export function registerDisassemblerAdapter(factory: DisassemblerAdapterFactory): () => void {
	const id = factory.id.trim().toLowerCase();
	if (!id) throw new Error("Disassembler backend id must not be empty");
	if (factories.has(id)) throw new Error(`Disassembler backend '${id}' is already registered`);
	factories.set(id, { ...factory, id });
	return () => {
		if (factories.get(id)?.create === factory.create) factories.delete(id);
	};
}
