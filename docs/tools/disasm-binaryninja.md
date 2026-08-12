# Binary Ninja SQL

> Compact reference for the `disasm` Binary Ninja backend. The live catalogs are authoritative; use Python only when SQL cannot express the operation.

## Quick start

```json
{
  "action": "open",
  "backend": "binaryninja",
  "file": "./sample.bin",
  "output_db": "./sample.bndb",
  "timeout": 300
}
```

Omit `output_db` for a temporary `.bndb`; pass an existing `.bndb` as `file` to reopen it. Keep the returned target ID for `query`, `execute`, `save`, and `close`. Configure `disasm.binaryNinja.installDir` / `disasm.binaryNinja.python`, or pass `binaryninja_dir` / `python`.

Examples below are SQL strings. Replace `:function_id`, `:type_id`, and similar placeholders with quoted values returned by earlier queries; `disasm` does not interpolate them.

## Discover before using

```sql
SELECT table_name, allowed_operations, identity_columns,
       required_bounds, description
FROM sql_tables ORDER BY table_name;

SELECT column_name, nullable, insertable, updatable,
       enum_name, canonicalization, null_behavior, description
FROM sql_columns
WHERE table_name='functions'
ORDER BY column_index;

SELECT function_name, mutating, argument_contract,
       return_contract, description
FROM sql_functions ORDER BY function_name;
```

`sql_enum_values`, `sqlite_master`, and PRAGMA are also available. Catalogs describe the running OMS version and supersede this guide.

## Core rules

- Join and mutate with opaque `_id` columns. IDs survive rename, relayout, reanalysis, and `.bndb` save/reopen; addresses are locations, not identities.
- Addresses are fixed-width lowercase `0x` TEXT, so lexical order is unsigned order. Normalize input with `addr(x)`; extents are `[start_address,end_address)`.
- Expensive tables require a direct owner equality or finite range. `LIMIT` is not a bound; unsupported `OR`/subquery bounds error. Hard budgets error instead of truncating.
- Each property has one writable owner: names → `symbols`; function prototypes → `functions.signature_override`; applied types → `data_items.type_override_declaration`; local overrides → `function_variables`; comments → their target table.
- Effective values (`functions.name/signature`, `data_items.name/type_declaration`, variable `name/type_declaration`) are read-only projections.
- `NULL` clears only documented overrides/comments. Empty strings are not clear operations.
- Use `RETURNING`: INSERT/UPDATE returns canonical post-analysis rows; DELETE returns pre-delete rows and verifies their IDs disappeared.

## Relations and bounds

| Area            | Relations                                                                           |
| --------------- | ----------------------------------------------------------------------------------- |
| Program         | `program_metadata`, `segments`                                                      |
| Symbols/data    | `symbols`, `functions`, `function_parameters`, `data_items`, `strings`              |
| Types           | `types`, `type_members`, `enum_values`, `function_type_parameters`                  |
| Disassembly     | `memory_items`, `instructions`, `instruction_operands`, `basic_blocks`, `cfg_edges` |
| Analysis        | `il_instructions`, `pseudocode`, `function_variables`                               |
| References      | `address_references`, `callers`, `callees`, `string_references`, `type_references`  |
| Comments/search | `address_comments`, `all_comments`, `byte_search`                                   |

Required expensive-query shapes:

- `memory_items`: `function_id`, `segment_id`, or both address endpoints.
- `instructions`: `function_id` or both address endpoints.
- `instruction_operands`: `instruction_id`, `function_id`, or both instruction-address endpoints.
- `basic_blocks`, `cfg_edges`, `il_instructions`, `function_parameters`, `function_variables`: `function_id`.
- `pseudocode`: `function_id` or exact address.
- `byte_search`: pattern plus both endpoints.

## Read recipes

Resolve a function once, then use its ID:

