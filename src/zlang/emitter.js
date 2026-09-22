const crypto = require('crypto');
const { OPS, OPCODE_COUNT } = require('./compiler3');
const { validateIR } = require('./ir');
const { makeProtectionProfile } = require('./protection');
const { REG_OPS, REG_OPCODE_COUNT, registerizeProgram, fuseRegisterComparisons, encodeRegisterControlTargets, permuteRegisterFile, diversifyRegisterIsa, validateRegisterProgram } = require('./registerVm');
const { verifyProgram } = require('./verifier');
const { diversifyConstants } = require('./diversify');
const { analyzeProgram } = require('./analysis');

function randomInt(maxExclusive) {
    return crypto.randomInt(0, maxExclusive);
}

function shuffle(values) {
    const out = values.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function cloneProgram(program) {
    return JSON.parse(JSON.stringify(program));
}

function isConditional(op) {
    return op === OPS.JUMP_IF_FALSE ||
        op === OPS.JUMP_IF_TRUE ||
        op === OPS.FOR_NUM_PREP ||
        op === OPS.FOR_NUM_NEXT ||
        op === OPS.ITER_PREP;
}

function isTerminal(op) {
    return op === OPS.RETURN || op === OPS.RETURN_MULTI || op === OPS.RETURN_VOID || op === OPS.RETURN_MIXED ||
        op === OPS.JUMP || op === OPS.BREAK || op === OPS.ITER_NEXT;
}

function explicitTargets(ins) {
    switch (ins[0]) {
        case OPS.JUMP:
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
        case OPS.BREAK:
            return [ins[1]];
        case OPS.FOR_NUM_PREP:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_PREP:
            return [ins[4]];
        case OPS.ITER_NEXT:
            return [ins[2], ins[4]];
        default:
            return [];
    }
}

function targetFields(ins) {
    switch (ins[0]) {
        case OPS.JUMP:
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
        case OPS.BREAK:
            return [1];
        case OPS.FOR_NUM_PREP:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_PREP:
            return [4];
        case OPS.ITER_NEXT:
            return [2, 4];
        default:
            return [];
    }
}

function shuffleControlFlow(code) {
    if (!Array.isArray(code) || code.length < 6) return code.map(ins => ins.slice());

    const leaders = new Set([1]);
    for (let pc = 1; pc <= code.length; pc += 1) {
        const ins = code[pc - 1];
        for (const target of explicitTargets(ins)) {
            if (target >= 1 && target <= code.length) leaders.add(target);
        }
        if (isConditional(ins[0]) && pc + 1 <= code.length) leaders.add(pc + 1);
        if (isTerminal(ins[0]) && pc + 1 <= code.length &&
            (ins[0] === OPS.RETURN || ins[0] === OPS.RETURN_MULTI || ins[0] === OPS.RETURN_VOID || ins[0] === OPS.RETURN_MIXED)) {
            leaders.add(pc + 1);
        }
    }

    const starts = [...leaders].sort((a, b) => a - b);
    const blocks = [];
    for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] - 1 : code.length;
        blocks.push({ start, end, code: code.slice(start - 1, end) });
    }
    if (blocks.length < 3) return code.map(ins => ins.slice());

    const ordered = [blocks[0], ...shuffle(blocks.slice(1))];
    const extraJump = new Map();
    for (let index = 0; index < ordered.length; index += 1) {
        const block = ordered[index];
        const last = code[block.end - 1];
        const natural = block.end + 1;
        const nextPhysical = index + 1 < ordered.length ? ordered[index + 1].start : code.length + 1;
        const needs = natural <= code.length &&
            (isConditional(last[0]) || !isTerminal(last[0])) &&
            nextPhysical !== natural;
        extraJump.set(index, needs ? 1 : 0);
    }

    const newPc = new Map();
    let pc = 1;
    for (let index = 0; index < ordered.length; index += 1) {
        const block = ordered[index];
        for (let old = block.start; old <= block.end; old += 1) newPc.set(old, pc++);
        pc += extraJump.get(index) || 0;
    }
    newPc.set(code.length + 1, pc);

    const output = [];
    for (let index = 0; index < ordered.length; index += 1) {
        const block = ordered[index];
        for (const sourceIns of block.code) {
            const ins = sourceIns.slice();
            for (const field of targetFields(ins)) {
                ins[field] = newPc.get(ins[field]) ?? ins[field];
            }
            output.push(ins);
        }

        const lastOld = block.end;
        const last = code[lastOld - 1];
        const natural = lastOld + 1;
        const nextPhysical = index + 1 < ordered.length ? ordered[index + 1].start : code.length + 1;
        const needsFallthroughJump =
            natural <= code.length &&
            (isConditional(last[0]) || !isTerminal(last[0])) &&
            nextPhysical !== natural;

        if (needsFallthroughJump) output.push([OPS.JUMP, newPc.get(natural), 0, 0, 0]);
    }

    return output;
}

