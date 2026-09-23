const crypto = require('crypto');
const { OPS } = require('./compiler3');

// ZRVM: register-oriented backend for the existing semantic ZIR.
// It keeps locals/upvalues separate from temporaries and uses explicit
// argument windows for calls, making the generated runtime independent from
// the source-language evaluation stack.
const REG_OPS = Object.freeze({
    NOP: 1,
    LOAD_CONST: 2,
    LOAD_LOCAL: 3,
    STORE_LOCAL: 4,
    LOAD_GLOBAL: 5,
    STORE_GLOBAL: 6,
    GET_MEMBER: 7,
    SET_MEMBER: 8,
    GET_INDEX: 9,
    SET_INDEX: 10,
    MAKE_FUNCTION: 11,
    BIN: 12,
    UNARY: 13,
    NEW_TABLE: 14,
    GET_VARARG: 15,
    MOVE: 16,
    CALL: 17,
    CALL_MULTI: 18,
    CALL_METHOD: 19,
    CALL_METHOD_MULTI: 20,
    RETURN: 21,
    RETURN_MULTI: 22,
    PACK_MULTI: 23,
    JUMP: 24,
    JUMP_IF_FALSE: 25,
    JUMP_IF_TRUE: 26,
    FOR_NUM_PREP: 27,
    FOR_NUM_CHECK: 28,
    FOR_NUM_NEXT: 29,
    ITER_PREP: 30,
    ITER_NEXT: 31,
    BREAK: 32,
    FUSED_LOCAL_CONST_BIN_STORE: 33,
    FUSED_LOCAL_LOCAL_BIN_STORE: 34,
    FUSED_GLOBAL_CALL: 35,
    LOAD_UPVALUE: 36,
    STORE_UPVALUE: 37,
    FUSED_BIN_JUMP_FALSE: 38,
    FUSED_BIN_JUMP_TRUE: 39,
    NOP_ALT: 40,
    LOAD_CONST_ALT: 41,
    LOAD_LOCAL_ALT: 42,
    STORE_LOCAL_ALT: 43,
    MOVE_ALT: 44,
    BIN_ALT: 45,
    JUMP_ALT: 46,
    RETURN_ALT: 47,
    FUSED_BIN_JUMP_FALSE_ALT: 48,
    FUSED_BIN_JUMP_TRUE_ALT: 49,
    RETURN_VOID: 50,
    UNPACK_MULTI: 51,
    RETURN_MIXED: 52,
    SETLIST_MULTI: 53,
    GET_VARARG_MULTI: 54,
    CALL_EXPAND: 55,
    CALL_METHOD_EXPAND: 56
});

const REG_OPCODE_COUNT = Object.keys(REG_OPS).length;
const REG_ALIAS_BASE = Object.freeze({
    NOP_ALT: 'NOP',
    LOAD_CONST_ALT: 'LOAD_CONST',
    LOAD_LOCAL_ALT: 'LOAD_LOCAL',
    STORE_LOCAL_ALT: 'STORE_LOCAL',
    MOVE_ALT: 'MOVE',
    BIN_ALT: 'BIN',
    JUMP_ALT: 'JUMP',
    RETURN_ALT: 'RETURN',
    FUSED_BIN_JUMP_FALSE_ALT: 'FUSED_BIN_JUMP_FALSE',
    FUSED_BIN_JUMP_TRUE_ALT: 'FUSED_BIN_JUMP_TRUE'
});
function hit(probability) { return probability > 0 && crypto.randomInt(0, 1000000) < Math.floor(Math.min(1, probability) * 1000000); }

const TERMINAL = new Set([OPS.RETURN, OPS.RETURN_MULTI, OPS.RETURN_VOID, OPS.RETURN_MIXED, OPS.JUMP, OPS.BREAK, OPS.ITER_NEXT]);

function successors(code, pc) {
    const ins = code[pc - 1];
    if (!ins) return [];
    const next = pc < code.length ? pc + 1 : null;
    switch (ins[0]) {
        case OPS.JUMP:
        case OPS.BREAK:
            return [ins[1]];
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
            return [ins[1], ...(next ? [next] : [])];
        case OPS.FOR_NUM_PREP:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_PREP:
            return [ins[4], ...(next ? [next] : [])];
        case OPS.ITER_NEXT:
            return [ins[2], ins[4]];
        case OPS.RETURN:
        case OPS.RETURN_MULTI:
        case OPS.RETURN_VOID:
        case OPS.RETURN_MIXED:
            return [];
        default:
            return next ? [next] : [];
    }
}