```sql
SELECT function_id,start_address,end_address,primary_symbol_id,
       name,signature,signature_origin,is_import,is_thunk
FROM functions
WHERE name LIKE '%packet%'
ORDER BY start_address;
```

Disassembly, operands, and CFG:

```sql
SELECT instruction_id,basic_block_id,address,mnemonic,text,bytes,
       branch_kind,is_call,is_jump,is_return
FROM instructions
WHERE function_id=':function_id'
ORDER BY address;

SELECT instruction_address,operand_index,kind,text,integer_value,
       target_address,register_name,width_bits
FROM instruction_operands
WHERE function_id=':function_id'
ORDER BY instruction_address,operand_index;

SELECT source_block_id,target_block_id,kind,is_back_edge
FROM cfg_edges
WHERE function_id=':function_id';
```

`il_instructions.il_level` supports `lifted`, `llil`, `llil_ssa`, `mlil`, `mlil_ssa`, `mapped_mlil`, `mapped_mlil_ssa`, `hlil`, and `hlil_ssa`:

```sql
SELECT il_level,instruction_index,expression_index,
       parent_expression_index,address,operation,type_declaration,text
FROM il_instructions
WHERE function_id=':function_id' AND il_level='hlil_ssa'
ORDER BY instruction_index,expression_index;
```

Unavailable levels are skipped independently. Correlated pseudocode:

```sql
SELECT line_index,row_kind,address,text,comment_id,
       placement,is_orphan,valid_placements
FROM pseudocode
WHERE function_id=':function_id'
ORDER BY line_index;
```

References (`kind`: `call|jump|flow|read|write|address|text|type|member|unknown`):

```sql
SELECT source_address,target_address,kind,backend_kind,
       target_function_id,operand_index,type_id,member_id
FROM address_references
WHERE source_function_id=':function_id'
ORDER BY source_address;

SELECT caller_function_id,call_address
FROM callers
WHERE callee_function_id=':function_id';

SELECT s.value,r.source_address,r.source_function_id
FROM strings s JOIN string_references r ON r.string_id=s.string_id
WHERE s.value LIKE '%password%';
```

Unresolved targets remain `NULL`; the model never invents callees.

## Types and writes

Inspect types and members:

```sql
SELECT type_id,ordinal,qualified_name,kind,size_bytes,alignment_bytes,
       member_count,layout_mode,origin,declaration
FROM types WHERE qualified_name LIKE '%Packet%';

SELECT member_id,member_index,name,offset_bits,width_bits,
       type_declaration,referenced_type_id,access,scope,
       is_bitfield,is_base,is_virtual_base,is_vtable,comment
FROM type_members
WHERE owner_type_id=':type_id'
ORDER BY member_index;
```

Create a type by shape or declaration:

```sql
INSERT INTO types(qualified_name,kind,layout_mode,size_bytes)
VALUES('PacketHeader','struct','explicit',16)
RETURNING type_id,ordinal,declaration;

INSERT INTO type_members(owner_type_id,name,offset_bits,
                         type_declaration,comment)
VALUES(':type_id','length',16,'uint16_t','Payload bytes')
RETURNING member_id,member_index,width_bits;
```

Layout modes: `automatic` computes ordinary layout, `packed` removes ordinary padding, and `explicit` preserves size/bit positions. Explicit inserts require `offset_bits`; `width_bits` creates bitfields. Automatic/packed inserts omit both. Reorder with `member_index`; IDs remain stable.

`types.qualified_name` owns rename. Replacing `types.declaration` must define exactly that name and preserve `kind`; full declaration replacement cannot share a script with child edits. Applied/referenced types cannot be deleted.

Enums store lossless decimal TEXT; compare with `integer_compare`:

```sql
INSERT INTO enum_values(owner_type_id,name,integer_value,comment)
VALUES(':enum_id','ALL','18446744073709551615','All bits')
RETURNING *;
```

`function_type_parameters` exposes named function-type returns/parameters. Replace the owning `types.declaration` to change them.