function shuffleFunctions(program) {
    if (program.functions.length <= 2) return;
    const tail = shuffle(program.functions.slice(1));
    const oldFunctions = program.functions.slice();
    const reordered = [oldFunctions[0], ...tail];
    const idMap = new Map();
    oldFunctions.forEach((fn, oldId) => idMap.set(oldId, reordered.indexOf(fn)));

    for (const fn of reordered) {
        for (const ins of fn.code) {
            if (ins[0] === OPS.MAKE_FUNCTION) ins[1] = idMap.get(ins[1]) ?? ins[1];
        }
    }

    program.functions = reordered;
    program.root = idMap.get(program.root ?? 0) ?? 0;
    return idMap;
}

const CONSTANT_OPERANDS = new Map([
    [OPS.PUSH_CONST, 1],
    [OPS.LOAD_VAR, 1],
    [OPS.STORE_VAR, 1],
    [OPS.LOAD_GLOBAL, 1],
    [OPS.STORE_GLOBAL, 1],
    [OPS.GET_MEMBER, 1],
    [OPS.SET_MEMBER, 1],
    [OPS.CALL_METHOD, 1],
    [OPS.CALL_METHOD_MULTI, 1],
    [OPS.FUSED_LOCAL_CONST_BIN_STORE, 2],
    [OPS.FUSED_GLOBAL_CALL, 1]
]);

function makeOpcodePermutation(count) {
    const ids = Array.from({ length: count }, (_, index) => index + 1);
    const permuted = shuffle(ids);
    const encode = {};
    const decode = [0];
    for (let i = 0; i < ids.length; i += 1) {
        encode[ids[i]] = permuted[i];
        decode[permuted[i]] = ids[i];
    }
    return { encode, decode };
}

function shuffleOpcodes(program) {
    const registerBackend = program.backend === 'register';
    const count = registerBackend ? REG_OPCODE_COUNT : OPCODE_COUNT;
    const global = makeOpcodePermutation(count);
    const functionPermutations = [];

    for (let fnIndex = 0; fnIndex < program.functions.length; fnIndex += 1) {
        const fn = program.functions[fnIndex];
        const permutation = registerBackend ? makeOpcodePermutation(count) : global;
        for (const ins of fn.code) ins[0] = permutation.encode[ins[0]] ?? ins[0];
        fn.opcodeDecode = permutation.decode.slice();
        fn.opcodeEncode = permutation.encode;
        functionPermutations.push(permutation);
    }

    program.metadata = {
        ...(program.metadata || {}),
        opcodeEncoding: {
            backend: registerBackend ? 'register' : 'stack',
            count,
            perFunction: registerBackend,
            functionCount: functionPermutations.length
        }
    };

    // Keep the legacy global map for callers/tests while exposing the actual
    // per-function mappings used by the encoded container.
    return { ...global.encode };
}

function samePermutation(a, b) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
}

function shuffleOperandLayouts(program) {
    const identity = [1, 2, 3, 4];
    const maxLayouts = 8;
    for (const fn of program.functions) {
        const desired = Math.max(1, Math.min(maxLayouts, fn.code.length || 1));
        const layouts = [];
        while (layouts.length < desired) {
            const candidate = shuffle(identity);
            if (!layouts.some(existing => samePermutation(existing, candidate))) layouts.push(candidate);
        }
        if (fn.code.length > 1 && layouts.length > 1 && layouts.every((layout, index) => index === 0 || samePermutation(layout, identity))) {
            const candidate = shuffle(identity);
            if (!samePermutation(candidate, layouts[0])) layouts[1] = candidate;
        }
        fn.operandLayouts = layouts.map(layout => layout.slice());
        fn.operandSchema = fn.code.map(() => crypto.randomInt(0, fn.operandLayouts.length));
        // Keep the first layout as a compatibility hint for tooling that only
        // understands the earlier single-per-function field.
        fn.operandPermutation = fn.operandLayouts[0].slice();
    }
    program.metadata = {
        ...(program.metadata || {}),
        operandLayout: {
            enabled: true,
            width: 4,
            perFunction: program.functions.map(fn => fn.operandPermutation.slice()),
            perFunctionTables: program.functions.map(fn => fn.operandLayouts.map(layout => layout.slice())),
            perInstruction: true,
            maxLayouts
        }
    };
    return program;
}