function stackDelta(ins) {
    const op = ins[0];
    const a = ins[1];
    switch (op) {
        case OPS.PUSH_CONST:
        case OPS.LOAD_GLOBAL:
        case OPS.LOAD_LOCAL:
        case OPS.LOAD_UPVALUE:
        case OPS.GET_VARARG:
        case OPS.GET_VARARG_MULTI:
        case OPS.NEW_TABLE:
        case OPS.MAKE_FUNCTION:
            return 1;
        case OPS.STORE_GLOBAL:
        case OPS.STORE_LOCAL:
        case OPS.STORE_UPVALUE:
        case OPS.POP:
            return -1;
        case OPS.GET_MEMBER:
            return 0;
        case OPS.SET_MEMBER:
            return -2;
        case OPS.GET_INDEX:
            return -1;
        case OPS.SET_INDEX:
            return -3;
        case OPS.CALL:
        case OPS.CALL_MULTI:
            return -a;
        case OPS.CALL_EXPAND:
            return -a - 1;
        case OPS.CALL_METHOD:
        case OPS.CALL_METHOD_MULTI:
            return -ins[2];
        case OPS.CALL_METHOD_EXPAND:
            return -ins[2] - 1;
        case OPS.BIN:
            return -1;
        case OPS.UNARY:
        case OPS.DUP:
        case OPS.NOP:
        case OPS.JUMP:
        case OPS.BREAK:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_NEXT:
            return op === OPS.DUP ? 1 : 0;
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
            return -1;
        case OPS.PACK_MULTI:
            return 1 - a;
        case OPS.UNPACK_MULTI:
            return a - 1;
        case OPS.SETLIST_MULTI:
            return -2;
        case OPS.FOR_NUM_PREP:
            return -3;
        case OPS.ITER_PREP:
            return -1;
        case OPS.FUSED_LOCAL_CONST_BIN_STORE:
        case OPS.FUSED_LOCAL_LOCAL_BIN_STORE:
            return 0;
        case OPS.FUSED_GLOBAL_CALL:
            return 1;
        case OPS.LOAD_VAR:
            return 1;
        case OPS.STORE_VAR:
            return -1;
        case OPS.RETURN:
        case OPS.RETURN_MULTI:
        case OPS.RETURN_VOID:
        case OPS.RETURN_MIXED:
            return 0;
        default:
            throw new Error(`Z registerizer: opcode ${op} desconocido.`);
    }
}

function buildBlocks(code) {
    const leaders = new Set([1]);
    for (let pc = 1; pc <= code.length; pc += 1) {
        for (const target of successors(code, pc)) if (target >= 1 && target <= code.length) leaders.add(target);
        if (TERMINAL.has(code[pc - 1][0]) || [OPS.JUMP_IF_FALSE, OPS.JUMP_IF_TRUE, OPS.FOR_NUM_PREP, OPS.FOR_NUM_NEXT, OPS.ITER_PREP].includes(code[pc - 1][0])) {
            if (pc < code.length) leaders.add(pc + 1);
        }
    }
    const starts = [...leaders].sort((a, b) => a - b);
    const blocks = [];
    const byStart = new Map();
    for (let i = 0; i < starts.length; i += 1) {
        const start = starts[i];
        const end = i + 1 < starts.length ? starts[i + 1] - 1 : code.length;
        const block = { id: i, start, end, succ: [] };
        blocks.push(block); byStart.set(start, block);
    }
    for (const block of blocks) block.succ = successors(code, block.end).map(pc => byStart.get(pc)).filter(Boolean);
    return { blocks, byStart };
}

function reachableBlocks(blocks, byStart) {
    const reachable = new Set();
    const queue = [1];

    while (queue.length) {
        const start = queue.shift();
        if (reachable.has(start)) continue;

        const block = byStart.get(start);
        if (!block) continue;

        reachable.add(start);
        for (const next of block.succ || []) {
            if (!reachable.has(next.start)) queue.push(next.start);
        }
    }

    return blocks.filter(block => reachable.has(block.start));
}

function analyzeHeights(code, blocks, byStart) {
    const heights = new Map();

    // Only analyze blocks reachable from the function entry. The source
    // compiler can intentionally leave dead blocks behind after return/break/
    // continue or unconditional jumps. Treating those blocks as executable
    // predecessors creates false stack merges such as 0 != 2.
    const propagate = root => {
        if (heights.has(root)) return;
        heights.set(root, 0);
        const queue = [root];

        while (queue.length) {
            const start = queue.shift();
            const block = byStart.get(start);
            if (!block) continue;

            let height = heights.get(start);
            for (let pc = block.start; pc <= block.end; pc += 1) {
                height += stackDelta(code[pc - 1]);
                if (height < 0) {
                    throw new Error(`Z registerizer: stack underflow en pc ${pc}.`);
                }
            }

            for (const target of successors(code, block.end)) {
                // A target outside the block map (for example code.length + 1)
                // is a valid function exit, not a stack-merge location.
                if (!byStart.has(target)) continue;

                const old = heights.get(target);
                if (old === undefined) {
                    heights.set(target, height);
                    queue.push(target);
                } else if (old !== height) {
                    const opName = op => Object.keys(OPS).find(key => OPS[key] === (code[op - 1]?.[0]));
                    const around = pc => {
                        const from = Math.max(1, pc - 2);
                        const to = Math.min(code.length, pc + 2);
                        return code.slice(from - 1, to).map((ins, idx) => `${from + idx}:${opName(from + idx)}:${ins.slice(1).join(',')}`).join('|');
                    };
                    throw new Error(`Z registerizer: merge de stack incompatible en pc ${target} (${old} != ${height}); predecessor ${block.start}-${block.end}; targetOps=${around(target)}; predOps=${around(block.end)}.`);
                }
            }
        }
    };

    propagate(1);
    return heights;
}

function analyzeStackHeights(code) {
    const { blocks: allBlocks, byStart } = buildBlocks(code || []);
    const blocks = reachableBlocks(allBlocks, byStart);
    return analyzeHeights(code || [], blocks, byStart);
}

