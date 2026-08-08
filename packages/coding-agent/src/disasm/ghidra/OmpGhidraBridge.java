// OMP-owned headless Ghidra bridge. Loaded by analyzeHeadless as a post-script.
// @category OMP

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.framework.Application;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressIterator;
import ghidra.program.model.listing.CodeUnit;
import ghidra.program.model.listing.CommentType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.listing.Instruction;
import ghidra.program.model.listing.InstructionIterator;
import ghidra.program.model.listing.Listing;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Reference;
import ghidra.program.model.symbol.ReferenceIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;

import org.h2.Driver;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.Writer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.Properties;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class OmpGhidraBridge extends GhidraScript {
	private static final Gson GSON = new Gson();
	private static final int MAX_REQUEST_BYTES = 2 * 1024 * 1024;
	private static final int MAX_QUERY_ROWS = 10_000;
	private static final int MAX_QUERY_SQL_CHARS = 64 * 1024;
	private static final int MAX_MATERIALIZATION_STEPS = 2_000_000;
	private static final int MAX_MATERIALIZED_TEXT_CHARS = 64 * 1024 * 1024;
	private static final int MAX_QUERY_CELL_CHARS = 256 * 1024;
	private static final int MAX_QUERY_OUTPUT_CHARS = 2 * 1024 * 1024;
	private static final int MAX_NATIVE_OUTPUT_CHARS = 2 * 1024 * 1024;
	private static final int MAX_NATIVE_RESULT_CHARS = 1024 * 1024;
	private static final int MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
	private static final int BATCH_SIZE = 1_000;
	private static final int PARENT_EXIT_GRACE_SECONDS = 10;
	private static final String TOKEN_ENV = "OMP_GHIDRA_BRIDGE_TOKEN";
	private static final String PARENT_PID_ENV = "OMP_GHIDRA_PARENT_PID";
	private static final String PARENT_WATCH_OWNER_PREFIX = "omp.ghidra.parent-watch.";
	private static final Pattern FORBIDDEN_SQL = Pattern.compile(
		"(?is)(?:;\\s*\\S|\\b(?:insert|update|delete|merge|create|drop|alter|truncate|call|runscript|script|backup|shutdown|grant|revoke|set)\\b)"
	);
	private static final Pattern EXPANSIVE_SQL = Pattern.compile(
		"(?i)(?:\\|\\||\\b(?:array_agg|json_arrayagg|json_objectagg|listagg|string_agg|group_concat|array_cat|array_append|concat|concat_ws|rawtohex|base64_encode|base64_decode|base64encode|base64decode|quote_ident|insert|repeat|space|lpad|rpad|secure_rand|expand|compress|encrypt|decrypt|hash|overlay|replace|regexp_replace|stringdecode|stringencode|stringtoutf8|utf8tostring|xmlattr|xmlnode|xmlcomment|xmlcdata|xmlstartdoc|xmltext|json_object|json_array|system_range|unnest|csvread|link_schema|table)\\s*\\()"
	);
	private static final Pattern UNBOUNDED_SQL = Pattern.compile("(?is)(?:\\bcross\\s+join\\b|\\brecursive\\b)");
	private static final Pattern DECOMPILE_ADDRESS = Pattern.compile(
		"(?i)\\baddress\\s*=\\s*(0x[0-9a-f]+|[0-9]+)"
	);
	private static final Pattern DECOMPILE_ADDRESS_HEX = Pattern.compile(
		"(?i)\\baddress_hex\\s*=\\s*'((?:''|[^'])+)'"
	);
	private static final Pattern DECOMPILE_NAME = Pattern.compile(
		"(?i)\\bname\\s*=\\s*'((?:''|[^'])+)'"
	);

	@Override
	public void run() throws Exception {
		String[] args = getScriptArgs();
		if (args.length != 6) {
			throw new IllegalArgumentException(
				"OmpGhidraBridge requires: <port> <ready-file> <script-dir> <target-id> <database-path> <temporary>"
			);
		}
		int port = Integer.parseInt(args[0]);
		if (port < 0 || port > 65535) throw new IllegalArgumentException("Invalid bridge port: " + port);
		String token = System.getenv(TOKEN_ENV);
		if (token == null || token.isBlank()) throw new IllegalArgumentException(TOKEN_ENV + " is required");
		Path readyFile = Path.of(args[1]).toAbsolutePath().normalize();
		Path scriptDirectory = Path.of(args[2]).toAbsolutePath().normalize();
		Files.createDirectories(scriptDirectory);

		// GhidraScript opens one transaction around run(). A server must not hold that
		// transaction for its full lifetime; request scripts own short transactions.
		end(true);
		new Bridge(port, token, readyFile, scriptDirectory, args[3], args[4], Boolean.parseBoolean(args[5])).serve();
	}

	private final class Bridge {
		private final int port;
		private final String token;
		private final Path readyFile;
		private final Path scriptDirectory;
		private final String targetId;
		private final String databasePath;
		private final boolean temporary;
		private final CountDownLatch closing = new CountDownLatch(1);
		private HttpServer server;
		private ExecutorService executor;
		private QueryBudget activeQueryBudget;

		Bridge(int port, String token, Path readyFile, Path scriptDirectory, String targetId, String databasePath, boolean temporary) {
			this.port = port;
			this.token = token;
			this.readyFile = readyFile;
			this.scriptDirectory = scriptDirectory;
			this.targetId = targetId;
			this.databasePath = databasePath;
			this.temporary = temporary;
		}

		void serve() throws Exception {
			server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 0);
			executor = Executors.newSingleThreadExecutor(runnable -> {
				Thread thread = new Thread(runnable, "omp-ghidra-bridge");
				thread.setDaemon(true);
				return thread;
			});
			server.setExecutor(executor);
			server.createContext("/health", this::handle);
			server.createContext("/query", this::handle);
			server.createContext("/execute", this::handle);
			server.createContext("/save", this::handle);
			server.createContext("/close", this::handle);
			server.start();
			watchParentProcess();
			System.setProperty(PARENT_WATCH_OWNER_PREFIX + targetId, "bridge");
			try {
				Files.writeString(readyFile, String.valueOf(server.getAddress().getPort()), StandardCharsets.UTF_8);
				println("OMP_GHIDRA_READY " + targetId + " " + server.getAddress().getPort());
				while (!closing.await(500, TimeUnit.MILLISECONDS)) monitor.checkCancelled();
			}
			finally {
				Files.deleteIfExists(readyFile);
				server.stop(0);
				executor.shutdownNow();
				executor.awaitTermination(2, TimeUnit.SECONDS);
				cleanupScriptDirectory();
				registerTemporaryProjectCleanup();
			}
		}


		private void watchParentProcess() {
			String rawPid = System.getenv(PARENT_PID_ENV);
			if (rawPid == null || rawPid.isBlank()) return;
			final long parentPid;
			try {
				parentPid = Long.parseLong(rawPid);
			}
			catch (NumberFormatException exception) {
				throw new IllegalArgumentException(PARENT_PID_ENV + " must contain a process ID", exception);
			}
			Thread watcher = new Thread(() -> {
				try {
					while (!closing.await(1, TimeUnit.SECONDS)) {
						if (ProcessHandle.of(parentPid).map(ProcessHandle::isAlive).orElse(false)) continue;
						closing.countDown();
						try {
							Thread.sleep(TimeUnit.SECONDS.toMillis(PARENT_EXIT_GRACE_SECONDS));
						}
						catch (InterruptedException exception) {
							Thread.currentThread().interrupt();
						}
						cleanupTemporaryProjectNow();
						Runtime.getRuntime().halt(143);
						return;
					}
				}
				catch (InterruptedException exception) {
					Thread.currentThread().interrupt();
				}
			}, "omp-ghidra-parent-watch");
			watcher.setDaemon(true);
			watcher.start();
		}

		private void cleanupScriptDirectory() {
			try (var entries = Files.list(scriptDirectory)) {
				for (Path entry : entries.toList()) Files.deleteIfExists(entry);
			}
			catch (IOException ignored) {
				// The TypeScript supervisor retries cleanup after the process exits.
			}
			try {
				Files.deleteIfExists(scriptDirectory);
			}
			catch (IOException ignored) {
				// The TypeScript supervisor retries cleanup after the process exits.
			}
		}

		private void registerTemporaryProjectCleanup() {
			if (!temporary) return;
			Path projectRoot = Path.of(databasePath).toAbsolutePath().normalize().getParent();
			if (projectRoot == null) return;
			try (var entries = Files.walk(projectRoot)) {
				for (Path entry : entries.toList()) entry.toFile().deleteOnExit();
			}
			catch (IOException ignored) {
				// The TypeScript supervisor removes the project during normal shutdown.
			}
		}

		private void cleanupTemporaryProjectNow() {
			if (!temporary) return;
			Path projectRoot = Path.of(databasePath).toAbsolutePath().normalize().getParent();
			if (projectRoot == null) return;
			try (var entries = Files.walk(projectRoot)) {
				for (Path entry : entries.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(entry);
			}
			catch (IOException ignored) {
				// Best effort before the parent-death hard stop.
			}
		}

		private void handle(HttpExchange exchange) throws IOException {
			boolean closeAfterResponse = false;
			try {
				if (!authorized(exchange)) {
					writeJson(exchange, 401, error("Unauthorized"));
					return;
				}
				String route = exchange.getRequestURI().getPath();
				String method = exchange.getRequestMethod();
				JsonObject response;
				if (route.equals("/health") && method.equals("GET")) {
					response = health();
				}
				else if (route.equals("/query") && method.equals("POST")) {
					JsonObject request = readRequest(exchange);
					response = query(requiredString(request, "sql"), optionalInt(request, "timeout_sec", 30));
				}
				else if (route.equals("/execute") && method.equals("POST")) {
					response = execute(requiredString(readRequest(exchange), "code"));
				}
				else if (route.equals("/save") && method.equals("POST")) {
					readRequest(exchange);
					saveProgram();
					response = ok();
					response.addProperty("saved", true);
				}
				else if (route.equals("/close") && method.equals("POST")) {
					readRequest(exchange);
					saveProgram();
					response = ok();
					response.addProperty("closed", true);
					closeAfterResponse = true;
				}
				else {
					writeJson(exchange, 404, error("Unknown route"));
					return;
				}
				writeJson(exchange, 200, response);
			}
			catch (IllegalArgumentException exception) {
				writeJson(exchange, 400, error(exception.getMessage()));
			}
			catch (Exception exception) {
				writeJson(exchange, 500, error(exception.getClass().getSimpleName() + ": " + exception.getMessage()));
			}
			finally {
				if (closeAfterResponse) closing.countDown();
			}
		}

		private boolean authorized(HttpExchange exchange) {
			String authorization = exchange.getRequestHeaders().getFirst("Authorization");
			return Objects.equals(authorization, "Bearer " + token);
		}

		private JsonObject health() {
			JsonObject response = ok();
			JsonObject target = new JsonObject();
			target.addProperty("id", targetId);
			target.addProperty("backend", "ghidra");
			target.addProperty("label", currentProgram.getName());
			target.addProperty("database_path", databasePath);
			target.addProperty("runtime", "ghidra-headless");
			target.addProperty("version", Application.getApplicationVersion());
			target.addProperty("processor", currentProgram.getLanguage().getProcessor().toString());
			target.addProperty("bits", currentProgram.getDefaultPointerSize() * 8);
			target.addProperty("pid", ProcessHandle.current().pid());
			JsonObject metadata = new JsonObject();
			metadata.addProperty("program", currentProgram.getDomainFile().getPathname());
			metadata.addProperty("executable_path", currentProgram.getExecutablePath());
			metadata.addProperty("executable_format", currentProgram.getExecutableFormat());
			metadata.addProperty("language_id", currentProgram.getLanguageID().getIdAsString());
			metadata.addProperty("compiler_spec", currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString());
			metadata.addProperty("image_base", addressHex(currentProgram.getImageBase()));
			metadata.addProperty("temporary_database", temporary);
			metadata.addProperty("managed_by_omp", true);
			target.add("metadata", metadata);
			response.add("target", target);
			return response;
		}

		private JsonObject query(String sql, int timeoutSec) throws Exception {
			String structure = sqlStructure(sql);
			validateQuery(structure);
			int boundedTimeout = Math.max(1, Math.min(timeoutSec, 300));
			String database = "omp_" + UUID.randomUUID().toString().replace("-", "");
			String ownerPassword = UUID.randomUUID().toString();
			String queryPassword = UUID.randomUUID().toString();
			String url = "jdbc:h2:mem:" + database;
			activeQueryBudget = new QueryBudget(boundedTimeout);
			try (Connection owner = connect(url, "OMP_OWNER", ownerPassword)) {
				createSchema(owner);
				populateReferencedTables(owner, sql, structure, boundedTimeout);
				activeQueryBudget.checkpoint();
				try (Statement statement = owner.createStatement()) {
					statement.execute("CREATE USER OMP_QUERY PASSWORD '" + queryPassword + "'");
					statement.execute("GRANT SELECT ON SCHEMA PUBLIC TO OMP_QUERY");
				}
				try (Connection queryConnection = connect(url, "OMP_QUERY", queryPassword)) {
					queryConnection.setReadOnly(true);
					try (Statement statement = queryConnection.createStatement()) {
						statement.setQueryTimeout(boundedTimeout);
						statement.setMaxRows(MAX_QUERY_ROWS + 1);
						try (ResultSet resultSet = statement.executeQuery(sql)) {
							return encodeRows(resultSet);
						}
					}
				}
			}
			finally {
				activeQueryBudget = null;
			}
		}

		private Connection connect(String url, String user, String password) throws Exception {
			Properties properties = new Properties();
			properties.setProperty("user", user);
			properties.setProperty("password", password);
			Connection connection = Driver.load().connect(url, properties);
			if (connection == null) throw new IllegalStateException("H2 rejected its in-memory database URL");
			return connection;
		}

		private JsonObject execute(String code) throws Exception {
			if (code.isBlank()) throw new IllegalArgumentException("code must not be empty");
			String className = "OmpGhidraRequest_" + UUID.randomUUID().toString().replace("-", "");
			Path sourcePath = scriptDirectory.resolve(className + ".java");
			Path resultPath = scriptDirectory.resolve(className + ".result.json");
			Files.writeString(sourcePath, userScript(className, resultPath, code), StandardCharsets.UTF_8);
			BoundedWriter stdoutBuffer = new BoundedWriter(MAX_NATIVE_OUTPUT_CHARS);
			BoundedWriter stderrBuffer = new BoundedWriter(MAX_NATIVE_OUTPUT_CHARS);
			PrintWriter previousWriter = writer;
			PrintWriter previousErrorWriter = errorWriter;
			writer = new PrintWriter(stdoutBuffer, true);
			errorWriter = new PrintWriter(stderrBuffer, true);
			JsonElement result = JsonNull.INSTANCE;
			try {
				runScript(sourcePath.getFileName().toString(), state);
				if (Files.exists(resultPath)) result = JsonParser.parseString(Files.readString(resultPath, StandardCharsets.UTF_8));
			}
			catch (Exception exception) {
				String output = stdoutBuffer.toString().trim();
				String errors = stderrBuffer.toString().trim();
				String detail = errors.isEmpty() ? output : errors;
				throw new IllegalArgumentException(
					"Ghidra Java execution failed: " + exception.getMessage() + (detail.isEmpty() ? "" : "\n" + detail),
					exception
				);
			}
			finally {
				writer.flush();
				errorWriter.flush();
				writer = previousWriter;
				errorWriter = previousErrorWriter;
				Files.deleteIfExists(sourcePath);
				Files.deleteIfExists(resultPath);
			}

			JsonObject response = ok();
			response.add("result", result);
			response.addProperty("stdout", stdoutBuffer.toString().stripTrailing());
			response.addProperty("stderr", stderrBuffer.toString().stripTrailing());
			response.addProperty("output_truncated", stdoutBuffer.isTruncated() || stderrBuffer.isTruncated());
			response.addProperty("language", "Ghidra Java");
			return response;
		}

		private void saveProgram() throws Exception {
			OmpGhidraBridge.this.saveProgram(currentProgram);
			currentProgram.setTemporary(true);
			end(true);
		}

		private void validateQuery(String structure) {
			String trimmed = structure.stripLeading();
			if (trimmed.isEmpty()) throw new IllegalArgumentException("sql must not be empty");
			String lower = trimmed.toLowerCase(Locale.ROOT);
			if (!(lower.startsWith("select") || lower.startsWith("with") || lower.startsWith("explain"))) {
				throw new IllegalArgumentException("Ghidra query accepts read-only SELECT, WITH, or EXPLAIN statements");
			}
			if (trimmed.length() > MAX_QUERY_SQL_CHARS) {
				throw new IllegalArgumentException("Ghidra query exceeds 64 KiB");
			}
			if (FORBIDDEN_SQL.matcher(trimmed).find()) {
				throw new IllegalArgumentException("Ghidra query is read-only and accepts one statement");
			}
			if (EXPANSIVE_SQL.matcher(trimmed).find()) {
				throw new IllegalArgumentException("Ghidra query uses a resource-intensive SQL function");
			}
			if (UNBOUNDED_SQL.matcher(trimmed).find()) {
				throw new IllegalArgumentException("Ghidra query uses an unbounded SQL plan");
			}
		}

		private String sqlStructure(String sql) {
			StringBuilder output = new StringBuilder(sql.length());
			boolean quoted = false;
			boolean lineComment = false;
			boolean blockComment = false;
			for (int index = 0; index < sql.length(); index++) {
				char value = sql.charAt(index);
				char next = index + 1 < sql.length() ? sql.charAt(index + 1) : '\0';
				if (lineComment) {
					if (value == '\n' || value == '\r') {
						lineComment = false;
						output.append(value);
					} else output.append(' ');
					continue;
				}
				if (blockComment) {
					output.append(' ');
					if (value == '*' && next == '/') {
						output.append(' ');
						index++;
						blockComment = false;
					}
					continue;
				}
				if (quoted) {
					output.append(' ');
					if (value == '\'' && next == '\'') {
						output.append(' ');
						index++;
					} else if (value == '\'') quoted = false;
					continue;
				}
				if (value == '\'') {
					quoted = true;
					output.append(' ');
				} else if (value == '-' && next == '-') {
					lineComment = true;
					output.append("  ");
					index++;
				} else if (value == '/' && next == '*') {
					blockComment = true;
					output.append("  ");
					index++;
				} else output.append(value);
			}
			if (quoted || blockComment) throw new IllegalArgumentException("sql contains an unterminated literal or comment");
			return output.toString();
		}

		private void createSchema(Connection connection) throws Exception {
			try (Statement statement = connection.createStatement()) {
				statement.execute("CREATE TABLE metadata (meta_key VARCHAR, meta_value VARCHAR)");
				statement.execute("CREATE TABLE segments (start_address BIGINT, start_hex VARCHAR, end_address BIGINT, end_hex VARCHAR, name VARCHAR, size BIGINT, is_read BOOLEAN, is_write BOOLEAN, is_execute BOOLEAN, is_initialized BOOLEAN)");
				statement.execute("CREATE TABLE funcs (address BIGINT, address_hex VARCHAR, end_address BIGINT, end_hex VARCHAR, name VARCHAR, namespace VARCHAR, signature VARCHAR, return_type VARCHAR, is_external BOOLEAN, is_thunk BOOLEAN)");
				statement.execute("CREATE VIEW functions AS SELECT * FROM funcs");
				statement.execute("CREATE TABLE names (address BIGINT, address_hex VARCHAR, name VARCHAR, namespace VARCHAR, symbol_type VARCHAR, source_type VARCHAR, is_primary BOOLEAN, is_external BOOLEAN)");
				statement.execute("CREATE VIEW symbols AS SELECT * FROM names");
				statement.execute("CREATE TABLE strings (address BIGINT, address_hex VARCHAR, string_value VARCHAR, length INT, data_type VARCHAR)");
				statement.execute("CREATE TABLE instructions (address BIGINT, address_hex VARCHAR, mnemonic VARCHAR, operands VARCHAR, bytes VARCHAR, length INT, flow_type VARCHAR, function_address BIGINT, function_hex VARCHAR)");
				statement.execute("CREATE VIEW disasm AS SELECT * FROM instructions");
				statement.execute("CREATE TABLE xrefs (from_address BIGINT, from_hex VARCHAR, to_address BIGINT, to_hex VARCHAR, reference_type VARCHAR, operand_index INT, is_primary BOOLEAN)");
				statement.execute("CREATE TABLE imports (address BIGINT, address_hex VARCHAR, name VARCHAR, library VARCHAR, namespace VARCHAR)");
				statement.execute("CREATE TABLE exports (address BIGINT, address_hex VARCHAR, name VARCHAR, namespace VARCHAR)");
				statement.execute("CREATE TABLE comments (address BIGINT, address_hex VARCHAR, eol VARCHAR, pre VARCHAR, post VARCHAR, plate VARCHAR, repeatable VARCHAR)");
				statement.execute("CREATE TABLE data_items (address BIGINT, address_hex VARCHAR, length INT, data_type VARCHAR, data_value VARCHAR)");
				statement.execute("CREATE TABLE decompile (address BIGINT, address_hex VARCHAR, name VARCHAR, signature VARCHAR, c VARCHAR, error VARCHAR)");
				statement.execute("CREATE TABLE table_catalog (table_name VARCHAR, description VARCHAR)");
			}
			populateCatalog(connection);
		}

		private void populateReferencedTables(Connection connection, String sql, String structure, int timeoutSec) throws Exception {
			if (mentions(structure, "metadata")) populateMetadata(connection);
			if (mentions(structure, "segments")) populateSegments(connection);
			if (mentionsAny(structure, "funcs", "functions")) populateFunctions(connection);
			if (mentionsAny(structure, "names", "symbols")) populateNames(connection);
			if (mentions(structure, "strings")) populateStrings(connection);
			if (mentionsAny(structure, "instructions", "disasm")) populateInstructions(connection);
			if (mentions(structure, "xrefs")) populateXrefs(connection);
			if (mentions(structure, "imports")) populateImports(connection);
			if (mentions(structure, "exports")) populateExports(connection);
			if (mentions(structure, "comments")) populateComments(connection);
			if (mentions(structure, "data_items")) populateDataItems(connection);
			if (mentions(structure, "decompile")) populateDecompile(connection, sql, timeoutSec);
		}

		private void checkQueryBudget() throws Exception {
			if (activeQueryBudget == null) throw new IllegalStateException("Ghidra query budget is unavailable");
			activeQueryBudget.checkpoint();
		}

		private int remainingQuerySeconds() throws Exception {
			if (activeQueryBudget == null) throw new IllegalStateException("Ghidra query budget is unavailable");
			return activeQueryBudget.remainingSeconds();
		}

		private final class QueryBudget {
			private final long deadlineNanos;
			private int steps;
			private int textChars;

			QueryBudget(int timeoutSec) {
				deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSec);
			}

			void checkpoint() throws Exception {
				if (++steps > MAX_MATERIALIZATION_STEPS) {
					throw new IllegalArgumentException("Ghidra query exceeded the materialization limit");
				}
				if (steps == 1 || steps % BATCH_SIZE == 0) monitor.checkCancelled();
				if (System.nanoTime() >= deadlineNanos) {
					throw new IllegalArgumentException("Ghidra query timed out during table materialization");
				}
			}

			void accountText(String value) {
				if (value.length() > MAX_MATERIALIZED_TEXT_CHARS - textChars) {
					throw new IllegalArgumentException("Ghidra query exceeded the materialized text limit");
				}
				textChars += value.length();
			}

			int remainingSeconds() throws Exception {
				checkpoint();
				long remainingNanos = deadlineNanos - System.nanoTime();
				if (remainingNanos <= 0) throw new IllegalArgumentException("Ghidra query timed out during table materialization");
				return Math.max(1, (int) Math.min(300, (remainingNanos + 999_999_999L) / 1_000_000_000L));
			}
		}

		private void populateCatalog(Connection connection) throws Exception {
			String[][] rows = {
				{"metadata", "Program metadata as key/value rows"},
				{"segments", "Memory blocks and permissions"},
				{"funcs", "Functions; alias: functions"},
				{"names", "Symbols and labels; alias: symbols"},
				{"strings", "Defined string data"},
				{"instructions", "Decoded instructions; alias: disasm"},
				{"xrefs", "All references"},
				{"imports", "External functions"},
				{"exports", "External entry points"},
				{"comments", "EOL, pre, post, plate, and repeatable comments"},
				{"data_items", "Defined data"},
				{"decompile", "Decompiler output; requires an address or name equality predicate"},
				{"table_catalog", "Available query tables"},
			};
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO table_catalog VALUES (?, ?)") ) {
				for (String[] row : rows) {
					checkQueryBudget();
					setText(statement, 1, row[0]);
					setText(statement, 2, row[1]);
					statement.addBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateMetadata(Connection connection) throws Exception {
			Map<String, String> values = new LinkedHashMap<>();
			values.put("name", currentProgram.getName());
			values.put("domain_path", currentProgram.getDomainFile().getPathname());
			values.put("executable_path", currentProgram.getExecutablePath());
			values.put("executable_format", currentProgram.getExecutableFormat());
			values.put("language_id", currentProgram.getLanguageID().getIdAsString());
			values.put("compiler_spec", currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString());
			values.put("processor", currentProgram.getLanguage().getProcessor().toString());
			values.put("bits", String.valueOf(currentProgram.getDefaultPointerSize() * 8));
			values.put("image_base", addressHex(currentProgram.getImageBase()));
			values.put("min_address", addressHex(currentProgram.getMinAddress()));
			values.put("max_address", addressHex(currentProgram.getMaxAddress()));
			values.put("ghidra_version", Application.getApplicationVersion());
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO metadata VALUES (?, ?)") ) {
				for (Map.Entry<String, String> entry : values.entrySet()) {
					checkQueryBudget();
					setText(statement, 1, entry.getKey());
					setText(statement, 2, entry.getValue());
					statement.addBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateSegments(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)") ) {
				for (MemoryBlock block : currentProgram.getMemory().getBlocks()) {
					checkQueryBudget();
					setAddress(statement, 1, block.getStart());
					setAddress(statement, 3, block.getEnd());
					setText(statement, 5, block.getName());
					statement.setLong(6, block.getSize());
					statement.setBoolean(7, block.isRead());
					statement.setBoolean(8, block.isWrite());
					statement.setBoolean(9, block.isExecute());
					statement.setBoolean(10, block.isInitialized());
					statement.addBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateFunctions(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO funcs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)") ) {
				int pending = 0;
				Set<String> seen = new LinkedHashSet<>();
				FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
				while (functions.hasNext()) {
					Function function = functions.next();
					insertFunction(statement, function, seen);
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				FunctionIterator externals = currentProgram.getFunctionManager().getExternalFunctions();
				while (externals.hasNext()) {
					insertFunction(statement, externals.next(), seen);
				}
				statement.executeBatch();
			}
		}

		private void insertFunction(PreparedStatement statement, Function function, Set<String> seen) throws Exception {
			checkQueryBudget();
			Address address = function.getEntryPoint();
			String identity = address.toString() + "\u0000" + function.getName(true);
			if (!seen.add(identity)) return;
			setAddress(statement, 1, address);
			Address end = function.getBody().getMaxAddress();
			setNullableAddress(statement, 3, end);
			setText(statement, 5, function.getName());
			setText(statement, 6, function.getParentNamespace().getName(true));
			setText(statement, 7, function.getPrototypeString(false, true));
			setText(statement, 8, function.getReturnType() == null ? null : function.getReturnType().getDisplayName());
			statement.setBoolean(9, function.isExternal());
			statement.setBoolean(10, function.isThunk());
			statement.addBatch();
		}

		private void populateNames(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO names VALUES (?, ?, ?, ?, ?, ?, ?, ?)") ) {
				int pending = 0;
				SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
				while (symbols.hasNext()) {
					checkQueryBudget();
					Symbol symbol = symbols.next();
					setAddress(statement, 1, symbol.getAddress());
					setText(statement, 3, symbol.getName());
					setText(statement, 4, symbol.getParentNamespace().getName(true));
					setText(statement, 5, symbol.getSymbolType().toString());
					setText(statement, 6, symbol.getSource().toString());
					statement.setBoolean(7, symbol.isPrimary());
					statement.setBoolean(8, symbol.isExternal());
					statement.addBatch();
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateStrings(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO strings VALUES (?, ?, ?, ?, ?)") ) {
				int pending = 0;
				DataIterator data = currentProgram.getListing().getDefinedData(true);
				while (data.hasNext()) {
					checkQueryBudget();
					Data item = data.next();
					Object value = item.getValue();
					if (!(value instanceof String text)) continue;
					setAddress(statement, 1, item.getAddress());
					setText(statement, 3, text);
					statement.setInt(4, item.getLength());
					setText(statement, 5, item.getDataType().getDisplayName());
					statement.addBatch();
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateInstructions(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO instructions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)") ) {
				int pending = 0;
				InstructionIterator instructions = currentProgram.getListing().getInstructions(true);
				while (instructions.hasNext()) {
					checkQueryBudget();
					Instruction instruction = instructions.next();
					setAddress(statement, 1, instruction.getAddress());
					setText(statement, 3, instruction.getMnemonicString());
					List<String> operands = new ArrayList<>();
					for (int index = 0; index < instruction.getNumOperands(); index++) {
						operands.add(instruction.getDefaultOperandRepresentation(index));
					}
					setText(statement, 4, String.join(", ", operands));
					try {
						setText(statement, 5, bytesHex(instruction.getBytes()));
					}
					catch (Exception ignored) {
						setText(statement, 5, null);
					}
					statement.setInt(6, instruction.getLength());
					setText(statement, 7, instruction.getFlowType().toString());
					Function function = currentProgram.getFunctionManager().getFunctionContaining(instruction.getAddress());
					setNullableAddress(statement, 8, function == null ? null : function.getEntryPoint());
					statement.addBatch();
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateXrefs(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO xrefs VALUES (?, ?, ?, ?, ?, ?, ?)") ) {
				int pending = 0;
				ReferenceIterator references = currentProgram.getReferenceManager().getReferenceIterator(currentProgram.getMinAddress());
				while (references.hasNext()) {
					checkQueryBudget();
					Reference reference = references.next();
					setAddress(statement, 1, reference.getFromAddress());
					setAddress(statement, 3, reference.getToAddress());
					setText(statement, 5, reference.getReferenceType().toString());
					statement.setInt(6, reference.getOperandIndex());
					statement.setBoolean(7, reference.isPrimary());
					statement.addBatch();
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateImports(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO imports VALUES (?, ?, ?, ?, ?)") ) {
				FunctionIterator functions = currentProgram.getFunctionManager().getExternalFunctions();
				while (functions.hasNext()) {
					checkQueryBudget();
					Function function = functions.next();
					setAddress(statement, 1, function.getEntryPoint());
					setText(statement, 3, function.getName());
					setText(statement, 4, function.getParentNamespace().getName());
					setText(statement, 5, function.getParentNamespace().getName(true));
					statement.addBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateExports(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO exports VALUES (?, ?, ?, ?)") ) {
				AddressIterator addresses = currentProgram.getSymbolTable().getExternalEntryPointIterator();
				while (addresses.hasNext()) {
					checkQueryBudget();
					Address address = addresses.next();
					Symbol symbol = currentProgram.getSymbolTable().getPrimarySymbol(address);
					setAddress(statement, 1, address);
					setText(statement, 3, symbol == null ? null : symbol.getName());
					setText(statement, 4, symbol == null ? null : symbol.getParentNamespace().getName(true));
					statement.addBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateComments(Connection connection) throws Exception {
			Listing listing = currentProgram.getListing();
			CommentType[] types = { CommentType.EOL, CommentType.PRE, CommentType.POST, CommentType.PLATE, CommentType.REPEATABLE };
			AddressIterator[] iterators = new AddressIterator[types.length];
			Address[] next = new Address[types.length];
			for (int index = 0; index < types.length; index++) {
				iterators[index] = listing.getCommentAddressIterator(types[index], currentProgram.getMemory(), true);
				if (iterators[index].hasNext()) next[index] = iterators[index].next();
			}
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?)") ) {
				int pending = 0;
				while (true) {
					checkQueryBudget();
					Address address = null;
					for (Address candidate : next) {
						if (candidate != null && (address == null || candidate.compareTo(address) < 0)) address = candidate;
					}
					if (address == null) break;
					setAddress(statement, 1, address);
					for (int index = 0; index < types.length; index++) {
						String comment = null;
						if (address.equals(next[index])) {
							comment = listing.getComment(types[index], address);
							next[index] = iterators[index].hasNext() ? iterators[index].next() : null;
						}
						setText(statement, index + 3, comment);
					}
					statement.addBatch();
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateDataItems(Connection connection) throws Exception {
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO data_items VALUES (?, ?, ?, ?, ?)") ) {
				int pending = 0;
				DataIterator data = currentProgram.getListing().getDefinedData(true);
				while (data.hasNext()) {
					checkQueryBudget();
					Data item = data.next();
					setAddress(statement, 1, item.getAddress());
					statement.setInt(3, item.getLength());
					setText(statement, 4, item.getDataType().getDisplayName());
					setText(statement, 5, item.getDefaultValueRepresentation());
					statement.addBatch();
					if (++pending % BATCH_SIZE == 0) statement.executeBatch();
				}
				statement.executeBatch();
			}
		}

		private void populateDecompile(Connection connection, String sql, int timeoutSec) throws Exception {
			List<Function> functions = resolveDecompileFunctions(sql);
			if (functions.isEmpty()) {
				throw new IllegalArgumentException(
					"decompile requires WHERE address = <integer>, address_hex = '0x...', or name = 'function'"
				);
			}
			DecompInterface decompiler = new DecompInterface();
			if (!decompiler.openProgram(currentProgram)) throw new IllegalStateException("Ghidra decompiler could not open the program");
			try (PreparedStatement statement = connection.prepareStatement("INSERT INTO decompile VALUES (?, ?, ?, ?, ?, ?)") ) {
				for (Function function : functions) {
					checkQueryBudget();
					setAddress(statement, 1, function.getEntryPoint());
					setText(statement, 3, function.getName());
					setText(statement, 4, function.getPrototypeString(false, true));
					DecompileResults results = decompiler.decompileFunction(function, remainingQuerySeconds(), monitor);
					if (results.decompileCompleted() && results.getDecompiledFunction() != null) {
						setText(statement, 5, results.getDecompiledFunction().getC());
						setText(statement, 6, null);
					}
					else {
						setText(statement, 5, null);
						setText(statement, 6, results.getErrorMessage());
					}
					statement.addBatch();
				}
				statement.executeBatch();
			}
			finally {
				decompiler.dispose();
			}
		}

		private List<Function> resolveDecompileFunctions(String sql) throws Exception {
			Set<Function> functions = new LinkedHashSet<>();
			Matcher numeric = DECOMPILE_ADDRESS.matcher(sql);
			while (numeric.find()) {
				checkQueryBudget();
				Address address = parseAddress(numeric.group(1));
				Function function = currentProgram.getFunctionManager().getFunctionContaining(address);
				if (function == null) function = currentProgram.getFunctionManager().getFunctionAt(address);
				if (function != null && !function.isExternal()) functions.add(function);
			}
			Matcher hexadecimal = DECOMPILE_ADDRESS_HEX.matcher(sql);
			while (hexadecimal.find()) {
				checkQueryBudget();
				Address address = parseAddress(hexadecimal.group(1).replace("''", "'"));
				Function function = currentProgram.getFunctionManager().getFunctionContaining(address);
				if (function == null) function = currentProgram.getFunctionManager().getFunctionAt(address);
				if (function != null && !function.isExternal()) functions.add(function);
			}
			Matcher named = DECOMPILE_NAME.matcher(sql);
			while (named.find()) {
				checkQueryBudget();
				String wanted = named.group(1).replace("''", "'");
				FunctionIterator iterator = currentProgram.getFunctionManager().getFunctions(true);
				while (iterator.hasNext() && functions.size() < 32) {
					checkQueryBudget();
					Function function = iterator.next();
					if (function.getName().equals(wanted)) functions.add(function);
				}
			}
			if (functions.size() > 32) throw new IllegalArgumentException("decompile is limited to 32 functions per query");
			return new ArrayList<>(functions);
		}

		private Address parseAddress(String value) {
			String normalized = value.trim().toLowerCase(Locale.ROOT);
			long offset = normalized.startsWith("0x")
				? Long.parseUnsignedLong(normalized.substring(2), 16)
				: Long.parseUnsignedLong(normalized, 10);
			return currentProgram.getAddressFactory().getDefaultAddressSpace().getAddress(offset);
		}

		private JsonObject encodeRows(ResultSet resultSet) throws Exception {
			ResultSetMetaData metadata = resultSet.getMetaData();
			int columnCount = metadata.getColumnCount();
			JsonArray columns = new JsonArray();
			List<String> labels = new ArrayList<>();
			for (int index = 1; index <= columnCount; index++) {
				String label = metadata.getColumnLabel(index).toLowerCase(Locale.ROOT);
				labels.add(label);
				columns.add(label);
			}
			JsonArray rows = new JsonArray();
			boolean truncated = false;
			int count = 0;
			int outputChars = columns.toString().length();
			while (resultSet.next()) {
				if (count++ >= MAX_QUERY_ROWS) {
					truncated = true;
					break;
				}
				JsonObject row = new JsonObject();
				for (int index = 1; index <= columnCount; index++) {
				checkQueryBudget();
					Object raw = resultSet.getObject(index);
					if (raw instanceof String text && text.length() > MAX_QUERY_CELL_CHARS) truncated = true;
					if (raw instanceof byte[] bytes && bytes.length > MAX_QUERY_CELL_CHARS / 2) truncated = true;
					row.add(labels.get(index - 1), jsonValue(raw));
				}
				int rowChars = row.toString().length();
				if (outputChars + rowChars > MAX_QUERY_OUTPUT_CHARS) {
					truncated = true;
					break;
				}
				outputChars += rowChars;
				rows.add(row);
			}
			JsonObject response = ok();
			response.add("columns", columns);
			response.add("rows", rows);
			response.addProperty("truncated", truncated);
			return response;
		}

		private JsonElement jsonValue(Object value) {
			if (value == null) return JsonNull.INSTANCE;
			if (value instanceof byte[] bytes) {
				String encoded = Base64.getEncoder().encodeToString(bytes);
				return GSON.toJsonTree(truncate(encoded, MAX_QUERY_CELL_CHARS));
			}
			if (value instanceof String text) return GSON.toJsonTree(truncate(text, MAX_QUERY_CELL_CHARS));
			return GSON.toJsonTree(value);
		}

		private String truncate(String value, int limit) {
			return value.length() <= limit ? value : value.substring(0, limit);
		}

		private void setText(PreparedStatement statement, int index, String value) throws Exception {
			String bounded = value == null ? null : truncate(value, MAX_QUERY_CELL_CHARS);
			if (bounded != null) {
				if (activeQueryBudget == null) throw new IllegalStateException("Ghidra query budget is unavailable");
				activeQueryBudget.accountText(bounded);
			}
			statement.setString(index, bounded);
		}

		private boolean mentions(String sql, String table) {
			return Pattern.compile("(?i)\\b" + Pattern.quote(table) + "\\b").matcher(sql).find();
		}

		private boolean mentionsAny(String sql, String... tables) {
			for (String table : tables) if (mentions(sql, table)) return true;
			return false;
		}

		private void setAddress(PreparedStatement statement, int index, Address address) throws Exception {
			statement.setLong(index, address.getOffset());
			setText(statement, index + 1, addressHex(address));
		}

		private void setNullableAddress(PreparedStatement statement, int index, Address address) throws Exception {
			if (address == null) {
				statement.setObject(index, null);
				setText(statement, index + 1, null);
			}
			else setAddress(statement, index, address);
		}

		private JsonObject readRequest(HttpExchange exchange) throws IOException {
			ByteArrayOutputStream output = new ByteArrayOutputStream();
			byte[] buffer = new byte[8192];
			int total = 0;
			int read;
			while ((read = exchange.getRequestBody().read(buffer)) >= 0) {
				total += read;
				if (total > MAX_REQUEST_BYTES) throw new IllegalArgumentException("Request body exceeds 2 MiB");
				output.write(buffer, 0, read);
			}
			if (total == 0) return new JsonObject();
			JsonElement parsed = JsonParser.parseString(output.toString(StandardCharsets.UTF_8));
			if (!parsed.isJsonObject()) throw new IllegalArgumentException("Request body must be a JSON object");
			return parsed.getAsJsonObject();
		}

		private void writeJson(HttpExchange exchange, int status, JsonObject value) throws IOException {
			byte[] body = GSON.toJson(value).getBytes(StandardCharsets.UTF_8);
			if (body.length > MAX_RESPONSE_BYTES) {
				status = 500;
				body = GSON.toJson(error("Ghidra bridge response exceeded 4 MiB")).getBytes(StandardCharsets.UTF_8);
			}
			exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
			exchange.sendResponseHeaders(status, body.length);
			try (var response = exchange.getResponseBody()) {
				response.write(body);
			}
		}
	}

	private static String userScript(String className, Path resultPath, String code) {
		return String.join("\n",
			"import com.google.gson.*;",
			"import ghidra.app.decompiler.*;",
			"import ghidra.app.script.GhidraScript;",
			"import ghidra.program.model.address.*;",
			"import ghidra.program.model.data.*;",
			"import ghidra.program.model.lang.*;",
			"import ghidra.program.model.listing.*;",
			"import ghidra.program.model.mem.*;",
			"import ghidra.program.model.pcode.*;",
			"import ghidra.program.model.scalar.*;",
			"import ghidra.program.model.symbol.*;",
			"import ghidra.util.task.*;",
			"import java.nio.charset.StandardCharsets;",
			"import java.nio.file.*;",
			"import java.util.*;",
			"public class " + className + " extends GhidraScript {",
			"  @Override public void run() throws Exception {",
			"    Object _result_ = null;",
			code,
			"    String _omp_result_json_ = new Gson().toJson(_result_);",
			"    if (_omp_result_json_.length() > " + MAX_NATIVE_RESULT_CHARS + ") throw new IllegalArgumentException(\"Ghidra Java result exceeds 1 MiB\");",
			"    Files.writeString(Path.of(\"" + javaStringLiteral(resultPath.toString()) + "\"), _omp_result_json_, StandardCharsets.UTF_8);",
			"  }",
			"}",
			""
		);
	}

	private static String javaStringLiteral(String value) {
		return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\r", "\\r").replace("\n", "\\n");
	}

	private static final class BoundedWriter extends Writer {
		private final StringBuilder output = new StringBuilder();
		private final int limit;
		private boolean truncated;

		BoundedWriter(int limit) {
			this.limit = limit;
		}

		@Override
		public void write(char[] values, int offset, int length) {
			int remaining = limit - output.length();
			if (remaining > 0) output.append(values, offset, Math.min(length, remaining));
			if (length > remaining) truncated = true;
		}

		@Override
		public void flush() {}

		@Override
		public void close() {}

		boolean isTruncated() {
			return truncated;
		}

		@Override
		public String toString() {
			return output.toString();
		}
	}

	private static JsonObject ok() {
		JsonObject value = new JsonObject();
		value.addProperty("ok", true);
		return value;
	}

	private static JsonObject error(String message) {
		JsonObject value = new JsonObject();
		value.addProperty("ok", false);
		value.addProperty("error", message == null ? "Unknown error" : message);
		return value;
	}

	private static String requiredString(JsonObject object, String key) {
		JsonElement value = object.get(key);
		if (value == null || !value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
			throw new IllegalArgumentException(key + " must be a string");
		}
		return value.getAsString();
	}

	private static int optionalInt(JsonObject object, String key, int fallback) {
		JsonElement value = object.get(key);
		if (value == null || value.isJsonNull()) return fallback;
		try {
			return value.getAsInt();
		}
		catch (Exception exception) {
			throw new IllegalArgumentException(key + " must be an integer");
		}
	}

	private static String addressHex(Address address) {
		return address == null ? null : "0x" + Long.toUnsignedString(address.getOffset(), 16);
	}

	private static String bytesHex(byte[] bytes) {
		StringBuilder output = new StringBuilder(bytes.length * 2);
		for (byte value : bytes) output.append(String.format("%02x", value & 0xff));
		return output.toString();
	}
}
