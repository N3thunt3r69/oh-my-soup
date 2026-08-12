export interface DisassemblerTarget {
	id: string;
	backend: string;
	label?: string;
	databasePath?: string;
	inputPath?: string;
	runtime?: string;
	version?: string;
	processor?: string;
	bits?: number;
	pid?: number;
	sessionId?: string;
	metadata: Record<string, unknown>;
}

/** Backend-neutral SQL result. Address formatting is owned by each adapter. */
export interface DisassemblerQueryResult {
	columns: string[];
	rows: Array<Record<string, unknown>>;
	truncated?: boolean;
}

/** Result of backend-native execution (IDAPython, Ghidra Java, or Binary Ninja Python). */
export interface DisassemblerExecutionResult {
	result?: unknown;
	stdout?: string;
	stderr?: string;
	truncated?: boolean;
}

export interface DisassemblerExecutionOptions {
	stateful?: boolean;
	sessionId?: string;
	timeoutSec?: number;
}

export interface DisassemblerResetOptions {
	sessionId: string;
	takeover?: boolean;
	release?: boolean;
	timeoutSec?: number;
}

export interface DisassemblerAdapterCapabilities {
	/** Human-readable language accepted by execute(). */
	executionLanguage: string;
	/** execute() can retain a namespace selected by DisassemblerExecutionOptions.sessionId. */
	statefulExecution: boolean;
	open: boolean;
	reset: boolean;
	save: boolean;
	close: boolean;
}

export interface DisassemblerOpenOptions {
	file: string;
	outputDb?: string;
	/** Domain path inside an existing Ghidra project. */
	program?: string;
	timeoutSec?: number;
}

export interface DisassemblerAdapter {
	readonly id: string;
	readonly label: string;
	readonly capabilities: DisassemblerAdapterCapabilities;
	list(signal?: AbortSignal): Promise<DisassemblerTarget[]>;
	query(
		target: string,
		sql: string,
		options?: DisassemblerExecutionOptions,
		signal?: AbortSignal,
	): Promise<DisassemblerQueryResult>;
	execute(
		target: string,
		code: string,
		options?: DisassemblerExecutionOptions,
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult>;
	open?(options: DisassemblerOpenOptions, signal?: AbortSignal): Promise<DisassemblerTarget>;
	reset?(target: string, options: DisassemblerResetOptions, signal?: AbortSignal): Promise<void>;
	save?(
		target: string,
		options?: DisassemblerExecutionOptions,
		signal?: AbortSignal,
	): Promise<DisassemblerExecutionResult>;
	close?(target: string, timeoutSec?: number, signal?: AbortSignal): Promise<void>;
	dispose(): void;
}

export interface DisassemblerAdapterOptions {
	endpoint?: string;
	idaDir?: string;
	python?: string;
	ghidraInstallDir?: string;
	ghidraJavaHome?: string;
	binaryNinjaInstallDir?: string;
	binaryNinjaPython?: string;
	cwd?: string;
}

export interface DisassemblerAdapterFactory {
	readonly id: string;
	readonly label: string;
	create(options?: DisassemblerAdapterOptions): DisassemblerAdapter;
}
