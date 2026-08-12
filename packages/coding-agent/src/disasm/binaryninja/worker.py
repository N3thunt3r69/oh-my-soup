from __future__ import annotations

import contextlib
import io
import json
import os
import re
import sqlite3
import struct
import sys
import traceback
from pathlib import Path
from typing import Any

import binaryninja as bn

# This worker owns one BinaryView for its whole lifetime. Keeping every API call
# in one Python process avoids passing Binary Ninja handles across process or
# language boundaries; the TypeScript adapter only exchanges NDJSON values.
bv = None
database_path: str | None = None
V3_CREATED_TYPE_IDS_SESSION_KEY = "oh_my_soup_sql_created_type_ids"
input_path: str | None = None
temporary_database = False

READ_TABLES = {
    "metadata",
    "segments",
    "funcs",
    "functions",
    "names",
    "symbols",
    "strings",
    "instructions",
    "disasm",
    "basic_blocks",
    "xrefs",
    "code_refs",
    "data_refs",
    "type_refs",
    "field_refs",
    "imports",
    "exports",
    "comments",
    "data_items",
    "types",
    "type_members",
    "prototypes",
    "locals",
    "il",
    "lifted_il",
    "llil",
    "llil_ssa",
    "mlil",
    "mlil_ssa",
    "mapped_mlil",
    "mapped_mlil_ssa",
    "hlil",
    "hlil_ssa",
    "decompile",
    "table_catalog",
}
MUTATION_TABLES = {
    "symbols_mut",
    "comments_mut",
    "prototypes_mut",
    "locals_mut",
    "types_mut",
    "type_members_mut",
}
IR_VIEWS = {
    "lifted_il": ("lifted_il", False),
    "llil": ("llil", False),
    "llil_ssa": ("llil", True),
    "mlil": ("mlil", False),
    "mlil_ssa": ("mlil", True),
    "mapped_mlil": ("mapped_medium_level_il", False),
    "mapped_mlil_ssa": ("mapped_medium_level_il", True),
    "hlil": ("hlil", False),
    "hlil_ssa": ("hlil", True),
}
TABLE_PATTERN = re.compile(r"(?i)\b(?:from|join|update|into|delete\s+from|insert\s+into)\s+([a-z_][a-z0-9_]*)")
WRITE_PATTERN = re.compile(r"(?is)^\s*(?:with\b.*?\b)?(insert|update|delete|replace)\b")


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def address_hex(value: int | None) -> str | None:
    if value is None:
        return None
    address = int(value)
    if address < 0 or address > 0xFFFFFFFFFFFFFFFF:
        raise ValueError(f"Address is outside the unsigned 64-bit range: {value}")
    return f"0x{address:016x}"


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex()
    if isinstance(value, (list, tuple, set)):
        return [json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    return repr(value)


def require_view():
    if bv is None:
        raise RuntimeError("No Binary Ninja target is open")
    return bv


def resolve_address(identifier: Any) -> int:
    view = require_view()
    if isinstance(identifier, int):
        address = identifier
        if 0 <= address <= 0xFFFFFFFFFFFFFFFF:
            return address
        raise ValueError(f"Address is outside the unsigned 64-bit range: {identifier}")
    text = str(identifier).strip()
    try:
        address = int(text, 0)
        if 0 <= address <= 0xFFFFFFFFFFFFFFFF:
            return address
        raise ValueError(f"Address is outside the unsigned 64-bit range: {identifier}")
    except ValueError:
        if re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|\d+)", text):
            raise
    match = re.fullmatch(r"(.+?)([+-])(0x[0-9a-fA-F]+|\d+)", text)
    if match:
        base = resolve_address(match.group(1))
        delta = int(match.group(3), 0)
        return resolve_address(base + delta if match.group(2) == "+" else base - delta)
    functions = list(view.get_functions_by_name(text))
    if len(functions) == 1:
        return int(functions[0].start)
    symbols = list(view.get_symbols_by_name(text))
    if len(symbols) == 1:
        return int(symbols[0].address)
    raise RuntimeError(f"Address or unambiguous symbol not found: {identifier}")


def find_function(identifier: Any, *, containing: bool = True):
    view = require_view()
    try:
        address = resolve_address(identifier)
    except Exception:
        address = None
    if address is not None:
        direct = view.get_function_at(address)
        if direct is not None:
            return direct
        if containing:
            functions = list(view.get_functions_containing(address))
            if len(functions) == 1:
                return functions[0]
    functions = list(view.get_functions_by_name(str(identifier)))
    if len(functions) == 1:
        return functions[0]
    raise RuntimeError(f"Function not found or ambiguous: {identifier}")


def function_for_address(address: int):
    view = require_view()
    direct = view.get_function_at(address)
    if direct is not None:
        return direct
    containing = list(view.get_functions_containing(address))
    return containing[0] if len(containing) == 1 else None


def instruction_length(address: int) -> int:
    view = require_view()
    try:
        length = int(view.get_instruction_length(address))
        if length > 0:
            return length
    except Exception:
        pass
    return 1


def iter_instruction_addresses(function):
    seen: set[int] = set()
    for block in function.basic_blocks:
        address = int(block.start)
        while address < int(block.end):
            if address not in seen:
                seen.add(address)
                yield address
            address += instruction_length(address)


def il_function(function, attr: str, ssa: bool):
    value = getattr(function, attr, None)
    if value is None:
        return None
    if ssa:
        try:
            value = value.ssa_form
        except Exception:
            return None
    return value

def render_il_node(node: Any) -> str:
    try:
        return str(node)
    except Exception:
        # Some lifted/SSA expression nodes cannot render independently. Their
        # operation and indices still make the row navigable to the parent IR.
        operation = getattr(node, "operation", None)
        return getattr(operation, "name", type(node).__name__)

def sqlite_integer(value: Any, fallback: int = -1) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if -(1 << 63) <= parsed < (1 << 63) else fallback




def iter_il_rows(function, view_name: str):
    attr, ssa = IR_VIEWS[view_name]
    il = il_function(function, attr, ssa)
    if il is None:
        return
    try:
        nodes = il.traverse(lambda instruction: instruction)
    except Exception:
        nodes = il.instructions
    for node in nodes:
        address = int(getattr(node, "address", function.start))
        operation = getattr(node, "operation", None)
        operation_name = getattr(operation, "name", str(operation) if operation is not None else type(node).__name__)
        yield (
            view_name,
            int(function.start),
            function.name,
            address,
            address_hex(address),
            sqlite_integer(getattr(node, "instr_index", -1)),
            sqlite_integer(getattr(node, "expr_index", -1)),
            operation_name,
            render_il_node(node),
        )


def variable_identifier(variable: Any) -> int | None:
    identifier = getattr(variable, "identifier", None)
    try:
        return int(identifier)
    except (TypeError, ValueError):
        return None


def variable_id(function: Any, variable: Any, is_parameter: bool) -> str:
    source = getattr(variable, "source_type", None)
    source_name = getattr(source, "name", str(source))
    identifier = variable_identifier(variable)
    return ":".join(
        (
            hex(int(function.start)),
            "parameter" if is_parameter else "local",
            source_name,
            str(int(getattr(variable, "storage", 0))),
            str(int(getattr(variable, "index", 0))),
            str(identifier if identifier is not None else "none"),
        )
    )


def iter_variables(function: Any):
    parameter_markers = {
        (variable_identifier(variable), int(getattr(variable, "storage", 0))) for variable in function.parameter_vars
    }
    seen: set[tuple[int | None, int]] = set()
    for variable in list(function.parameter_vars) + list(function.stack_layout):
        marker = (variable_identifier(variable), int(getattr(variable, "storage", 0)))
        if marker in seen:
            continue
        seen.add(marker)
        yield variable, marker in parameter_markers


def type_kind(type_object: Any) -> str:
    value = getattr(type_object, "type_class", None)
    return getattr(value, "name", str(value) if value is not None else type(type_object).__name__)


def create_schema(connection: sqlite3.Connection) -> None:
    statements = (
        "CREATE TABLE metadata (meta_key TEXT, meta_value TEXT)",
        "CREATE TABLE segments (start_address INTEGER, start_hex TEXT, end_address INTEGER, end_hex TEXT, name TEXT, size INTEGER, is_read INTEGER, is_write INTEGER, is_execute INTEGER)",
        "CREATE TABLE funcs (address INTEGER, address_hex TEXT, end_address INTEGER, end_hex TEXT, name TEXT, raw_name TEXT, signature TEXT, return_type TEXT, is_import INTEGER)",
        "CREATE VIEW functions AS SELECT * FROM funcs",
        "CREATE TABLE names (address INTEGER, address_hex TEXT, name TEXT, raw_name TEXT, symbol_type TEXT, binding TEXT, namespace TEXT, is_import INTEGER)",
        "CREATE VIEW symbols AS SELECT * FROM names",
        "CREATE TABLE strings (address INTEGER, address_hex TEXT, string_value TEXT, length INTEGER, string_type TEXT)",
        "CREATE TABLE instructions (address INTEGER, address_hex TEXT, text TEXT, bytes TEXT, length INTEGER, function_address INTEGER, function_hex TEXT, function_name TEXT)",
        "CREATE VIEW disasm AS SELECT * FROM instructions",
        "CREATE TABLE basic_blocks (function_address INTEGER, function_hex TEXT, function_name TEXT, start_address INTEGER, start_hex TEXT, end_address INTEGER, end_hex TEXT, instruction_count INTEGER, outgoing_edges INTEGER, incoming_edges INTEGER)",
        "CREATE TABLE xrefs (from_address INTEGER, from_hex TEXT, to_address INTEGER, to_hex TEXT, reference_kind TEXT, function_address INTEGER, function_hex TEXT, function_name TEXT)",
        "CREATE TABLE code_refs AS SELECT * FROM xrefs WHERE 0",
        "CREATE TABLE data_refs AS SELECT * FROM xrefs WHERE 0",
        "CREATE TABLE type_refs (type_name TEXT, referring_type TEXT, offset INTEGER, reference_type TEXT)",
        "CREATE TABLE field_refs (type_name TEXT, member_name TEXT, member_offset INTEGER, reference_kind TEXT, address INTEGER, address_hex TEXT, function_address INTEGER, function_hex TEXT, function_name TEXT, size INTEGER, incoming_type TEXT, referring_type TEXT, referring_offset INTEGER, reference_type TEXT)",
        "CREATE TABLE imports (address INTEGER, address_hex TEXT, name TEXT, namespace TEXT, symbol_type TEXT)",
        "CREATE TABLE exports (address INTEGER, address_hex TEXT, name TEXT, namespace TEXT, symbol_type TEXT)",
        "CREATE TABLE comments (address INTEGER, address_hex TEXT, function_address INTEGER, function_hex TEXT, function_name TEXT, scope TEXT, comment TEXT)",
        "CREATE TABLE data_items (address INTEGER, address_hex TEXT, data_type TEXT, value TEXT)",
        "CREATE TABLE types (name TEXT, kind TEXT, declaration TEXT, width INTEGER, alignment INTEGER)",
        "CREATE TABLE type_members (type_name TEXT, member_index INTEGER, member_name TEXT, offset INTEGER, offset_hex TEXT, member_type TEXT, width INTEGER)",
        "CREATE TABLE prototypes (address INTEGER, address_hex TEXT, function_name TEXT, prototype TEXT, return_type TEXT, calling_convention TEXT, can_return INTEGER, variadic INTEGER)",
        "CREATE TABLE locals (function_address INTEGER, function_hex TEXT, function_name TEXT, local_id TEXT, name TEXT, variable_type TEXT, storage INTEGER, variable_index INTEGER, identifier INTEGER, source_type TEXT, is_parameter INTEGER)",
        "CREATE TABLE il (view TEXT, function_address INTEGER, function_name TEXT, address INTEGER, address_hex TEXT, instruction_index INTEGER, expression_index INTEGER, operation TEXT, text TEXT)",
        "CREATE TABLE lifted_il AS SELECT * FROM il WHERE 0",
        "CREATE TABLE llil AS SELECT * FROM il WHERE 0",
        "CREATE TABLE llil_ssa AS SELECT * FROM il WHERE 0",
        "CREATE TABLE mlil AS SELECT * FROM il WHERE 0",
        "CREATE TABLE mlil_ssa AS SELECT * FROM il WHERE 0",
        "CREATE TABLE mapped_mlil AS SELECT * FROM il WHERE 0",
        "CREATE TABLE mapped_mlil_ssa AS SELECT * FROM il WHERE 0",
        "CREATE TABLE hlil AS SELECT * FROM il WHERE 0",
        "CREATE TABLE hlil_ssa AS SELECT * FROM il WHERE 0",
        "CREATE TABLE decompile (address INTEGER, address_hex TEXT, name TEXT, signature TEXT, c TEXT)",
        "CREATE TABLE table_catalog (table_name TEXT, writable INTEGER, description TEXT)",
        "CREATE TABLE symbols_mut (address INTEGER PRIMARY KEY, name TEXT, symbol_type TEXT)",
        "CREATE TABLE comments_mut (address INTEGER PRIMARY KEY, comment TEXT)",
        "CREATE TABLE prototypes_mut (address INTEGER PRIMARY KEY, prototype TEXT)",
        "CREATE TABLE locals_mut (function_address INTEGER, local_id TEXT, name TEXT, variable_type TEXT, PRIMARY KEY (function_address, local_id))",
        "CREATE TABLE types_mut (name TEXT PRIMARY KEY, declaration TEXT)",
        "CREATE TABLE type_members_mut (type_name TEXT, member_name TEXT, offset INTEGER, member_type TEXT, PRIMARY KEY (type_name, member_name))",
    )
    for statement in statements:
        connection.execute(statement)


def populate_metadata(connection: sqlite3.Connection) -> None:
    view = require_view()
    rows = {
        "backend": "binaryninja",
        "version": bn.core_version(),
        "product": bn.core_product(),
        "filename": view.file.filename,
        "original_filename": view.file.original_filename,
        "database_path": database_path,
        "input_path": input_path,
        "view_type": view.view_type,
        "architecture": getattr(view.arch, "name", None),
        "platform": str(view.platform) if view.platform is not None else None,
        "entry_point": address_hex(view.entry_point),
        "start": address_hex(view.start),
        "end": address_hex(view.end),
        "address_size": view.address_size,
        "endianness": str(view.endianness),
        "temporary_database": temporary_database,
    }
    connection.executemany("INSERT INTO metadata VALUES (?, ?)", ((key, json.dumps(value)) for key, value in rows.items()))


