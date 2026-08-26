/**
 * Shared classifiers for `bun:sqlite` error result codes.
 *
 * OMS SQLite stores need the same distinction between transient BUSY errors
 * that can clear after backoff and unrecoverable corruption that requires the
 * owning store to stop using or replace the database.
 */

/**
 * SQLite's busy result-code family — base `SQLITE_BUSY` plus extended variants
 * such as `SQLITE_BUSY_RECOVERY`, `SQLITE_BUSY_SNAPSHOT`, and
 * `SQLITE_BUSY_TIMEOUT`.
 */
export function isSqliteBusyError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

/**
 * SQLite's unrecoverable-corruption result codes: the `SQLITE_CORRUPT` family
 * and `SQLITE_NOTADB`. These errors do not clear through busy retries.
 */
export function isSqliteCorruptionError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	const code = err.code;
	return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}