function shuffleConstants(program) {
    const count = program.constants.length;
    if (count <= 1) return;

    const order = shuffle([...Array(count).keys()]);
    const oldToNew = new Map();
    order.forEach((oldIndex, newIndex) => oldToNew.set(oldIndex, newIndex));
    const oldConstants = program.constants.slice();
    program.constants = order.map(oldIndex => oldConstants[oldIndex]);

    for (const fn of program.functions) {
        // ZIR v2 params are local-slot indexes, not constant-pool indexes.
        // They must survive constant shuffling unchanged.
        for (const ins of fn.code) {
            const field = CONSTANT_OPERANDS.get(ins[0]);
            if (field !== undefined) ins[field] = oldToNew.get(ins[field]) ?? ins[field];
        }
    }
}

function annotateMetadata(program, opcodeMap, backend, protection) {
    program.metadata = {
        ...(program.metadata || {}),
        emission: {
            ...(program.metadata && program.metadata.emission ? program.metadata.emission : {}),
            localsOpaque: true,
            constantsShuffled: true,
            functionsShuffled: true,
            controlFlowPermuted: true,
            stringLayer: 2,
            constantLayer: 2,
            operandLayer: 1,
            opcodeLayer: 2,
            integrityLayer: 2,
            vmDispatch: 'indirect-routing',
            backend,
            opcodeCount: backend === 'register' ? REG_OPCODE_COUNT : OPCODE_COUNT,
            opcodePermutation: opcodeMap,
            opcodePerFunction: program.functions.map(fn => fn.opcodeDecode || null),
            operandLayout: program.metadata.operandLayout,
            protection
        }
    };
}

function fuseSuperinstructions(program) {
    validateIR(program);
    for (const fn of program.functions) {
        const code = fn.code;
        const targeted = new Set();
        for (const ins of code) for (const target of explicitTargets(ins)) targeted.add(target);

        const next = [];
        const oldToNew = new Map();
        for (let i = 0; i < code.length;) {
            const oldPc = i + 1;
            const startPc = next.length + 1;
            let consumed = 1;
            let fused = null;

            const safeRange = length => {
                for (let p = oldPc + 1; p < oldPc + length; p += 1) if (targeted.has(p)) return false;
                return true;
            };

            if (i + 3 < code.length && safeRange(4) &&
                code[i][0] === OPS.LOAD_LOCAL &&
                code[i + 1][0] === OPS.PUSH_CONST &&
                code[i + 2][0] === OPS.BIN &&
                code[i + 3][0] === OPS.STORE_LOCAL) {
                fused = [OPS.FUSED_LOCAL_CONST_BIN_STORE, code[i][1], code[i + 1][1], code[i + 2][1], code[i + 3][1]];
                consumed = 4;
            } else if (i + 3 < code.length && safeRange(4) &&
                code[i][0] === OPS.LOAD_LOCAL &&
                code[i + 1][0] === OPS.LOAD_LOCAL &&
                code[i + 2][0] === OPS.BIN &&
                code[i + 3][0] === OPS.STORE_LOCAL) {
                fused = [OPS.FUSED_LOCAL_LOCAL_BIN_STORE, code[i][1], code[i + 1][1], code[i + 2][1], code[i + 3][1]];
                consumed = 4;
            } else if (i + 1 < code.length && safeRange(2) &&
                code[i][0] === OPS.LOAD_GLOBAL &&
                (code[i + 1][0] === OPS.CALL || code[i + 1][0] === OPS.CALL_MULTI) &&
                code[i + 1][1] === 0) {
                fused = [OPS.FUSED_GLOBAL_CALL, code[i][1], 0, code[i + 1][0] === OPS.CALL_MULTI ? 1 : 0, 0];
                consumed = 2;
            }

            if (fused) {
                next.push(fused);
                for (let j = 0; j < consumed; j += 1) oldToNew.set(i + j + 1, startPc);
                i += consumed;
            } else {
                next.push(code[i].slice());
                oldToNew.set(oldPc, startPc);
                i += 1;
            }
        }
        oldToNew.set(code.length + 1, next.length + 1);

        // Fusion changes physical PCs, so every surviving branch target has to
        // be translated through the same old->new map before CFG shuffling.
        for (let oldPc = 1; oldPc <= code.length; oldPc += 1) {
            const oldIns = code[oldPc - 1];
            const newPc = oldToNew.get(oldPc);
            const newIns = next[newPc - 1];
            if (!newIns || newIns[0] === OPS.FUSED_LOCAL_CONST_BIN_STORE ||
                newIns[0] === OPS.FUSED_LOCAL_LOCAL_BIN_STORE || newIns[0] === OPS.FUSED_GLOBAL_CALL) continue;
            for (const field of targetFields(oldIns)) newIns[field] = oldToNew.get(oldIns[field]) ?? oldIns[field];
        }
        fn.code = next;
    }
    program.metadata = { ...(program.metadata || {}), superinstructions: ['local-const-bin-store', 'local-local-bin-store', 'global-call0'] };
    return validateIR(program);
}