def populate_segments(connection: sqlite3.Connection) -> None:
    rows = []
    for segment in require_view().segments:
        rows.append((segment.start, address_hex(segment.start), segment.end, address_hex(segment.end), str(segment), segment.length, segment.readable, segment.writable, segment.executable))
    connection.executemany("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


def populate_functions(connection: sqlite3.Connection) -> None:
    view = require_view()
    imported = {bn.SymbolType.ImportedFunctionSymbol, bn.SymbolType.ImportAddressSymbol}
    rows = []
    for function in view.functions:
        symbol = function.symbol
        rows.append((function.start, address_hex(function.start), function.highest_address, address_hex(function.highest_address), function.name, getattr(function, "raw_name", function.name), str(function.type), str(function.return_type), symbol.type in imported))
    connection.executemany("INSERT INTO funcs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


def populate_symbols(connection: sqlite3.Connection) -> None:
    imported = {bn.SymbolType.ImportedFunctionSymbol, bn.SymbolType.ImportedDataSymbol, bn.SymbolType.ImportAddressSymbol}
    rows = []
    for symbol in require_view().get_symbols():
        rows.append((symbol.address, address_hex(symbol.address), symbol.name, symbol.raw_name, symbol.type.name, symbol.binding.name, str(symbol.namespace), symbol.type in imported))
    connection.executemany("INSERT INTO names VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)


def populate_strings(connection: sqlite3.Connection) -> None:
    rows = [(item.start, address_hex(item.start), item.value, item.length, item.type.name) for item in require_view().strings]
    connection.executemany("INSERT INTO strings VALUES (?, ?, ?, ?, ?)", rows)


def populate_instructions(connection: sqlite3.Connection) -> None:
    view = require_view()
    rows = []
    for function in view.functions:
        for address in iter_instruction_addresses(function):
            length = instruction_length(address)
            rows.append((address, address_hex(address), view.get_disassembly(address) or "", bytes(view.read(address, length)).hex(" "), length, function.start, address_hex(function.start), function.name))
    connection.executemany("INSERT INTO instructions VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows)


def populate_basic_blocks(connection: sqlite3.Connection) -> None:
    rows = []
    for function in require_view().functions:
        for block in function.basic_blocks:
            rows.append((function.start, address_hex(function.start), function.name, block.start, address_hex(block.start), block.end, address_hex(block.end), len(block), len(block.outgoing_edges), len(block.incoming_edges)))
    connection.executemany("INSERT INTO basic_blocks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


def populate_refs(connection: sqlite3.Connection, requested: set[str]) -> None:
    view = require_view()
    code_rows: set[tuple[Any, ...]] = set()
    data_rows: set[tuple[Any, ...]] = set()
    for function in view.functions:
        for source in iter_instruction_addresses(function):
            for target in view.get_code_refs_from(source, function):
                code_rows.add((source, address_hex(source), int(target), address_hex(int(target)), "code", function.start, address_hex(function.start), function.name))
            for target in view.get_data_refs_from(source):
                data_rows.add((source, address_hex(source), int(target), address_hex(int(target)), "data", function.start, address_hex(function.start), function.name))
    for source in view.data_vars:
        for target in view.get_data_refs_from(source):
            data_rows.add((source, address_hex(source), int(target), address_hex(int(target)), "data", None, None, None))
    if requested & {"xrefs", "code_refs"}:
        connection.executemany("INSERT INTO code_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sorted(code_rows))
    if requested & {"xrefs", "data_refs"}:
        connection.executemany("INSERT INTO data_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sorted(data_rows))
    if "xrefs" in requested:
        connection.executemany("INSERT INTO xrefs VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sorted(code_rows | data_rows))


def populate_imports_exports(connection: sqlite3.Connection, requested: set[str]) -> None:
    view = require_view()
    import_types = {bn.SymbolType.ImportedFunctionSymbol, bn.SymbolType.ImportedDataSymbol, bn.SymbolType.ImportAddressSymbol}
    imports = []
    exports = []
    for symbol in view.get_symbols():
        row = (symbol.address, address_hex(symbol.address), symbol.name, str(symbol.namespace), symbol.type.name)
        if symbol.type in import_types:
            imports.append(row)
        if symbol.binding in {bn.SymbolBinding.GlobalBinding, bn.SymbolBinding.WeakBinding} and symbol.type not in import_types:
            exports.append(row)
    if "imports" in requested:
        connection.executemany("INSERT INTO imports VALUES (?, ?, ?, ?, ?)", imports)
    if "exports" in requested:
        connection.executemany("INSERT INTO exports VALUES (?, ?, ?, ?, ?)", exports)


def populate_comments(connection: sqlite3.Connection) -> None:
    view = require_view()
    rows = [(address, address_hex(address), None, None, None, "global", comment) for address, comment in view.address_comments.items()]
    for function in view.functions:
        rows.extend((address, address_hex(address), function.start, address_hex(function.start), function.name, "function", comment) for address, comment in function.comments.items())
    connection.executemany("INSERT INTO comments VALUES (?, ?, ?, ?, ?, ?, ?)", rows)


def populate_data_items(connection: sqlite3.Connection) -> None:
    rows = []
    for address, variable in require_view().data_vars.items():
        value = require_view().get_data_var_at(address)
        rows.append((address, address_hex(address), str(variable.type), repr(value)))
    connection.executemany("INSERT INTO data_items VALUES (?, ?, ?, ?)", rows)


def populate_types(connection: sqlite3.Connection, requested: set[str]) -> None:
    view = require_view()
    type_rows = []
    member_rows = []
    reference_rows = []
    field_rows = []
    for name_object, type_object in view.types.items():
        name = str(name_object)
        type_rows.append((name, type_kind(type_object), str(type_object), int(getattr(type_object, "width", 0)), int(getattr(type_object, "alignment", 1))))
        members = getattr(type_object, "members", None)
        if members is not None:
            for index, member in enumerate(members):
                member_rows.append((name, index, member.name, member.offset, address_hex(member.offset), str(member.type), int(getattr(member.type, "width", 0))))
                if "field_refs" in requested:
                    for reference in view.get_code_refs_for_type_field(name, member.offset):
                        function = reference.func
                        field_rows.append((name, member.name, member.offset, "code", reference.address, address_hex(reference.address), function.start if function else None, address_hex(function.start) if function else None, function.name if function else None, reference.size, str(reference.incomingType) if reference.incomingType is not None else None, None, None, None))
                    for address in view.get_data_refs_for_type_field(name, member.offset):
                        function = function_for_address(address)
                        field_rows.append((name, member.name, member.offset, "data", address, address_hex(address), function.start if function else None, address_hex(function.start) if function else None, function.name if function else None, None, None, None, None, None, None))
                    for source in view.get_type_refs_for_type_field(name, member.offset):
                        field_rows.append((name, member.name, member.offset, "type", None, None, None, None, None, None, None, str(source.name), source.offset, source.ref_type.name))
        if "type_refs" in requested:
            for source in view.get_type_refs_for_type(name):
                reference_rows.append((name, str(source.name), source.offset, source.ref_type.name))
    if "types" in requested:
        connection.executemany("INSERT INTO types VALUES (?, ?, ?, ?, ?)", type_rows)
    if "type_members" in requested:
        connection.executemany("INSERT INTO type_members VALUES (?, ?, ?, ?, ?, ?, ?)", member_rows)
    if "type_refs" in requested:
        connection.executemany("INSERT INTO type_refs VALUES (?, ?, ?, ?)", reference_rows)
    if "field_refs" in requested:
        connection.executemany("INSERT INTO field_refs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", field_rows)


def populate_prototypes_locals(connection: sqlite3.Connection, requested: set[str]) -> None:
    prototype_rows = []
    local_rows = []
    for function in require_view().functions:
        if "prototypes" in requested:
            convention = function.calling_convention
            prototype_rows.append((function.start, address_hex(function.start), function.name, str(function.type), str(function.return_type), getattr(convention, "name", str(convention)) if convention else None, bool(function.can_return), bool(getattr(function, "has_variable_arguments", False))))
        if "locals" in requested:
            for variable, is_parameter in iter_variables(function):
                source = getattr(variable, "source_type", None)
                local_rows.append((function.start, address_hex(function.start), function.name, variable_id(function, variable, is_parameter), variable.name, str(variable.type), int(variable.storage), int(getattr(variable, "index", 0)), variable_identifier(variable), getattr(source, "name", str(source)), is_parameter))
    if "prototypes" in requested:
        connection.executemany("INSERT INTO prototypes VALUES (?, ?, ?, ?, ?, ?, ?, ?)", prototype_rows)
    if "locals" in requested:
        connection.executemany("INSERT INTO locals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", local_rows)


def populate_il(connection: sqlite3.Connection, requested: set[str]) -> None:
    views = set(IR_VIEWS) if "il" in requested else requested & set(IR_VIEWS)
    rows = []
    for function in require_view().functions:
        for view_name in views:
            rows.extend(iter_il_rows(function, view_name) or ())
    if "il" in requested:
        connection.executemany("INSERT INTO il VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    for view_name in views & requested:
        connection.executemany(f"INSERT INTO {view_name} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", (row for row in rows if row[0] == view_name))


def populate_decompile(connection: sqlite3.Connection) -> None:
    rows = []
    for function in require_view().functions:
        hlil = il_function(function, "hlil", False)
        rows.append((function.start, address_hex(function.start), function.name, str(function.type), str(hlil) if hlil is not None else ""))
    connection.executemany("INSERT INTO decompile VALUES (?, ?, ?, ?, ?)", rows)


def populate_catalog(connection: sqlite3.Connection) -> None:
    descriptions = {
        "il": "Every Binary Ninja IR. Filter view to lifted_il, llil, llil_ssa, mlil, mlil_ssa, mapped_mlil, mapped_mlil_ssa, hlil, or hlil_ssa.",
        "xrefs": "Outbound code and data references with source and destination addresses.",
        "type_refs": "References from one named type to another.",
        "field_refs": "Code, data, and type references to structure fields.",
        "prototypes_mut": "Write lane: INSERT OR REPLACE(address, prototype), UPDATE prototype by address, or DELETE to reset automatic type.",
        "types_mut": "Write lane: INSERT OR REPLACE(name, declaration) to parse and define C declarations, or DELETE by name.",
        "type_members_mut": "Write lane: insert/update/delete named structure members by type, offset, name, and C type.",
    }
    rows = [(name, name in MUTATION_TABLES, descriptions.get(name, "Binary Ninja analysis table.")) for name in sorted(READ_TABLES | MUTATION_TABLES)]
    connection.executemany("INSERT INTO table_catalog VALUES (?, ?, ?)", rows)


def materialize(connection: sqlite3.Connection, requested: set[str]) -> None:
    if "table_catalog" in requested:
        populate_catalog(connection)
    if "metadata" in requested:
        populate_metadata(connection)
    if "segments" in requested:
        populate_segments(connection)
    if requested & {"funcs", "functions"}:
        populate_functions(connection)
    if requested & {"names", "symbols"}:
        populate_symbols(connection)
    if "strings" in requested:
        populate_strings(connection)
    if requested & {"instructions", "disasm"}:
        populate_instructions(connection)
    if "basic_blocks" in requested:
        populate_basic_blocks(connection)
    if requested & {"xrefs", "code_refs", "data_refs"}:
        populate_refs(connection, requested)
    if requested & {"imports", "exports"}:
        populate_imports_exports(connection, requested)
    if "comments" in requested:
        populate_comments(connection)
    if "data_items" in requested:
        populate_data_items(connection)
    if requested & {"types", "type_members", "type_refs", "field_refs"}:
        populate_types(connection, requested)
    if requested & {"prototypes", "locals"}:
        populate_prototypes_locals(connection, requested)
    if requested & ({"il"} | set(IR_VIEWS)):
        populate_il(connection, requested)
    if "decompile" in requested:
        populate_decompile(connection)


def parse_declarations(declaration: str):
    view = require_view()
    platform = view.platform
    if platform is not None and hasattr(platform, "parse_types_from_source"):
        try:
            return platform.parse_types_from_source(declaration)
        except Exception:
            pass
    return view.parse_types_from_string(declaration)


def find_variable(function: Any, local_id: str):
    for variable, is_parameter in iter_variables(function):
        if variable_id(function, variable, is_parameter) == local_id or variable.name == local_id:
            return variable, is_parameter
    raise RuntimeError(f"Local variable not found: {local_id}")


def find_structure_member(builder: Any, name: str):
    index = builder.index_by_name(name)
    if index is None:
        raise RuntimeError(f"Structure field not found: {name}")
    member = builder[name]
    if member is None:
        raise RuntimeError(f"Structure field not found: {name}")
    return index, member


def parse_write_operation(sql: str) -> tuple[str, str]:
    match = WRITE_PATTERN.search(sql)
    if match is None:
        raise RuntimeError("Only SELECT, INSERT, UPDATE, DELETE, and REPLACE SQL are supported")
    table_match = TABLE_PATTERN.search(sql)
    if table_match is None:
        raise RuntimeError("SQL mutation does not name a supported table")
    return match.group(1).lower(), table_match.group(1).lower()


def apply_symbol_mutation(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    if operation == "delete":
        for row in before:
            address = int(row["address"])
            symbol = view.get_symbol_at(address)
            if symbol is not None:
                view.undefine_user_symbol(symbol)
        return
    for row in after:
        address = int(row["address"])
        name = str(row["name"])
        kind = str(row.get("symbol_type") or "auto")
        function = view.get_function_at(address)
        if function is not None and kind in {"auto", "function", "FunctionSymbol"}:
            function.name = name
        else:
            symbol_type = bn.SymbolType.DataSymbol if kind == "auto" else bn.SymbolType[kind] if kind in bn.SymbolType.__members__ else bn.SymbolType.DataSymbol
            view.define_user_symbol(bn.Symbol(symbol_type, address, name))


def apply_comment_mutation(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    if operation == "delete":
        for row in before:
            view.set_comment_at(int(row["address"]), "")
        return
    for row in after:
        view.set_comment_at(int(row["address"]), str(row["comment"]))


def apply_prototype_mutation(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    if operation == "delete":
        raise RuntimeError("Deleting a function prototype is not supported; replace it with the desired declaration")
    view = require_view()
    for row in changed_rows(before, after, ("address",)):
        function = find_function(int(row["address"]), containing=False)
        expected, _ = view.parse_type_string(str(row["prototype"]))
        function.set_user_type(expected)


def apply_local_mutation(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    if operation == "delete":
        for row in before:
            function = find_function(int(row["function_address"]), containing=False)
            variable, _ = find_variable(function, str(row["local_id"]))
            function.delete_user_var(variable)
        return
    for row in changed_rows(before, after, ("function_address", "local_id")):
        function = find_function(int(row["function_address"]), containing=False)
        variable, _ = find_variable(function, str(row["local_id"]))
        variable_type = variable.type
        if row.get("variable_type"):
            variable_type, _ = require_view().parse_type_string(str(row["variable_type"]))
        function.create_user_var(variable, variable_type, str(row.get("name") or variable.name))


def apply_type_mutation(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    if operation == "delete":
        for row in before:
            view.undefine_user_type(str(row["name"]))
        return
    for row in changed_rows(before, after, ("name",)):
        parsed = parse_declarations(str(row["declaration"]))
        named = list(getattr(parsed, "types", {}).items())
        if not named:
            type_object, name = view.parse_type_string(str(row["declaration"]))
            named = [(str(row.get("name") or name), type_object)]
        requested_name = str(row.get("name") or "")
        selected = next(((str(name), type_object) for name, type_object in named if str(name) == requested_name), None)
        if selected is None:
            if len(named) != 1:
                raise RuntimeError(f"Declaration defines {len(named)} types; specify one row per named type")
            selected = (requested_name or str(named[0][0]), named[0][1])
        view.define_user_type(selected[0], selected[1])


def changed_rows(before: list[dict[str, Any]], after: list[dict[str, Any]], keys: tuple[str, ...]) -> list[dict[str, Any]]:
    previous = {tuple(row.get(key) for key in keys): row for row in before}
    return [row for row in after if previous.get(tuple(row.get(key) for key in keys)) != row]


def apply_member_mutation(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    rows = before if operation == "delete" else after
    for row in rows:
        type_name = str(row["type_name"])
        type_object = view.get_type_by_name(type_name)
        if type_object is None or getattr(type_object, "members", None) is None:
            raise RuntimeError(f"Structure type not found: {type_name}")
        builder = type_object.mutable_copy()
        member_name = str(row["member_name"])
        if operation == "delete":
            index, _ = find_structure_member(builder, member_name)
            builder.remove(index)
        elif operation == "update":
            old = next(item for item in before if str(item["type_name"]) == type_name and str(item["member_name"]) == member_name)
            index, member = find_structure_member(builder, str(old["member_name"]))
            member_type = member.type
            if row.get("member_type"):
                member_type, _ = view.parse_type_string(str(row["member_type"]))
            new_name = str(row.get("member_name") or old["member_name"])
            new_offset = int(row.get("offset") if row.get("offset") is not None else old["offset"])
            if new_offset == int(member.offset):
                builder.replace(index, member_type, new_name, True)
            else:
                builder.remove(index)
                builder.add_member_at_offset(new_name, member_type, new_offset, True)
        else:
            member_type, _ = view.parse_type_string(str(row["member_type"]))
            builder.add_member_at_offset(member_name, member_type, int(row["offset"]), True)
        view.define_user_type(type_name, builder)


def execute_mutation(sql: str) -> dict[str, Any]:
    operation, table = parse_write_operation(sql)
    if table not in MUTATION_TABLES:
        raise RuntimeError(f"Table '{table}' is read-only; use a *_mut table for Binary Ninja writes")
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    create_schema(connection)
    seed_mutation_tables(connection, table)
    before = [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
    cursor = connection.execute(sql)
    after = [dict(row) for row in connection.execute(f"SELECT * FROM {table}")]
    handlers = {
        "symbols_mut": apply_symbol_mutation,
        "comments_mut": apply_comment_mutation,
        "prototypes_mut": apply_prototype_mutation,
        "locals_mut": apply_local_mutation,
        "types_mut": apply_type_mutation,
        "type_members_mut": apply_member_mutation,
    }
    handlers[table](operation, before, after)
    require_view().update_analysis_and_wait()
    return {"columns": ["rows_affected", "operation", "table"], "rows": [{"rows_affected": cursor.rowcount, "operation": operation, "table": table}]}


def seed_mutation_tables(connection: sqlite3.Connection, table: str) -> None:
    view = require_view()
    if table == "symbols_mut":
        rows = [(symbol.address, symbol.name, symbol.type.name) for symbol in view.get_symbols()]
        connection.executemany("INSERT OR IGNORE INTO symbols_mut VALUES (?, ?, ?)", rows)
    elif table == "comments_mut":
        connection.executemany("INSERT INTO comments_mut VALUES (?, ?)", view.address_comments.items())
    elif table == "prototypes_mut":
        connection.executemany("INSERT INTO prototypes_mut VALUES (?, ?)", ((function.start, str(function.type)) for function in view.functions))
    elif table == "locals_mut":
        rows = []
        for function in view.functions:
            for variable, is_parameter in iter_variables(function):
                rows.append((function.start, variable_id(function, variable, is_parameter), variable.name, str(variable.type)))
        connection.executemany("INSERT INTO locals_mut VALUES (?, ?, ?, ?)", rows)
    elif table == "types_mut":
        connection.executemany("INSERT INTO types_mut VALUES (?, ?)", ((str(name), str(type_object)) for name, type_object in view.types.items()))
    elif table == "type_members_mut":
        rows = []
        for name, type_object in view.types.items():
            for member in getattr(type_object, "members", None) or ():
                rows.append((str(name), member.name, member.offset, str(member.type)))
        connection.executemany("INSERT INTO type_members_mut VALUES (?, ?, ?, ?)", rows)


def execute_query(sql: str) -> dict[str, Any]:
    if WRITE_PATTERN.search(sql):
        return execute_mutation(sql)
    requested = {match.group(1).lower() for match in TABLE_PATTERN.finditer(sql)}
    unknown = requested - READ_TABLES
    if unknown:
        raise RuntimeError(f"Unknown Binary Ninja SQL table(s): {', '.join(sorted(unknown))}")
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    create_schema(connection)
    materialize(connection, requested)
    cursor = connection.execute(sql)
    columns = [item[0] for item in cursor.description or ()]
    rows = [{column: json_value(row[column]) for column in columns} for row in cursor.fetchall()]
    return {"columns": columns, "rows": rows}


def parse_open_options(request: dict[str, Any]) -> dict[str, Any]:
    raw = request.get("options")
    return raw if isinstance(raw, dict) else {}


def open_target(request: dict[str, Any]) -> dict[str, Any]:
    global bv, database_path, input_path, temporary_database
    if bv is not None:
        raise RuntimeError("This Binary Ninja worker already owns a target")
    source = str(request["file"])
    database_path = str(request["database_path"])
    input_path = source if not source.lower().endswith(".bndb") else None
    temporary_database = bool(request.get("temporary_database"))
    options = parse_open_options(request)
    update_analysis = bool(options.pop("update_analysis", True))
    loaded = bn.load(source, update_analysis=update_analysis, options=options)
    if loaded is None:
        raise RuntimeError(f"Binary Ninja could not open {source}")
    bv = loaded
    v3_load_oms_metadata()
    if input_path is not None and not Path(database_path).exists():
        if not bv.create_database(database_path):
            raise RuntimeError(f"Binary Ninja could not create database {database_path}")
    return target_info()


def target_info() -> dict[str, Any]:
    view = require_view()
    return {
        "database_path": database_path,
        "input_path": input_path,
        "runtime": "headless-python",
        "version": bn.core_version(),
        "processor": getattr(view.arch, "name", None),
        "bits": int(view.address_size) * 8,
        "pid": os.getpid(),
        "metadata": {
            "product": bn.core_product(),
            "view_type": view.view_type,
            "entry_point": address_hex(view.entry_point),
            "platform": str(view.platform) if view.platform is not None else None,
            "temporary_database": temporary_database,
        },
    }


def save_target() -> bool:
    view = require_view()
    v3_store_oms_metadata()
    if view.file.has_database:
        return bool(view.save_auto_snapshot())
    if database_path is None:
        raise RuntimeError("Target has no database path")
    return bool(view.create_database(database_path))


def close_target(save: bool) -> None:
    global bv
    if bv is None:
        return
    if save and not temporary_database:
        save_target()
    bv.file.close()
    bv = None


def byte_order() -> str:
    return "little" if "little" in str(require_view().endianness).lower() else "big"


def read_bytes(identifier: Any, size: int) -> bytes:
    address = resolve_address(identifier)
    data = bytes(require_view().read(address, int(size)))
    if len(data) != int(size):
        raise RuntimeError(f"Could not read {size} bytes at {hex(address)}")
    return data


def execute_python(script: str) -> dict[str, Any]:
    output = io.StringIO()

    def read_integer(identifier: Any, size: int, signed: bool = False) -> int:
        return int.from_bytes(read_bytes(identifier, size), byte_order(), signed=signed)

    scope = {
        "bn": bn,
        "binaryninja": bn,
        "bv": require_view(),
        "current_view": require_view(),
        "address": resolve_address,
        "function": find_function,
        "functions_containing": lambda identifier: list(require_view().get_functions_containing(resolve_address(identifier))),
        "read_u8": lambda identifier: read_integer(identifier, 1),
        "read_u16": lambda identifier: read_integer(identifier, 2),
        "read_u32": lambda identifier: read_integer(identifier, 4),
        "read_u64": lambda identifier: read_integer(identifier, 8),
        "read_i8": lambda identifier: read_integer(identifier, 1, True),
        "read_i16": lambda identifier: read_integer(identifier, 2, True),
        "read_i32": lambda identifier: read_integer(identifier, 4, True),
        "read_i64": lambda identifier: read_integer(identifier, 8, True),
        "read_ptr": lambda identifier: read_integer(identifier, require_view().address_size),
        "read_f32": lambda identifier: struct.unpack("<f" if byte_order() == "little" else ">f", read_bytes(identifier, 4))[0],
        "read_f64": lambda identifier: struct.unpack("<d" if byte_order() == "little" else ">d", read_bytes(identifier, 8))[0],
        "read_cstr": lambda identifier, limit=4096: bytes(require_view().read(resolve_address(identifier), int(limit))).split(b"\0", 1)[0].decode("utf-8", errors="replace"),
        "result": None,
    }
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        exec(script, scope, scope)
    value = scope.get("result")
    normalized = json_value(value)
    warnings = [] if normalized is value or isinstance(value, (type(None), bool, int, float, str, list, tuple, dict)) else ["`result` was not JSON-serializable; returned repr(result) instead."]
    return {"result": normalized, "stdout": output.getvalue(), "warnings": warnings}

# The SQL database is a transaction workspace, not the source of truth. Stable
# identities and the few properties Binary Ninja cannot represent natively are
# kept in analysis metadata so a saved BNDB reopens with the same SQL model.
V3_METADATA_KEY = "oh-my-soup.sql.v4"
v3_oms_metadata: dict[str, Any] = {}


def v3_empty_metadata() -> dict[str, Any]:
    return {
        "version": 5,
        "next_id": {},
        "ids": {},
        "created": {},
        "data_overrides": {},
        "data_primary_symbols": {},
        "comments": {},
    }


def v3_load_oms_metadata() -> dict[str, Any]:
    global v3_oms_metadata
    try:
        loaded = require_view().query_metadata(V3_METADATA_KEY)
    except Exception:
        loaded = None
    if isinstance(loaded, str):
        try:
            loaded = json.loads(loaded)
        except (TypeError, ValueError):
            loaded = None
    v3_oms_metadata = loaded if isinstance(loaded, dict) and loaded.get("version") == 5 else v3_empty_metadata()
    for key, default in v3_empty_metadata().items():
        v3_oms_metadata.setdefault(key, default)
    return v3_oms_metadata


def v3_store_oms_metadata() -> None:
    require_view().store_metadata(V3_METADATA_KEY, v3_oms_metadata, False)


def v3_new_id(domain: str) -> str:
    counters = v3_oms_metadata.setdefault("next_id", {})
    ordinal = int(counters.get(domain, 0)) + 1
    identifier = f"oms:{domain}:{ordinal}"
    while domain == "type" and _v3_type_by_id(identifier) is not None:
        ordinal += 1
        identifier = f"oms:{domain}:{ordinal}"
    counters[domain] = ordinal
    return identifier

def v3_mark_created(domain: str, identifier: str) -> None:
    created = v3_oms_metadata.setdefault("created", {}).setdefault(domain, [])
    if identifier not in created:
        created.append(identifier)


def v3_stable_id(domain: str, native_key: Any) -> str:
    key = str(native_key)
    identities = v3_oms_metadata.setdefault("ids", {}).setdefault(domain, {})
    identifier = identities.get(key)
    if not isinstance(identifier, str):
        identifier = v3_new_id(domain)
        identities[key] = identifier
    return identifier


def v3_bind_id(domain: str, native_key: Any, identifier: str) -> None:
    identities = v3_oms_metadata.setdefault("ids", {}).setdefault(domain, {})
    for key, value in list(identities.items()):
        if value == identifier and key != str(native_key):
            del identities[key]
    identities[str(native_key)] = identifier


def v3_retire_id(domain: str, native_key: Any) -> None:
    v3_oms_metadata.setdefault("ids", {}).setdefault(domain, {}).pop(str(native_key), None)


def v3_symbol_key(symbol: Any) -> str:
    namespace = str(getattr(symbol, "namespace", ""))
    ordinal = int(getattr(symbol, "ordinal", 0))
    binding = getattr(getattr(symbol, "binding", None), "name", "")
    raw_name = str(getattr(symbol, "raw_name", symbol.name))
    return f"{symbol.type.name}:{int(symbol.address):016x}:{ordinal}:{namespace}:{binding}:{int(bool(getattr(symbol, 'auto', False)))}:{raw_name}"


def v3_symbol_id(symbol: Any) -> str:
    return v3_stable_id("symbol", v3_symbol_key(symbol))


def v3_find_symbol_by_id(identifier: str):
    for symbol in require_view().get_symbols():
        if v3_symbol_id(symbol) == identifier:
            return symbol
    return None


def v3_address(value: Any) -> str:
    if value is None:
        raise ValueError("Address cannot be NULL")
    if isinstance(value, bool):
        raise ValueError("Boolean values are not addresses")
    if isinstance(value, int):
        parsed = value
    else:
        text = str(value).strip()
        if not re.fullmatch(r"(?:0[xX][0-9a-fA-F]+|\d+)", text):
            raise ValueError(f"Invalid address: {value}")
        parsed = int(text, 0)
    return address_hex(parsed)  # type: ignore[return-value]


def v3_address_add(value: Any, delta: Any) -> str:
    address = int(v3_address(value), 16)
    if isinstance(delta, bool) or not re.fullmatch(r"[+-]?\d+", str(delta).strip()):
        raise ValueError(f"Address delta must be a signed decimal integer: {delta}")
    result = address + int(str(delta), 10)
    return address_hex(result)  # type: ignore[return-value]


def v3_integer_compare(left: Any, right: Any) -> int:
    def parse(value: Any) -> int:
        text = str(value).strip()
        if not re.fullmatch(r"[+-]?\d+", text):
            raise ValueError(f"Integer must be canonical decimal text: {value}")
        return int(text, 10)

    a, b = parse(left), parse(right)
    return (a > b) - (a < b)


V3_CORE_TABLES = {
    "program_metadata",
    "segments",
    "symbols",
    "data_items",
    "address_comments",
    "all_comments",
    "sql_tables",
    "sql_columns",
    "sql_functions",
    "sql_enum_values",
}

V3_TABLE_POLICIES: dict[str, dict[str, Any]] = {
    "program_metadata": {"id": ("key",), "insert": (), "update": (), "bounds": ""},
    "segments": {"id": ("segment_id",), "insert": (), "update": (), "bounds": ""},
    "symbols": {
        "id": ("symbol_id",),
        "insert": ("address", "name", "kind", "binding", "namespace"),
        "required": ("address", "name", "kind"),
        "update": ("name", "binding", "namespace"),
        "bounds": "",
    },
    "functions": {
        "id": ("function_id",),
        "insert": ("start_address", "primary_symbol_id", "signature_override"),
        "required": ("start_address",),
        "update": ("primary_symbol_id", "signature_override", "can_return", "comment"),
        "bounds": "",
    },
    "entry_points": {"id": ("entry_point_id",), "insert": (), "update": (), "bounds": ""},
    "data_items": {
        "id": ("data_item_id",),
        "insert": ("address", "primary_symbol_id", "type_override_declaration"),
        "required": ("address",),
        "update": ("primary_symbol_id", "type_override_declaration"),
        "bounds": "",
    },
    "strings": {"id": ("string_id",), "insert": (), "update": (), "bounds": ""},
    "types": {
        "id": ("type_id",),
        "insert": ("qualified_name", "kind", "layout_mode", "size_bytes", "declaration"),
        "update": ("qualified_name", "declaration", "layout_mode", "size_bytes"),
        "bounds": "",
    },
    "type_members": {
        "id": ("member_id",),
        "insert": ("owner_type_id", "member_index", "name", "offset_bits", "width_bits", "type_declaration", "access", "scope", "is_base", "is_virtual_base", "is_vtable", "comment"),
        "update": ("member_index", "name", "offset_bits", "width_bits", "type_declaration", "access", "scope", "is_base", "is_virtual_base", "is_vtable", "comment"),
        "bounds": "",
    },
    "enum_values": {
        "id": ("enum_value_id",),
        "insert": ("owner_type_id", "name", "integer_value", "comment"),
        "update": ("name", "integer_value", "comment"),
        "bounds": "",
    },
    "function_type_parameters": {"id": ("parameter_id",), "insert": (), "update": (), "bounds": ""},
    "memory_items": {"id": ("item_id",), "insert": (), "update": (), "bounds": "function_id = ? OR segment_id = ? OR (address >= ? AND address < ?)"},
    "instructions": {"id": ("instruction_id",), "insert": (), "update": (), "bounds": "function_id = ? OR (address >= ? AND address < ?)"},
    "instruction_operands": {"id": ("instruction_id", "operand_index"), "insert": (), "update": (), "bounds": "instruction_id = ? OR function_id = ? OR (instruction_address >= ? AND instruction_address < ?)"},
    "basic_blocks": {"id": ("basic_block_id",), "insert": (), "update": (), "bounds": "function_id = ?"},
    "cfg_edges": {"id": ("edge_id",), "insert": (), "update": (), "bounds": "function_id = ?"},
    "address_references": {"id": ("reference_id",), "insert": (), "update": (), "bounds": ""},
    "callers": {"id": ("reference_id",), "insert": (), "update": (), "bounds": ""},
    "callees": {"id": ("reference_id",), "insert": (), "update": (), "bounds": ""},
    "string_references": {"id": ("reference_id",), "insert": (), "update": (), "bounds": ""},
    "type_references": {"id": ("reference_id",), "insert": (), "update": (), "bounds": ""},
    "il_instructions": {"id": ("function_id", "il_level", "instruction_index", "expression_index"), "insert": (), "update": (), "bounds": "function_id = ?"},
    "pseudocode": {
        "id": ("comment_id",),
        "insert": ("function_id", "address", "placement", "text"),
        "update": ("placement", "text"),
        "bounds": "function_id = ? OR address = ?",
    },
    "function_variables": {
        "id": ("variable_id",),
        "insert": (),
        "update": ("name_override", "type_override_declaration", "comment"),
        "bounds": "function_id = ?",
    },
    "function_parameters": {"id": ("parameter_id",), "insert": (), "update": (), "bounds": "function_id = ?"},
    "address_comments": {
        "id": ("comment_id",),
        "insert": ("scope", "function_id", "address", "is_repeatable", "text"),
        "required": ("scope", "address", "is_repeatable", "text"),
        "update": ("text",),
        "bounds": "",
    },
    "all_comments": {"id": ("comment_id",), "insert": (), "update": (), "bounds": ""},
    "byte_search": {"id": ("address",), "insert": (), "update": (), "bounds": "pattern = ? AND start_address = ? AND end_address = ?"},
}


def v3_create_core_schema(connection: sqlite3.Connection) -> None:
    statements = (
        "CREATE TABLE program_metadata (key TEXT PRIMARY KEY, value TEXT, value_type TEXT NOT NULL)",
        "CREATE TABLE segments (segment_id TEXT PRIMARY KEY, name TEXT, start_address TEXT NOT NULL, end_address TEXT NOT NULL, size_bytes INTEGER NOT NULL, is_readable INTEGER NOT NULL, is_writable INTEGER NOT NULL, is_executable INTEGER NOT NULL, semantics TEXT)",
        "CREATE TABLE symbols (symbol_id TEXT PRIMARY KEY DEFAULT (oms_id('symbol')), address TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT, kind TEXT NOT NULL, binding TEXT, namespace TEXT, origin TEXT NOT NULL DEFAULT 'user', is_import INTEGER NOT NULL DEFAULT 0)",
        "CREATE TABLE data_items (data_item_id TEXT PRIMARY KEY DEFAULT (oms_id('data_item')), address TEXT NOT NULL UNIQUE, primary_symbol_id TEXT, name TEXT, type_id TEXT, type_declaration TEXT, type_override_declaration TEXT, type_origin TEXT, size_bytes INTEGER, display_value TEXT, origin TEXT NOT NULL DEFAULT 'user', segment_id TEXT)",
        "CREATE TABLE address_comments (comment_id TEXT PRIMARY KEY DEFAULT (oms_id('comment')), scope TEXT NOT NULL, function_id TEXT, address TEXT NOT NULL, is_repeatable INTEGER NOT NULL, text TEXT NOT NULL, is_orphan INTEGER NOT NULL DEFAULT 0, UNIQUE(scope, function_id, address, is_repeatable))",
        "CREATE UNIQUE INDEX address_comments_owner ON address_comments(scope, coalesce(function_id,''), address, is_repeatable)",
        "CREATE TABLE all_comments (comment_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, target_id TEXT, address TEXT, function_id TEXT, placement TEXT, is_repeatable INTEGER, text TEXT NOT NULL, is_orphan INTEGER NOT NULL)",
        "CREATE TABLE sql_tables (table_name TEXT PRIMARY KEY, relation_kind TEXT NOT NULL, allowed_operations TEXT NOT NULL, identity_columns TEXT NOT NULL, required_bounds TEXT NOT NULL, description TEXT NOT NULL)",
        "CREATE TABLE sql_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, column_index INTEGER NOT NULL, sqlite_type TEXT NOT NULL, nullable INTEGER NOT NULL, insertable INTEGER NOT NULL, updatable INTEGER NOT NULL, enum_name TEXT, canonicalization TEXT, null_behavior TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY(table_name,column_name))",
        "CREATE TABLE sql_functions (function_name TEXT PRIMARY KEY, minimum_arguments INTEGER NOT NULL, maximum_arguments INTEGER NOT NULL, mutating INTEGER NOT NULL, argument_contract TEXT NOT NULL, return_contract TEXT NOT NULL, description TEXT NOT NULL)",
        "CREATE TABLE sql_enum_values (enum_name TEXT NOT NULL, value TEXT NOT NULL, description TEXT NOT NULL, PRIMARY KEY(enum_name,value))",
    )
    for statement in statements:
        connection.execute(statement)


def v3_register_core_functions(connection: sqlite3.Connection) -> None:
    connection.create_function("addr", 1, v3_address, deterministic=True)
    connection.create_function("address_add", 2, v3_address_add, deterministic=True)
    connection.create_function("integer_compare", 2, v3_integer_compare, deterministic=True)
    connection.create_function("oms_id", 1, lambda domain: v3_new_id(str(domain)))


def v3_value_text(value: Any) -> tuple[str | None, str]:
    if value is None:
        return None, "null"
    if isinstance(value, bool):
        return ("true" if value else "false"), "boolean"
    if isinstance(value, int):
        return str(value), "integer"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, separators=(",", ":")), "json"
    return str(value), "text"


def v3_function_id_for_object(function: Any) -> str | None:
    helper = globals().get("v3_function_id")
    if callable(helper):
        return str(helper(function))
    helper = globals().get("v3_function_id_for_native")
    if callable(helper):
        return str(helper(function))
    return v3_stable_id("function", f"{int(function.start):016x}")


def v3_find_function_by_id(identifier: str):
    for function in require_view().functions:
        if v3_function_id_for_object(function) == identifier:
            return function
    return None


def v3_segment_key(segment: Any) -> str:
    return f"{int(segment.start):016x}:{int(segment.end):016x}:{int(segment.data_offset):x}:{int(segment.data_length):x}"


def v3_segment_for_address(address: int) -> Any:
    for segment in require_view().segments:
        if int(segment.start) <= address < int(segment.end):
            return segment
    return None


def v3_type_id(type_object: Any) -> str | None:
    helper = globals().get("v3_type_id_for_object")
    if callable(helper):
        value = helper(type_object)
        return None if value is None else str(value)
    return None


def v3_populate_program_metadata(connection: sqlite3.Connection) -> None:
    view = require_view()
    values = {
        "backend": "binaryninja",
        "backend_version": bn.core_version(),
        "product": bn.core_product(),
        "filename": view.file.filename,
        "original_filename": view.file.original_filename,
        "database_path": database_path,
        "input_path": input_path,
        "view_type": view.view_type,
        "architecture": getattr(view.arch, "name", None),
        "platform": str(view.platform) if view.platform is not None else None,
        "entry_point": address_hex(view.entry_point),
        "start_address": address_hex(view.start),
        "end_address": address_hex(view.end),
        "address_size_bytes": int(view.address_size),
        "endianness": byte_order(),
        "temporary_database": temporary_database,
    }
    rows = []
    for key, value in values.items():
        text, value_type = v3_value_text(value)
        if key.endswith("_address") or key == "entry_point":
            value_type = "address"
        rows.append((key, text, value_type))
    connection.executemany("INSERT INTO program_metadata VALUES (?, ?, ?)", rows)


def v3_populate_segments(connection: sqlite3.Connection) -> None:
    rows = []
    for segment in require_view().segments:
        semantics = getattr(segment, "data_semantics", None)
        semantics_name = getattr(semantics, "name", str(semantics) if semantics is not None else None)
        rows.append((
            v3_stable_id("segment", v3_segment_key(segment)),
            str(segment),
            address_hex(segment.start),
            address_hex(segment.end),
            int(segment.end) - int(segment.start),
            int(bool(segment.readable)),
            int(bool(segment.writable)),
            int(bool(segment.executable)),
            semantics_name,
        ))
    connection.executemany("INSERT INTO segments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


def v3_symbol_kind(symbol: Any) -> str:
    name = symbol.type.name
    if "Function" in name:
        return "function"
    if "Data" in name or name == "ImportAddressSymbol":
        return "data"
    if name == "LocalLabelSymbol":
        return "label"
    if name == "ExternalSymbol":
        return "external"
    return "other"


def v3_symbol_origin(symbol: Any) -> str:
    imported = {"ImportedFunctionSymbol", "ImportedDataSymbol", "ImportAddressSymbol"}
    if symbol.type.name in imported:
        return "import"
    if bool(getattr(symbol, "auto", False)):
        return "analysis"
    identifier = v3_symbol_id(symbol)
    created = v3_oms_metadata.setdefault("created", {}).setdefault("symbol", [])
    return "oms" if identifier in created else "user"


def v3_symbol_row(symbol: Any) -> tuple[Any, ...]:
    imported = {"ImportedFunctionSymbol", "ImportedDataSymbol", "ImportAddressSymbol"}
    namespace = str(getattr(symbol, "namespace", "")) or None
    binding = getattr(getattr(symbol, "binding", None), "name", None)
    return (
        v3_symbol_id(symbol),
        address_hex(symbol.address),
        symbol.name,
        getattr(symbol, "full_name", symbol.name),
        v3_symbol_kind(symbol),
        binding,
        namespace,
        v3_symbol_origin(symbol),
        int(symbol.type.name in imported),
    )


def v3_populate_symbols(connection: sqlite3.Connection) -> None:
    connection.executemany(
        "INSERT INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (v3_symbol_row(symbol) for symbol in require_view().get_symbols()),
    )


def v3_data_key(address: int) -> str:
    return f"{address:016x}"


def v3_data_row(variable: Any) -> tuple[Any, ...]:
    address = int(variable.address)
    identifier = v3_stable_id("data_item", v3_data_key(address))
    candidates = [symbol for symbol in require_view().get_symbols(address) if v3_symbol_kind(symbol) == "data"]
    selected_id = v3_oms_metadata.setdefault("data_primary_symbols", {}).get(identifier)
    symbol = v3_find_symbol_by_id(str(selected_id)) if selected_id is not None else None
    if symbol is None and candidates:
        symbol = sorted(candidates, key=lambda item: (int(bool(getattr(item, "auto", False))), item.full_name, v3_symbol_id(item)))[0]
    segment = v3_segment_for_address(address)
    override = v3_oms_metadata.setdefault("data_overrides", {}).get(identifier)
    if override is None and not bool(variable.auto_discovered):
        override = str(variable.type)
    try:
        display = repr(variable.value)
    except Exception:
        display = None
    origin = "analysis" if bool(variable.auto_discovered) else ("oms" if identifier in v3_oms_metadata.setdefault("created", {}).setdefault("data_item", []) else "user")
    return (
        identifier,
        address_hex(address),
        v3_symbol_id(symbol) if symbol is not None else None,
        symbol.name if symbol is not None else None,
        v3_type_id(variable.type),
        str(variable.type),
        override,
        "analysis" if override is None else origin,
        int(getattr(variable.type, "width", len(variable))),
        display,
        origin,
        v3_stable_id("segment", v3_segment_key(segment)) if segment is not None else None,
    )


def v3_populate_data_items(connection: sqlite3.Connection) -> None:
    rows = [v3_data_row(variable) for variable in require_view().data_vars.values()]
    connection.executemany("INSERT INTO data_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)


def v3_comment_key(scope: str, function_id: str | None, address: int, repeatable: int) -> str:
    return f"{scope}:{function_id or '-'}:{address:016x}:{repeatable}"


def v3_comment_native_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for address, text in require_view().address_comments.items():
        rows.append({"scope": "global", "function_id": None, "address": int(address), "is_repeatable": 0, "text": str(text)})
    for function in require_view().functions:
        function_id = v3_function_id_for_object(function)
        for address, text in function.comments.items():
            rows.append({"scope": "function", "function_id": function_id, "address": int(address), "is_repeatable": 0, "text": str(text)})
    return rows


def v3_populate_address_comments(connection: sqlite3.Connection) -> None:
    rows_by_key: dict[str, dict[str, Any]] = {}
    for row in v3_comment_native_rows():
        key = v3_comment_key(row["scope"], row["function_id"], row["address"], row["is_repeatable"])
        identifier = v3_stable_id("comment", key)
        row.update({"comment_id": identifier, "is_orphan": 0})
        rows_by_key[key] = row
    for identifier, saved in v3_oms_metadata.setdefault("comments", {}).items():
        if not isinstance(saved, dict):
            continue
        try:
            address = int(str(saved["address"]), 0)
            scope = str(saved["scope"])
            function_id = saved.get("function_id")
            repeatable = int(bool(saved.get("is_repeatable")))
            text = str(saved["text"])
        except (KeyError, TypeError, ValueError):
            continue
        key = v3_comment_key(scope, function_id, address, repeatable)
        function_missing = scope == "function" and v3_find_function_by_id(str(function_id)) is None
        rows_by_key[key] = {
            "comment_id": str(identifier),
            "scope": scope,
            "function_id": function_id,
            "address": address,
            "is_repeatable": repeatable,
            "text": text,
            "is_orphan": int(function_missing),
        }
        v3_bind_id("comment", key, str(identifier))
    connection.executemany(
        "INSERT INTO address_comments VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            (
                row["comment_id"],
                row["scope"],
                row["function_id"],
                address_hex(row["address"]),
                row["is_repeatable"],
                row["text"],
                row["is_orphan"],
            )
            for row in rows_by_key.values()
        ),
    )


def v3_populate_all_comments(connection: sqlite3.Connection) -> None:
    connection.execute(
        "INSERT INTO all_comments SELECT comment_id,'address',comment_id,address,function_id,scope,is_repeatable,text,is_orphan FROM address_comments"
    )
    projections = (
        ("functions", "function_id", "function", "comment", "start_address", "function_id"),
        ("type_members", "member_id", "member", "comment", "NULL", "NULL"),
        ("enum_values", "enum_value_id", "enum", "comment", "NULL", "NULL"),
        ("function_variables", "variable_id", "variable", "comment", "NULL", "function_id"),
    )
    existing = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    for table, identity, kind, comment, address, function_id in projections:
        if table in existing:
            connection.execute(
                f"INSERT OR IGNORE INTO all_comments SELECT '{kind}:' || {identity},'{kind}',{identity},{address},{function_id},NULL,NULL,{comment},0 FROM {table} WHERE {comment} IS NOT NULL"
            )
    if "pseudocode" in existing:
        connection.execute(
            "INSERT OR IGNORE INTO all_comments SELECT comment_id,'pseudocode',comment_id,address,function_id,placement,NULL,text,is_orphan FROM pseudocode WHERE row_kind='comment' AND comment_id IS NOT NULL"
        )
    variable_resolver = globals().get("v3_native_variable_by_id")
    if callable(variable_resolver):
        for identifier, text in v3_oms_metadata.get("variable_comments", {}).items():
            resolved = variable_resolver(str(identifier))
            if resolved is None:
                continue
            function, _, _ = resolved
            connection.execute(
                "INSERT OR IGNORE INTO all_comments VALUES (?,?,?,?,?,?,?,?,?)",
                (f"variable:{identifier}", "variable", identifier, None, v3_function_id_for_object(function), None, None, str(text), 0),
            )
    for identifier, saved in v3_oms_metadata.get("pseudocode_comments", {}).items():
        if not isinstance(saved, dict):
            continue
        connection.execute(
            "INSERT OR IGNORE INTO all_comments VALUES (?,?,?,?,?,?,?,?,?)",
            (
                str(identifier), "pseudocode", str(identifier), saved.get("address"),
                saved.get("function_id"), saved.get("placement"), None,
                str(saved.get("text") or ""), 0,
            ),
        )


V3_TABLE_DESCRIPTIONS = {
    "program_metadata": "Read-only target and Binary Ninja metadata. Values are text tagged by value_type.",
    "segments": "Read-only half-open mapped segments; addresses are canonical unsigned-64 text.",
    "symbols": "Canonical symbol owner. INSERT requires address, name, and kind; UPDATE owns name, binding, and namespace; DELETE is restricted to user or OMS symbols.",
    "functions": "Canonical functions. Function names project the primary symbol and are renamed through symbols.",
    "function_parameters": "Read-only concrete function return and parameter rows; requires function_id.",
    "strings": "Read-only discovered strings with stable identities.",
    "data_items": "Canonical applied data. INSERT requires an address; type override and a same-address primary data symbol are optional. UPDATE owns only those overrides.",
    "types": "Canonical named type definitions. Declaration replacement conflicts with child edits to the same owner in one script.",
    "type_members": "Canonical structure/union members. Writable layout columns depend on the owner's layout_mode.",
    "enum_values": "Canonical enum values. integer_value is lossless signed decimal text.",
    "address_comments": "Canonical global and function-address comments. UPDATE changes text only; NULL and empty text are invalid.",
    "all_comments": "Read-only cross-domain comment search.",
    "memory_items": "Read-only code/data/undefined extents; requires an owner or both finite address bounds.",
    "instructions": "Read-only decoded instructions; requires function_id or both finite address bounds.",
    "instruction_operands": "Read-only operands; requires instruction_id, function_id, or both instruction-address bounds.",
    "basic_blocks": "Read-only basic blocks; requires function_id.",
    "cfg_edges": "Read-only CFG edges; requires function_id.",
    "address_references": "Authoritative code, data, type, and member reference relation.",
    "callers": "Read-only call references projected by callee.",
    "callees": "Read-only call references projected by caller.",
    "string_references": "Read-only source-to-string reference projection.",
    "type_references": "Read-only code, data, type, and member type-reference projection.",
    "il_instructions": "Read-only normalized IL; requires function_id.",
    "pseudocode": "Correlated decompile rows. Code rows are read-only; comment rows use comment_id.",
    "function_variables": "Effective name/type are read-only; locals own nullable name/type overrides and all roles own nullable comments.",
    "byte_search": "Constraint relation requiring pattern and both half-open address endpoints.",
}

V3_ENUMS: dict[str, tuple[str, ...]] = {
    "origin": ("analysis", "debug", "import", "user", "oms"),
    "symbol_kind": ("function", "data", "label", "external", "other"),
    "comment_scope": ("global", "function"),
    "type_kind": ("struct", "union", "enum", "function", "typedef", "other"),
    "layout_mode": ("automatic", "packed", "explicit"),
    "il_level": ("lifted", "llil", "llil_ssa", "mlil", "mlil_ssa", "mapped_mlil", "mapped_mlil_ssa", "hlil", "hlil_ssa"),
    "variable_role": ("argument", "local", "result"),
    "reference_kind": ("call", "jump", "flow", "read", "write", "address", "text", "type", "member", "unknown"),
}

V3_COLUMN_ENUMS = {
    ("symbols", "kind"): "symbol_kind",
    ("symbols", "origin"): "origin",
    ("data_items", "origin"): "origin",
    ("address_comments", "scope"): "comment_scope",
    ("types", "kind"): "type_kind",
    ("types", "layout_mode"): "layout_mode",
    ("types", "origin"): "origin",
    ("type_members", "origin"): "origin",
    ("enum_values", "origin"): "origin",
    ("il_instructions", "il_level"): "il_level",
    ("function_variables", "role"): "variable_role",
    ("address_references", "kind"): "reference_kind",
}


def v3_catalog_column_description(table: str, column: str) -> tuple[str | None, str, str]:
    enum_name = V3_COLUMN_ENUMS.get((table, column))
    if column.endswith("_address") or column in {"address", "start_address", "end_address", "source_address", "target_address", "instruction_address", "call_address", "fallthrough_address"}:
        return enum_name, "lowercase fixed-width 0x-prefixed unsigned-64 text", "NULL means unavailable; writable address columns never use NULL"
    if column.endswith("_id"):
        return enum_name, "opaque stable TEXT identity", "NULL means the optional related entity is unavailable"
    if column.endswith("_declaration") or column == "signature_override":
        behavior = "NULL clears the override" if column in {"type_override_declaration", "signature_override"} else "NULL means unavailable"
        return enum_name, "Binary Ninja normalized declaration where documented", behavior
    if column in {"comment", "text"}:
        return enum_name, "UTF-8 text", "NULL clears nullable local comments; address comment text rejects NULL and empty strings"
    return enum_name, "", "NULL means unavailable unless the table description states that it clears a property"


def v3_populate_catalog(connection: sqlite3.Connection) -> None:
    relations = list(connection.execute(
        "SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ))
    table_rows = []
    column_rows = []
    for name, relation_kind in relations:
        policy = V3_TABLE_POLICIES.get(name, {"id": (), "insert": (), "update": (), "bounds": ""})
        operations = ["SELECT"]
        if policy.get("insert"):
            operations.append("INSERT")
        if policy.get("update"):
            operations.append("UPDATE")
        if policy.get("delete", bool(policy.get("insert"))):
            operations.append("DELETE")
        table_rows.append((
            name,
            relation_kind,
            ",".join(operations),
            ",".join(policy.get("id", ())),
            policy.get("bounds", ""),
            V3_TABLE_DESCRIPTIONS.get(name, "Canonical read-only Binary Ninja SQL relation." if not policy.get("insert") else "Canonical writable Binary Ninja SQL relation."),
        ))
        insertable = set(policy.get("insert", ()))
        updatable = set(policy.get("update", ()))
        for ordinal, pragma in enumerate(connection.execute(f'PRAGMA table_info("{name}")')):
            column = str(pragma[1])
            enum_name, canonicalization, null_behavior = v3_catalog_column_description(name, column)
            column_rows.append((
                name,
                column,
                ordinal,
                str(pragma[2] or ""),
                int(not bool(pragma[3])),
                int(column in insertable),
                int(column in updatable),
                enum_name,
                canonicalization,
                null_behavior,
                f"{'Writable' if column in insertable or column in updatable else 'Read-only'} {column} column.",
            ))
    connection.executemany("INSERT INTO sql_tables VALUES (?, ?, ?, ?, ?, ?)", table_rows)
    connection.executemany("INSERT INTO sql_columns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", column_rows)
    function_rows = (
        ("addr", 1, 1, 0, "integer or decimal/hex address text", "canonical address TEXT", "Normalizes a lossless unsigned-64 address."),
        ("address_add", 2, 2, 0, "canonical address and signed decimal delta", "canonical address TEXT", "Checked unsigned-64 address arithmetic."),
        ("integer_compare", 2, 2, 0, "two signed decimal TEXT integers", "-1, 0, or 1", "Lossless integer ordering outside SQLite's integer range."),
        ("type_at", 1, 1, 0, "exact address", "effective declaration or NULL", "Resolves only an exact function/data row."),
        ("set_type", 2, 2, 1, "constant exact address and nullable declaration", "1", "Updates the one exact canonical function/data owner and verifies readback."),
        ("parse_type", 1, 1, 1, "one named declaration constant expression", "type_id", "Atomic exact UPSERT of one named type."),
        ("parse_types", 1, 1, 1, "declaration unit constant expression", "canonical JSON TEXT", "Atomic dependency-aware named type UPSERT."),
        ("invalidate_decompile", 1, 1, 1, "standalone constant exact address", "1", "Non-persistent cache control; forbidden in scripts or with DML."),
        ("read_bytes", 2, 2, 0, "address,size_bytes (maximum 4096)", "BLOB", "Reads exactly the requested bytes or errors."),
        ("read_u8", 1, 2, 0, "address[,endianness]", "lossless integer", "Reads an unsigned 8-bit integer."),
        ("read_u16", 1, 2, 0, "address[,endianness]", "lossless integer", "Reads an unsigned 16-bit integer."),
        ("read_u32", 1, 2, 0, "address[,endianness]", "lossless integer", "Reads an unsigned 32-bit integer."),
        ("read_u64", 1, 2, 0, "address[,endianness]", "lossless integer", "Reads an unsigned 64-bit integer."),
        ("read_i8", 1, 2, 0, "address[,endianness]", "INTEGER", "Reads a signed 8-bit integer."),
        ("read_i16", 1, 2, 0, "address[,endianness]", "INTEGER", "Reads a signed 16-bit integer."),
        ("read_i32", 1, 2, 0, "address[,endianness]", "INTEGER", "Reads a signed 32-bit integer."),
        ("read_i64", 1, 2, 0, "address[,endianness]", "INTEGER", "Reads a signed 64-bit integer."),
        ("read_f32", 1, 2, 0, "address[,endianness]", "REAL", "Reads an IEEE-754 binary32 value."),
        ("read_f64", 1, 2, 0, "address[,endianness]", "REAL", "Reads an IEEE-754 binary64 value."),
        ("read_ptr", 1, 3, 0, "address[,width_bytes[,endianness]]", "lossless integer", "Reads a pointer-width unsigned integer."),
        ("read_rel32", 1, 2, 0, "address[,endianness]", "canonical address TEXT", "Reads a signed rel32 and adds the following-address base."),
        ("read_cstr", 2, 3, 0, "address,max_bytes[,encoding]", "TEXT", "Requires a terminator within max_bytes."),
        ("decompile", 1, 1, 0, "address resolving to one function", "TEXT", "Returns full correlated pseudocode."),
    )
    connection.executemany("INSERT INTO sql_functions VALUES (?, ?, ?, ?, ?, ?, ?)", function_rows)
    enum_rows = ((name, value, f"Allowed {name} value.") for name, values in V3_ENUMS.items() for value in values)
    connection.executemany("INSERT INTO sql_enum_values VALUES (?, ?, ?)", enum_rows)


def v3_rows(connection: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(f'SELECT * FROM "{table}"')]


def v3_index_rows(rows: list[dict[str, Any]], keys: tuple[str, ...]) -> dict[tuple[Any, ...], dict[str, Any]]:
    return {tuple(row.get(key) for key in keys): row for row in rows}


def v3_symbol_type(kind: str):
    mapping = {
        "function": bn.SymbolType.FunctionSymbol,
        "data": bn.SymbolType.DataSymbol,
        "label": bn.SymbolType.LocalLabelSymbol,
        "external": bn.SymbolType.ExternalSymbol,
        "other": bn.SymbolType.DataSymbol,
    }
    if kind not in mapping:
        raise RuntimeError(f"Unsupported symbol kind '{kind}'; query sql_enum_values for symbol_kind")
    return mapping[kind]


def v3_symbol_binding(name: Any):
    if name is None or str(name) in {"", "none", "NoBinding"}:
        return bn.SymbolBinding.NoBinding
    text = str(name)
    aliases = {
        "local": "LocalBinding",
        "global": "GlobalBinding",
        "weak": "WeakBinding",
    }
    member = aliases.get(text.lower(), text)
    try:
        return bn.SymbolBinding[member]
    except KeyError:
        raise RuntimeError(f"Unsupported symbol binding: {name}")


def v3_define_symbol(row: dict[str, Any], native_type: Any = None):
    address = int(v3_address(row["address"]), 16)
    name = str(row.get("name") or "")
    if not name:
        raise RuntimeError("symbols.name must not be empty")
    symbol_type = native_type if native_type is not None else v3_symbol_type(str(row["kind"]))
    namespace_text = str(row.get("namespace") or "")
    namespace = [part for part in namespace_text.split("::") if part] or None
    symbol = bn.Symbol(
        symbol_type,
        address,
        name,
        binding=v3_symbol_binding(row.get("binding")),
        namespace=namespace,
    )
    require_view().define_user_symbol(symbol)
    candidates = [
        candidate for candidate in require_view().get_symbols(address)
        if candidate.type == symbol_type and candidate.name == name
    ]
    selected = candidates[0] if candidates else require_view().get_symbol_at(address)
    if selected is None:
        raise RuntimeError(f"Binary Ninja did not retain symbol '{name}' at {address_hex(address)}")
    v3_bind_id("symbol", v3_symbol_key(selected), str(row["symbol_id"]))
    return selected


def v3_apply_symbol_diff(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    keys = ("symbol_id",)
    old, new = v3_index_rows(before, keys), v3_index_rows(after, keys)
    if operation == "delete":
        for identity in old.keys() - new.keys():
            row = old[identity]
            if row.get("origin") not in {"user", "oms"}:
                raise RuntimeError(f"Symbol {row['symbol_id']} has origin={row.get('origin')} and cannot be deleted")
            symbol = v3_find_symbol_by_id(str(row["symbol_id"]))
            if symbol is None or bool(getattr(symbol, "auto", False)):
                raise RuntimeError(f"Symbol {row['symbol_id']} is not a removable user symbol")
            native_key = v3_symbol_key(symbol)
            require_view().undefine_user_symbol(symbol)
            v3_retire_id("symbol", native_key)
        return
    for identity in new.keys() - old.keys():
        v3_mark_created("symbol", str(new[identity]["symbol_id"]))
        v3_define_symbol(new[identity])
    if operation == "update":
        for identity in old.keys() & new.keys():
            if old[identity] == new[identity]:
                continue
            symbol = v3_find_symbol_by_id(str(new[identity]["symbol_id"]))
            if symbol is None:
                raise RuntimeError(f"Symbol not found: {new[identity]['symbol_id']}")
            native_key = v3_symbol_key(symbol)
            native_type = symbol.type
            if not bool(getattr(symbol, "auto", False)):
                require_view().undefine_user_symbol(symbol)
            replacement = v3_define_symbol(new[identity], native_type)
            if v3_symbol_key(replacement) != native_key:
                v3_retire_id("symbol", native_key)


def v3_validate_data_primary(symbol_id: Any, address: int):
    if symbol_id is None:
        return None
    symbol = v3_find_symbol_by_id(str(symbol_id))
    if symbol is None:
        raise RuntimeError(f"Primary data symbol not found: {symbol_id}")
    if int(symbol.address) != address or v3_symbol_kind(symbol) != "data":
        raise RuntimeError("data_items.primary_symbol_id must name a data symbol at the same address")
    return symbol


def v3_data_type(declaration: Any):
    if declaration is None:
        return None
    text = str(declaration).strip()
    if not text:
        raise RuntimeError("type_override_declaration must be NULL to clear; empty text is invalid")
    parsed, _ = require_view().parse_type_string(text)
    return parsed


def v3_apply_data_diff(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    keys = ("data_item_id",)
    old, new = v3_index_rows(before, keys), v3_index_rows(after, keys)
    overrides = v3_oms_metadata.setdefault("data_overrides", {})
    primaries = v3_oms_metadata.setdefault("data_primary_symbols", {})
    if operation == "delete":
        for identity in old.keys() - new.keys():
            row = old[identity]
            if row.get("origin") not in {"user", "oms"}:
                raise RuntimeError(f"Data item {row['data_item_id']} has origin={row.get('origin')} and cannot be deleted")
            address = int(v3_address(row["address"]), 16)
            variable = require_view().get_data_var_at(address)
            if variable is None or bool(variable.auto_discovered):
                raise RuntimeError(f"Data item {row['data_item_id']} is not a removable user data variable")
            require_view().undefine_user_data_var(address)
            overrides.pop(str(row["data_item_id"]), None)
            primaries.pop(str(row["data_item_id"]), None)
            v3_retire_id("data_item", v3_data_key(address))
        return
    for identity in new.keys() - old.keys():
        row = new[identity]
        address = int(v3_address(row["address"]), 16)
        v3_validate_data_primary(row.get("primary_symbol_id"), address)
        declaration = row.get("type_override_declaration")
        data_type = v3_data_type(declaration)
        if data_type is None:
            data_type = bn.Type.int(1, False)
        result = require_view().define_user_data_var(address, data_type)
        if result is None:
            raise RuntimeError(f"Binary Ninja could not define data at {address_hex(address)}")
        identifier = str(row["data_item_id"])
        v3_mark_created("data_item", identifier)
        v3_bind_id("data_item", v3_data_key(address), identifier)
        if declaration is not None:
            overrides[identifier] = str(data_type)
        if row.get("primary_symbol_id") is not None:
            primaries[identifier] = str(row["primary_symbol_id"])
    if operation == "update":
        for identity in old.keys() & new.keys():
            previous, row = old[identity], new[identity]
            if previous == row:
                continue
            identifier = str(row["data_item_id"])
            address = int(v3_address(row["address"]), 16)
            v3_validate_data_primary(row.get("primary_symbol_id"), address)
            if previous.get("primary_symbol_id") != row.get("primary_symbol_id"):
                if row.get("primary_symbol_id") is None:
                    primaries.pop(identifier, None)
                else:
                    primaries[identifier] = str(row["primary_symbol_id"])
            if previous.get("type_override_declaration") != row.get("type_override_declaration"):
                declaration = row.get("type_override_declaration")
                if declaration is None:
                    require_view().undefine_user_data_var(address)
                    overrides.pop(identifier, None)
                else:
                    data_type = v3_data_type(declaration)
                    result = require_view().define_user_data_var(address, data_type)
                    if result is None:
                        raise RuntimeError(f"Binary Ninja could not apply data type at {address_hex(address)}")
                    overrides[identifier] = str(data_type)


def v3_set_native_comment(scope: str, function_id: str | None, address: int, text: str) -> None:
    if scope == "global":
        if function_id is not None:
            raise RuntimeError("Global address comments require function_id=NULL")
        require_view().set_comment_at(address, text)
        return
    if scope != "function" or function_id is None:
        raise RuntimeError("Function address comments require a function_id")
    function = v3_find_function_by_id(str(function_id))
    if function is None:
        raise RuntimeError(f"Function not found: {function_id}")
    function.set_comment_at(address, text)


def v3_validate_comment_row(row: dict[str, Any]) -> tuple[str, str | None, int, int, str]:
    scope = str(row.get("scope") or "")
    function_id = None if row.get("function_id") is None else str(row["function_id"])
    address = int(v3_address(row.get("address")), 16)
    repeatable = int(row.get("is_repeatable"))
    text_value = row.get("text")
    if repeatable not in {0, 1}:
        raise RuntimeError("address_comments.is_repeatable must be 0 or 1")
    if text_value is None or not str(text_value):
        raise RuntimeError("address_comments.text rejects NULL and empty text; use DELETE to clear")
    if scope == "global" and function_id is not None:
        raise RuntimeError("Global address comments require function_id=NULL")
    if scope == "function" and function_id is None:
        raise RuntimeError("Function address comments require function_id")
    if scope not in {"global", "function"}:
        raise RuntimeError("address_comments.scope must be global or function")
    if scope == "function" and v3_find_function_by_id(function_id) is None:
        raise RuntimeError(f"Function not found: {function_id}")
    return scope, function_id, address, repeatable, str(text_value)


def v3_apply_comment_diff(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    keys = ("comment_id",)
    old, new = v3_index_rows(before, keys), v3_index_rows(after, keys)
    comments = v3_oms_metadata.setdefault("comments", {})
    if operation == "delete":
        for identity in old.keys() - new.keys():
            row = old[identity]
            scope, function_id, address, repeatable, _ = v3_validate_comment_row(row)
            if repeatable == 0:
                v3_set_native_comment(scope, function_id, address, "")
            comments.pop(str(row["comment_id"]), None)
            v3_retire_id("comment", v3_comment_key(scope, function_id, address, repeatable))
        return
    candidates = list(new.keys() - old.keys())
    if operation == "update":
        candidates.extend(identity for identity in new.keys() & old.keys() if new[identity] != old[identity])
    for identity in candidates:
        row = new[identity]
        scope, function_id, address, repeatable, text = v3_validate_comment_row(row)
        if identity in old:
            immutable = ("scope", "function_id", "address", "is_repeatable", "is_orphan")
            changed = [column for column in immutable if old[identity].get(column) != row.get(column)]
            if changed:
                raise RuntimeError(f"address_comments UPDATE cannot change read-only column(s): {', '.join(changed)}")
        if repeatable == 0:
            v3_set_native_comment(scope, function_id, address, text)
        identifier = str(row["comment_id"])
        comments[identifier] = {
            "scope": scope,
            "function_id": function_id,
            "address": address_hex(address),
            "is_repeatable": repeatable,
            "text": text,
        }
        v3_bind_id("comment", v3_comment_key(scope, function_id, address, repeatable), identifier)


def v3_apply_table_diff(table: str, operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    if table == "symbols":
        v3_apply_symbol_diff(operation, before, after)
        return
    if table == "data_items":
        v3_apply_data_diff(operation, before, after)
        return
    if table == "address_comments":
        v3_apply_comment_diff(operation, before, after)
        return
    type_hook = globals().get("v3_apply_type_diff")
    if table in {"types", "type_members", "enum_values"} and callable(type_hook):
        type_hook(table, operation, before, after)
        return
    analysis_hook = globals().get("v3_apply_analysis_diff")
    if callable(analysis_hook):
        handled = analysis_hook(table, operation, before, after)
        if handled is not False:
            return
    raise RuntimeError(f"Table '{table}' is read-only")


def v3_sql_shape(sql: str) -> str:
    output = list(sql)
    index = 0
    quote = None
    while index < len(sql):
        char = sql[index]
        if quote is not None:
            output[index] = " "
            if char == quote:
                if index + 1 < len(sql) and sql[index + 1] == quote:
                    output[index + 1] = " "
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if char in {"'", '"', "`"}:
            quote = char
            output[index] = " "
            index += 1
            continue
        if char == "[":
            quote = "]"
            output[index] = " "
            index += 1
            continue
        if sql.startswith("--", index):
            end = sql.find("\n", index)
            end = len(sql) if end < 0 else end
            output[index:end] = " " * (end - index)
            index = end
            continue
        if sql.startswith("/*", index):
            end = sql.find("*/", index + 2)
            end = len(sql) if end < 0 else end + 2
            output[index:end] = " " * (end - index)
            index = end
            continue
        index += 1
    return "".join(output)


def v3_split_sql(sql: str) -> list[str]:
    statements: list[str] = []
    start = 0
    for index, char in enumerate(sql):
        if char == ";" and sqlite3.complete_statement(sql[start:index + 1]):
            statement = sql[start:index + 1].strip()
            if statement:
                statements.append(statement)
            start = index + 1
    remainder = sql[start:].strip()
    if remainder:
        if not sqlite3.complete_statement(remainder + ";"):
            raise RuntimeError("Incomplete SQL statement")
        statements.append(remainder)
    if not statements:
        raise RuntimeError("SQL script is empty")
    return statements


def v3_split_expressions(text: str) -> list[str]:
    parts: list[str] = []
    start = 0
    depth = 0
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if quote is not None:
            if char == quote:
                if index + 1 < len(text) and text[index + 1] == quote:
                    index += 2
                    continue
                quote = None
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            parts.append(text[start:index].strip())
            start = index + 1
        index += 1
    parts.append(text[start:].strip())
    return [part for part in parts if part]


def v3_statement_info(statement: str) -> dict[str, Any] | None:
    shape = v3_sql_shape(statement)
    lowered = shape.lower()
    match = re.search(r"\b(insert)\s+into\s+([a-z_][a-z0-9_]*)|\b(update)\s+([a-z_][a-z0-9_]*)|\b(delete)\s+from\s+([a-z_][a-z0-9_]*)|\b(replace)\s+into\s+([a-z_][a-z0-9_]*)", lowered)
    if match is None:
        return None
    operation = next(value for value in (match.group(1), match.group(3), match.group(5), match.group(7)) if value)
    table = next(value for value in (match.group(2), match.group(4), match.group(6), match.group(8)) if value)
    returning_match = list(re.finditer(r"\breturning\b", lowered))
    returning = statement[returning_match[-1].end():].strip().rstrip(";").strip() if returning_match else None
    assigned: list[str] = []
    if operation in {"insert", "replace"}:
        suffix = shape[match.end():]
        columns = re.match(r"\s*\(([^)]*)\)", suffix)
        if columns is not None:
            assigned = [column.strip().strip('"`[]').lower() for column in columns.group(1).split(",")]
    elif operation == "update":
        set_match = re.search(r"\bset\b", lowered[match.end():])
        if set_match is None:
            raise RuntimeError("UPDATE is missing SET")
        start = match.end() + set_match.end()
        boundary = re.search(r"\b(where|returning|order\s+by|limit)\b", lowered[start:])
        end = start + boundary.start() if boundary else len(statement)
        for assignment in v3_split_expressions(statement[start:end]):
            column_match = re.match(r"\s*([a-z_][a-z0-9_]*)\s*=", v3_sql_shape(assignment), re.I)
            if column_match is None:
                raise RuntimeError(f"Could not identify UPDATE assignment: {assignment}")
            assigned.append(column_match.group(1).lower())
    return {"operation": operation, "table": table, "assigned": assigned, "returning": returning}


def v3_validate_writes(connection: sqlite3.Connection, info: dict[str, Any]) -> None:
    operation, table = info["operation"], info["table"]
    if operation == "replace":
        raise RuntimeError("REPLACE is not part of the canonical DML contract; use INSERT or UPDATE")
    policy = V3_TABLE_POLICIES.get(table)
    writable = policy is not None and (
        (operation == "insert" and bool(policy.get("insert")))
        or (operation == "update" and bool(policy.get("update")))
        or (operation == "delete" and bool(policy.get("delete", bool(policy.get("insert")))))
    )
    if not writable:
        raise RuntimeError(f"Table '{table}' does not permit {operation.upper()}")
    assigned = info["assigned"]
    if operation == "insert" and not assigned:
        raise RuntimeError(f"INSERT into {table} must name its writable columns explicitly")
    allowed = set(policy["insert"] if operation == "insert" else policy.get("update", ()))
    rejected = sorted(set(assigned) - allowed)
    if rejected:
        raise RuntimeError(f"{operation.upper()} on {table} assigns read-only column(s): {', '.join(rejected)}")
    if operation == "insert":
        missing = sorted(set(policy.get("required", ())) - set(assigned))
        if missing:
            raise RuntimeError(f"INSERT into {table} requires column(s): {', '.join(missing)}")
    existing = {str(row[1]).lower() for row in connection.execute(f'PRAGMA table_info("{table}")')}
    unknown = sorted(set(assigned) - existing)
    if unknown:
        raise RuntimeError(f"Unknown column(s) for {table}: {', '.join(unknown)}")


def v3_sql_literal(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def v3_install_touch_capture(connection: sqlite3.Connection, table: str, operation: str, keys: tuple[str, ...]) -> None:
    connection.execute("DROP TABLE IF EXISTS temp.v3_touched")
    connection.execute("CREATE TEMP TABLE v3_touched (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, identity_json TEXT NOT NULL)")
    timing = "BEFORE" if operation == "delete" else "AFTER"
    prefix = "OLD" if operation == "delete" else "NEW"
    expressions = ",".join(f'{prefix}."{key}"' for key in keys)
    connection.execute("DROP TRIGGER IF EXISTS temp.v3_capture")
    connection.execute(
        f'CREATE TEMP TRIGGER v3_capture {timing} {operation.upper()} ON "{table}" BEGIN '
        f"INSERT INTO v3_touched(identity_json) VALUES(json_array({expressions})); END"
    )


def v3_touched_identities(connection: sqlite3.Connection) -> list[tuple[Any, ...]]:
    rows = [tuple(json.loads(row[0])) for row in connection.execute("SELECT identity_json FROM v3_touched ORDER BY ordinal")]
    connection.execute("DROP TRIGGER IF EXISTS temp.v3_capture")
    connection.execute("DROP TABLE IF EXISTS temp.v3_touched")
    return rows


def v3_requested_tables(sql: str) -> set[str]:
    return {match.group(1).lower() for match in TABLE_PATTERN.finditer(v3_sql_shape(sql))}


def v3_result(cursor: sqlite3.Cursor) -> dict[str, Any]:
    columns = [item[0] for item in cursor.description or ()]
    rows: list[dict[str, Any]] = []
    response_bytes = 0
    while True:
        batch = cursor.fetchmany(1024)
        if not batch:
            break
        for sqlite_row in batch:
            row = {column: json_value(sqlite_row[column]) for column in columns}
            rows.append(row)
            if len(rows) > 100000:
                raise RuntimeError("SQL row budget exceeded (maximum 100000)")
            response_bytes += len(json.dumps(row, separators=(",", ":")).encode("utf-8"))
            if response_bytes > 8 * 1024 * 1024:
                raise RuntimeError("SQL response budget exceeded (maximum 8388608 bytes)")
    return {"columns": columns, "rows": rows}


def v3_select_returning(
    connection: sqlite3.Connection,
    table: str,
    returning: str,
    keys: tuple[str, ...],
    identities: list[tuple[Any, ...]],
    parameters: Any,
) -> dict[str, Any]:
    columns: list[str] = []
    rows: list[dict[str, Any]] = []
    for identity in identities:
        predicate = " AND ".join(f'"{key}" IS {v3_sql_literal(value)}' for key, value in zip(keys, identity))
        cursor = connection.execute(f'SELECT {returning} FROM "{table}" WHERE {predicate}', parameters or {})
        result = v3_result(cursor)
        if not columns:
            columns = result["columns"]
        rows.extend(result["rows"])
    return {"columns": columns, "rows": rows}


V3_MUTATING_SCALARS = {"set_type", "parse_type", "parse_types"}
V3_CONSTANT_SCALARS = {
    "addr", "address_add", "integer_compare",
    "read_u8", "read_u16", "read_u32", "read_u64",
    "read_i8", "read_i16", "read_i32", "read_i64",
    "read_f32", "read_f64", "read_ptr", "read_bytes", "read_cstr", "read_rel32",
    "type_at", "decompile", "invalidate_decompile", "cast",
}


def v3_mutating_call_ranges(statement: str) -> list[tuple[int, int, str]]:
    shape = v3_sql_shape(statement)
    ranges = []
    for match in re.finditer(r"\b(set_type|parse_type|parse_types)\s*\(", shape, re.I):
        depth = 1
        index = match.end()
        while index < len(shape) and depth:
            if shape[index] == "(":
                depth += 1
            elif shape[index] == ")":
                depth -= 1
            index += 1
        if depth:
            raise RuntimeError(f"Unclosed {match.group(1)} call")
        ranges.append((match.start(), index, match.group(1).lower()))
    for left, right in zip(ranges, ranges[1:]):
        if right[0] < left[1]:
            raise RuntimeError("Mutating scalar calls cannot be nested")
    return ranges


def v3_validate_constant_scalar(expression: str, function_name: str) -> None:
    shape = v3_sql_shape(expression)
    shape = re.sub(r"[:@$][a-z_][a-z0-9_]*|\?[0-9]*", " ", shape, flags=re.I)
    identifiers = set(re.findall(r"\b[a-z_][a-z0-9_]*\b", shape, re.I))
    allowed = V3_CONSTANT_SCALARS | V3_MUTATING_SCALARS | {
        "null", "true", "false", "as", "text", "integer", "real", "blob", "numeric",
    }
    disallowed = sorted(identifier.lower() for identifier in identifiers if identifier.lower() not in allowed)
    if disallowed:
        raise RuntimeError(
            f"{function_name} arguments must be constant expressions; disallowed identifier(s): {', '.join(disallowed)}"
        )
    nested_mutators = V3_MUTATING_SCALARS & {identifier.lower() for identifier in identifiers}
    nested_mutators.discard(function_name)
    if nested_mutators:
        raise RuntimeError("Mutating scalar calls cannot be arguments to another mutating scalar")


def v3_evaluate_mutating_scalars(
    connection: sqlite3.Connection, statement: str, parameters: Any
) -> str:
    rewritten = statement
    for start, end, name in reversed(v3_mutating_call_ranges(statement)):
        expression = statement[start:end]
        v3_validate_constant_scalar(expression, name)
        row = connection.execute(f"SELECT {expression}", parameters or {}).fetchone()
        if row is None:
            raise RuntimeError(f"{name} did not return a value")
        rewritten = rewritten[:start] + v3_sql_literal(row[0]) + rewritten[end:]
    return rewritten


def v3_validate_script_conflicts(records: list[dict[str, Any]]) -> None:
    replaced_owners = {
        str(row.get("type_id"))
        for record in records
        if record["table"] == "types"
        and record["operation"] == "update"
        and "declaration" in record.get("assigned", ())
        for row in record.get("touched_rows", ())
        if row.get("type_id") is not None
    }
    child_owners = {
        str(row.get("owner_type_id"))
        for record in records
        if record["table"] in {"type_members", "enum_values"}
        for row in record.get("touched_rows", ())
        if row.get("owner_type_id") is not None
    }
    conflicts = sorted(replaced_owners & child_owners)
    if conflicts:
        raise RuntimeError(
            "A script cannot replace types.declaration and edit children of the same owner: "
            + ", ".join(conflicts)
        )


def v3_validate_invalidate_statement(statement: str) -> None:
    shape = v3_sql_shape(statement)
    match = re.match(r"^\s*select\s+invalidate_decompile\s*\(", shape, re.I)
    if match is None:
        raise RuntimeError("invalidate_decompile is permitted only as a standalone SELECT")
    depth = 1
    index = match.end()
    while index < len(shape) and depth:
        if shape[index] == "(":
            depth += 1
        elif shape[index] == ")":
            depth -= 1
        index += 1
    if depth or not re.fullmatch(r"\s*;?\s*", shape[index:]):
        raise RuntimeError("invalidate_decompile is permitted only as SELECT invalidate_decompile(constant)")
    expression = statement[match.start():index]
    call_start = re.search(r"\binvalidate_decompile\s*\(", expression, re.I)
    if call_start is None:
        raise RuntimeError("Invalid invalidate_decompile expression")
    v3_validate_constant_scalar(expression[call_start.start():], "invalidate_decompile")


def v3_materialization_sql(sql: str, parameters: Any) -> str:
    if parameters is None:
        return sql
    shape = v3_sql_shape(sql)
    replacements: list[tuple[int, int, str]] = []
    if isinstance(parameters, dict):
        for match in re.finditer(r"(?<!:):([a-z_][a-z0-9_]*)|[$@]([a-z_][a-z0-9_]*)", shape, re.I):
            name = match.group(1) or match.group(2)
            if name not in parameters:
                raise RuntimeError(f"Missing SQL parameter: {name}")
            replacements.append((match.start(), match.end(), v3_sql_literal(parameters[name])))
    elif isinstance(parameters, (list, tuple)):
        matches = list(re.finditer(r"\?(?:[1-9][0-9]*)?", shape))
        for ordinal, match in enumerate(matches):
            explicit = match.group(0)[1:]
            parameter_index = int(explicit) - 1 if explicit else ordinal
            if parameter_index >= len(parameters):
                raise RuntimeError(f"Missing positional SQL parameter {parameter_index + 1}")
            replacements.append((match.start(), match.end(), v3_sql_literal(parameters[parameter_index])))
    else:
        raise RuntimeError("SQL params must be an object or array")
    rendered = sql
    for start, end, literal in reversed(replacements):
        rendered = rendered[:start] + literal + rendered[end:]
    return rendered


def v3_execute_query(sql: str, parameters: Any = None) -> dict[str, Any]:
    statements = v3_split_sql(sql)
    shape = v3_sql_shape(sql)
    if re.search(r"\b(begin|commit|rollback|savepoint|release)\b", shape, re.I):
        raise RuntimeError("Explicit transaction control is forbidden; one submitted script is already atomic")
    invalidate = bool(re.search(r"\binvalidate_decompile\s*\(", shape, re.I))
    if invalidate:
        if len(statements) != 1 or v3_statement_info(statements[0]) is not None:
            raise RuntimeError("invalidate_decompile is permitted only as a standalone SELECT")
        v3_validate_invalidate_statement(statements[0])
    infos = [v3_statement_info(statement) for statement in statements]
    for statement, info in zip(statements, infos):
        if info is None and not re.match(r"^\s*(?:select|with|pragma)\b", v3_sql_shape(statement), re.I):
            raise RuntimeError("Only SELECT, PRAGMA, INSERT, UPDATE, and DELETE statements are supported")
    mutating_scalar = bool(re.search(r"\b(set_type|parse_type|parse_types)\s*\(", shape, re.I))
    if mutating_scalar and any(info is not None for info in infos):
        raise RuntimeError("Mutating scalar calls cannot be mixed with canonical DML in one script because property conflicts must be unambiguous")
    has_mutation = mutating_scalar or any(info is not None for info in infos)
    bound_sql = v3_materialization_sql(sql, parameters)
    requested = v3_requested_tables(sql)
    connection = v3_create_connection(requested, bound_sql)
    metadata_before = json.loads(json.dumps(v3_oms_metadata))
    undo_id = require_view().begin_undo_actions(False) if has_mutation else None
    if has_mutation:
        setattr(require_view().session_data, V3_CREATED_TYPE_IDS_SESSION_KEY, [])
        require_view().set_analysis_hold(True)
    records: list[dict[str, Any]] = []
    final_result: dict[str, Any] = {"columns": [], "rows": []}
    try:
        connection.execute("BEGIN")
        for index, (statement, info) in enumerate(zip(statements, infos)):
            final = index == len(statements) - 1
            before: list[dict[str, Any]] | None = None
            keys: tuple[str, ...] = ()
            if info is not None:
                v3_validate_writes(connection, info)
                table = info["table"]
                keys = tuple(V3_TABLE_POLICIES[table]["id"])
                before = v3_rows(connection, table)
                v3_install_touch_capture(connection, table, info["operation"], keys)
            rewritten_statement = v3_evaluate_mutating_scalars(connection, statement, parameters) if v3_mutating_call_ranges(statement) else statement
            cursor = connection.execute(rewritten_statement, parameters or {})
            result = v3_result(cursor) if cursor.description is not None else {"columns": [], "rows": []}
            if not final and result["columns"]:
                raise RuntimeError("Only the final SQL statement may return rows")
            if info is not None:
                identities = v3_touched_identities(connection)
                after = v3_rows(connection, info["table"])
                v3_apply_table_diff(info["table"], info["operation"], before or [], after)
                records.append({
                    "table": info["table"],
                    "operation": info["operation"],
                    "keys": keys,
                    "identities": identities,
                    "returning": info["returning"],
                    "assigned": tuple(info["assigned"]),
                    "touched_rows": [
                        row
                        for row in ((after if info["operation"] != "delete" else before) or [])
                        if tuple(row.get(key) for key in keys) in identities
                        or (info["operation"] == "insert" and row not in (before or []) and any(row.get(key) is None for key in keys))
                    ],
                    "generated_rows": [
                        row for row in after
                        if info["operation"] == "insert" and row not in (before or []) and any(row.get(key) is None for key in keys)
                    ],
                    "sql_result": result,
                })
            if final:
                final_result = result
        connection.commit()
        if has_mutation:
            v3_store_oms_metadata()
            require_view().update_analysis_and_wait()
            verify_tables = {record["table"] for record in records}
            v3_validate_script_conflicts(records)
            verify_tables.update(v3_requested_tables(statements[-1]))
            verification = v3_create_connection(verify_tables, bound_sql)
            for record in records:
                table, keys = record["table"], record["keys"]
                for generated in record.get("generated_rows", ()):
                    candidate_columns = v3_generated_identity_columns(table)
                    predicate = " AND ".join(
                        f'"{column}" IS {v3_sql_literal(generated.get(column))}'
                        for column in candidate_columns
                    )
                    count = verification.execute(
                        f'SELECT count(*) FROM "{table}" WHERE {predicate}'
                    ).fetchone()[0]
                    if count != 1:
                        raise RuntimeError(
                            f"Generated {table} mutation did not resolve to exactly one canonical readback row"
                        )
                for identity in record["identities"]:
                    if any(value is None for value in identity):
                        continue
                    predicate = " AND ".join(f'"{key}" IS {v3_sql_literal(value)}' for key, value in zip(keys, identity))
                    present = verification.execute(f'SELECT 1 FROM "{table}" WHERE {predicate}').fetchone() is not None
                    if record["operation"] == "delete" and present:
                        raise RuntimeError(f"DELETE verification failed for {table} identity {identity}")
                    if record["operation"] != "delete" and not present:
                        observed = [
                            tuple(row)
                            for row in verification.execute(
                                f'SELECT {",".join(keys)} FROM "{table}" LIMIT 100'
                            )
                        ]
                        raise RuntimeError(
                            f"{record['operation'].upper()} verification failed for {table} identity {identity}; "
                            f"observed identities begin with {observed}"
                        )
            final_info = infos[-1]
            if final_info is not None and final_info["returning"] is not None:
                record = records[-1]
                if not record["identities"]:
                    final_result = record["sql_result"]
                elif record["operation"] == "delete":
                    final_result = record["sql_result"]
                elif any(any(value is None for value in identity) for identity in record["identities"]):
                    final_result = v3_generated_returning(verification, record, parameters)
                else:
                    final_result = v3_select_returning(
                        verification,
                        record["table"],
                        record["returning"],
                        record["keys"],
                        record["identities"],
                        parameters,
                    )
            elif final_info is None and not mutating_scalar:
                cursor = verification.execute(statements[-1], parameters or {})
                final_result = v3_result(cursor)
            verification.close()
            require_view().commit_undo_actions(undo_id)
            setattr(require_view().session_data, V3_CREATED_TYPE_IDS_SESSION_KEY, [])
            require_view().set_analysis_hold(False)
            require_view().update_analysis_and_wait()
        return final_result
    except Exception:
        with contextlib.suppress(Exception):
            connection.rollback()
        if undo_id is not None:
            with contextlib.suppress(Exception):
                require_view().revert_undo_actions(undo_id)
            for type_id in list(getattr(require_view().session_data, V3_CREATED_TYPE_IDS_SESSION_KEY, ())):
                with contextlib.suppress(Exception):
                    require_view().undefine_type(type_id)
            setattr(require_view().session_data, V3_CREATED_TYPE_IDS_SESSION_KEY, [])
            require_view().set_analysis_hold(False)
            require_view().update_analysis_and_wait()
        globals()["v3_oms_metadata"] = metadata_before
        with contextlib.suppress(Exception):
            require_view().store_metadata(V3_METADATA_KEY, metadata_before, False)
        raise
    finally:
        connection.close()


def v3_generated_identity_columns(table: str) -> tuple[str, ...]:
    candidates = {
        "functions": ("start_address",),
        "pseudocode": ("function_id", "address", "placement", "text"),
        "types": ("qualified_name",),
        "type_members": ("owner_type_id", "name"),
        "enum_values": ("owner_type_id", "name", "integer_value"),
    }.get(table)
    if candidates is None:
        raise RuntimeError(f"{table} returned a generated NULL identity without a canonical lookup contract")
    return candidates


def v3_generated_returning(connection: sqlite3.Connection, record: dict[str, Any], parameters: Any) -> dict[str, Any]:
    table = record["table"]
    candidates = v3_generated_identity_columns(table)
    columns: list[str] = []
    rows: list[dict[str, Any]] = []
    for generated in record.get("generated_rows", ()):
        predicate = " AND ".join(
            f'"{column}" IS {v3_sql_literal(generated.get(column))}' for column in candidates
        )
        cursor = connection.execute(
            f'SELECT {record["returning"]} FROM "{table}" WHERE {predicate}',
            parameters or {},
        )
        result = v3_result(cursor)
        if len(result["rows"]) != 1:
            raise RuntimeError(f"Generated {table} row did not resolve to exactly one canonical readback row")
        if not columns:
            columns = result["columns"]
        rows.extend(result["rows"])
    return {"columns": columns, "rows": rows}


def execute_query(sql: str, parameters: Any = None) -> dict[str, Any]:
    return v3_execute_query(sql, parameters)


def v3_create_connection(requested: set[str], sql: str, populate: bool = True) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    v3_register_core_functions(connection)
    v3_create_core_schema(connection)
    type_schema = globals().get("v3_create_type_schema")
    if callable(type_schema):
        type_schema(connection)
    analysis_schema = globals().get("v3_create_analysis_schema")
    if callable(analysis_schema):
        analysis_schema(connection)
    register_types = globals().get("v3_register_type_functions")
    if callable(register_types):
        register_types(connection)
    register_analysis = globals().get("v3_register_analysis_functions")
    if callable(register_analysis):
        register_analysis(connection)
    if not populate:
        connection.commit()
        return connection
    if "program_metadata" in requested:
        v3_populate_program_metadata(connection)
    if "segments" in requested or "data_items" in requested:
        v3_populate_segments(connection)
    if "symbols" in requested or "data_items" in requested:
        v3_populate_symbols(connection)
    if "data_items" in requested:
        v3_populate_data_items(connection)
    if "address_comments" in requested or "all_comments" in requested:
        v3_populate_address_comments(connection)
    hook_requested = set(requested)
    if "all_comments" in requested:
        hook_requested.update({"functions", "types", "type_members", "enum_values"})
    materialize_types = globals().get("v3_materialize_types")
    if callable(materialize_types):
        materialize_types(connection, hook_requested, sql)
    materialize_analysis = globals().get("v3_materialize_analysis")
    if callable(materialize_analysis):
        materialize_analysis(connection, hook_requested, sql)
    if "all_comments" in requested:
        v3_populate_all_comments(connection)
    if requested & {"sql_tables", "sql_columns", "sql_functions", "sql_enum_values"}:
        v3_populate_catalog(connection)
    connection.commit()
    return connection



# Analysis relations are materialized only after the core query planner has
# extracted their mandatory owner/range constraints.
V3_ANALYSIS_ROW_LIMIT = 100000
V3_ANALYSIS_BYTE_LIMIT = 8 * 1024 * 1024
V3_READ_BYTES_LIMIT = 4096
V3_IL_LEVELS = {
    "lifted": ("lifted_il", False),
    "llil": ("llil", False),
    "llil_ssa": ("llil", True),
    "mlil": ("mlil", False),
    "mlil_ssa": ("mlil", True),
    "mapped_mlil": ("mapped_medium_level_il", False),
    "mapped_mlil_ssa": ("mapped_medium_level_il", True),
    "hlil": ("hlil", False),
    "hlil_ssa": ("hlil", True),
}
V3_ANALYSIS_TABLES = {
    "functions", "function_parameters", "strings", "memory_items", "instructions",
    "instruction_operands", "basic_blocks", "cfg_edges", "address_references",
    "callers", "callees", "string_references", "type_references",
    "il_instructions", "pseudocode", "function_variables", "byte_search",
}


def v3_function_id(function: Any) -> str:
    architecture = getattr(getattr(function, "arch", None), "name", "")
    platform = str(getattr(function, "platform", "") or "")
    return v3_stable_id("function", f"{architecture}:{platform}:{int(function.start):016x}")


def v3_function_from_id(identifier: str):
    for function in require_view().functions:
        if v3_function_id(function) == str(identifier):
            return function
    raise RuntimeError(f"Unknown function_id: {identifier}")


def v3_segment_id_for_object(segment: Any) -> str | None:
    if segment is None:
        return None
    return v3_stable_id("segment", v3_segment_key(segment))


def v3_instruction_id(function: Any, address: int) -> str:
    return v3_stable_id("instruction", f"{v3_function_id(function)}:{address:016x}")


def v3_block_id(function: Any, block: Any) -> str:
    return v3_stable_id(
        "basic_block", f"{v3_function_id(function)}:{int(block.start):016x}:{int(block.end):016x}"
    )


def v3_string_id(item: Any) -> str:
    encoding = getattr(getattr(item, "type", None), "name", str(getattr(item, "type", "")))
    return v3_stable_id("string", f"{int(item.start):016x}:{int(item.length)}:{encoding}")


def v3_extract_sql_literal(pattern: str, sql: str) -> str | None:
    match = re.search(pattern, sql, re.IGNORECASE | re.DOTALL)
    return match.group(1).replace("''", "'") if match else None


def v3_sql_id(sql: str, column: str) -> str | None:
    return v3_extract_sql_literal(
        rf"(?:\b[a-z_][a-z0-9_]*\s*\.\s*)?\b{column}\b\s*=\s*'([^']*(?:''[^']*)*)'", sql
    )

def v3_insert_value(sql: str, table: str, column: str) -> str | None:
    match = re.search(
        rf"\binsert\s+into\s+{table}\s*\((.*?)\)\s*values\s*\((.*?)\)\s*(?:returning\b.*)?$",
        sql,
        re.IGNORECASE | re.DOTALL,
    )
    if match is None:
        return None
    columns = [item.strip().strip('"`[]').lower() for item in v3_split_expressions(match.group(1))]
    values = v3_split_expressions(match.group(2))
    if column not in columns or len(columns) != len(values):
        return None
    return values[columns.index(column)]


def v3_sql_address_term(value: str) -> int:
    text = value.strip()
    match = re.fullmatch(r"addr\s*\(\s*'([^']+)'\s*\)", text, re.IGNORECASE)
    if match:
        text = match.group(1)
    elif text.startswith("'") and text.endswith("'"):
        text = text[1:-1]
    return int(v3_address(text), 16)


def v3_sql_address_bound(sql: str, column: str, operator: str) -> int | None:
    term = r"(addr\s*\(\s*(?:'[^']+'|\d+)\s*\)|'0x[0-9a-f]+'|0x[0-9a-f]+|\d+)"
    match = re.search(
        rf"(?:\b[a-z_][a-z0-9_]*\s*\.\s*)?\b{column}\b\s*{operator}\s*{term}",
        sql,
        re.IGNORECASE,
    )
    return v3_sql_address_term(match.group(1)) if match else None


def v3_reject_complex_bound(sql: str, table: str) -> None:
    if re.search(r"\bor\b", sql, re.IGNORECASE):
        raise RuntimeError(f"Unsupported OR bound for {table}; use one direct owner equality or half-open range")
    if re.search(rf"\b{table}\b.*\b(?:in|exists)\s*\(", sql, re.IGNORECASE | re.DOTALL):
        raise RuntimeError(f"Unsupported subquery bound for {table}; use a direct equality")


def v3_owner_function(sql: str, table: str):
    v3_reject_complex_bound(sql, table)
    identifier = v3_sql_id(sql, "function_id")
    if identifier is None:
        raise RuntimeError(f"{table} requires function_id = ?")
    return v3_function_from_id(identifier)


def v3_range(sql: str, table: str, column: str = "address") -> tuple[int, int]:
    v3_reject_complex_bound(sql, table)
    start = v3_sql_address_bound(sql, column, r">=")
    end = v3_sql_address_bound(sql, column, r"<")
    if start is None or end is None:
        raise RuntimeError(f"{table} requires {column} >= ? AND {column} < ?")
    if end <= start:
        raise RuntimeError(f"{table} requires a non-empty half-open address range")
    return start, end


def v3_budget_add(budget: dict[str, int], row: tuple[Any, ...]) -> None:
    budget["rows"] += 1
    if budget["rows"] > V3_ANALYSIS_ROW_LIMIT:
        raise RuntimeError(f"Analysis row budget exceeded ({V3_ANALYSIS_ROW_LIMIT}); narrow the query bound")
    for value in row:
        if isinstance(value, str):
            budget["bytes"] += len(value.encode("utf-8", "replace"))
        elif isinstance(value, (bytes, bytearray)):
            budget["bytes"] += len(value)
    if budget["bytes"] > V3_ANALYSIS_BYTE_LIMIT:
        raise RuntimeError(f"Analysis byte budget exceeded ({V3_ANALYSIS_BYTE_LIMIT}); select less data")


def v3_wants_column(sql: str, column: str) -> bool:
    match = re.search(r"\bselect\b(.*?)\bfrom\b", sql, re.IGNORECASE | re.DOTALL)
    return match is None or "*" in match.group(1) or re.search(rf"\b{column}\b", match.group(1), re.IGNORECASE) is not None


def v3_segment_at(address: int):
    return require_view().get_segment_at(address)


def v3_instruction_tokens(renderer: Any, address: int) -> tuple[list[Any], int]:
    line, length = next(renderer.get_instruction_text(address), (None, 0))
    if line is None:
        return [], instruction_length(address)
    return list(line.tokens), max(1, int(length))


def v3_token_text(tokens: list[Any]) -> str:
    return "".join(str(getattr(token, "text", token)) for token in tokens)


def v3_iter_instructions(function: Any):
    seen: set[int] = set()
    renderer = bn.DisassemblyTextRenderer(function)
    for block in function.basic_blocks:
        address = int(block.start)
        while address < int(block.end):
            if address in seen:
                break
            seen.add(address)
            tokens, length = v3_instruction_tokens(renderer, address)
            yield block, address, length, tokens
            address += length


def v3_read_exact(address: Any, size: Any) -> bytes:
    count = int(size)
    if count < 0 or count > V3_READ_BYTES_LIMIT:
        raise RuntimeError(f"read_bytes size_bytes must be between 0 and {V3_READ_BYTES_LIMIT}")
    location = int(v3_address(address), 16)
    data = bytes(require_view().read(location, count))
    if len(data) != count:
        raise RuntimeError(f"Unable to read {count} bytes at {v3_address(location)}")
    return data


def v3_endian(value: Any = None) -> str:
    if value is None:
        return "little" if "little" in str(require_view().endianness).lower() else "big"
    text = str(value).lower()
    if text not in {"little", "big"}:
        raise RuntimeError("endianness must be 'little' or 'big'")
    return text


def v3_read_int(address: Any, size: int, signed: bool, endian: Any = None) -> int:
    return int.from_bytes(v3_read_exact(address, size), v3_endian(endian), signed=signed)


def v3_read_float(address: Any, size: int, endian: Any = None) -> float:
    prefix = "<" if v3_endian(endian) == "little" else ">"
    return struct.unpack(prefix + ("f" if size == 4 else "d"), v3_read_exact(address, size))[0]


def v3_read_cstr(address: Any, maximum: Any, encoding: Any = "utf-8") -> str:
    count = int(maximum)
    if count <= 0 or count > V3_READ_BYTES_LIMIT:
        raise RuntimeError(f"read_cstr max_bytes must be between 1 and {V3_READ_BYTES_LIMIT}")
    codec = str(encoding).lower()
    terminator = b"\0\0" if codec in {"utf-16", "utf-16le", "utf-16be"} else b"\0"
    data = v3_read_exact(address, count)
    end = data.find(terminator)
    while end >= 0 and len(terminator) == 2 and end % 2:
        end = data.find(terminator, end + 1)
    if end < 0:
        raise RuntimeError("read_cstr did not find a terminator within max_bytes")
    return data[:end].decode(codec, "strict")


def v3_pseudocode_lines(function: Any) -> list[tuple[int | None, str]]:
    try:
        representation = function.pseudo_c
        if representation is not None:
            lines = representation.get_linear_lines(representation.hlil.root)
            return [
                (
                    int(line.address) if getattr(line, "address", None) is not None else None,
                    v3_token_text(list(getattr(line, "tokens", ()))),
                )
                for line in lines
            ]
    except Exception:
        pass
    try:
        hlil = function.hlil
        return [
            (int(getattr(node, "address", function.start)), render_il_node(node))
            for node in (hlil.traverse(lambda item: item) if hlil is not None else ())
        ]
    except Exception:
        return []


def v3_decompile(address: Any) -> str:
    location = int(v3_address(address), 16)
    functions = list(require_view().get_functions_containing(location))
    if len(functions) != 1:
        raise RuntimeError("decompile(address) requires exactly one containing function")
    return "\n".join(text for _address, text in v3_pseudocode_lines(functions[0]))


def v3_invalidate_decompile(address: Any) -> int:
    location = int(v3_address(address), 16)
    functions = list(require_view().get_functions_containing(location))
    if len(functions) != 1:
        raise RuntimeError("invalidate_decompile(address) requires exactly one containing function")
    functions[0].reanalyze()
    return 1


def v3_register_analysis_scalars(connection: sqlite3.Connection) -> None:
    for name, size, signed in (
        ("read_u8", 1, False), ("read_u16", 2, False), ("read_u32", 4, False), ("read_u64", 8, False),
        ("read_i8", 1, True), ("read_i16", 2, True), ("read_i32", 4, True), ("read_i64", 8, True),
    ):
        connection.create_function(name, 1, lambda address, s=size, sign=signed: v3_read_int(address, s, sign))
        connection.create_function(name, 2, lambda address, endian, s=size, sign=signed: v3_read_int(address, s, sign, endian))
    connection.create_function("read_f32", 1, lambda address: v3_read_float(address, 4))
    connection.create_function("read_f32", 2, lambda address, endian: v3_read_float(address, 4, endian))
    connection.create_function("read_f64", 1, lambda address: v3_read_float(address, 8))
    connection.create_function("read_f64", 2, lambda address, endian: v3_read_float(address, 8, endian))
    connection.create_function("read_bytes", 2, v3_read_exact)
    connection.create_function("read_cstr", 2, v3_read_cstr)
    connection.create_function("read_cstr", 3, v3_read_cstr)
    connection.create_function("read_ptr", 1, lambda address: v3_read_int(address, require_view().address_size, False))
    connection.create_function("read_ptr", 2, lambda address, width: v3_read_int(address, int(width), False))
    connection.create_function("read_ptr", 3, lambda address, width, endian: v3_read_int(address, int(width), False, endian))
    connection.create_function("read_rel32", 1, lambda address: v3_address(int(v3_address(address), 16) + 4 + v3_read_int(address, 4, True)))
    connection.create_function("read_rel32", 2, lambda address, endian: v3_address(int(v3_address(address), 16) + 4 + v3_read_int(address, 4, True, endian)))
    connection.create_function("decompile", 1, v3_decompile)
    connection.create_function("invalidate_decompile", 1, v3_invalidate_decompile)


def v3_create_analysis_schema(connection: sqlite3.Connection) -> None:
    statements = (
        "CREATE TABLE functions (function_id TEXT PRIMARY KEY, start_address TEXT, end_address TEXT, primary_symbol_id TEXT, function_type_id TEXT, name TEXT, signature TEXT, signature_override TEXT, signature_origin TEXT, return_type_declaration TEXT, calling_convention TEXT, parameter_count INTEGER, can_return INTEGER, is_variadic INTEGER, is_import INTEGER, is_thunk INTEGER, origin TEXT, comment TEXT)",
        "CREATE TABLE function_parameters (parameter_id TEXT PRIMARY KEY, function_id TEXT, role TEXT, parameter_index INTEGER, name TEXT, type_declaration TEXT, referenced_type_id TEXT, storage_kind TEXT, stack_offset INTEGER, register_name TEXT, origin TEXT, confidence INTEGER)",
        "CREATE TABLE strings (string_id TEXT PRIMARY KEY, address TEXT, byte_length INTEGER, character_length INTEGER, encoding TEXT, value TEXT, type_id TEXT)",
        "CREATE TABLE memory_items (item_id TEXT PRIMARY KEY, address TEXT, end_address TEXT, size_bytes INTEGER, kind TEXT, is_head INTEGER, is_defined INTEGER, function_id TEXT, segment_id TEXT, type_id TEXT, type_declaration TEXT, bytes BLOB)",
        "CREATE TABLE instructions (instruction_id TEXT PRIMARY KEY, function_id TEXT, basic_block_id TEXT, address TEXT, end_address TEXT, size_bytes INTEGER, segment_id TEXT, architecture TEXT, mnemonic TEXT, operand_count INTEGER, text TEXT, bytes BLOB, branch_kind TEXT, is_call INTEGER, is_jump INTEGER, is_return INTEGER, has_fallthrough INTEGER)",
        "CREATE TABLE instruction_operands (instruction_id TEXT, function_id TEXT, instruction_address TEXT, operand_index INTEGER, text TEXT, kind TEXT, integer_value TEXT, target_address TEXT, register_name TEXT, width_bits INTEGER, PRIMARY KEY (instruction_id, operand_index))",
        "CREATE TABLE basic_blocks (basic_block_id TEXT PRIMARY KEY, function_id TEXT, start_address TEXT, end_address TEXT, size_bytes INTEGER, instruction_count INTEGER, incoming_edge_count INTEGER, outgoing_edge_count INTEGER)",
        "CREATE TABLE cfg_edges (edge_id TEXT PRIMARY KEY, function_id TEXT, source_block_id TEXT, target_block_id TEXT, kind TEXT, is_back_edge INTEGER)",
        "CREATE TABLE address_references (reference_id TEXT PRIMARY KEY, source_instruction_id TEXT, source_address TEXT, target_address TEXT, source_function_id TEXT, target_function_id TEXT, kind TEXT, backend_kind TEXT, is_code INTEGER, is_data INTEGER, is_call INTEGER, is_jump INTEGER, is_flow INTEGER, operand_index INTEGER, type_id TEXT, member_id TEXT)",
        "CREATE TABLE callers (reference_id TEXT PRIMARY KEY, callee_function_id TEXT, caller_function_id TEXT, call_address TEXT, fallthrough_address TEXT)",
        "CREATE TABLE callees (reference_id TEXT PRIMARY KEY, caller_function_id TEXT, callee_function_id TEXT, call_address TEXT, fallthrough_address TEXT)",
        "CREATE TABLE string_references (reference_id TEXT, string_id TEXT, source_address TEXT, source_function_id TEXT)",
        "CREATE TABLE type_references (reference_id TEXT, type_id TEXT, source_type_id TEXT, source_address TEXT, source_function_id TEXT, member_id TEXT, kind TEXT, backend_kind TEXT)",
        "CREATE TABLE il_instructions (function_id TEXT, il_level TEXT, instruction_index INTEGER, expression_index INTEGER, parent_expression_index INTEGER, address TEXT, operation TEXT, size_bytes INTEGER, type_declaration TEXT, text TEXT)",
        "CREATE TABLE pseudocode (function_id TEXT, line_index INTEGER, row_kind TEXT, address TEXT, text TEXT, comment_id TEXT, placement TEXT, is_orphan INTEGER, valid_placements TEXT)",
        "CREATE TABLE function_variables (variable_id TEXT PRIMARY KEY, function_id TEXT, variable_index INTEGER, role TEXT, name TEXT, name_override TEXT, name_origin TEXT, type_declaration TEXT, type_override_declaration TEXT, type_origin TEXT, type_id TEXT, size_bytes INTEGER, storage_kind TEXT, storage TEXT, stack_offset INTEGER, register_name TEXT, origin TEXT, confidence INTEGER, comment TEXT)",
        "CREATE TABLE byte_search (pattern TEXT, start_address TEXT, end_address TEXT, alignment INTEGER, address TEXT)",
    )
    for statement in statements:
        connection.execute(statement)
    v3_register_analysis_scalars(connection)


def v3_primary_function_symbol(function: Any):
    selections = v3_oms_metadata.setdefault("function_primary_symbols", {})
    selected_id = selections.get(v3_function_id(function))
    if selected_id is not None:
        symbol = v3_find_symbol_by_id(str(selected_id))
        if symbol is not None and int(symbol.address) == int(function.start) and v3_symbol_kind(symbol) == "function":
            return symbol
        selections.pop(v3_function_id(function), None)
    return getattr(function, "symbol", None)

def v3_function_override(function: Any) -> str | None:
    value = v3_oms_metadata.setdefault("function_overrides", {}).get(v3_function_id(function))
    return str(value) if isinstance(value, str) else None


def v3_set_function_override(function: Any, declaration: Any) -> str | None:
    identifier = v3_function_id(function)
    overrides = v3_oms_metadata.setdefault("function_overrides", {})
    base_types = v3_oms_metadata.setdefault("function_base_types", {})
    if declaration is None:
        base_declaration = base_types.get(identifier)
        if isinstance(base_declaration, str):
            base_type, _ = require_view().parse_type_string(base_declaration)
            function.set_user_type(base_type)
        overrides.pop(identifier, None)
        return None
    parsed_type, parsed_name = require_view().parse_type_string(str(declaration))
    primary_symbol = v3_primary_function_symbol(function)
    primary_name = str(getattr(primary_symbol, "name", function.name))
    if str(parsed_name) and str(parsed_name) != primary_name:
        raise RuntimeError("signature_override declarator name must equal the primary symbol name")
    base_types.setdefault(identifier, str(function.type))
    function.set_user_type(parsed_type)
    overrides[identifier] = str(declaration)
    return str(parsed_type)


def v3_function_row(function: Any) -> tuple[Any, ...]:
    symbol = v3_primary_function_symbol(function)
    function_type = function.type
    imported = {"ImportedFunctionSymbol", "ImportAddressSymbol"}
    override = v3_function_override(function)
    signature_origin = "oms" if override is not None else (
        "debug" if bool(getattr(function, "has_user_type", False)) else "analysis"
    )
    end = max(int(function.start) + 1, int(getattr(function, "highest_address", function.start)) + 1)
    convention = getattr(function, "calling_convention", None)
    return (
        v3_function_id(function), v3_address(function.start), v3_address(end),
        v3_symbol_id(symbol) if symbol is not None else None, v3_type_id(function_type),
        str(getattr(symbol, "name", function.name)), str(function_type), override,
        signature_origin, str(function.return_type),
        getattr(convention, "name", str(convention)) if convention else None,
        len(list(getattr(function_type, "parameters", ()) or ())),
        int(bool(function.can_return)), int(bool(getattr(function, "has_variable_arguments", False))),
        int(getattr(getattr(symbol, "type", None), "name", "") in imported),
        int("thunk" in str(function.name).lower()),
        "analysis" if bool(getattr(function, "auto", True)) else "user",
        str(getattr(function, "comment", "") or "") or None,
    )


def v3_parameter_storage(function: Any, variable: Any) -> tuple[str | None, int | None, str | None]:
    if variable is None:
        return None, None, None
    source = getattr(getattr(variable, "source_type", None), "name", "").lower()
    storage = int(getattr(variable, "storage", 0))
    if "stack" in source:
        return "stack", storage, None
    if "register" in source:
        try:
            return "register", None, str(function.arch.get_reg_name(storage))
        except Exception:
            return "register", None, None
    return source or "other", None, None


def v3_populate_functions(
    connection: sqlite3.Connection, requested: set[str], sql: str, budget: dict[str, int]
) -> None:
    parameter_owner = v3_owner_function(sql, "function_parameters") if "function_parameters" in requested else None
    functions = list(require_view().functions) if "functions" in requested else [parameter_owner]
    function_rows = []
    parameter_rows = []
    for function in functions:
        if function is None:
            continue
        if "functions" in requested:
            row = v3_function_row(function)
            v3_budget_add(budget, row)
            function_rows.append(row)
        if function != parameter_owner:
            continue
        variables = list(function.parameter_vars)
        parameters = list(getattr(function.type, "parameters", ()) or ())
        result_type = function.return_type
        result = (
            v3_stable_id("function_parameter", f"{v3_function_id(function)}:return"),
            v3_function_id(function), "return", None, None, str(result_type),
            v3_type_id(result_type), None, None, None, "analysis",
            int(getattr(result_type, "confidence", 0)) or None,
        )
        v3_budget_add(budget, result)
        parameter_rows.append(result)
        for index, parameter in enumerate(parameters):
            variable = variables[index] if index < len(variables) else None
            storage_kind, stack_offset, register_name = v3_parameter_storage(function, variable)
            type_object = getattr(parameter, "type", None)
            parameter_row = (
                v3_stable_id("function_parameter", f"{v3_function_id(function)}:parameter:{index}"),
                v3_function_id(function), "parameter", index,
                str(getattr(parameter, "name", "") or "") or None,
                str(type_object) if type_object is not None else None,
                v3_type_id(type_object), storage_kind, stack_offset, register_name,
                "analysis", int(getattr(type_object, "confidence", 0)) or None,
            )
            v3_budget_add(budget, parameter_row)
            parameter_rows.append(parameter_row)
    if "functions" in requested:
        connection.executemany("INSERT INTO functions VALUES (" + ",".join("?" for _ in range(18)) + ")", function_rows)
    if "function_parameters" in requested:
        connection.executemany("INSERT INTO function_parameters VALUES (" + ",".join("?" for _ in range(12)) + ")", parameter_rows)


def v3_populate_strings(connection: sqlite3.Connection, budget: dict[str, int]) -> None:
    rows = []
    for item in require_view().strings:
        encoding = getattr(getattr(item, "type", None), "name", str(getattr(item, "type", ""))).lower()
        row = (
            v3_string_id(item), v3_address(item.start), int(item.length),
            len(str(item.value)), encoding, str(item.value), None,
        )
        v3_budget_add(budget, row)
        rows.append(row)
    connection.executemany("INSERT INTO strings VALUES (?,?,?,?,?,?,?)", rows)


def v3_operand_rows(function: Any, address: int, tokens: list[Any]) -> list[tuple[Any, ...]]:
    token_type = bn.InstructionTextTokenType
    groups: list[list[Any]] = []
    current: list[Any] = []
    saw_mnemonic = False
    for token in tokens:
        if not saw_mnemonic:
            saw_mnemonic = getattr(token, "type", None) == token_type.InstructionToken
            continue
        if getattr(token, "type", None) == token_type.OperandSeparatorToken:
            if current:
                groups.append(current)
                current = []
        else:
            current.append(token)
    if current:
        groups.append(current)
    address_types = {
        token_type.PossibleAddressToken, token_type.CodeRelativeAddressToken,
        token_type.CodeSymbolToken, token_type.DataSymbolToken,
    }
    rows = []
    instruction_id = v3_instruction_id(function, address)
    for index, group in enumerate(groups):
        integer = next((token for token in group if token.type in address_types | {token_type.IntegerToken}), None)
        target = next((token for token in group if token.type in address_types), None)
        register = next((token for token in group if token.type == token_type.RegisterToken), None)
        memory = any(token.type == token_type.BeginMemoryOperandToken for token in group)
        kind = "memory" if memory else ("address" if target else ("integer" if integer else ("register" if register else "text")))
        target_address = None
        if target is not None:
            try:
                target_address = v3_address(int(target.value))
            except Exception:
                pass
        rows.append((
            instruction_id, v3_function_id(function), v3_address(address), index,
            v3_token_text(group).strip(), kind,
            str(int(integer.value)) if integer is not None else None,
            target_address, str(register.text).strip() if register else None,
            int(getattr(integer, "size", 0)) * 8 or None if integer else None,
        ))
    return rows


def v3_branch_info(function: Any, block: Any, address: int, length: int) -> tuple[Any, ...]:
    try:
        is_call = bool(require_view().get_callees(address, function))
    except Exception:
        is_call = False
    try:
        operation = getattr(function.get_low_level_il_at(address).operation, "name", "")
    except Exception:
        operation = ""
    is_call = is_call or "CALL" in operation
    outgoing = list(block.outgoing_edges) if address + length >= int(block.end) else []
    kind = "|".join(sorted({getattr(edge.type, "name", str(edge.type)) for edge in outgoing})) or None
    is_return = "RET" in operation
    is_jump = "JUMP" in operation or bool(outgoing and not is_call)
    has_fallthrough = not is_return and (
        not outgoing or any(
            marker in getattr(edge.type, "name", str(edge.type))
            for edge in outgoing for marker in ("FalseBranch", "FallThrough", "Unconditional")
        )
    )
    return kind, int(is_call), int(is_jump), int(is_return), int(has_fallthrough)


def v3_instruction_functions(sql: str) -> tuple[list[Any], tuple[int, int] | None]:
    identifier = v3_sql_id(sql, "function_id")
    if identifier is not None:
        return [v3_function_from_id(identifier)], None
    address_range = v3_range(sql, "instructions")
    return [
        function for function in require_view().functions
        if any(int(block.end) > address_range[0] and int(block.start) < address_range[1] for block in function.basic_blocks)
    ], address_range


def v3_populate_instructions(
    connection: sqlite3.Connection, sql: str, requested: set[str], budget: dict[str, int]
) -> None:
    functions, address_range = v3_instruction_functions(sql)
    instruction_rows = []
    operand_rows = []
    include_bytes = v3_wants_column(sql, "bytes")
    for function in functions:
        for block, address, length, tokens in v3_iter_instructions(function):
            if address_range is not None and not (address_range[0] <= address < address_range[1]):
                continue
            operands = v3_operand_rows(function, address, tokens)
            text = v3_token_text(tokens)
            mnemonic = next((
                str(token.text).strip() for token in tokens
                if token.type == bn.InstructionTextTokenType.InstructionToken
            ), text.strip().split(None, 1)[0] if text.strip() else "")
            segment = v3_segment_at(address)
            row = (
                v3_instruction_id(function, address), v3_function_id(function), v3_block_id(function, block),
                v3_address(address), v3_address(address + length), length,
                v3_segment_id_for_object(segment), getattr(function.arch, "name", None),
                mnemonic, len(operands), text,
                bytes(require_view().read(address, length)) if include_bytes else None,
            ) + v3_branch_info(function, block, address, length)
            v3_budget_add(budget, row)
            instruction_rows.append(row)
            for operand in operands:
                v3_budget_add(budget, operand)
                operand_rows.append(operand)
    if "instructions" in requested:
        connection.executemany("INSERT INTO instructions VALUES (" + ",".join("?" for _ in range(17)) + ")", instruction_rows)
    if "instruction_operands" in requested:
        connection.executemany("INSERT INTO instruction_operands VALUES (" + ",".join("?" for _ in range(10)) + ")", operand_rows)


def v3_populate_operands(connection: sqlite3.Connection, sql: str, budget: dict[str, int]) -> None:
    instruction_bound = v3_sql_id(sql, "instruction_id")
    function_bound = v3_sql_id(sql, "function_id")
    start = v3_sql_address_bound(sql, "instruction_address", r">=")
    end = v3_sql_address_bound(sql, "instruction_address", r"<")
    if instruction_bound is None and function_bound is None and (start is None or end is None):
        raise RuntimeError("instruction_operands requires instruction_id = ?, function_id = ?, or both instruction_address endpoints")
    functions = [v3_function_from_id(function_bound)] if function_bound else list(require_view().functions)
    rows = []
    for function in functions:
        for _block, address, _length, tokens in v3_iter_instructions(function):
            if instruction_bound and v3_instruction_id(function, address) != instruction_bound:
                continue
            if start is not None and end is not None and not (start <= address < end):
                continue
            for row in v3_operand_rows(function, address, tokens):
                v3_budget_add(budget, row)
                rows.append(row)
    connection.executemany("INSERT INTO instruction_operands VALUES (" + ",".join("?" for _ in range(10)) + ")", rows)


def v3_populate_cfg(connection: sqlite3.Connection, sql: str, requested: set[str], budget: dict[str, int]) -> None:
    function = v3_owner_function(sql, "basic_blocks/cfg_edges")
    blocks = list(function.basic_blocks)
    identifiers = {(int(block.start), int(block.end)): v3_block_id(function, block) for block in blocks}
    block_rows = []
    edge_rows = []
    for block in blocks:
        instruction_count = len(block)
        block_id = v3_block_id(function, block)
        row = (
            block_id, v3_function_id(function), v3_address(block.start), v3_address(block.end),
            int(block.end) - int(block.start), instruction_count,
            len(block.incoming_edges), len(block.outgoing_edges),
        )
        v3_budget_add(budget, row)
        block_rows.append(row)
        for ordinal, edge in enumerate(block.outgoing_edges):
            target_id = identifiers.get((int(edge.target.start), int(edge.target.end)))
            if target_id is None:
                continue
            kind = getattr(edge.type, "name", str(edge.type))
            edge_row = (
                v3_stable_id("cfg_edge", f"{block_id}:{target_id}:{kind}:{ordinal}"),
                v3_function_id(function), block_id, target_id, kind,
                int(int(edge.target.start) <= int(block.start)),
            )
            v3_budget_add(budget, edge_row)
            edge_rows.append(edge_row)
    if "basic_blocks" in requested:
        connection.executemany("INSERT INTO basic_blocks VALUES (?,?,?,?,?,?,?,?)", block_rows)
    if "cfg_edges" in requested:
        connection.executemany("INSERT INTO cfg_edges VALUES (?,?,?,?,?,?)", edge_rows)


def v3_memory_ranges(sql: str) -> tuple[list[tuple[int, int, str | None, Any]], str | None]:
    function_id = v3_sql_id(sql, "function_id")
    if function_id:
        function = v3_function_from_id(function_id)
        return [
            (int(block.start), int(block.end), v3_segment_id_for_object(v3_segment_at(block.start)), function)
            for block in function.basic_blocks
        ], function_id
    segment_id = v3_sql_id(sql, "segment_id")
    if segment_id:
        for segment in require_view().segments:
            if v3_segment_id_for_object(segment) == segment_id:
                return [(int(segment.start), int(segment.end), segment_id, None)], None
        raise RuntimeError(f"Unknown segment_id: {segment_id}")
    start, end = v3_range(sql, "memory_items")
    return [(start, end, v3_segment_id_for_object(v3_segment_at(start)), None)], None


def v3_memory_bytes(view: Any, address: int, size: int, include: bool) -> bytes | None:
    if not include:
        return None
    if size > V3_ANALYSIS_BYTE_LIMIT:
        raise RuntimeError(
            f"memory_items bytes extent exceeds the {V3_ANALYSIS_BYTE_LIMIT}-byte response budget"
        )
    data = bytes(view.read(address, size))
    if len(data) != size:
        raise RuntimeError(f"memory_items extent is not fully readable at {v3_address(address)}")
    return data

def v3_populate_memory(connection: sqlite3.Connection, sql: str, budget: dict[str, int]) -> None:
    ranges, owner_id = v3_memory_ranges(sql)
    include_bytes = v3_wants_column(sql, "bytes")
    view = require_view()
    strings_by_address = {int(item.start): item for item in view.strings}
    rows = []
    for start, end, segment_id, owner in ranges:
        heads: dict[int, tuple[int, str, Any]] = {}
        functions = [owner] if owner is not None else list(view.functions)
        for function in functions:
            if function is None:
                continue
            for _block, address, length, _tokens in v3_iter_instructions(function):
                if start <= address < end:
                    heads[address] = (min(length, end - address), "code", None)
        for address, variable in view.data_vars.items():
            if start <= int(address) < end:
                width = max(1, int(getattr(variable.type, "width", 1)))
                heads[int(address)] = (min(width, end - int(address)), "data", variable.type)
        for address, item in strings_by_address.items():
            if start <= address < end:
                heads[address] = (min(int(item.length), end - address), "string", None)
        cursor = start
        for address in sorted(heads):
            if address > cursor:
                row = (
                    v3_stable_id("memory_item", f"{owner_id}:{cursor:016x}:{address:016x}:undefined"),
                    v3_address(cursor), v3_address(address), address - cursor,
                    "undefined", 0, 0, owner_id, segment_id, None, None,
                    v3_memory_bytes(view, cursor, address - cursor, include_bytes),
                )
                v3_budget_add(budget, row)
                rows.append(row)
            size, kind, type_object = heads[address]
            item_end = address + size
            row = (
                v3_stable_id("memory_item", f"{owner_id}:{address:016x}:{item_end:016x}:{kind}"),
                v3_address(address), v3_address(item_end), size, kind, 1, 1,
                owner_id, segment_id, v3_type_id(type_object),
                str(type_object) if type_object is not None else None,
                v3_memory_bytes(view, address, size, include_bytes),
            )
            v3_budget_add(budget, row)
            rows.append(row)
            cursor = max(cursor, item_end)
        if cursor < end:
            row = (
                v3_stable_id("memory_item", f"{owner_id}:{cursor:016x}:{end:016x}:undefined"),
                v3_address(cursor), v3_address(end), end - cursor, "undefined", 0, 0,
                owner_id, segment_id, None, None,
                v3_memory_bytes(view, cursor, end - cursor, include_bytes),
            )
            v3_budget_add(budget, row)
            rows.append(row)
    connection.executemany("INSERT INTO memory_items VALUES (" + ",".join("?" for _ in range(12)) + ")", rows)


def v3_il_level(function: Any, attribute: str, ssa: bool):
    try:
        il = getattr(function, attribute, None)
    except Exception:
        return None
    if il is None:
        return None
    if ssa:
        try:
            return il.ssa_form
        except Exception:
            return None
    return il

def v3_il_nodes(il: Any) -> list[Any]:
    try:
        return list(il.traverse(lambda node: node))
    except Exception:
        try:
            return list(il.instructions)
        except Exception:
            return []


def v3_populate_il(connection: sqlite3.Connection, sql: str, budget: dict[str, int]) -> None:
    function = v3_owner_function(sql, "il_instructions")
    level_bound = v3_extract_sql_literal(r"\bil_level\b\s*=\s*'([^']+)'", sql)
    if level_bound is not None and level_bound not in V3_IL_LEVELS:
        raise RuntimeError(f"Unknown il_level: {level_bound}")
    rows = []
    for level in ([level_bound] if level_bound else list(V3_IL_LEVELS)):
        attribute, ssa = V3_IL_LEVELS[level]
        il = v3_il_level(function, attribute, ssa)
        if il is None:
            continue
        # Every level is isolated: one unavailable SSA form must not suppress
        # rows from the other eight forms.
        for node in v3_il_nodes(il):
            try:
                parent = getattr(node, "parent", None)
                type_object = getattr(node, "expr_type", None)
                row = (
                    v3_function_id(function), level,
                    sqlite_integer(getattr(node, "instr_index", -1)),
                    sqlite_integer(getattr(node, "expr_index", -1)),
                    sqlite_integer(getattr(parent, "expr_index")) if parent is not None else None,
                    v3_address(int(getattr(node, "address", function.start))),
                    str(getattr(getattr(node, "operation", None), "name", type(node).__name__)),
                    int(getattr(node, "size", 0)) or None,
                    str(type_object) if type_object is not None else None,
                    render_il_node(node),
                )
            except Exception:
                continue
            v3_budget_add(budget, row)
            rows.append(row)
    connection.executemany("INSERT INTO il_instructions VALUES (?,?,?,?,?,?,?,?,?,?)", rows)


def v3_populate_pseudocode(connection: sqlite3.Connection, sql: str, budget: dict[str, int]) -> None:
    function_id = v3_sql_id(sql, "function_id")
    insert_function = v3_insert_value(sql, "pseudocode", "function_id")
    if function_id is None and insert_function is not None:
        text = insert_function.strip()
        if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
            function_id = text[1:-1].replace("''", "'")
    comment_id = v3_sql_id(sql, "comment_id")
    if function_id is None and comment_id is not None:
        saved = v3_oms_metadata.setdefault("pseudocode_comments", {}).get(comment_id)
        if not isinstance(saved, dict):
            saved = v3_oms_metadata.setdefault("pseudocode_comment_owners", {}).get(comment_id)
        if isinstance(saved, dict):
            function_id = str(saved.get("function_id") or "")
    if function_id:
        function = v3_function_from_id(function_id)
    else:
        v3_reject_complex_bound(sql, "pseudocode")
        address = v3_sql_address_bound(sql, "address", "=")
        insert_address = v3_insert_value(sql, "pseudocode", "address")
        if address is None and insert_address is not None:
            address = v3_sql_address_term(insert_address)
        if address is None:
            raise RuntimeError("pseudocode requires function_id = ?, comment_id = ?, or address = ?")
        functions = list(require_view().get_functions_containing(address))
        if len(functions) != 1:
            raise RuntimeError("pseudocode address must resolve to exactly one function")
        function = functions[0]
    entries: list[tuple[int, int, str, tuple[Any, ...]]] = []
    correlated_address = None
    for ordinal, (line_address, text) in enumerate(v3_pseudocode_lines(function)):
        if line_address is not None:
            correlated_address = line_address
        address_value = correlated_address if correlated_address is not None else int(function.start)
        entries.append((
            address_value, 1, f"code:{ordinal}",
            (v3_function_id(function), 0, "code", v3_address(correlated_address)
             if correlated_address is not None else None, text, None, None, 0, "before,after,line,end"),
        ))
    placement_order = {"before": 0, "line": 1, "after": 2, "end": 3}
    for comment_id, saved in v3_oms_metadata.setdefault("pseudocode_comments", {}).items():
        if not isinstance(saved, dict) or saved.get("function_id") != v3_function_id(function):
            continue
        address_value = int(v3_address(saved.get("address")), 16)
        placement = str(saved.get("placement"))
        is_orphan = int(function not in require_view().get_functions_containing(address_value))
        entries.append((
            address_value, placement_order.get(placement, 4), str(comment_id),
            (v3_function_id(function), 0, "comment", v3_address(address_value),
             str(saved.get("text")), str(comment_id), placement, is_orphan,
             "before,after,line,end"),
        ))
    rows = []
    for line_index, (_address, _placement, _key, original) in enumerate(sorted(entries)):
        row = original[:1] + (line_index,) + original[2:]
        v3_budget_add(budget, row)
        rows.append(row)
    connection.executemany("INSERT INTO pseudocode VALUES (?,?,?,?,?,?,?,?,?)", rows)


def v3_variable_marker(variable: Any) -> tuple[int, int, int]:
    source = getattr(variable, "source_type", 0)
    return (
        int(getattr(source, "value", source)), int(getattr(variable, "index", 0)),
        int(getattr(variable, "storage", 0)),
    )


def v3_variable_storage(function: Any, variable: Any) -> tuple[str, str, int | None, str | None]:
    source = getattr(getattr(variable, "source_type", None), "name", "").lower()
    storage = int(getattr(variable, "storage", 0))
    if "stack" in source:
        return "stack", str(storage), storage, None
    if "register" in source:
        try:
            register = str(function.arch.get_reg_name(storage))
        except Exception:
            register = None
        return "register", str(storage), None, register
    return source or "other", str(storage), None, None


def v3_populate_variables(connection: sqlite3.Connection, sql: str, budget: dict[str, int]) -> None:
    variable_bound = v3_sql_id(sql, "variable_id")
    if variable_bound is not None:
        resolved = v3_native_variable_by_id(variable_bound)
        if resolved is None:
            raise RuntimeError(f"Unknown variable_id: {variable_bound}")
        function = resolved[0]
    else:
        function = v3_owner_function(sql, "function_variables")
    from binaryninja import _binaryninjacore as core
    parameters = {v3_variable_marker(variable) for variable in function.parameter_vars}
    seen: set[tuple[int, int, int]] = set()
    rows = []
    index = 0
    for variable in list(function.parameter_vars) + list(function.vars) + list(function.stack_layout):
        marker = v3_variable_marker(variable)
        if marker in seen:
            continue
        seen.add(marker)
        role = "argument" if marker in parameters else "local"
        storage_kind, storage, stack_offset, register_name = v3_variable_storage(function, variable)
        type_object = variable.type
        name = str(variable.name) or None
        variable_id_value = v3_stable_id(
            "variable", f"{v3_function_id(function)}:{marker[0]}:{marker[1]}:{marker[2]}"
        )
        native_variable = variable.to_BNVariable()
        is_user = role == "local" and bool(core.BNIsVariableUserDefined(function.handle, native_variable))
        explicit_name = core.BNGetVariableName(function.handle, native_variable) if is_user else None
        saved_override = v3_oms_metadata.setdefault("variable_overrides", {}).get(variable_id_value)
        if isinstance(saved_override, dict):
            name_override = saved_override.get("name_override")
            type_override = saved_override.get("type_override_declaration")
        else:
            name_override = str(explicit_name) if explicit_name else None
            type_override = str(type_object) if is_user and type_object is not None else None
        row = (
            variable_id_value,
            v3_function_id(function), index, role, name, name_override,
            "user" if name_override else "analysis",
            str(type_object) if type_object is not None else None, type_override,
            "user" if type_override else "analysis", v3_type_id(type_object),
            int(getattr(type_object, "width", 0)) or None if type_object is not None else None,
            storage_kind, storage, stack_offset, register_name, "analysis",
            int(getattr(type_object, "confidence", 0)) or None if type_object is not None else None,
            v3_oms_metadata.setdefault("variable_comments", {}).get(variable_id_value),
        )
        v3_budget_add(budget, row)
        rows.append(row)
        index += 1
    result_type = function.return_type
    result_id = v3_stable_id("variable", f"{v3_function_id(function)}:result")
    result = (
        result_id,
        v3_function_id(function), index, "result", None, None, "analysis",
        str(result_type), None, "analysis", v3_type_id(result_type),
        int(getattr(result_type, "width", 0)) or None, "result", None, None, None,
        "analysis", int(getattr(result_type, "confidence", 0)) or None,
        v3_oms_metadata.setdefault("variable_comments", {}).get(result_id),
    )
    v3_budget_add(budget, result)
    rows.append(result)
    connection.executemany("INSERT INTO function_variables VALUES (" + ",".join("?" for _ in range(19)) + ")", rows)


def v3_reference_class(function: Any, source: int, target: int, data: bool) -> tuple[str, str, int, int, int]:
    try:
        operation = getattr(function.get_low_level_il_at(source).operation, "name", "")
    except Exception:
        operation = ""
    if data:
        if "STORE" in operation:
            return "write", operation, 0, 0, 0
        if "LOAD" in operation:
            return "read", operation, 0, 0, 0
        return "address", operation or "data-address", 0, 0, 0
    try:
        if target in require_view().get_callees(source, function):
            return "call", operation or "code-call", 1, 0, 0
    except Exception:
        pass
    if "JUMP" in operation or "GOTO" in operation:
        return "jump", operation, 0, 1, 0
    return "flow", operation or "code-flow", 0, 0, 1


def v3_populate_references(connection: sqlite3.Connection, requested: set[str], budget: dict[str, int]) -> None:
    view = require_view()
    functions_at = {int(function.start): function for function in view.functions}
    strings_at = {int(item.start): v3_string_id(item) for item in view.strings}
    authoritative: dict[str, tuple[Any, ...]] = {}
    callers = []
    callees = []
    string_refs = []
    type_refs = []
    for function in view.functions:
        owner_id = v3_function_id(function)
        for _block, source, length, _tokens in v3_iter_instructions(function):
            code_targets = [int(target) for target in view.get_code_refs_from(source, function)]
            targets = [(target, False) for target in code_targets]
            targets.extend((int(target), True) for target in view.get_data_refs_from(source, length))
            for target, data in targets:
                kind, backend, is_call, is_jump, is_flow = v3_reference_class(function, source, target, data)
                target_function = functions_at.get(target)
                target_id = v3_function_id(target_function) if target_function is not None else None
                reference_id = v3_stable_id("reference", f"{owner_id}:{source:016x}:{target:016x}:{kind}")
                authoritative[reference_id] = (
                    reference_id, v3_instruction_id(function, source), v3_address(source),
                    v3_address(target), owner_id, target_id, kind, backend,
                    int(not data), int(data), is_call, is_jump, is_flow, None, None, None,
                )
                if is_call and target_id:
                    fallthrough = v3_address(source + length)
                    callers.append((reference_id, target_id, owner_id, v3_address(source), fallthrough))
                    callees.append((reference_id, owner_id, target_id, v3_address(source), fallthrough))
                if target in strings_at:
                    string_refs.append((reference_id, strings_at[target], v3_address(source), owner_id))
            try:
                operation = getattr(function.get_low_level_il_at(source).operation, "name", "")
            except Exception:
                operation = ""
            if "CALL" in operation and not code_targets:
                reference_id = v3_stable_id("reference", f"{owner_id}:{source:016x}:unresolved-call")
                authoritative[reference_id] = (
                    reference_id, v3_instruction_id(function, source), v3_address(source),
                    None, owner_id, None, "call", operation, 1, 0, 1, 0, 0,
                    None, None, None,
                )
    for source, variable in view.data_vars.items():
        width = max(1, int(getattr(variable.type, "width", 1)))
        for target in view.get_data_refs_from(int(source), width):
            target = int(target)
            reference_id = v3_stable_id("reference", f"data:{int(source):016x}:{target:016x}")
            source_functions = list(view.get_functions_containing(int(source)))
            source_function_id = v3_function_id(source_functions[0]) if len(source_functions) == 1 else None
            authoritative[reference_id] = (
                reference_id, None, v3_address(source), v3_address(target),
                source_function_id, None, "address", "data", 0, 1, 0, 0, 0,
                None, None, None,
            )
            if target in strings_at:
                string_refs.append((reference_id, strings_at[target], v3_address(source), source_function_id))
    for type_name, type_object in view.types.items():
        type_id = v3_type_id(type_object)
        try:
            code_references = view.get_code_refs_for_type(str(type_name), V3_ANALYSIS_ROW_LIMIT)
        except Exception:
            code_references = ()
        for reference in code_references:
            source = int(reference.address)
            function = getattr(reference, "function", None) or getattr(reference, "func", None)
            function_id = v3_function_id(function) if function is not None else None
            reference_id = v3_stable_id("reference", f"type:{type_id}:{function_id}:{source:016x}")
            authoritative[reference_id] = (
                reference_id, v3_instruction_id(function, source) if function is not None else None,
                v3_address(source), None, function_id, None, "type", "code-type",
                1, 0, 0, 0, 0, None, type_id, None,
            )
            type_refs.append((reference_id, type_id, None, v3_address(source), function_id, None, "type", "code-type"))
        try:
            data_type_references = view.get_data_refs_for_type(str(type_name), V3_ANALYSIS_ROW_LIMIT)
        except Exception:
            data_type_references = ()
        for source in data_type_references:
            source = int(source)
            source_functions = list(view.get_functions_containing(source))
            function_id = v3_function_id(source_functions[0]) if len(source_functions) == 1 else None
            reference_id = v3_stable_id("reference", f"data-type:{type_id}:{source:016x}")
            authoritative[reference_id] = (
                reference_id, None, v3_address(source), None, function_id, None,
                "type", "data-type", 0, 1, 0, 0, 0, None, type_id, None,
            )
            type_refs.append((reference_id, type_id, None, v3_address(source), function_id, None, "type", "data-type"))
        aggregate_members = [
            member
            for member in list(getattr(type_object, "members", ()) or ())
            if hasattr(member, "type") and hasattr(member, "offset")
        ]
        member_rows_helper = globals().get("_v3_member_rows")
        identity_rows = member_rows_helper(type_id, type_object) if aggregate_members and callable(member_rows_helper) else ()
        for member_index, member in enumerate(aggregate_members):
            member_id = next((
                str(row[0]) for row in identity_rows
                if str(row[3]) == str(member.name) and int(row[4]) == int(member.offset) * 8
            ), None)
            try:
                field_references = view.get_code_refs_for_type_field(type_name, int(member.offset), V3_ANALYSIS_ROW_LIMIT)
            except Exception:
                field_references = ()
            for reference in field_references:
                source = int(reference.address)
                function = getattr(reference, "function", None) or getattr(reference, "func", None)
                function_id = v3_function_id(function) if function is not None else None
                reference_id = v3_stable_id("reference", f"member:{member_id}:{function_id}:{source:016x}")
                authoritative[reference_id] = (
                    reference_id, v3_instruction_id(function, source) if function is not None else None,
                    v3_address(source), None, function_id, None, "member", "code-member",
                    1, 0, 0, 0, 0, None, type_id, member_id,
                )
                type_refs.append((reference_id, type_id, None, v3_address(source), function_id, member_id, "member", "code-member"))
            try:
                data_field_references = view.get_data_refs_for_type_field(
                    type_name, int(member.offset), V3_ANALYSIS_ROW_LIMIT
                )
            except Exception:
                data_field_references = ()
            for source in data_field_references:
                source = int(source)
                source_functions = list(view.get_functions_containing(source))
                function_id = v3_function_id(source_functions[0]) if len(source_functions) == 1 else None
                reference_id = v3_stable_id("reference", f"data-member:{member_id}:{source:016x}")
                authoritative[reference_id] = (
                    reference_id, None, v3_address(source), None, function_id, None,
                    "member", "data-member", 0, 1, 0, 0, 0, None, type_id, member_id,
                )
                type_refs.append((reference_id, type_id, None, v3_address(source), function_id, member_id, "member", "data-member"))
        try:
            type_sources = view.get_type_refs_for_type(type_name, V3_ANALYSIS_ROW_LIMIT)
        except Exception:
            type_sources = ()
        for source in type_sources:
            source_type = None
            source_name = getattr(source, "name", None)
            if source_name is not None:
                try:
                    source_type = view.get_type_by_name(source_name)
                except Exception:
                    pass
            source_type_id = v3_type_id(source_type)
            reference_id = v3_stable_id(
                "reference", f"type-type:{type_id}:{source_type_id}:{int(getattr(source, 'offset', 0))}"
            )
            backend = getattr(getattr(source, "ref_type", None), "name", "type")
            type_refs.append((reference_id, type_id, source_type_id, None, None, None, "type", backend))
    table_rows = (
        ("address_references", list(authoritative.values()), 16),
        ("callers", callers, 5), ("callees", callees, 5),
        ("string_references", string_refs, 4), ("type_references", type_refs, 8),
    )
    for table, rows, count in table_rows:
        if table not in requested:
            continue
        for row in rows:
            v3_budget_add(budget, row)
        connection.executemany(
            f"INSERT INTO {table} VALUES (" + ",".join("?" for _ in range(count)) + ")", rows
        )


def v3_parse_search_pattern(pattern: str) -> tuple[bytes, bytes]:
    compact = re.sub(r"\s+", "", pattern)
    if not compact or len(compact) % 2:
        raise RuntimeError("byte_search pattern requires complete byte pairs")
    values = bytearray()
    masks = bytearray()
    for offset in range(0, len(compact), 2):
        pair = compact[offset:offset + 2]
        if pair == "??":
            values.append(0)
            masks.append(0)
        elif re.fullmatch(r"[0-9a-fA-F]{2}", pair):
            values.append(int(pair, 16))
            masks.append(0xff)
        else:
            raise RuntimeError("byte_search accepts only hexadecimal byte pairs and ??")
    return bytes(values), bytes(masks)


def v3_populate_byte_search(connection: sqlite3.Connection, sql: str, budget: dict[str, int]) -> None:
    v3_reject_complex_bound(sql, "byte_search")
    pattern = v3_extract_sql_literal(r"\bpattern\b\s*=\s*'([^']+)'", sql)
    start = v3_sql_address_bound(sql, "start_address", "=")
    end = v3_sql_address_bound(sql, "end_address", "=")
    alignment_match = re.search(r"\balignment\b\s*=\s*(\d+)", sql, re.IGNORECASE)
    if pattern is None or start is None or end is None:
        raise RuntimeError("byte_search requires pattern and both endpoint equality constraints")
    alignment = int(alignment_match.group(1)) if alignment_match else 1
    if alignment <= 0 or alignment & (alignment - 1):
        raise RuntimeError("byte_search alignment must be a positive power of two")
    if end <= start:
        raise RuntimeError("byte_search requires start_address < end_address")
    if end - start > V3_ANALYSIS_BYTE_LIMIT:
        raise RuntimeError(f"byte_search range exceeds {V3_ANALYSIS_BYTE_LIMIT} bytes")
    data = bytes(require_view().read(start, end - start))
    if len(data) != end - start:
        raise RuntimeError("byte_search range is not fully readable")
    values, masks = v3_parse_search_pattern(pattern)
    rows = []
    for offset in range(0, len(data) - len(values) + 1):
        address = start + offset
        if address % alignment:
            continue
        if all(not masks[index] or data[offset + index] == values[index] for index in range(len(values))):
            row = (pattern, v3_address(start), v3_address(end), alignment, v3_address(address))
            v3_budget_add(budget, row)
            rows.append(row)
    connection.executemany("INSERT INTO byte_search VALUES (?,?,?,?,?)", rows)
def v3_native_variable_by_id(identifier: str) -> tuple[Any, Any, str] | None:
    for function in require_view().functions:
        parameters = {v3_variable_marker(variable) for variable in function.parameter_vars}
        seen: set[tuple[int, int, int]] = set()
        for variable in list(function.parameter_vars) + list(function.vars) + list(function.stack_layout):
            marker = v3_variable_marker(variable)
            if marker in seen:
                continue
            seen.add(marker)
            candidate = v3_stable_id(
                "variable", f"{v3_function_id(function)}:{marker[0]}:{marker[1]}:{marker[2]}"
            )
            if candidate == identifier:
                return function, variable, "argument" if marker in parameters else "local"
        if v3_stable_id("variable", f"{v3_function_id(function)}:result") == identifier:
            return function, None, "result"
    return None


def v3_apply_variable_diff(
    operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]
) -> None:
    if operation != "update":
        raise RuntimeError("function_variables supports UPDATE only")
    old_rows = {str(row["variable_id"]): row for row in before}
    comments = v3_oms_metadata.setdefault("variable_comments", {})
    overrides = v3_oms_metadata.setdefault("variable_overrides", {})
    for row in after:
        identifier = str(row["variable_id"])
        previous = old_rows.get(identifier)
        if previous is None or previous == row:
            continue
        resolved = v3_native_variable_by_id(identifier)
        if resolved is None:
            raise RuntimeError(f"Unknown variable_id: {identifier}")
        function, variable, role = resolved
        name_changed = row.get("name_override") != previous.get("name_override")
        type_changed = row.get("type_override_declaration") != previous.get("type_override_declaration")
        if (name_changed or type_changed) and role != "local":
            raise RuntimeError("Argument/result name and type changes require functions.signature_override")
        name_override = row.get("name_override")
        type_override = row.get("type_override_declaration")
        if name_override == "":
            raise RuntimeError("function_variables.name_override rejects empty text; use NULL to clear")
        if type_override == "":
            raise RuntimeError("function_variables.type_override_declaration rejects empty text; use NULL to clear")
        if name_changed or type_changed:
            desired_type = None
            if type_override is not None:
                desired_type, parsed_name = require_view().parse_type_string(str(type_override))
                if str(parsed_name):
                    raise RuntimeError("Variable type override must be an abstract type declaration without a name")
            function.delete_user_var(variable)
            if name_override is not None or type_override is not None:
                if desired_type is None:
                    desired_type = variable.type
                desired_name = str(name_override) if name_override is not None else str(variable.name)
                function.create_user_var(variable, desired_type, desired_name)
            if name_override is None and type_override is None:
                overrides.pop(identifier, None)
            else:
                overrides[identifier] = {
                    "name_override": name_override,
                    "type_override_declaration": type_override,
                }
        if row.get("comment") != previous.get("comment"):
            comment = row.get("comment")
            if comment == "":
                raise RuntimeError("function_variables.comment rejects empty text; use NULL to clear")
            if comment is None:
                comments.pop(identifier, None)
            else:
                comments[identifier] = str(comment)


def v3_validate_pseudocode_comment(row: dict[str, Any]) -> tuple[str, int, str, str]:
    function_id = str(row.get("function_id") or "")
    function = v3_function_from_id(function_id)
    address = int(v3_address(row.get("address")), 16)
    if function not in require_view().get_functions_containing(address):
        raise RuntimeError("pseudocode comment address must belong to its function_id")
    placement = str(row.get("placement") or "")
    if placement not in {"before", "after", "line", "end"}:
        raise RuntimeError("pseudocode placement must be before, after, line, or end")
    text = row.get("text")
    if text is None or str(text) == "":
        raise RuntimeError("pseudocode comment text must be non-empty")
    return function_id, address, placement, str(text)


def v3_apply_pseudocode_diff(
    operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]
) -> None:
    comments = v3_oms_metadata.setdefault("pseudocode_comments", {})
    owners = v3_oms_metadata.setdefault("pseudocode_comment_owners", {})
    fields = (
        "function_id", "line_index", "row_kind", "address", "text",
        "comment_id", "placement", "is_orphan", "valid_placements",
    )
    old_code = {tuple(row.get(field) for field in fields) for row in before if row.get("row_kind") == "code"}
    new_code = {tuple(row.get(field) for field in fields) for row in after if row.get("row_kind") == "code"}
    if old_code != new_code:
        raise RuntimeError("Pseudocode code rows are read-only")
    old_rows = {
        str(row["comment_id"]): row for row in before
        if row.get("row_kind") == "comment" and row.get("comment_id") is not None
    }
    new_rows = {
        str(row["comment_id"]): row for row in after
        if row.get("row_kind") == "comment" and row.get("comment_id") is not None
    }
    for identifier in old_rows.keys() - new_rows.keys():
        owners[identifier] = {
            "function_id": old_rows[identifier].get("function_id"),
            "address": old_rows[identifier].get("address"),
        }
        comments.pop(identifier, None)
    if operation == "delete":
        return
    changed = [
        row for identifier, row in new_rows.items()
        if old_rows.get(identifier) != row
    ]
    changed.extend(
        row for row in after
        if row.get("row_kind") in {None, "comment"} and row.get("comment_id") is None
    )
    for row in changed:
        function_id, address, placement, text = v3_validate_pseudocode_comment(row)
        raw_identifier = row.get("comment_id")
        identifier = str(raw_identifier) if raw_identifier is not None else v3_new_id("pseudocode_comment")
        previous = old_rows.get(identifier)
        if previous is not None:
            for column in ("function_id", "address"):
                if row.get(column) != previous.get(column):
                    raise RuntimeError(f"pseudocode UPDATE cannot change {column}")
        comments[identifier] = {
            "function_id": function_id,
            "address": v3_address(address),
            "placement": placement,
            "text": text,
        }
        owners[identifier] = {"function_id": function_id, "address": v3_address(address)}




def v3_materialize_analysis(connection: sqlite3.Connection, requested: set[str], sql: str) -> None:
    requested = requested & V3_ANALYSIS_TABLES
    if not requested:
        return
    budget = {"rows": 0, "bytes": 0}
    if requested & {"functions", "function_parameters"}:
        v3_populate_functions(connection, requested, sql, budget)
    if "strings" in requested:
        v3_populate_strings(connection, budget)
    if "memory_items" in requested:
        v3_populate_memory(connection, sql, budget)
    if "instructions" in requested:
        v3_populate_instructions(connection, sql, requested, budget)
    elif "instruction_operands" in requested:
        v3_populate_operands(connection, sql, budget)
    if requested & {"basic_blocks", "cfg_edges"}:
        v3_populate_cfg(connection, sql, requested, budget)
    if requested & {"address_references", "callers", "callees", "string_references", "type_references"}:
        v3_populate_references(connection, requested, budget)
    if "il_instructions" in requested:
        v3_populate_il(connection, sql, budget)
    if "pseudocode" in requested:
        v3_populate_pseudocode(connection, sql, budget)
    if "function_variables" in requested:
        v3_populate_variables(connection, sql, budget)
    if "byte_search" in requested:
        v3_populate_byte_search(connection, sql, budget)


def v3_apply_function_properties(function: Any, before: dict[str, Any], after: dict[str, Any]) -> None:
    if after.get("primary_symbol_id") != before.get("primary_symbol_id"):
        identifier = after.get("primary_symbol_id")
        selections = v3_oms_metadata.setdefault("function_primary_symbols", {})
        if identifier is None:
            selections.pop(v3_function_id(function), None)
        else:
            symbol = v3_find_symbol_by_id(str(identifier))
            if symbol is None or int(symbol.address) != int(function.start) or v3_symbol_kind(symbol) != "function":
                raise RuntimeError("primary_symbol_id must be a function symbol at the function start")
            selections[v3_function_id(function)] = str(identifier)
    if after.get("signature_override") != before.get("signature_override"):
        v3_set_function_override(function, after.get("signature_override"))
    if after.get("can_return") != before.get("can_return"):
        function.can_return = bool(after.get("can_return"))
    if after.get("comment") != before.get("comment"):
        comment = after.get("comment")
        if comment == "":
            raise RuntimeError("functions.comment rejects empty text; use NULL to clear")
        function.comment = str(comment or "")


def v3_apply_analysis_diff(
    table: str, operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]
) -> bool | None:
    if table == "function_variables":
        v3_apply_variable_diff(operation, before, after)
        require_view().update_analysis_and_wait()
        return True
    if table == "pseudocode":
        v3_apply_pseudocode_diff(operation, before, after)
        return True
    if table != "functions":
        return False
    view = require_view()
    before_ids = {str(row["function_id"]): row for row in before if row.get("function_id")}
    after_ids = {str(row["function_id"]): row for row in after if row.get("function_id")}
    if operation == "insert":
        for row in after:
            if row.get("function_id") is not None and str(row["function_id"]) in before_ids:
                continue
            address = int(v3_address(row["start_address"]), 16)
            if view.get_function_at(address) is not None:
                raise RuntimeError(f"A function already exists at {v3_address(address)}")
            function = view.create_user_function(address)
            if function is None:
                raise RuntimeError(f"Binary Ninja could not create a function at {v3_address(address)}")
            if row.get("function_id"):
                v3_bind_id(
                    "function",
                    f"{getattr(function.arch, 'name', '')}:{str(function.platform or '')}:{address:016x}",
                    str(row["function_id"]),
                )
            v3_apply_function_properties(function, {}, row)
    elif operation == "update":
        functions = {v3_function_id(function): function for function in view.functions}
        for identifier, row in after_ids.items():
            previous = before_ids.get(identifier)
            if previous is not None and previous != row:
                function = functions.get(identifier)
                if function is None:
                    raise RuntimeError(f"Unknown function_id: {identifier}")
                v3_apply_function_properties(function, previous, row)
    elif operation == "delete":
        functions = {v3_function_id(function): function for function in view.functions}
        for identifier in before_ids.keys() - after_ids.keys():
            row = before_ids[identifier]
            if row.get("origin") not in {"user", "oms"}:
                raise RuntimeError("Only user/OMS functions may be deleted")
            function = functions.get(identifier)
            if function is not None:
                view.remove_user_function(function)
                v3_retire_id(
                    "function",
                    f"{getattr(function.arch, 'name', '')}:{str(function.platform or '')}:{int(function.start):016x}",
                )
    else:
        raise RuntimeError(f"Unsupported functions operation: {operation}")
    view.update_analysis_and_wait()
    return True

v3_python_namespaces: dict[str, dict[str, Any]] = {}


def v3_python_scope() -> dict[str, Any]:
    def read_integer(identifier: Any, size: int, signed: bool = False) -> int:
        return int.from_bytes(read_bytes(identifier, size), byte_order(), signed=signed)

    return {
        "bn": bn,
        "binaryninja": bn,
        "bv": require_view(),
        "current_view": require_view(),
        "address": resolve_address,
        "function": find_function,
        "functions_containing": lambda identifier: list(require_view().get_functions_containing(resolve_address(identifier))),
        "read_u8": lambda identifier: read_integer(identifier, 1),
        "read_u16": lambda identifier: read_integer(identifier, 2),
        "read_u32": lambda identifier: read_integer(identifier, 4),
        "read_u64": lambda identifier: read_integer(identifier, 8),
        "read_i8": lambda identifier: read_integer(identifier, 1, True),
        "read_i16": lambda identifier: read_integer(identifier, 2, True),
        "read_i32": lambda identifier: read_integer(identifier, 4, True),
        "read_i64": lambda identifier: read_integer(identifier, 8, True),
        "read_ptr": lambda identifier: read_integer(identifier, require_view().address_size),
        "read_f32": lambda identifier: struct.unpack("<f" if byte_order() == "little" else ">f", read_bytes(identifier, 4))[0],
        "read_f64": lambda identifier: struct.unpack("<d" if byte_order() == "little" else ">d", read_bytes(identifier, 8))[0],
        "read_cstr": lambda identifier, limit=4096: bytes(require_view().read(resolve_address(identifier), int(limit))).split(b"\0", 1)[0].decode("utf-8", errors="replace"),
    }


def v3_execute_python(script: str, stateful: bool = False, session_id: Any = None) -> dict[str, Any]:
    if stateful:
        if not isinstance(session_id, str) or not session_id:
            raise RuntimeError("Stateful Binary Ninja execution requires a non-empty session_id")
        scope = v3_python_namespaces.setdefault(session_id, {})
    else:
        scope = {}
    scope.update(v3_python_scope())
    scope["result"] = None
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        exec(script, scope, scope)
    value = scope.get("result")
    normalized = json_value(value)
    warnings = [] if normalized is value or isinstance(value, (type(None), bool, int, float, str, list, tuple, dict)) else ["`result` was not JSON-serializable; returned repr(result) instead."]
    return {"result": normalized, "stdout": output.getvalue(), "warnings": warnings}


def v3_reset_python_namespace(session_id: Any = None) -> bool:
    if session_id is None:
        v3_python_namespaces.clear()
        return True
    if not isinstance(session_id, str) or not session_id:
        raise RuntimeError("reset requires a non-empty session_id")
    v3_python_namespaces.pop(session_id, None)
    return True


def execute_python(script: str, stateful: bool = False, session_id: Any = None) -> dict[str, Any]:
    return v3_execute_python(script, stateful, session_id)


def dispatch(request: dict[str, Any]) -> Any:
    operation = request.get("op")
    if operation == "open":
        return open_target(request)
    if operation == "query":
        return execute_query(str(request["sql"]), request.get("params"))
    if operation == "execute":
        return execute_python(str(request["code"]), bool(request.get("stateful")), request.get("session_id"))
    if operation == "reset":
        return v3_reset_python_namespace(request.get("session_id"))
    if operation == "save":
        return save_target()
    if operation == "close":
        close_target(bool(request.get("save", True)))
        return True
    if operation == "info":
        return target_info()
    raise RuntimeError(f"Unknown Binary Ninja worker operation: {operation}")


def main() -> None:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request.get("id")
            emit({"id": request_id, "ok": True, "result": dispatch(request)})
            if request.get("op") == "close":
                return
        except Exception as error:
            emit({"id": request.get("id") if "request" in locals() else None, "ok": False, "error": f"{type(error).__name__}: {error}", "traceback": traceback.format_exc()})
    close_target(False)



# Binary Ninja gives named types stable native IDs, but aggregate children do
# not have native identities. Keep only the missing identity/layout/style data
# in OMS metadata; declarations and offsets always come from live analysis.
def _v3_type_state() -> dict[str, Any]:
    # Load once per worker target. Reloading on every helper call would discard
    # IDs allocated earlier in the same SQL transaction before commit.
    root = v3_oms_metadata if v3_oms_metadata.get("version") == 5 else v3_load_oms_metadata()
    return root.setdefault("named_types", {})


def _v3_save_type_state() -> None:
    v3_store_oms_metadata()


def _v3_type_class_name(type_object: Any) -> str:
    value = getattr(type_object, "type_class", None)
    return getattr(value, "name", str(value) if value is not None else "")


def v3_type_id_for_object(type_object: Any):
    if type_object is None:
        return None
    registered = getattr(type_object, "registered_name", None)
    if registered is not None and getattr(registered, "type_id", None):
        return str(registered.type_id)
    if _v3_type_class_name(type_object) == "NamedTypeReferenceClass":
        native_id = getattr(type_object, "type_id", None)
        return str(native_id) if native_id else None
    return None


def _v3_direct_type_id(type_object: Any):
    if type_object is None:
        return None
    if _v3_type_class_name(type_object) == "NamedTypeReferenceClass":
        native_id = getattr(type_object, "type_id", None)
        return str(native_id) if native_id else None
    return v3_type_id_for_object(type_object)
def _v3_type_name_by_id(type_id: str):
    view = require_view()
    name = view.get_type_name_by_id(type_id)
    if name is None:
        saved = _v3_type_state().setdefault("oms_type_names", {}).get(type_id)
        return saved if isinstance(saved, str) else None
    return name


def _v3_type_by_id(type_id: str):
    view = require_view()
    type_object = view.get_type_by_id(type_id)
    if type_object is not None:
        return type_object
    name = _v3_type_name_by_id(type_id)
    return view.get_type_by_name(name) if name is not None else None




def _v3_named_type_kind(type_object: Any) -> str:
    class_name = _v3_type_class_name(type_object)
    if class_name == "StructureTypeClass":
        variant = getattr(getattr(type_object, "type", None), "name", "")
        return "union" if "Union" in variant else "struct"
    if class_name == "EnumerationTypeClass":
        return "enum"
    if class_name == "FunctionTypeClass":
        return "function"
    if class_name == "NamedTypeReferenceClass":
        return "typedef"
    return "other"


def _v3_type_ordinal(type_id: str) -> int:
    state = _v3_type_state()
    ordinals = state.setdefault("ordinals", {})
    if type_id not in ordinals:
        ordinal = int(state.get("next_ordinal", 0))
        ordinals[type_id] = ordinal
        state["next_ordinal"] = ordinal + 1
        _v3_save_type_state()
    return int(ordinals[type_id])


def _v3_type_origin(type_id: str, name: str) -> str:
    if type_id in _v3_type_state().setdefault("oms_type_ids", []):
        return "oms"
    return "analysis" if require_view().is_type_auto_defined(name) else "user"


def _v3_layout_mode(type_id: str, type_object: Any) -> str:
    saved = _v3_type_state().setdefault("layout", {}).get(type_id)
    if isinstance(saved, dict) and saved.get("mode"):
        return str(saved["mode"])
    return "packed" if bool(getattr(type_object, "packed", False)) else "automatic"


def _v3_type_declaration(name: str, type_object: Any) -> str:
    try:
        rendered = bn.TypePrinter.default.print_all_types([(name, type_object)], require_view())
        if rendered and rendered.strip():
            return rendered.strip()
    except Exception:
        pass
    return str(type_object)


def _v3_unpadded_size(type_object: Any) -> int:
    ends = []
    for member in list(getattr(type_object, "members", None) or ()):
        member_type = getattr(member, "type", None)
        member_offset = getattr(member, "offset", None)
        if member_type is None or member_offset is None:
            continue
        width = int(getattr(member, "bit_width", 0) or int(getattr(member_type, "width", 0)) * 8)
        ends.append(int(getattr(member, "bit_offset", int(member_offset) * 8)) + width)
    for base in list(getattr(type_object, "base_structures", None) or ()):
        ends.append((int(base.offset) + int(base.width)) * 8)
    return (max(ends) + 7) // 8 if ends else 0


def _v3_child_ids(domain: str, owner_id: str, signatures: list[str]) -> list[str]:
    state = _v3_type_state()
    records_by_owner = state.setdefault("%s_records" % domain, {})
    old = list(records_by_owner.get(owner_id, []))
    used = set()
    ids = []
    records = []
    for index, signature in enumerate(signatures):
        selected = None
        for old_index, record in enumerate(old):
            if old_index not in used and record.get("signature") == signature:
                selected = (old_index, str(record["id"]))
                break
        if selected is None and domain == "parameter" and index < len(old) and index not in used:
            selected = (index, str(old[index]["id"]))
        if selected is None:
            counter_key = "next_%s" % domain
            counter = int(state.get(counter_key, 0))
            state[counter_key] = counter + 1
            child_id = v3_stable_id(domain, "%s:%d" % (owner_id, counter))
        else:
            used.add(selected[0])
            child_id = selected[1]
        ids.append(child_id)
        records.append({"id": child_id, "signature": signature})
    if records != old:
        records_by_owner[owner_id] = records
        _v3_save_type_state()
    return ids


def _v3_access_name(value: Any) -> str:
    name = getattr(value, "name", str(value))
    normalized = name[:-6].lower() if name.endswith("Access") else name.lower()
    return "none" if normalized == "no" else normalized


def _v3_scope_name(value: Any) -> str:
    name = getattr(value, "name", str(value))
    normalized = name[:-5].lower() if name.endswith("Scope") else name.lower()
    return "none" if normalized == "no" else normalized


def _v3_type_row(name_object: Any, type_object: Any) -> tuple[Any, ...]:
    view = require_view()
    name = str(name_object)
    type_id = str(view.get_type_id(name))
    kind = _v3_named_type_kind(type_object)
    members = list(getattr(type_object, "members", None) or ())
    bases = list(getattr(type_object, "base_structures", None) or ())
    target_id = _v3_direct_type_id(type_object) if kind == "typedef" else None
    forward = bool(kind == "typedef" and target_id and view.get_type_by_id(target_id) is None)
    return (
        type_id, _v3_type_ordinal(type_id), name, kind,
        int(getattr(type_object, "width", 0)), int(getattr(type_object, "alignment", 1)),
        _v3_unpadded_size(type_object), len(members) + len(bases), kind == "typedef",
        target_id, forward, _v3_layout_mode(type_id, type_object),
        _v3_type_origin(type_id, name), int(getattr(type_object, "confidence", 255)),
        _v3_type_declaration(name, type_object),
    )


def _v3_member_rows(owner_id: str, type_object: Any) -> list[tuple[Any, ...]]:
    metadata = _v3_type_state().setdefault("member_metadata", {})
    owner_name = _v3_type_name_by_id(owner_id)
    owner_origin = _v3_type_origin(owner_id, str(owner_name)) if owner_name is not None else "analysis"
    raw = []
    for base in list(getattr(type_object, "base_structures", None) or ()):
        declaration = str(base.type)
        raw.append((
            "base:%s" % declaration, str(getattr(base.type, "name", "")),
            int(base.offset) * 8, int(base.width) * 8, declaration,
            _v3_direct_type_id(base.type), "none", "none", False, True,
            int(getattr(base.type, "confidence", 255)),
        ))
    for member in list(getattr(type_object, "members", None) or ()):
        declaration = str(member.type)
        raw.append((
            "member:%s:%s" % (member.name, declaration), member.name,
            int(getattr(member, "bit_offset", int(member.offset) * 8)),
            int(getattr(member, "bit_width", 0) or int(getattr(member.type, "width", 0)) * 8),
            declaration, _v3_direct_type_id(member.type), _v3_access_name(member.access),
            _v3_scope_name(member.scope), bool(getattr(member, "bit_width", 0)), False,
            int(getattr(member.type, "confidence", 255)),
        ))
    saved = list(_v3_type_state().setdefault("member_records", {}).get(owner_id, []))
    saved_order = {str(record["id"]): index for index, record in enumerate(saved)}
    ids = _v3_child_ids("member", owner_id, [item[0] for item in raw])
    paired = list(zip(ids, raw))
    # BN stores bases separately from ordinary fields. OMS ordering metadata is
    # therefore authoritative only when those two native lists are interleaved.
    if any(item[1][9] for item in paired) and set(saved_order) == set(ids):
        paired.sort(key=lambda item: saved_order[item[0]])
    rows = []
    for index, (child_id, item) in enumerate(paired):
        extra = metadata.get(child_id, {})
        rows.append((
            child_id, owner_id, index, item[1], item[2], item[3], item[4], item[5],
            item[6], item[7], item[8], item[9], bool(extra.get("is_virtual_base", False)),
            bool(extra.get("is_vtable", False)), str(extra.get("origin", owner_origin)),
            int(extra.get("confidence", item[10])), extra.get("comment"),
        ))
    desired_records = [{"id": child_id, "signature": item[0]} for child_id, item in paired]
    if _v3_type_state().setdefault("member_records", {}).get(owner_id) != desired_records:
        _v3_type_state()["member_records"][owner_id] = desired_records
        _v3_save_type_state()
    return rows


def _v3_enum_rows(owner_id: str, type_object: Any) -> list[tuple[Any, ...]]:
    metadata = _v3_type_state().setdefault("enum_metadata", {})
    owner_name = _v3_type_name_by_id(owner_id)
    owner_origin = _v3_type_origin(owner_id, str(owner_name)) if owner_name is not None else "analysis"
    members = list(getattr(type_object, "members", None) or ())
    ids = _v3_child_ids("enum_value", owner_id, ["enum:%s" % item.name for item in members])
    rows = []
    for index, (child_id, member) in enumerate(zip(ids, members)):
        extra = metadata.get(child_id, {})
        value = extra.get("integer_value", member.value if member.value is not None else index)
        rows.append((
            child_id, owner_id, index, member.name, str(int(value)),
            str(extra.get("origin", owner_origin)),
            int(extra.get("confidence", getattr(type_object, "confidence", 255))),
            extra.get("comment"),
        ))
    return rows


def _v3_parameter_storage(location: Any) -> tuple[Any, Any, Any]:
    if location is None:
        return None, None, None
    source = getattr(getattr(location, "source_type", None), "name", "")
    storage = int(getattr(location, "storage", 0))
    if source == "StackVariableSourceType":
        return "stack", storage, None
    if source == "RegisterVariableSourceType":
        arch = require_view().arch
        return "register", None, arch.get_reg_name(storage) if arch is not None else str(storage)
    if source == "FlagVariableSourceType":
        return "flag", None, str(storage)
    return "unknown", None, None


def _v3_function_type_parameter_rows(owner_id: str, type_object: Any) -> list[tuple[Any, ...]]:
    owner_name = _v3_type_name_by_id(owner_id)
    owner_origin = _v3_type_origin(owner_id, str(owner_name)) if owner_name is not None else "analysis"
    raw = [("return:%s" % str(type_object.return_value), "return", None, None, type_object.return_value, None)]
    for index, parameter in enumerate(list(getattr(type_object, "parameters", None) or ())):
        raw.append((
            "parameter:%s:%s" % (parameter.name, str(parameter.type)),
            "parameter", index, parameter.name or None, parameter.type, parameter.location,
        ))
    ids = _v3_child_ids("parameter", owner_id, [item[0] for item in raw])
    rows = []
    for child_id, item in zip(ids, raw):
        storage_kind, stack_offset, register_name = _v3_parameter_storage(item[5])
        rows.append((
            child_id, owner_id, item[1], item[2], item[3], str(item[4]),
            _v3_direct_type_id(item[4]), storage_kind, stack_offset, register_name,
            owner_origin, int(getattr(item[4], "confidence", 255)),
        ))
    return rows


def v3_create_type_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        "CREATE TABLE types (type_id TEXT PRIMARY KEY, ordinal INTEGER, qualified_name TEXT UNIQUE, "
        "kind TEXT, size_bytes INTEGER, alignment_bytes INTEGER, unpadded_size_bytes INTEGER, "
        "member_count INTEGER, is_typedef INTEGER, target_type_id TEXT, is_forward_declaration INTEGER, "
        "layout_mode TEXT, origin TEXT, confidence INTEGER, declaration TEXT)"
    )
    connection.execute(
        "CREATE TABLE type_members (member_id TEXT PRIMARY KEY, owner_type_id TEXT, member_index INTEGER, "
        "name TEXT, offset_bits INTEGER, width_bits INTEGER, type_declaration TEXT, referenced_type_id TEXT, "
        "access TEXT, scope TEXT, is_bitfield INTEGER, is_base INTEGER, is_virtual_base INTEGER, "
        "is_vtable INTEGER, origin TEXT, confidence INTEGER, comment TEXT)"
    )
    connection.execute(
        "CREATE TABLE enum_values (enum_value_id TEXT PRIMARY KEY, owner_type_id TEXT, value_index INTEGER, "
        "name TEXT, integer_value TEXT, origin TEXT, confidence INTEGER, comment TEXT)"
    )
    connection.execute(
        "CREATE TABLE function_type_parameters (parameter_id TEXT PRIMARY KEY, owner_type_id TEXT, role TEXT, "
        "parameter_index INTEGER, name TEXT, type_declaration TEXT, referenced_type_id TEXT, storage_kind TEXT, "
        "stack_offset INTEGER, register_name TEXT, origin TEXT, confidence INTEGER)"
    )


def v3_materialize_types(connection: sqlite3.Connection, requested: set[str], sql: str = "") -> None:
    wanted = requested & {"types", "type_members", "enum_values", "function_type_parameters"}
    if not wanted:
        return
    type_rows = []
    member_rows = []
    enum_rows = []
    parameter_rows = []
    for name_object, type_object in require_view().types.items():
        name = str(name_object)
        type_id = str(require_view().get_type_id(name))
        if "types" in wanted:
            type_rows.append(_v3_type_row(name_object, type_object))
        kind = _v3_named_type_kind(type_object)
        if "type_members" in wanted and kind in {"struct", "union"}:
            member_rows.extend(_v3_member_rows(type_id, type_object))
        if "enum_values" in wanted and kind == "enum":
            enum_rows.extend(_v3_enum_rows(type_id, type_object))
        if "function_type_parameters" in wanted and kind == "function":
            parameter_rows.extend(_v3_function_type_parameter_rows(type_id, type_object))
    if "types" in wanted:
        connection.executemany("INSERT INTO types VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", type_rows)
    if "type_members" in wanted:
        connection.executemany("INSERT INTO type_members VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", member_rows)
    if "enum_values" in wanted:
        connection.executemany("INSERT INTO enum_values VALUES (?,?,?,?,?,?,?,?)", enum_rows)
    if "function_type_parameters" in wanted:
        connection.executemany("INSERT INTO function_type_parameters VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", parameter_rows)


def _v3_parse_one_named(declaration: str) -> tuple[str, Any]:
    if not isinstance(declaration, str) or not declaration.strip():
        raise RuntimeError("A non-empty named type declaration is required")
    parsed = require_view().parse_types_from_string(declaration)
    named = list(parsed.types.items())
    if parsed.variables or parsed.functions:
        raise RuntimeError("Named type declarations cannot also declare variables or functions")
    if len(named) != 1:
        raise RuntimeError("Declaration must define exactly one named type; it defined %d" % len(named))
    return str(named[0][0]), named[0][1]


def _v3_mark_oms_type(type_id: str, layout_mode: Any = None, size_bytes: Any = None) -> None:
    state = _v3_type_state()
    owned = state.setdefault("oms_type_ids", [])
    if type_id not in owned:
        owned.append(type_id)
    _v3_type_ordinal(type_id)
    if layout_mode is not None:
        state.setdefault("layout", {})[type_id] = {
            "mode": str(layout_mode),
            "width": int(size_bytes or 0),
            "fixed_size": size_bytes is not None,
        }
    _v3_save_type_state()

def _v3_define_named_type(type_id: str, name: str, type_object: Any) -> None:
    view = require_view()
    if _v3_type_by_id(type_id) is None:
        created_type_ids = list(getattr(view.session_data, V3_CREATED_TYPE_IDS_SESSION_KEY, ()))
        created_type_ids.append(type_id)
        setattr(view.session_data, V3_CREATED_TYPE_IDS_SESSION_KEY, created_type_ids)
    owned = _v3_type_state().setdefault("oms_type_ids", [])
    if type_id in owned:
        if _v3_type_by_id(type_id) is None:
            registered = view.define_type(type_id, name, type_object)
            if str(registered) != name:
                raise RuntimeError("Binary Ninja registered type '%s' as '%s'" % (name, registered))
        view.define_user_type(name, type_object)
        _v3_type_state().setdefault("oms_type_names", {})[type_id] = str(name)
        return
    view.define_user_type(name, type_object)
    native_id = str(view.get_type_id(name))
    if native_id != type_id:
        # User-type promotion may replace BN's generated ID. Keep the OMS ID
        # as the SQL identity and remember which native name now owns it.
        _v3_type_state().setdefault("oms_type_names", {})[type_id] = str(name)


def _v3_create_empty_type(row: dict[str, Any]) -> tuple[str, Any]:
    name = row.get("qualified_name")
    kind = str(row.get("kind") or "")
    mode = str(row.get("layout_mode") or "automatic")
    size = row.get("size_bytes")
    if not name:
        raise RuntimeError("types INSERT requires qualified_name when declaration is omitted")
    if kind not in {"struct", "union", "enum"}:
        raise RuntimeError("Empty types INSERT supports only struct, union, or enum")
    if mode not in {"automatic", "packed", "explicit"}:
        raise RuntimeError("layout_mode must be automatic, packed, or explicit")
    if kind in {"struct", "union"}:
        variant = bn.StructureVariant.UnionStructureType if kind == "union" else bn.StructureVariant.StructStructureType
        result = bn.StructureBuilder.create(
            type=variant, packed=mode == "packed",
            width=int(size) if size is not None else None,
            platform=require_view().platform,
        )
    else:
        if mode != "automatic":
            raise RuntimeError("Enumeration layout_mode must be automatic")
        result = bn.EnumerationBuilder.create(
            width=int(size) if size is not None else None,
            arch=require_view().arch, platform=require_view().platform,
        )
    return str(name), result


def _v3_definition_from_row(row: dict[str, Any]) -> tuple[str, Any]:
    if row.get("declaration"):
        parsed_name, type_object = _v3_parse_one_named(str(row["declaration"]))
        requested = row.get("qualified_name")
        if requested and str(requested) != parsed_name:
            raise RuntimeError(
                "Declaration defines '%s', not qualified_name '%s'" % (parsed_name, requested)
            )
        return parsed_name, type_object
    return _v3_create_empty_type(row)


def _v3_type_contains_id(type_object: Any, target_id: str, seen: Any = None) -> bool:
    if type_object is None:
        return False
    if _v3_direct_type_id(type_object) == target_id:
        return True
    seen = set() if seen is None else seen
    identity = id(type_object)
    if identity in seen:
        return False
    seen.add(identity)
    return any(_v3_type_contains_id(child, target_id, seen)
               for child in list(getattr(type_object, "children", None) or ()))


def _v3_delete_named_type(row: dict[str, Any]) -> None:
    view = require_view()
    type_id = str(row["type_id"])
    name = str(row["qualified_name"])
    references = list(view.get_type_refs_for_type(name))
    references.extend(function for function in view.functions if _v3_type_contains_id(function.type, type_id))
    if type_id in _v3_type_state().setdefault("oms_type_ids", []):
        view.undefine_user_type(name)
        view.undefine_type(type_id)
    else:
        view.undefine_type(type_id)
    if view.get_type_by_name(name) is not None:
        raise RuntimeError("Binary Ninja refused to delete type '%s'" % name)
    state = _v3_type_state()
    with contextlib.suppress(ValueError):
        state.setdefault("oms_type_ids", []).remove(type_id)
    for key in ("oms_type_names", "ordinals", "layout", "member_records", "enum_value_records"):
        state.setdefault(key, {}).pop(type_id, None)
    _v3_save_type_state()


def _v3_rebuild_layout(type_id: str, name: str, type_object: Any, mode: str, width: Any, fixed: bool) -> None:
    if _v3_named_type_kind(type_object) not in {"struct", "union"}:
        raise RuntimeError("layout_mode and size_bytes apply only to struct/union types")
    if mode not in {"automatic", "packed", "explicit"}:
        raise RuntimeError("layout_mode must be automatic, packed, or explicit")
    members = list(type_object.members)
    bases = list(type_object.base_structures)
    if mode == "explicit":
        builder = type_object.mutable_copy()
        configured = int(width if width is not None else type_object.width)
        largest_end = max(
            [int(getattr(member, "bit_offset", member.offset * 8)) +
             int(member.bit_width or member.type.width * 8) for member in members] +
            [(int(base.offset) + int(base.width)) * 8 for base in bases] + [0]
        )
        if configured * 8 < largest_end:
            raise RuntimeError("Explicit aggregate size is too small for its members")
        builder.width = configured
    else:
        builder = bn.StructureBuilder.create(
            type=type_object.type, packed=mode == "packed", platform=require_view().platform
        )
        builder.base_structures = bases
        bit_cursor = 0
        for member in members:
            bit_width = int(getattr(member, "bit_width", 0))
            if bit_width:
                storage_bits = max(8, int(member.type.width) * 8)
                if bit_cursor % storage_bits + bit_width > storage_bits:
                    bit_cursor = ((bit_cursor + storage_bits - 1) // storage_bits) * storage_bits
                builder.add_member_at_offset(
                    member.name, member.type, bit_cursor // 8, False, member.access,
                    member.scope, bit_cursor % 8, bit_width,
                )
                bit_cursor += bit_width
            else:
                builder.append(member.type, member.name, member.access, member.scope)
                bit_cursor = int(builder.width) * 8
    _v3_define_named_type(type_id, name, builder)
    _v3_type_state().setdefault("layout", {})[type_id] = {
        "mode": mode,
        "width": int(width if width is not None else builder.width),
        "fixed_size": bool(fixed),
    }
    _v3_save_type_state()


def _v3_apply_types_diff(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    old_by_id = {str(row["type_id"]): row for row in before if row.get("type_id") is not None}
    new_by_id = {str(row["type_id"]): row for row in after if row.get("type_id") is not None}
    if operation == "delete":
        for type_id in old_by_id.keys() - new_by_id.keys():
            _v3_delete_named_type(old_by_id[type_id])
        return
    additions = [row for row in after if row.get("type_id") is None]
    for row in additions:
        name, type_object = _v3_definition_from_row(row)
        actual_kind = _v3_named_type_kind(type_object)
        if row.get("kind") and str(row["kind"]) != actual_kind:
            raise RuntimeError("Declaration kind is %s, not %s" % (actual_kind, row["kind"]))
        if view.get_type_by_name(name) is not None:
            raise RuntimeError("Type '%s' already exists; INSERT is not replacement" % name)
        type_id = v3_new_id("type")
        _v3_mark_oms_type(type_id)
        _v3_define_named_type(type_id, name, type_object)
        row["qualified_name"] = name
        mode = row.get("layout_mode") or (
            "packed" if bool(getattr(type_object, "packed", False)) else "automatic"
        )
        _v3_mark_oms_type(type_id, mode, row.get("size_bytes"))
        native_mode = "packed" if bool(getattr(type_object, "packed", False)) else "automatic"
        if actual_kind in {"struct", "union"} and str(mode) != native_mode:
            _v3_rebuild_layout(
                type_id, name, view.get_type_by_name(name), str(mode),
                row.get("size_bytes"), row.get("size_bytes") is not None,
            )
    for type_id in old_by_id.keys() & new_by_id.keys():
        old = old_by_id[type_id]
        row = new_by_id[type_id]
        if row.get("ordinal") != old.get("ordinal") or row.get("origin") != old.get("origin"):
            raise RuntimeError("Type type_id, ordinal, and origin are immutable")
        old_name = str(old["qualified_name"])
        new_name = str(row["qualified_name"])
        if new_name != old_name:
            if type_id in _v3_type_state().setdefault("oms_type_ids", []):
                view.rename_type(old_name, new_name)
            elif not view.type_container.rename_type(type_id, new_name):
                raise RuntimeError("Binary Ninja refused to rename type '%s'" % old_name)
            if view.get_type_by_name(new_name) is None:
                raise RuntimeError("Binary Ninja refused to rename type '%s'" % old_name)
            _v3_type_state().setdefault("oms_type_names", {})[type_id] = new_name
        current = _v3_type_by_id(type_id) or view.get_type_by_name(new_name)
        if current is None:
            raise RuntimeError("Type '%s' disappeared during update" % new_name)
        if row.get("declaration") != old.get("declaration"):
            parsed_name, replacement = _v3_parse_one_named(str(row["declaration"]))
            if parsed_name != new_name:
                raise RuntimeError("Replacement declaration must define exactly '%s'" % new_name)
            old_kind = _v3_named_type_kind(current)
            new_kind = _v3_named_type_kind(replacement)
            if old_kind != new_kind:
                raise RuntimeError("Named type kind is immutable (%s, not %s)" % (old_kind, new_kind))
            _v3_define_named_type(type_id, new_name, replacement)
            current = _v3_type_by_id(type_id) or view.get_type_by_name(new_name)
        old_mode = str(old.get("layout_mode") or "automatic")
        new_mode = str(row.get("layout_mode") or old_mode)
        size_changed = row.get("size_bytes") != old.get("size_bytes")
        if size_changed and new_mode != "explicit":
            raise RuntimeError("size_bytes is writable only for explicit aggregate layout")
        if new_mode != old_mode or size_changed:
            saved = _v3_type_state().setdefault("layout", {}).get(type_id, {})
            _v3_rebuild_layout(
                type_id, new_name, current, new_mode, row.get("size_bytes"),
                size_changed or (new_mode == "explicit" and new_mode != old_mode) or bool(saved.get("fixed_size", False)),
            )


def _v3_member_access(value: Any):
    key = "none" if value is None else str(value).lower()
    values = {
        "none": bn.MemberAccess.NoAccess, "private": bn.MemberAccess.PrivateAccess,
        "protected": bn.MemberAccess.ProtectedAccess, "public": bn.MemberAccess.PublicAccess,
    }
    if key not in values:
        raise RuntimeError("Unsupported member access '%s'" % value)
    return values[key]


def _v3_member_scope(value: Any):
    key = "none" if value is None else str(value).lower()
    values = {
        "none": bn.MemberScope.NoScope, "static": bn.MemberScope.StaticScope,
        "virtual": bn.MemberScope.VirtualScope, "thunk": bn.MemberScope.ThunkScope,
        "friend": bn.MemberScope.FriendScope,
    }
    if key not in values:
        raise RuntimeError("Unsupported member scope '%s'" % value)
    return values[key]


def _v3_owner_rows(rows: list[dict[str, Any]], owner_id: str) -> list[dict[str, Any]]:
    return [dict(row) for row in rows if str(row.get("owner_type_id")) == owner_id]


def _v3_order_members(operation: str, owner_id: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> list[dict[str, Any]]:
    old_rows = sorted(_v3_owner_rows(before, owner_id), key=lambda row: int(row["member_index"]))
    new_rows = _v3_owner_rows(after, owner_id)
    new_by_id = {str(row["member_id"]): row for row in new_rows if row.get("member_id") is not None}
    old_by_id = {str(row["member_id"]): row for row in old_rows}
    ordered = [new_by_id[str(row["member_id"])] for row in old_rows if str(row["member_id"]) in new_by_id]
    if operation == "update":
        for row in list(ordered):
            old = old_by_id[str(row["member_id"])]
            if row.get("owner_type_id") != old.get("owner_type_id"):
                raise RuntimeError("Member owner_type_id is immutable")
            if row.get("member_index") != old.get("member_index"):
                ordered.remove(row)
                target = max(0, min(int(row["member_index"]), len(ordered)))
                ordered.insert(target, row)
    for row in [item for item in new_rows if item.get("member_id") is None]:
        target = len(ordered) if row.get("member_index") is None else int(row["member_index"])
        counter = int(_v3_type_state().get("next_member", 0))
        _v3_type_state()["next_member"] = counter + 1
        row["_assigned_id"] = v3_stable_id("member", "%s:%d" % (owner_id, counter))
        ordered.insert(max(0, min(target, len(ordered))), row)
    for index, row in enumerate(ordered):
        row["member_index"] = index
    return ordered


def _v3_apply_member_owner(operation: str, owner_id: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    owner_name = _v3_type_name_by_id(owner_id)
    type_object = _v3_type_by_id(owner_id)
    if owner_name is None or type_object is None or _v3_named_type_kind(type_object) not in {"struct", "union"}:
        raise RuntimeError("type_members owner must be an existing struct or union")
    mode = _v3_layout_mode(owner_id, type_object)
    rows = _v3_order_members(operation, owner_id, before, after)
    old_by_id = {str(row["member_id"]): row for row in _v3_owner_rows(before, owner_id)}
    for row in rows:
        old = old_by_id.get(str(row.get("member_id")))
        if old is not None:
            if row.get("is_bitfield") != old.get("is_bitfield"):
                raise RuntimeError("is_bitfield is computed and read-only")
            if mode != "explicit" and (
                row.get("offset_bits") != old.get("offset_bits") or
                row.get("width_bits") != old.get("width_bits")
            ):
                raise RuntimeError("offset_bits/width_bits are writable only in explicit layout")
        elif mode == "explicit" and row.get("offset_bits") is None:
            raise RuntimeError("Explicit-layout member INSERT requires offset_bits")
        elif mode != "explicit" and (row.get("offset_bits") is not None or row.get("width_bits") is not None):
            raise RuntimeError("Automatic/packed member INSERT computes offset_bits and width_bits")
        if not row.get("type_declaration"):
            raise RuntimeError("type_members requires type_declaration")
        if row.get("comment") == "":
            raise RuntimeError("Member comments cannot be empty; use NULL to clear")
    builder = bn.StructureBuilder.create(
        type=type_object.type, packed=mode == "packed", platform=view.platform
    )
    bases = []
    max_end = 0
    for row in rows:
        member_type, parsed_name = view.parse_type_string(str(row["type_declaration"]))
        if str(parsed_name):
            raise RuntimeError("Member type_declaration cannot include a declarator name")
        if bool(row.get("is_base")):
            if mode == "explicit":
                offset_bits = int(row.get("offset_bits") or 0)
            else:
                cursor = max(int(builder.width), (max_end + 7) // 8)
                alignment = 1 if mode == "packed" else max(1, int(getattr(member_type, "alignment", 1)))
                cursor = ((cursor + alignment - 1) // alignment) * alignment
                offset_bits = cursor * 8
            if offset_bits % 8:
                raise RuntimeError("Base offsets must be byte aligned")
            bases.append(bn.BaseStructure(member_type, offset_bits // 8))
            max_end = max(max_end, offset_bits + int(member_type.width) * 8)
            if mode != "explicit":
                builder.base_structures = bases
                builder.width = (max_end + 7) // 8
            continue
        access = _v3_member_access(row.get("access"))
        scope = _v3_member_scope(row.get("scope"))
        if mode == "explicit":
            offset_bits = int(row["offset_bits"])
            native_width = int(member_type.width) * 8
            supplied_width = row.get("width_bits")
            old = old_by_id.get(str(row.get("member_id")))
            if (
                old is not None
                and not bool(old.get("is_bitfield"))
                and row.get("type_declaration") != old.get("type_declaration")
                and supplied_width == old.get("width_bits")
            ):
                supplied_width = None
            is_bitfield = supplied_width is not None and int(supplied_width) != native_width
            bit_width = int(supplied_width) if is_bitfield else 0
            if not is_bitfield and offset_bits % 8:
                raise RuntimeError("Non-bitfield members must be byte aligned")
            builder.add_member_at_offset(
                str(row.get("name") or ""), member_type, offset_bits // 8, False,
                access, scope, offset_bits % 8, bit_width,
            )
            max_end = max(max_end, offset_bits + (bit_width or native_width))
        else:
            builder.append(member_type, str(row.get("name") or ""), access, scope)
    builder.base_structures = bases
    layout = _v3_type_state().setdefault("layout", {}).get(owner_id, {})
    if mode == "explicit":
        configured = int(layout.get("width", type_object.width))
        needed = (max_end + 7) // 8
        if bool(layout.get("fixed_size", False)) and needed > configured:
            raise RuntimeError("Member does not fit the configured explicit aggregate size")
        builder.width = max(configured, needed)
        layout["width"] = int(builder.width)
    _v3_define_named_type(owner_id, str(owner_name), builder)
    metadata = _v3_type_state().setdefault("member_metadata", {})
    records = []
    for row in rows:
        child_id = str(row.get("member_id") or row["_assigned_id"])
        previous = metadata.get(child_id, {})
        signature = "%s:%s:%s" % (
            "base" if bool(row.get("is_base")) else "member",
            row.get("name") or "", row.get("type_declaration") or "",
        )
        metadata[child_id] = {
            "is_virtual_base": bool(row.get("is_virtual_base")),
            "is_vtable": bool(row.get("is_vtable")),
            "origin": str(previous.get("origin", row.get("origin") or "oms")),
            "confidence": int(row.get("confidence") if row.get("confidence") is not None else 255),
            "comment": row.get("comment"),
        }
        records.append({"id": child_id, "signature": signature})
    _v3_type_state().setdefault("member_records", {})[owner_id] = records
    _v3_save_type_state()
    readback_type = _v3_type_by_id(owner_id)
    readback_rows = _v3_member_rows(owner_id, readback_type) if readback_type is not None else []
    expected_ids = {record["id"] for record in records}
    observed_ids = {str(row[0]) for row in readback_rows}
    if expected_ids != observed_ids:
        raise RuntimeError(
            "Type member semantic readback changed identities: expected %s, observed %s"
            % (sorted(expected_ids), sorted(observed_ids))
        )


def _v3_apply_members_diff(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    old_ids = {str(row["member_id"]) for row in before if row.get("member_id") is not None}
    new_ids = {str(row["member_id"]) for row in after if row.get("member_id") is not None}
    if operation == "insert":
        owners = {str(row["owner_type_id"]) for row in after if row.get("member_id") is None}
    elif operation == "delete":
        removed = old_ids - new_ids
        owners = {str(row["owner_type_id"]) for row in before if str(row.get("member_id")) in removed}
    else:
        old_by_id = {str(row["member_id"]): row for row in before if row.get("member_id") is not None}
        owners = {
            str(row["owner_type_id"]) for row in after
            if row.get("member_id") is not None and old_by_id.get(str(row["member_id"])) != row
        }
    for owner_id in owners:
        _v3_apply_member_owner(operation, owner_id, before, after)


def _v3_apply_enum_owner(operation: str, owner_id: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    view = require_view()
    owner_name = _v3_type_name_by_id(owner_id)
    type_object = _v3_type_by_id(owner_id)
    if owner_name is None or type_object is None or _v3_named_type_kind(type_object) != "enum":
        raise RuntimeError("enum_values owner must be an existing enum")
    old_rows = sorted(_v3_owner_rows(before, owner_id), key=lambda row: int(row["value_index"]))
    new_rows = _v3_owner_rows(after, owner_id)
    new_by_id = {str(row["enum_value_id"]): row for row in new_rows if row.get("enum_value_id") is not None}
    rows = []
    for old in old_rows:
        child_id = str(old["enum_value_id"])
        if child_id in new_by_id:
            row = new_by_id[child_id]
            if row.get("owner_type_id") != old.get("owner_type_id") or row.get("value_index") != old.get("value_index"):
                raise RuntimeError("Enum owner_type_id and value_index are immutable")
            rows.append(row)
    for row in [item for item in new_rows if item.get("enum_value_id") is None]:
        if row.get("value_index") is not None:
            raise RuntimeError("enum_values INSERT always appends")
        counter = int(_v3_type_state().get("next_enum_value", 0))
        _v3_type_state()["next_enum_value"] = counter + 1
        row["_assigned_id"] = v3_stable_id("enum_value", "%s:%d" % (owner_id, counter))
        rows.append(row)
    enum_members = []
    metadata = _v3_type_state().setdefault("enum_metadata", {})
    records = []
    for row in rows:
        if not row.get("name"):
            raise RuntimeError("Enum value name must be non-empty")
        if row.get("comment") == "":
            raise RuntimeError("Enum comments cannot be empty; use NULL to clear")
        try:
            value = int(str(row["integer_value"]), 10)
        except (TypeError, ValueError):
            raise RuntimeError("integer_value must be canonical decimal TEXT")
        if value < -(1 << 63) or value > (1 << 64) - 1:
            raise RuntimeError("integer_value is outside the signed/u64 range")
        enum_members.append(bn.EnumerationMember(str(row["name"]), value))
        child_id = str(row.get("enum_value_id") or row["_assigned_id"])
        previous = metadata.get(child_id, {})
        metadata[child_id] = {
            "origin": str(previous.get("origin", row.get("origin") or "oms")),
            "confidence": int(row.get("confidence") if row.get("confidence") is not None else 255),
            "comment": row.get("comment"),
            "integer_value": str(value),
        }
        records.append({"id": child_id, "signature": "enum:%s" % row["name"]})
    builder = type_object.mutable_copy()
    builder.members = enum_members
    _v3_define_named_type(owner_id, str(owner_name), builder)
    _v3_type_state().setdefault("enum_value_records", {})[owner_id] = records
    _v3_save_type_state()


def _v3_apply_enum_diff(operation: str, before: list[dict[str, Any]], after: list[dict[str, Any]]) -> None:
    old_ids = {str(row["enum_value_id"]) for row in before if row.get("enum_value_id") is not None}
    new_ids = {str(row["enum_value_id"]) for row in after if row.get("enum_value_id") is not None}
    if operation == "insert":
        owners = {str(row["owner_type_id"]) for row in after if row.get("enum_value_id") is None}
    elif operation == "delete":
        removed = old_ids - new_ids
        owners = {str(row["owner_type_id"]) for row in before if str(row.get("enum_value_id")) in removed}
    else:
        old_by_id = {str(row["enum_value_id"]): row for row in before if row.get("enum_value_id") is not None}
        owners = {
            str(row["owner_type_id"]) for row in after
            if row.get("enum_value_id") is not None and old_by_id.get(str(row["enum_value_id"])) != row
        }
    for owner_id in owners:
        _v3_apply_enum_owner(operation, owner_id, before, after)


def v3_apply_type_diff(
    table: str, operation: str,
    before_rows: list[dict[str, Any]], after_rows: list[dict[str, Any]],
) -> None:
    if table == "types":
        _v3_apply_types_diff(operation, before_rows, after_rows)
    elif table == "type_members":
        _v3_apply_members_diff(operation, before_rows, after_rows)
    elif table == "enum_values":
        _v3_apply_enum_diff(operation, before_rows, after_rows)
    elif table == "function_type_parameters":
        raise RuntimeError("function_type_parameters is read-only; replace types.declaration")
    else:
        raise RuntimeError("Unsupported named-type mutation table '%s'" % table)


def _v3_exact_type_candidate(address: Any) -> tuple[str, Any]:
    if isinstance(address, bool):
        raise RuntimeError("Address cannot be boolean")
    try:
        resolved = int(str(address), 0) if isinstance(address, str) else int(address)
    except (TypeError, ValueError):
        raise RuntimeError("Address must be an integer or canonical hexadecimal TEXT")
    if resolved < 0 or resolved > (1 << 64) - 1:
        raise RuntimeError("Address is outside the unsigned 64-bit range")
    view = require_view()
    candidates = []
    function = view.get_function_at(resolved)
    if function is not None:
        candidates.append(("function", function, resolved))
    variable = view.get_data_var_at(resolved)
    if variable is not None:
        candidates.append(("data", variable, resolved))
    if not candidates:
        return "none", None
    if len(candidates) != 1:
        raise RuntimeError("Address resolves to multiple exact function/data rows")
    return candidates[0][0], candidates[0]


def _v3_type_at_scalar(address: Any):
    kind, candidate = _v3_exact_type_candidate(address)
    if kind == "none":
        return None
    return str(candidate[1].type)



def _v3_set_type_scalar(address: Any, declaration: Any) -> int:
    kind, candidate = _v3_exact_type_candidate(address)
    if kind == "none":
        raise RuntimeError("set_type address does not resolve to an exact function or data row")
    entity = candidate[1]
    resolved = candidate[2]
    view = require_view()
    expected = None
    if kind == "function":
        expected = v3_set_function_override(entity, declaration)
    else:
        identifier = v3_stable_id("data_item", v3_data_key(resolved))
        overrides = v3_oms_metadata.setdefault("data_overrides", {})
        if declaration is None:
            view.undefine_user_data_var(resolved)
            overrides.pop(identifier, None)
        else:
            parsed, parsed_name = view.parse_type_string(str(declaration))
            if str(parsed_name):
                raise RuntimeError("Data set_type requires a type without a variable declarator name")
            view.define_user_data_var(resolved, parsed)
            expected = str(parsed)
            overrides[identifier] = str(declaration)
    view.update_analysis_and_wait()
    read_kind, read_candidate = _v3_exact_type_candidate(resolved)
    if read_kind == "none" or read_candidate is None:
        raise RuntimeError("set_type semantic readback did not retain an exact typed row")
    read_entity = read_candidate[1]
    if expected is not None and str(read_entity.type) != expected:
        raise RuntimeError("set_type semantic readback does not match the applied type")
    if declaration is None and kind == "function" and v3_function_override(read_entity) is not None:
        raise RuntimeError("set_type semantic readback did not clear the function override")
    if kind == "data":
        identifier = v3_stable_id("data_item", v3_data_key(resolved))
        read_override = v3_oms_metadata.setdefault("data_overrides", {}).get(identifier)
        if declaration is None and read_override is not None:
            raise RuntimeError("set_type semantic readback did not clear the data override")
        if declaration is not None and read_override != str(declaration):
            raise RuntimeError("set_type semantic readback did not retain the data override")
    return 1


def _v3_upsert_named(name: str, type_object: Any) -> str:
    view = require_view()
    existing = view.get_type_by_name(name)
    if existing is not None:
        old_kind = _v3_named_type_kind(existing)
        new_kind = _v3_named_type_kind(type_object)
        if old_kind != new_kind:
            raise RuntimeError("Named type kind is immutable (%s, not %s)" % (old_kind, new_kind))
        type_id = str(view.get_type_id(name))
        _v3_define_named_type(type_id, name, type_object)
    else:
        type_id = v3_new_id("type")
        _v3_mark_oms_type(type_id)
        _v3_define_named_type(type_id, name, type_object)
    _v3_type_ordinal(type_id)
    return type_id


def _v3_parse_type_scalar(declaration: Any) -> str:
    name, type_object = _v3_parse_one_named(str(declaration))
    type_id = _v3_upsert_named(name, type_object)
    require_view().update_analysis_and_wait()
    read_name = _v3_type_name_by_id(type_id)
    if read_name is None or str(read_name) != name:
        raise RuntimeError("parse_type semantic readback failed")
    return type_id


def _v3_parse_types_scalar(declarations: Any) -> str:
    source = str(declarations)
    parsed = require_view().parse_types_from_string(source)
    if parsed.variables or parsed.functions:
        raise RuntimeError("parse_types accepts named type declarations only")
    named = [(str(name), type_object) for name, type_object in parsed.types.items()]
    names = [name for name, _ in named]
    if len(set(names)) != len(names):
        raise RuntimeError("parse_types rejects duplicate qualified names")
    if not named:
        raise RuntimeError("parse_types did not define any named types")
    result = []
    for name, type_object in named:
        result.append({
            "type_id": _v3_upsert_named(name, type_object),
            "qualified_name": name,
        })
    require_view().update_analysis_and_wait()
    for row in result:
        read_name = _v3_type_name_by_id(row["type_id"])
        if read_name is None or str(read_name) != row["qualified_name"]:
            raise RuntimeError("parse_types semantic readback failed for '%s'" % row["qualified_name"])
    return json.dumps(result, separators=(",", ":"), ensure_ascii=False)


def v3_register_type_functions(connection: sqlite3.Connection) -> None:
    connection.create_function("type_at", 1, _v3_type_at_scalar)
    connection.create_function("set_type", 2, _v3_set_type_scalar)
    connection.create_function("parse_type", 1, _v3_parse_type_scalar)
    connection.create_function("parse_types", 1, _v3_parse_types_scalar)


if __name__ == "__main__":
    main()