function makeEntryRegisters(blocks, heights) {
    let next = 0;
    const entries = new Map();
    for (const block of blocks) {
        const regs = [];
        for (let i = 0; i < (heights.get(block.start) || 0); i += 1) regs.push(next++);
        entries.set(block.start, regs);
    }
    return { entries, next };
}

function lowerFunction(fn) {
    const code = fn.code || [];
    if (!code.length) return { ...fn, backend: 'register', registerCount: 0, code: [] };
    if (code.some(ins => ins[0] === OPS.LOAD_VAR || ins[0] === OPS.STORE_VAR)) {
        throw new Error('Z registerizer: ZIR legacy LOAD_VAR/STORE_VAR requiere recompilación.');
    }

    const { blocks: allBlocks, byStart } = buildBlocks(code);
    const blocks = reachableBlocks(allBlocks, byStart);
    const heights = analyzeHeights(code, blocks, byStart);

    // Compact registerization: one transient register per virtual stack slot.
    // Equal stack depth always maps to the same register, so CFG edges need
    // no MOVE instructions and call windows are naturally contiguous.
    let maxRegister = 0;
    const out = [];
    const blockPc = new Map();
    const patches = [];

    const emit = (op, a = 0, b = 0, c = 0, d = 0) => {
        out.push([op, a >>> 0, b >>> 0, c >>> 0, d >>> 0]);
        return out.length - 1;
    };
    const patch = (index, targetStart, field = 1) => patches.push({ index, targetStart, field });
    const noteHeight = stack => {
        if (stack.length > maxRegister) maxRegister = stack.length;
    };
    const makeStack = height => {
        const stack = new Array(height);
        for (let i = 0; i < height; i += 1) stack[i] = i;
        noteHeight(stack);
        return stack;
    };
    const push = (stack, reg) => {
        stack.push(reg);
        noteHeight(stack);
    };
    const pop = stack => {
        if (!stack.length) throw new Error('Z registerizer: stack underflow.');
        return stack.pop();
    };

    for (const block of blocks) {
        blockPc.set(block.start, out.length + 1);
        const stack = makeStack(heights.get(block.start) || 0);

        for (let pc = block.start; pc <= block.end; pc += 1) {
            const ins = code[pc - 1];
            const op = ins[0];
            const a = ins[1], b = ins[2], c = ins[3], d = ins[4];

            switch (op) {
                case OPS.PUSH_CONST: {
                    const dst = stack.length;
                    emit(REG_OPS.LOAD_CONST, dst, a);
                    push(stack, dst);
                    break;
                }
                case OPS.LOAD_LOCAL: {
                    const dst = stack.length;
                    emit(REG_OPS.LOAD_LOCAL, dst, a);
                    push(stack, dst);
                    break;
                }
                case OPS.STORE_LOCAL: {
                    const src = pop(stack);
                    emit(REG_OPS.STORE_LOCAL, a, src);
                    break;
                }
                case OPS.LOAD_UPVALUE: {
                    const dst = stack.length;
                    emit(REG_OPS.LOAD_UPVALUE, dst, a);
                    push(stack, dst);
                    break;
                }
                case OPS.STORE_UPVALUE: {
                    const src = pop(stack);
                    emit(REG_OPS.STORE_UPVALUE, a, src);
                    break;
                }
                case OPS.LOAD_GLOBAL: {
                    const dst = stack.length;
                    emit(REG_OPS.LOAD_GLOBAL, dst, a);
                    push(stack, dst);
                    break;
                }
                case OPS.STORE_GLOBAL: {
                    const src = pop(stack);
                    emit(REG_OPS.STORE_GLOBAL, a, src);
                    break;
                }
                case OPS.GET_MEMBER: {
                    const obj = pop(stack);
                    const dst = stack.length;
                    emit(REG_OPS.GET_MEMBER, dst, obj, a);
                    push(stack, dst);
                    break;
                }
                case OPS.SET_MEMBER: {
                    const n = stack.length;
                    if (n < 2) throw new Error('Z registerizer: stack underflow.');
                    const obj = stack[n - 2];
                    const value = stack[n - 1];
                    stack.length = n - 2;
                    emit(REG_OPS.SET_MEMBER, obj, a, value);
                    break;
                }
                case OPS.GET_INDEX: {
                    const key = pop(stack);
                    const obj = pop(stack);
                    const dst = stack.length;
                    emit(REG_OPS.GET_INDEX, dst, obj, key);
                    push(stack, dst);
                    break;
                }
                case OPS.SET_INDEX: {
                    const n = stack.length;
                    if (n < 3) throw new Error('Z registerizer: stack underflow.');
                    const obj = stack[n - 3];
                    const key = stack[n - 2];
                    const value = stack[n - 1];
                    stack.length = n - 3;
                    emit(REG_OPS.SET_INDEX, obj, key, value);
                    break;
                }
                case OPS.BIN: {
                    const right = pop(stack);
                    const left = pop(stack);
                    const dst = stack.length;
                    emit(REG_OPS.BIN, dst, left, right, a);
                    push(stack, dst);
                    break;
                }
                case OPS.UNARY: {
                    const src = pop(stack);
                    const dst = stack.length;
                    emit(REG_OPS.UNARY, dst, src, a);
                    push(stack, dst);
                    break;
                }
                case OPS.NEW_TABLE: {
                    const dst = stack.length;
                    emit(REG_OPS.NEW_TABLE, dst);
                    push(stack, dst);
                    break;
                }
                case OPS.GET_VARARG: {
                    const dst = stack.length;
                    emit(REG_OPS.GET_VARARG, dst);
                    push(stack, dst);
                    break;
                }
                case OPS.GET_VARARG_MULTI: {
                    const dst = stack.length;
                    emit(REG_OPS.GET_VARARG_MULTI, dst);
                    push(stack, dst);
                    break;
                }
                case OPS.MAKE_FUNCTION: {
                    const dst = stack.length;
                    emit(REG_OPS.MAKE_FUNCTION, dst, a);
                    push(stack, dst);
                    break;
                }
                case OPS.CALL:
                case OPS.CALL_MULTI: {
                    const argc = a >>> 0;
                    const base = stack.length - argc - 1;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    emit(op === OPS.CALL ? REG_OPS.CALL : REG_OPS.CALL_MULTI, base, base, argc);
                    stack.length = base + 1;
                    noteHeight(stack);
                    break;
                }
                case OPS.CALL_METHOD:
                case OPS.CALL_METHOD_MULTI: {
                    const argc = b >>> 0;
                    const base = stack.length - argc - 1;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    emit(op === OPS.CALL_METHOD ? REG_OPS.CALL_METHOD : REG_OPS.CALL_METHOD_MULTI, base, base, a, argc);
                    stack.length = base + 1;
                    noteHeight(stack);
                    break;
                }
                case OPS.CALL_EXPAND: {
                    const fixedArgs = a >>> 0;
                    const base = stack.length - fixedArgs - 2;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    const tail = base + fixedArgs + 1;
                    emit(REG_OPS.CALL_EXPAND, base, base, fixedArgs, tail);
                    stack.length = base + 1;
                    noteHeight(stack);
                    break;
                }
                case OPS.CALL_METHOD_EXPAND: {
                    const fixedArgs = b >>> 0;
                    const base = stack.length - fixedArgs - 2;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    const tail = base + fixedArgs + 1;
                    if (tail > 65535 || fixedArgs > 65535) throw new Error('Z registerizer: method expand window too large.');
                    const packed = ((tail & 0xFFFF) << 16) | (fixedArgs & 0xFFFF);
                    emit(REG_OPS.CALL_METHOD_EXPAND, base, base, a, packed >>> 0);
                    stack.length = base + 1;
                    noteHeight(stack);
                    break;
                }
                case OPS.DUP: {
                    if (!stack.length) throw new Error('Z registerizer: DUP vacío.');
                    const src = stack[stack.length - 1];
                    const dst = stack.length;
                    emit(REG_OPS.MOVE, dst, src);
                    push(stack, dst);
                    break;
                }
                case OPS.POP:
                    pop(stack);
                    break;
                case OPS.PACK_MULTI: {
                    const count = a >>> 0;
                    const base = stack.length - count;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    emit(REG_OPS.PACK_MULTI, base, base, count);
                    stack.length = base + 1;
                    noteHeight(stack);
                    break;
                }
                case OPS.UNPACK_MULTI: {
                    const src = pop(stack);
                    const count = a >>> 0;
                    emit(REG_OPS.UNPACK_MULTI, src, src, count);
                    for (let i = 0; i < count; i += 1) push(stack, src + i);
                    break;
                }
                case OPS.SETLIST_MULTI: {
                    const value = pop(stack);
                    const obj = pop(stack);
                    emit(REG_OPS.SETLIST_MULTI, obj, value, a);
                    break;
                }
                case OPS.RETURN_VOID:
                    emit(REG_OPS.RETURN_VOID);
                    break;
                case OPS.RETURN: {
                    const src = pop(stack);
                    emit(REG_OPS.RETURN, src);
                    break;
                }
                case OPS.RETURN_MULTI: {
                    const count = a >>> 0;
                    const base = stack.length - count;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    emit(REG_OPS.RETURN_MULTI, base, count);
                    break;
                }
                case OPS.RETURN_MIXED: {
                    const tail = pop(stack);
                    const count = a >>> 0;
                    const base = stack.length - count;
                    if (base < 0) throw new Error('Z registerizer: stack underflow.');
                    emit(REG_OPS.RETURN_MIXED, base, count, tail);
                    break;
                }
                case OPS.JUMP: {
                    const idx = emit(REG_OPS.JUMP, 0);
                    patch(idx, a);
                    break;
                }
                case OPS.JUMP_IF_FALSE:
                case OPS.JUMP_IF_TRUE: {
                    const cond = pop(stack);
                    const idx = emit(op === OPS.JUMP_IF_FALSE ? REG_OPS.JUMP_IF_FALSE : REG_OPS.JUMP_IF_TRUE, cond, 0);
                    patch(idx, a, 2);
                    break;
                }
                case OPS.FOR_NUM_PREP: {
                    const step = pop(stack);
                    const finish = pop(stack);
                    const start = pop(stack);
                    emit(REG_OPS.FOR_NUM_PREP, a, start, finish, step);
                    const idx = emit(REG_OPS.FOR_NUM_CHECK, 0);
                    patch(idx, d);
                    break;
                }
                case OPS.FOR_NUM_NEXT: {
                    const idx = emit(REG_OPS.FOR_NUM_NEXT, 0);
                    patch(idx, d);
                    break;
                }
                case OPS.ITER_PREP: {
                    const iterator = pop(stack);
                    const idx = emit(REG_OPS.ITER_PREP, iterator, a, b, 0);
                    patch(idx, d, 4);
                    break;
                }
                case OPS.ITER_NEXT: {
                    const idx = emit(REG_OPS.ITER_NEXT, 0, 0);
                    patch(idx, b, 1);
                    patch(idx, d, 2);
                    break;
                }
                case OPS.BREAK: {
                    const idx = emit(REG_OPS.BREAK, 0);
                    patch(idx, a);
                    break;
                }
                case OPS.NOP:
                    emit(REG_OPS.NOP);
                    break;
                case OPS.FUSED_LOCAL_CONST_BIN_STORE:
                    emit(REG_OPS.FUSED_LOCAL_CONST_BIN_STORE, a, b, c, d);
                    break;
                case OPS.FUSED_LOCAL_LOCAL_BIN_STORE:
                    emit(REG_OPS.FUSED_LOCAL_LOCAL_BIN_STORE, a, b, c, d);
                    break;
                case OPS.FUSED_GLOBAL_CALL: {
                    const dst = stack.length;
                    emit(REG_OPS.FUSED_GLOBAL_CALL, dst, a, c);
                    push(stack, dst);
                    break;
                }
                default:
                    throw new Error(`Z registerizer: opcode ${op} no soportado en pc ${pc}.`);
            }
        }

        const last = code[block.end - 1];
        const natural = block.end < code.length ? block.end + 1 : null;
        if (natural && ![OPS.JUMP, OPS.BREAK, OPS.RETURN, OPS.RETURN_MULTI, OPS.RETURN_VOID, OPS.RETURN_MIXED, OPS.ITER_NEXT].includes(last[0])) {
            const expected = heights.get(natural);
            if (expected !== undefined && stack.length !== expected) {
                throw new Error(`Z registerizer: edge stack mismatch hacia ${natural}.`);
            }
        }
    }

    for (const item of patches) {
        const target = blockPc.get(item.targetStart);
        if (target === undefined) throw new Error(`Z registerizer: target ${item.targetStart} no encontrado.`);
        out[item.index][item.field] = target >>> 0;
    }

    return { ...fn, backend: 'register', registerCount: maxRegister, code: out };
}

