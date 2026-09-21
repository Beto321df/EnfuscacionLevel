const { OPS } = require('./compiler3');
const { REG_OPS, PC_INV } = require('./registerVm');

const STACK_TERMINAL = new Set([OPS.RETURN, OPS.RETURN_MULTI, OPS.RETURN_VOID, OPS.RETURN_MIXED, OPS.JUMP, OPS.BREAK]);
const REG_TERMINAL = new Set([REG_OPS.RETURN, REG_OPS.RETURN_ALT, REG_OPS.RETURN_MULTI, REG_OPS.RETURN_VOID, REG_OPS.RETURN_MIXED, REG_OPS.JUMP, REG_OPS.JUMP_ALT, REG_OPS.BREAK]);

function normalizeOpName(map, op) {
    const key = Object.keys(map).find(name => map[name] === op);
    return key || `OP_${op}`;
}

function mul32(a, b) { const al=a%65536, ah=Math.floor(a/65536), bl=b%65536, bh=Math.floor(b/65536); return (al*bl+(al*bh+ah*bl)*65536)%4294967296; }
function decodePc(value, add) { return mul32((value - add) >>> 0, PC_INV) >>> 0; }

function successorsFor(code, pc, backend) {
    const ins = code[pc - 1];
    if (!ins) return [];
    const next = pc < code.length ? pc + 1 : null;
    if (backend === 'register') {
        const op = ins[0];
        if (op === REG_OPS.JUMP || op === REG_OPS.JUMP_ALT || op === REG_OPS.BREAK) return [ins[1]];
        if (op === REG_OPS.JUMP_IF_FALSE || op === REG_OPS.JUMP_IF_TRUE) return [ins[2], ...(next ? [next] : [])];
        if (op === REG_OPS.FOR_NUM_CHECK || op === REG_OPS.FOR_NUM_NEXT) return [ins[1], ...(next ? [next] : [])];
        if (op === REG_OPS.ITER_PREP) return [ins[4], ...(next ? [next] : [])];
        if (op === REG_OPS.ITER_NEXT) return [ins[1], ins[2]];
        if (op === REG_OPS.FUSED_BIN_JUMP_FALSE || op === REG_OPS.FUSED_BIN_JUMP_TRUE ||
            op === REG_OPS.FUSED_BIN_JUMP_FALSE_ALT || op === REG_OPS.FUSED_BIN_JUMP_TRUE_ALT) {
            return [ins[4], ...(next ? [next] : [])];
        }
        return next ? [next] : [];
    }
    const op = ins[0];
    if (op === OPS.JUMP || op === OPS.BREAK) return [ins[1]];
    if (op === OPS.JUMP_IF_FALSE || op === OPS.JUMP_IF_TRUE) return [ins[1], ...(next ? [next] : [])];
    if (op === OPS.FOR_NUM_PREP || op === OPS.FOR_NUM_NEXT || op === OPS.ITER_PREP) return [ins[4], ...(next ? [next] : [])];
    if (op === OPS.ITER_NEXT) return [ins[2], ins[4]];
    return next ? [next] : [];
}

function collectBlocks(code, backend) {
    if (!code.length) return [];
    const leaders = new Set([1]);
    for (let pc = 1; pc <= code.length; pc += 1) {
        for (const target of successorsFor(code, pc, backend)) if (target >= 1 && target <= code.length) leaders.add(target);
        const op = code[pc - 1][0];
        const conditional = backend === 'register'
            ? new Set([REG_OPS.JUMP_IF_FALSE, REG_OPS.JUMP_IF_TRUE, REG_OPS.FOR_NUM_CHECK, REG_OPS.FOR_NUM_NEXT, REG_OPS.ITER_PREP, REG_OPS.ITER_NEXT, REG_OPS.FUSED_BIN_JUMP_FALSE, REG_OPS.FUSED_BIN_JUMP_TRUE, REG_OPS.FUSED_BIN_JUMP_FALSE_ALT, REG_OPS.FUSED_BIN_JUMP_TRUE_ALT]).has(op)
            : new Set([OPS.JUMP_IF_FALSE, OPS.JUMP_IF_TRUE, OPS.FOR_NUM_PREP, OPS.FOR_NUM_NEXT, OPS.ITER_PREP, OPS.ITER_NEXT]).has(op);
        if ((conditional || (backend === 'register' ? REG_TERMINAL : STACK_TERMINAL).has(op)) && pc < code.length) leaders.add(pc + 1);
    }
    const starts = [...leaders].sort((a, b) => a - b);
    return starts.map((start, i) => ({ start, end: i + 1 < starts.length ? starts[i + 1] - 1 : code.length }));
}

