# Nyvex Z3 — arquitectura 3.2-dev.5

## Pipeline

```text
Luau / Luau-compatible source
        ↓
Z3 lexer + parser
        ↓
AST
        ↓
ZIR v2 semantic IR
        ↓
constant diversification
        ↓
superinstructions
        ↓
CFG relocation / control-flow permutation
        ↓
function + constant permutation
        ↓
register lowering
        ↓
per-function register permutation
        ↓
per-function operand layout tables + per-instruction schema selectors
        ↓
ISA aliases / polymorphism
        ↓
semantic verification
        ↓
per-function encoded branch targets
        ↓
opcode ID permutation
        ↓
protected format 3
        ↓
visual transport
        ↓
generated register VM runtime
```

## Frontend / IR

Nyvex keeps a real compiler-style frontend. Source names are reduced to numeric local slots; closures carry explicit upvalue descriptors and generic iterators carry numeric iterator layouts. The ZIR is kept stable enough that the backend can change without rewriting the parser.

## Register backend

The default backend is a register VM. The registerizer lowers stack semantics into explicit registers, inserts edge moves for CFG merges, preserves contiguous call/return argument windows and reuses temporary registers where lifetimes permit.

The register ISA has canonical operations plus alternate aliases. A build may substitute canonical instructions with aliases, while the runtime routes both spellings to the same semantic handler.

Register-file polymorphism permutes movable temporary registers per function. Registers required by contiguous call, return and pack windows are kept stable so the ABI remains valid.

## Control-flow representation

Blocks are physically relocated before bytecode emission. After the register backend is verified, branch destinations are transformed with a per-function affine mapping in 32-bit space. The generated runtime decodes the destination immediately before changing `pc`.

This means decoded instruction streams do not contain the final small integer program counters used by the dispatcher.

## Constants

The constant pipeline has two independent layers:

1. **Diversification** — selected strings are split into shards joined at runtime and selected integer literals are reconstructed from arithmetic expressions.
2. **Protected storage** — the format stores encoded bytes. The generated loader keeps encoded constants in a raw pool and materializes each constant on first access, caching the decoded value.

The lazy pool is a runtime optimization as well as a representation boundary; it is not a claim that an executing runtime can never expose its own data.

## Per-build diversification

Every normal encode gets fresh protection parameters. Function order, constant order, opcode IDs, register mappings, branch-target keys and ISA alias choices are independent randomized layers.

## Verification

The verifier runs before semantic opcode permutation and before branch-target encoding. It checks register/local/constant/upvalue bounds, call windows, iterator layouts and control-flow target ranges. This catches malformed IR before it reaches the final binary format.

## Stack backend

The original stack backend remains available for compatibility. The generated register backend is the default for 3.2-dev.5.

## Security model

These techniques raise the cost of static recovery and change the shape of the intermediate representation on each build. They are not cryptographic secrecy, and a runtime under an analyst's control can always be instrumented. The project should therefore treat compatibility, correctness and measured analysis resistance as separate engineering goals.

## Fused comparison branches

Comparison operations immediately followed by a pure register-copy chain and a conditional branch can be lowered to a single virtual instruction. The fusion preserves the original comparison opcode and branch destination while removing intermediate register traffic.

## Per-instruction operand schemas

Each function carries multiple valid four-field operand permutations. Every instruction selects one through an encoded per-PC selector, and the generated VM reconstructs canonical operands before dispatch. This makes operand-field layout a property of the individual instruction stream rather than a single global convention.

## Stability boundary

Physical opcode IDs and encoded control-flow targets are normalized before diagnostics. The final container may use per-function opcode tables and per-instruction operand schemas, while analysis remains semantic.