function registerizeProgram(program) {
    if (!program || !Array.isArray(program.functions)) throw new TypeError('Z registerizer: programa inválido.');
    return {
        ...program,
        backend: 'register',
        functions: program.functions.map(lowerFunction),
        metadata: { ...(program.metadata || {}), backend: 'register', registerVm: true }
    };
}


const REGISTER_FIELDS = Object.freeze({
    LOAD_CONST: [1], LOAD_LOCAL: [1], STORE_LOCAL: [2],
    LOAD_GLOBAL: [1], STORE_GLOBAL: [2], GET_MEMBER: [1, 2], SET_MEMBER: [1, 3],
    GET_INDEX: [1, 2, 3], SET_INDEX: [1, 2, 3], MAKE_FUNCTION: [1],
    BIN: [1, 2, 3], UNARY: [1, 2], NEW_TABLE: [1], GET_VARARG: [1], GET_VARARG_MULTI: [1], MOVE: [1, 2],
    CALL: [1, 2], CALL_MULTI: [1, 2], CALL_EXPAND: [1, 2, 4], CALL_METHOD: [1, 2], CALL_METHOD_MULTI: [1, 2], CALL_METHOD_EXPAND: [1, 2],
    RETURN: [1], RETURN_MULTI: [1], RETURN_MIXED: [1, 3], UNPACK_MULTI: [1, 2], SETLIST_MULTI: [1, 2], PACK_MULTI: [1, 2],
    JUMP_IF_FALSE: [1], JUMP_IF_TRUE: [1], FOR_NUM_PREP: [2, 3, 4], ITER_PREP: [1],
    FUSED_LOCAL_CONST_BIN_STORE: [], FUSED_LOCAL_LOCAL_BIN_STORE: [], FUSED_GLOBAL_CALL: [1],
    FUSED_BIN_JUMP_FALSE: [1, 2], FUSED_BIN_JUMP_TRUE: [1, 2],
    LOAD_UPVALUE: [1], STORE_UPVALUE: [2]
});