Rename and override a concrete function:

```sql
UPDATE symbols SET name='parse_header'
WHERE symbol_id=':primary_symbol_id'
RETURNING symbol_id,name,qualified_name;

UPDATE functions
SET signature_override='int32_t parse_header(uint8_t *buf, size_t len)'
WHERE function_id=':function_id'
RETURNING function_id,name,signature,parameter_count;
```

A declarator name must match the primary symbol. Set `signature_override=NULL` to restore analysis. Apply/clear a data type similarly:

```sql
UPDATE data_items
SET type_override_declaration='struct PacketHeader'
WHERE data_item_id=':data_id'
RETURNING data_item_id,type_declaration,type_origin,size_bytes;
```

Locals own name/type overrides; arguments/results change through the function signature:

```sql
UPDATE function_variables
SET name_override='cursor',type_override_declaration='uint8_t *',
    comment='Current decode position'
WHERE variable_id=':variable_id' AND role='local'
RETURNING variable_id,name,type_declaration,comment;
```

## Comments

Function summaries use `functions.comment`. Address comments use `address_comments`; UPDATE changes text only, so retargeting is DELETE + INSERT:

```sql
INSERT INTO address_comments(scope,function_id,address,is_repeatable,text)
VALUES('function',':function_id',addr('0x401020'),0,'Bounds checked')
RETURNING comment_id,address,text;
```

Decompiler comments are writable comment rows in `pseudocode`; code rows are read-only:

```sql
INSERT INTO pseudocode(function_id,address,placement,text)
VALUES(':function_id',addr('0x401187'),'before','Helper returns score')
RETURNING comment_id,address,placement,text;
```

Use a code row's `valid_placements`. Search every comment domain through read-only `all_comments`.

## Scalars and search

- Address/value: `addr`, `address_add`, `integer_compare`.
- Memory: `read_u8/u16/u32/u64`, signed variants, `read_f32/f64`, `read_ptr`, `read_bytes`, `read_cstr`, `read_rel32`. Optional endianness is `little|big`; byte/string reads cap at 4096 bytes.
- Analysis: `decompile(address)` requires exactly one containing function.
- Types: `type_at(address)` uses an exact function/data start; `set_type(address, declaration_or_null)` updates that exact row.
- Parsing: `parse_type(declaration)` upserts one named type; `parse_types(declarations)` atomically upserts several and returns JSON for `json_each`.

```sql
SELECT address
FROM byte_search
WHERE pattern='48 8b ?? ?? ff'
  AND start_address=addr('0x400000')
  AND end_address=addr('0x410000')
  AND alignment=1
ORDER BY address;
```

Patterns use byte pairs and `??`; alignment must be a positive power of two. `invalidate_decompile(address)` is non-persistent and valid only as a standalone SELECT.

## Transactions

One submitted script is one SQLite transaction and one Binary Ninja undo action. Explicit transaction control is forbidden; only the final statement may return rows. SQL, backend, refresh, or canonical-readback failure rolls back the entire script. Read-only assignments error even if unchanged; zero matched rows is ordinary zero rows.

Mutating scalars use the same validation/readback but cannot be mixed with canonical DML in one script.

## Python escape hatch

`execute` runs unrestricted Python against the same live view. Its scope includes `bn`, `binaryninja`, `bv`, `current_view`, `address`, `function`, `functions_containing`, read helpers, and `result`:

```json
{
  "action": "execute",
  "backend": "binaryninja",
  "target": "binaryninja-...",
  "code": "result={'entry':hex(bv.entry_point),'functions':len(list(bv.functions))}"
}
```

Calls are stateless by default. Add `stateful:true` and a stable `session_id` to retain Python objects; `reset` with that ID clears the namespace. Binary Ninja does not use `takeover`/`release`. SQL and Python see the same live `BinaryView`; call `save` to persist changes.