function registerUsesAndDefs(ins, backend) {
    if (backend !== 'register') return { uses: new Set(), defs: new Set() };
    const op = ins[0], a = ins[1], b = ins[2], c = ins[3];
    switch (op) {
        case REG_OPS.LOAD_CONST: case REG_OPS.LOAD_CONST_ALT:
        case REG_OPS.LOAD_LOCAL: case REG_OPS.LOAD_LOCAL_ALT:
        case REG_OPS.LOAD_GLOBAL: case REG_OPS.GET_VARARG: case REG_OPS.GET_VARARG_MULTI:
        case REG_OPS.NEW_TABLE: case REG_OPS.MAKE_FUNCTION:
            return { uses: new Set(), defs: new Set([a]) };
        case REG_OPS.STORE_LOCAL: return { uses: new Set([b]), defs: new Set() };
        case REG_OPS.STORE_GLOBAL: return { uses: new Set([b]), defs: new Set() };
        case REG_OPS.GET_MEMBER: return { uses: new Set([b]), defs: new Set([a]) };
        case REG_OPS.SET_MEMBER: return { uses: new Set([a, c]), defs: new Set() };
        case REG_OPS.GET_INDEX: return { uses: new Set([b, c]), defs: new Set([a]) };
        case REG_OPS.SET_INDEX: return { uses: new Set([a, b, c]), defs: new Set() };
        case REG_OPS.LOAD_UPVALUE: return { uses: new Set(), defs: new Set([a]) };
        case REG_OPS.STORE_UPVALUE: return { uses: new Set([b]), defs: new Set() };
        case REG_OPS.BIN: case REG_OPS.BIN_ALT: return { uses: new Set([b, c]), defs: new Set([a]) };
        case REG_OPS.UNARY: return { uses: new Set([b]), defs: new Set([a]) };
        case REG_OPS.MOVE: case REG_OPS.MOVE_ALT: return { uses: new Set([b]), defs: new Set([a]) };
        case REG_OPS.CALL: case REG_OPS.CALL_MULTI: return { uses: new Set(Array.from({ length: ins[3] + 1 }, (_, i) => b + i)), defs: new Set([a]) };
        case REG_OPS.CALL_EXPAND: return { uses: new Set([...Array.from({ length: ins[3] + 1 }, (_, i) => b + i), ins[4]]), defs: new Set([a]) };
        case REG_OPS.CALL_METHOD: case REG_OPS.CALL_METHOD_MULTI: return { uses: new Set(Array.from({ length: ins[4] + 1 }, (_, i) => b + i)), defs: new Set([a]) };
        case REG_OPS.CALL_METHOD_EXPAND: { const prefix = ins[4] & 0xFFFF; const tail = (Math.floor(ins[4] / 65536)) & 0xFFFF; return { uses: new Set([...Array.from({ length: prefix + 1 }, (_, i) => b + i), tail]), defs: new Set([a]) }; }
        case REG_OPS.RETURN: case REG_OPS.RETURN_ALT: return { uses: new Set([a]), defs: new Set() };
        case REG_OPS.RETURN_MULTI: return { uses: new Set(Array.from({ length: ins[2] }, (_, i) => a + i)), defs: new Set() };
        case REG_OPS.RETURN_MIXED: return { uses: new Set([...Array.from({ length: ins[2] }, (_, i) => a + i), ins[3]]), defs: new Set() };
        case REG_OPS.UNPACK_MULTI: return { uses: new Set([b]), defs: new Set(Array.from({ length: ins[3] }, (_, i) => a + i)) };
        case REG_OPS.SETLIST_MULTI: return { uses: new Set([a, b]), defs: new Set() };
        case REG_OPS.PACK_MULTI: return { uses: new Set(Array.from({ length: ins[3] }, (_, i) => b + i)), defs: new Set([a]) };
        case REG_OPS.JUMP_IF_FALSE: case REG_OPS.JUMP_IF_TRUE: return { uses: new Set([a]), defs: new Set() };
        case REG_OPS.FOR_NUM_PREP: return { uses: new Set([b, c, ins[4]]), defs: new Set() };
        case REG_OPS.ITER_PREP: return { uses: new Set([a]), defs: new Set() };
        case REG_OPS.FUSED_BIN_JUMP_FALSE: case REG_OPS.FUSED_BIN_JUMP_TRUE:
        case REG_OPS.FUSED_BIN_JUMP_FALSE_ALT: case REG_OPS.FUSED_BIN_JUMP_TRUE_ALT:
            return { uses: new Set([a, b]), defs: new Set() };
        default: return { uses: new Set(), defs: new Set() };
    }
}