const PC_MUL = 65537;
const PC_INV = 4294901761;
const PC_MASK = 0xFFFFFFFF;


const COMPARISON_BINS = new Set([8, 9, 10, 11, 12, 13]);

function fuseRegisterComparisons(program) {
    if (!program || program.backend !== 'register') throw new TypeError('ZRVM fusion: programa inválido.');
    let fused = 0;
    const branchTargetFields = base => {
        if (base === 'JUMP' || base === 'BREAK') return [1];
        if (base === 'JUMP_IF_FALSE' || base === 'JUMP_IF_TRUE') return [2];
        if (base === 'FOR_NUM_CHECK' || base === 'FOR_NUM_NEXT') return [1];
        if (base === 'ITER_PREP') return [4];
        if (base === 'ITER_NEXT') return [1, 2];
        if (base === 'FUSED_BIN_JUMP_FALSE' || base === 'FUSED_BIN_JUMP_TRUE') return [4];
        return [];
    };
    for (const fn of program.functions) {
        const code = fn.code || [];
        let functionFused = 0;
        const targeted = new Set();
        for (const ins of code) {
            const name = Object.keys(REG_OPS).find(k => REG_OPS[k] === ins?.[0]);
            const base = REG_ALIAS_BASE[name] || name;
            const fields =
                base === 'JUMP' || base === 'BREAK' ? [1] :
                base === 'JUMP_IF_FALSE' || base === 'JUMP_IF_TRUE' ? [2] :
                base === 'FOR_NUM_CHECK' || base === 'FOR_NUM_NEXT' ? [1] :
                base === 'ITER_PREP' ? [4] :
                base === 'ITER_NEXT' ? [1, 2] :
                base === 'FUSED_BIN_JUMP_FALSE' || base === 'FUSED_BIN_JUMP_TRUE' ? [4] : [];
            for (const field of fields) if (Number.isInteger(ins[field])) targeted.add(ins[field]);
        }
        const next = [];
        const oldToNew = new Map();
        for (let i = 0; i < code.length; ) {
            const first = code[i];
            const firstName = Object.keys(REG_OPS).find(k => REG_OPS[k] === first?.[0]);
            const firstBase = REG_ALIAS_BASE[firstName] || firstName;
            let moveEnd = i;
            let valueReg = first?.[1];
            if (firstBase === 'BIN' && COMPARISON_BINS.has(first?.[4])) {
                // The lowering pass may introduce a chain of register moves before
                // the conditional branch. These moves are pure register copies; the
                // branch is the only consumer in this contiguous window, so the whole
                // compare+copy chain can be represented by one fused semantic op.
                while (moveEnd + 1 < code.length) {
                    const m = code[moveEnd + 1];
                    const mn = Object.keys(REG_OPS).find(k => REG_OPS[k] === m?.[0]);
                    const mb = REG_ALIAS_BASE[mn] || mn;
                    if (mb === 'NOP') { moveEnd += 1; continue; }
                    if (mb !== 'MOVE' || m[2] !== valueReg) break;
                    valueReg = m[1];
                    moveEnd += 1;
                }
                const branch = code[moveEnd + 1];
                const bn = Object.keys(REG_OPS).find(k => REG_OPS[k] === branch?.[0]);
                const bb = REG_ALIAS_BASE[bn] || bn;
                const branchPc = moveEnd + 2;
                let safeFusion = true;
                for (let pc = i + 1; pc <= branchPc; pc += 1) {
                    if (targeted.has(pc)) {
                        safeFusion = false;
                        break;
                    }
                }
                if ((bb === 'JUMP_IF_FALSE' || bb === 'JUMP_IF_TRUE') &&
                    safeFusion &&
                    branch[1] === valueReg &&
                    Number.isInteger(branch[2]) &&
                    branch[2] >= 1 &&
                    branch[2] <= code.length) {
                    const newPc = next.length + 1;
                    for (let oldPc = i + 1; oldPc <= branchPc; oldPc += 1) oldToNew.set(oldPc, newPc);
                    next.push([
                        bb === 'JUMP_IF_FALSE' ? REG_OPS.FUSED_BIN_JUMP_FALSE : REG_OPS.FUSED_BIN_JUMP_TRUE,
                        first[2], first[3], first[4], branch[2]
                    ]);
                    i = moveEnd + 2;
                    functionFused += 1;
                    continue;
                }
            }

            const newPc = next.length + 1;
            oldToNew.set(i + 1, newPc);
            next.push(first.slice());
            i += 1;
        }
        oldToNew.set(code.length + 1, next.length + 1);

        // Once every old instruction has a destination in the new stream, repair
        // all control-flow operands in one pass. Never keep an old target when
        // the target PC was removed by fusion.
        let valid = true;
        for (const ins of next) {
            const name = Object.keys(REG_OPS).find(k => REG_OPS[k] === ins[0]);
            const base = REG_ALIAS_BASE[name] || name;
            for (const field of branchTargetFields(base)) {
                const oldTarget = ins[field];
                const mapped = oldToNew.get(oldTarget);
                if (mapped === undefined) {
                    valid = false;
                    break;
                }
                ins[field] = mapped;
            }
            if (!valid) break;
        }

        if (valid) {
            for (const ins of next) {
                const name = Object.keys(REG_OPS).find(k => REG_OPS[k] === ins[0]);
                const base = REG_ALIAS_BASE[name] || name;
                for (const field of branchTargetFields(base)) {
                    const target = ins[field];
                    if (!Number.isInteger(target) || target < 1 || target > next.length + 1) {
                        valid = false;
                        break;
                    }
                }
                if (!valid) break;
            }
        }
        if (!valid) {
            // Fusion is an optimization only. Never let a bad relocation make
            // the whole register pipeline fail; keep the original function.
            fn.code = code.map(ins => ins.slice());
            continue;
        }
        fused += functionFused;
        fn.code = next;
    }
    program.metadata = {
        ...(program.metadata || {}),
        registerFusions: { comparisonJumps: fused }
    };
    return program;
}
function encodeRegisterControlTargets(program, options = {}) {
    if (!program || program.backend !== 'register') throw new TypeError('ZRVM control targets: programa inválido.');
    if (program.metadata?.controlTargetEncoding?.enabled && options.force !== true) return program;
    const randomAdd = () => crypto.randomInt(1, 0x100000000) >>> 0;
    let functionsChanged = 0;
    for (const fn of program.functions) {
        const add = options.deterministic && Number.isInteger(options.seed)
            ? ((Number(options.seed) + (functionsChanged + 1) * 0x9E3779B1) >>> 0)
            : randomAdd();
        for (const ins of fn.code) {
            const base = REG_ALIAS_BASE[Object.keys(REG_OPS).find(name => REG_OPS[name] === ins[0])] ||
                Object.keys(REG_OPS).find(name => REG_OPS[name] === ins[0]);
            if (!base) continue;
            const fields =
                base === 'JUMP' || base === 'BREAK' ? [1] :
                base === 'JUMP_IF_FALSE' || base === 'JUMP_IF_TRUE' ? [2] :
                base === 'FOR_NUM_CHECK' || base === 'FOR_NUM_NEXT' ? [1] :
                base === 'ITER_PREP' ? [4] :
                base === 'ITER_NEXT' ? [1, 2] :
                base === 'FUSED_BIN_JUMP_FALSE' || base === 'FUSED_BIN_JUMP_TRUE' ? [4] : [];
            for (const field of fields) {
                const pc = ins[field] >>> 0;
                // Affine map in Z/2^32Z; 65537 is odd and its modular inverse is fixed.
                ins[field] = ((pc * PC_MUL + add) >>> 0);
            }
        }
        fn.pcTargetAdd = add >>> 0;
        fn.pcTargetEncoded = true;
        functionsChanged += 1;
    }
    program.metadata = {
        ...(program.metadata || {}),
        controlTargetEncoding: {
            enabled: true,
            functions: functionsChanged,
            multiplier: PC_MUL,
            inverse: PC_INV
        }
    };
    return program;
}

