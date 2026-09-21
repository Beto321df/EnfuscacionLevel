# Z3 Evolution — 3.2-dev.5

Z3 treats obfuscation as compilation plus representation diversification, not as text replacement.

## What changed

- Register VM is the default backend.
- Stack-to-register lowering handles closures, upvalues, loops, generic iterators, calls and multi-value windows.
- Superinstructions remain available for hot semantic patterns.
- Register IDs can be permuted independently per function while preserving contiguous ABI windows.
- ISA aliases provide alternate instruction identities inside the same semantic family.
- Branch targets receive a per-function 32-bit affine encoding after verification.
- String and integer literals can be structurally diversified before constant-pool shuffling.
- Constants are stored in a protected raw pool and decoded lazily on first access by the generated loader.
- Function metadata includes local slots, register counts, upvalues, iterator layouts and branch-target keys.
- Fresh protection profiles are generated for normal builds.

## Strength presets

`balanced`, `strong` and `maximum` now configure multiple layers rather than one polymorphism knob:

- AST/IR polymorphism intensity
- literal diversification intensity
- register permutation probability
- ISA alias probability
- maximum string shard count

The preset remains a performance/size trade-off, not a security score.

## Comparison with studied projects

Prometheus contributes the strongest lesson on the frontend/AST pass architecture. AzureVM contributes a useful prototype-oriented format/encoder/runtime separation. Clyde demonstrates why a real register compiler and explicit VM instruction model matter.

Nyvex combines those architectural ideas with its own ZIR, generated register runtime, per-function register diversification, encoded control targets and lazy constant pool. This is a capability comparison, not a claim that one project is universally superior.

## Validation

`npm test` runs the core regression suite, advanced register/format tests, architecture checks and generator audits. The advanced suite forces the new layers on, restores opcode IDs in the reference VM and checks closures, loops, arithmetic, branch targets, randomized builds and lazy constant generation.

The environment used during development may not contain the actual `luaparse` package or a Lua interpreter. In that situation, generated-loader syntax checks can use a temporary local stub, while semantic tests still execute against Nyvex's reference VM.

- Comparison + conditional-branch patterns are fused after register lowering when a pure MOVE chain connects the comparison result to the branch.

## 3.2-dev.5 hardening/consistency changes

- Register-backend opcode permutations are now encoded per function and consumed by the generated decoder. The semantic opcode seen by the register dispatcher is therefore the original semantic ID after the physical opcode label is decoded.
- The actual protection profile used by `format3` is stored in the emission metadata and reused by the encoder, so metadata and bytes describe the same build profile.
- A CFG/liveness analysis pass records block/edge/instruction counts and maximum live register pressure before and after emission. This is diagnostic metadata and is not used as a security score.
- External `luaparse` loading is lazy so internal VM/format modules can be tested without requiring the optional parser package at module-load time.

### 3.2-dev.5 operand-schema layer

The protected format stores a small per-function table of operand permutations and an encoded schema selector for each instruction. The stack and register generated decoders both reconstruct canonical operands from that selector before dispatch.

## 3.2-dev.5 stability fixes

- Post-packing analysis decodes per-function physical opcode IDs before interpreting register operands.
- Post-packing analysis decodes per-function branch targets when target encoding is active.
- Register validation checks every register operand against the function register file and understands packed method-expand tail registers.
- `CALL_METHOD_EXPAND` preserves its packed argument-count field while still participating in register permutation.
- Added randomized stability coverage for the combined compiler, VM, format and generator pipeline.