function normalizeInstruction(fn, ins, backend) {
    const out = ins.slice();
    if (backend === 'register' && Array.isArray(fn.opcodeDecode) && fn.opcodeDecode[out[0]]) {
        out[0] = fn.opcodeDecode[out[0]];
    }
    if (backend === 'register' && fn.pcTargetEncoded) {
        const op = out[0];
        const fields =
            op === REG_OPS.JUMP || op === REG_OPS.JUMP_ALT || op === REG_OPS.BREAK ? [1] :
            op === REG_OPS.JUMP_IF_FALSE || op === REG_OPS.JUMP_IF_TRUE ? [2] :
            op === REG_OPS.FOR_NUM_CHECK || op === REG_OPS.FOR_NUM_NEXT ? [1] :
            op === REG_OPS.ITER_PREP ? [4] :
            op === REG_OPS.ITER_NEXT ? [1, 2] :
            op === REG_OPS.FUSED_BIN_JUMP_FALSE || op === REG_OPS.FUSED_BIN_JUMP_TRUE ||
            op === REG_OPS.FUSED_BIN_JUMP_FALSE_ALT || op === REG_OPS.FUSED_BIN_JUMP_TRUE_ALT ? [4] : [];
        for (const field of fields) out[field] = decodePc(out[field], fn.pcTargetAdd >>> 0);
    }
    return out;
}

function analyzeFunction(fn, backend = 'register') {
    const sourceCode = fn.code || [];
    const code = sourceCode.map(ins => normalizeInstruction(fn, ins, backend));
    const blocks = collectBlocks(code, backend);
    const blockByPc = new Map(blocks.map(block => [block.start, block]));
    const succ = new Map();
    for (const block of blocks) succ.set(block.start, [...new Set(successorsFor(code, block.end, backend))].filter(v => blockByPc.has(v)));

    const blockUse = new Map(), blockDef = new Map(), liveIn = new Map(), liveOut = new Map();
    for (const block of blocks) {
        const use = new Set(), def = new Set();
        for (let pc = block.start; pc <= block.end; pc += 1) {
            const { uses, defs } = registerUsesAndDefs(code[pc - 1], backend);
            for (const r of uses) if (!def.has(r)) use.add(r);
            for (const r of defs) def.add(r);
        }
        blockUse.set(block.start, use); blockDef.set(block.start, def);
        liveIn.set(block.start, new Set()); liveOut.set(block.start, new Set());
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (let i = blocks.length - 1; i >= 0; i -= 1) {
            const block = blocks[i];
            const out = new Set();
            for (const target of succ.get(block.start) || []) for (const r of liveIn.get(target) || []) out.add(r);
            const nextIn = new Set(blockUse.get(block.start));
            for (const r of out) if (!blockDef.get(block.start).has(r)) nextIn.add(r);
            const prevIn = liveIn.get(block.start);
            const prevOut = liveOut.get(block.start);
            const sameIn = prevIn.size === nextIn.size && [...prevIn].every(r => nextIn.has(r));
            const sameOut = prevOut.size === out.size && [...prevOut].every(r => out.has(r));
            if (!sameIn) { liveIn.set(block.start, nextIn); changed = true; }
            if (!sameOut) { liveOut.set(block.start, out); changed = true; }
        }
    }

    const opHistogram = {};
    const names = backend === 'register' ? REG_OPS : OPS;
    for (const ins of code) { const name = normalizeOpName(names, ins[0]); opHistogram[name] = (opHistogram[name] || 0) + 1; }
    const liveRegs = new Set();
    for (const s of liveIn.values()) for (const r of s) liveRegs.add(r);
    for (const s of liveOut.values()) for (const r of s) liveRegs.add(r);

    return {
        instructionCount: code.length,
        blockCount: blocks.length,
        edgeCount: [...succ.values()].reduce((n, edges) => n + edges.length, 0),
        maxLiveRegisters: liveRegs.size,
        reachableBlocks: blocks.length,
        opcodeHistogram: opHistogram
    };
}

function analyzeProgram(program) {
    const backend = program.backend === 'register' ? 'register' : 'stack';
    const functions = (program.functions || []).map(fn => analyzeFunction(fn, backend));
    return {
        backend,
        functionCount: functions.length,
        instructionCount: functions.reduce((n, s) => n + s.instructionCount, 0),
        blockCount: functions.reduce((n, s) => n + s.blockCount, 0),
        edgeCount: functions.reduce((n, s) => n + s.edgeCount, 0),
        maxLiveRegisters: Math.max(0, ...functions.map(s => s.maxLiveRegisters)),
        functions
    };
}

module.exports = { analyzeFunction, analyzeProgram };