function buildEmissionPlan(program, options = {}) {
    validateIR(program);
    const requestedBackend = options.backend === undefined ? 'register' : String(options.backend).toLowerCase();
    if (requestedBackend !== 'register' && requestedBackend !== 'stack') throw new Error(`Z3 backend desconocido: ${requestedBackend}`);
    const out = cloneProgram(program);

    // Constant diversification expands selected literals before control-flow
    // relocation, so branch targets are translated once by the same CFG pass.
    diversifyConstants(out, options.diversify || {});

    // Superinstructions are formed after diversification so common expanded
    // arithmetic patterns can still collapse into fused operations.
    fuseSuperinstructions(out);

    // This remains one integrated CFG transformation: blocks are relocated
    // once, then explicit jumps repair the new physical ordering.
    for (const fn of out.functions) fn.code = shuffleControlFlow(fn.code);
    shuffleFunctions(out);
    shuffleConstants(out);

    if (requestedBackend === 'register') {
        const lowered = registerizeProgram(out);
        out.backend = lowered.backend;
        out.functions = lowered.functions;
        out.metadata = lowered.metadata;
        fuseRegisterComparisons(out);
        permuteRegisterFile(out, options.registers || {});
        diversifyRegisterIsa(out, options.isa || {});
        validateRegisterProgram(out);
        verifyProgram(out, { backend: 'register' });
        // Capture semantic analysis before physical branch-target encoding.
        out.metadata = { ...(out.metadata || {}), analysisBeforePacking: analyzeProgram(out) };
        // Only after semantic verification, hide branch destinations as per-function tokens.
        encodeRegisterControlTargets(out, options.controlTargets || {});
    }    } else {
        out.backend = 'stack';
        out.metadata = { ...(out.metadata || {}), analysisBeforePacking: analyzeProgram(out) };
    }

    const opcodeMap = shuffleOpcodes(out);
    shuffleOperandLayouts(out);
    const protection = makeProtectionProfile(out.functions.length);
    annotateMetadata(out, opcodeMap, requestedBackend, protection);
    const beforeAnalysis = out.metadata.analysisBeforePacking || null;
    out.metadata.analysis = analyzeProgram(out);
    out.metadata.analysis.beforePacking = beforeAnalysis;
    // The stored program intentionally contains the permuted opcode IDs; semantic
    // verification therefore happens immediately before opcode permutation above.
    // Keep only structural metadata checks here.
    if (!out.metadata?.emission?.opcodePermutation) throw new Error('Z3 emission: opcode metadata missing.');
    return out;
}

module.exports = {
    buildEmissionPlan,
    shuffleControlFlow,
    shuffleConstants,
    shuffleFunctions,
    shuffleOpcodes,
    shuffleOperandLayouts,
    fuseSuperinstructions,
    fuseRegisterComparisons,
    diversifyConstants,
    diversifyRegisterIsa,
    permuteRegisterFile,
    encodeRegisterControlTargets
};