function permuteRegisterFile(program, options = {}) {
    if (!program || program.backend !== 'register') throw new TypeError('ZRVM registers: programa inválido.');
    const probability = options.chance === undefined ? 1 : Math.max(0, Math.min(1, Number(options.chance)));
    let functionsChanged = 0;
    const mappings = [];
    for (const fn of program.functions) {
        const count = Number(fn.registerCount) || 0;
        if (count < 2 || probability <= 0 || !hit(probability)) {
            mappings.push(null);
            continue;
        }

        // Call/return/pack windows depend on contiguous register IDs. Keep those
        // registers stable and permute the remaining temporaries independently.
        const protectedRegs = new Set();
        const protectRange = (base, size) => {
            for (let i = 0; i < size; i += 1) if (base + i >= 0 && base + i < count) protectedRegs.add(base + i);
        };
        for (const ins of fn.code) {
            const rawOp = ins[0];
            const semanticOp = Array.isArray(fn.opcodeDecode) ? (fn.opcodeDecode[rawOp] ?? rawOp) : rawOp;
            const name = Object.keys(REG_OPS).find(key => REG_OPS[key] === semanticOp);
            const base = REG_ALIAS_BASE[name] || name;
            switch (base) {
                case 'CALL': case 'CALL_MULTI':
                    protectedRegs.add(ins[1]); protectRange(ins[2], ins[3] + 1); break;
                case 'CALL_EXPAND':
                    protectedRegs.add(ins[1]); protectRange(ins[2], ins[3] + 1); protectedRegs.add(ins[4]); break;
                case 'CALL_METHOD': case 'CALL_METHOD_MULTI':
                    protectedRegs.add(ins[1]); protectRange(ins[2], ins[4] + 1); break;
                case 'CALL_METHOD_EXPAND': {
                    protectedRegs.add(ins[1]);
                    protectRange(ins[2], (ins[4] & 0xFFFF) + 1);
                    protectedRegs.add((Math.floor(ins[4] / 65536)) & 0xFFFF);
                    break;
                }
                case 'RETURN_MULTI': protectRange(ins[1], ins[2]); break;
                case 'RETURN_MIXED': protectRange(ins[1], ins[2]); protectedRegs.add(ins[3]); break;
                case 'UNPACK_MULTI': protectedRegs.add(ins[2]); protectRange(ins[1], ins[3]); break;
                case 'SETLIST_MULTI': protectedRegs.add(ins[1]); protectedRegs.add(ins[2]); break;
                case 'PACK_MULTI': protectedRegs.add(ins[1]); protectRange(ins[2], ins[3]); break;
                default: break;
            }
        }
        const movable = Array.from({ length: count }, (_, i) => i).filter(i => !protectedRegs.has(i));
        if (movable.length < 2) {
            mappings.push({ count, changed: false, protected: protectedRegs.size });
            continue;
        }
        const shuffled = movable.slice();
        for (let i = shuffled.length - 1; i > 0; i -= 1) {
            const j = crypto.randomInt(0, i + 1);
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        if (shuffled.every((v, i) => v === movable[i])) [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
        const inverse = new Map();
        for (let i = 0; i < movable.length; i += 1) inverse.set(movable[i], shuffled[i]);

        for (const ins of fn.code) {
            const canonicalName = Object.keys(REG_OPS).find(key => REG_OPS[key] === ins[0]);
            if (!canonicalName) continue;
            const baseName = REG_ALIAS_BASE[canonicalName] || canonicalName;
            const fields = REGISTER_FIELDS[baseName] || [];
            for (const field of fields) {
                if (inverse.has(ins[field])) ins[field] = inverse.get(ins[field]);
            }
            if (baseName === 'CALL_METHOD_EXPAND') {
                const packed = ins[4] >>> 0;
                const tailReg = (packed >>> 16) & 0xFFFF;
                if (inverse.has(tailReg)) {
                    ins[4] = (((inverse.get(tailReg) & 0xFFFF) << 16) | (packed & 0xFFFF)) >>> 0;
                }
            }
        }
        mappings.push({ count, changed: true, movable: movable.length, protected: protectedRegs.size });
        functionsChanged += 1;
    }
    program.metadata = {
        ...(program.metadata || {}),
        registerPolymorphism: {
            enabled: functionsChanged > 0,
            functionsChanged,
            chance: probability,
            mappings
        }
    };
    return program;
}

function diversifyRegisterIsa(program, options = {}) {
    if (!program || program.backend !== 'register') throw new TypeError('ZRVM ISA: programa inválido.');
    const probability = options.aliasChance === undefined ? 0.34 : Number(options.aliasChance);
    const aliases = Object.entries(REG_ALIAS_BASE).map(([alias, base]) => [REG_OPS[alias], REG_OPS[base]]);
    if (!aliases.length || probability <= 0) return program;
    const byBase = new Map(aliases.map(([aliasId, baseId]) => [baseId, aliasId]));
    let changed = 0;
    for (const fn of program.functions) {
        for (const ins of fn.code) {
            const aliasId = byBase.get(ins[0]);
            if (aliasId && hit(probability)) {
                ins[0] = aliasId;
                changed += 1;
            }
        }
    }
    program.metadata = {
        ...(program.metadata || {}),
        isaPolymorphism: { aliases: Object.keys(REG_ALIAS_BASE), substituted: changed, aliasChance: probability }
    };
    return program;
}

function validateRegisterProgram(program) {
    if (!program || program.backend !== 'register' || !Array.isArray(program.functions)) throw new TypeError('ZRVM programa inválido.');
    const registerMax = 1_000_000;
    for (let i = 0; i < program.functions.length; i += 1) {
        const fn = program.functions[i];
        if (!Number.isInteger(fn.registerCount) || fn.registerCount < 0 || fn.registerCount > registerMax) throw new Error(`ZRVM registerCount inválido en función ${i}.`);
        if (!Array.isArray(fn.params) || !Array.isArray(fn.upvalues) || !Array.isArray(fn.iteratorLayouts)) throw new Error(`ZRVM metadata inválida en función ${i}.`);
        for (const slot of fn.params) if (!Number.isInteger(slot) || slot < 0) throw new Error(`ZRVM parámetro inválido en función ${i}.`);
        for (const ref of fn.upvalues) if (!ref || (ref.kind !== 'local' && ref.kind !== 'upvalue') || !Number.isInteger(ref.index) || ref.index < 0) throw new Error(`ZRVM upvalue inválido en función ${i}.`);
        for (const ins of fn.code) {
            if (!Array.isArray(ins) || ins.length !== 5 || !Number.isInteger(ins[0]) || ins[0] < 1 || ins[0] > REG_OPCODE_COUNT) throw new Error(`ZRVM instrucción inválida en función ${i}.`);
            if (ins.slice(1).some(v => !Number.isInteger(v) || v < 0)) throw new Error(`ZRVM operando inválido en función ${i}.`);
            const rawOp = ins[0];
            const semanticOp = Array.isArray(fn.opcodeDecode) ? (fn.opcodeDecode[rawOp] ?? rawOp) : rawOp;
            const name = Object.keys(REG_OPS).find(key => REG_OPS[key] === semanticOp);
            const base = REG_ALIAS_BASE[name] || name;
            const fields = REGISTER_FIELDS[base] || [];
            for (const field of fields) {
                if (ins[field] >= fn.registerCount) {
                    throw new Error(`ZRVM registro ${ins[field]} fuera de rango en función ${i} (pc/campo ${field}, opcode ${name}, raw ${rawOp}, registerCount ${fn.registerCount}).`);
                }
            }
            if (base === 'CALL_METHOD_EXPAND') {
                const tailReg = (ins[4] >>> 16) & 0xFFFF;
                if (tailReg >= fn.registerCount) {
                    throw new Error(`ZRVM registro tail ${tailReg} fuera de rango en función ${i} (opcode ${name}, raw ${rawOp}, registerCount ${fn.registerCount}).`);
                }
            }
        }
    }
    return program;
}

module.exports = { REG_OPS, REG_OPCODE_COUNT, REG_ALIAS_BASE, REGISTER_FIELDS, PC_MUL, PC_INV, analyzeStackHeights, registerizeProgram, fuseRegisterComparisons, encodeRegisterControlTargets, permuteRegisterFile, diversifyRegisterIsa, validateRegisterProgram };
