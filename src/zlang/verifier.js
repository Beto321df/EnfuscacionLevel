const { OPS } = require('./compiler3');
const { REG_OPS, PC_INV } = require('./registerVm');

function mul32(a, b) { const al=a%65536, ah=Math.floor(a/65536), bl=b%65536, bh=Math.floor(b/65536); return (al*bl+(al*bh+ah*bl)*65536)%4294967296; }
function decodeTarget(fn, value) {
    if (!fn.pcTargetEncoded) return value;
    return mul32((value - (fn.pcTargetAdd >>> 0)) >>> 0, PC_INV) >>> 0;
}

function fail(msg) { throw new Error(`Z3 verifier: ${msg}`); }
function inRange(value, max, label) { if (!Number.isInteger(value) || value < 0 || value >= max) fail(`${label} fuera de rango (${value}, max ${max - 1}).`); }
function jumpTarget(value, len, label) { if (!Number.isInteger(value) || value < 1 || value > len) fail(`${label} inválido (${value}).`); }

function verifyStackFunction(fn, fnCount, constCount) {
    const code = fn.code || [];
    for (let pc = 1; pc <= code.length; pc += 1) {
        const ins = code[pc - 1]; const op = ins[0]; const a = ins[1], b = ins[2], c = ins[3], d = ins[4];
        const local = slot => inRange(slot, fn.localCount, `local pc ${pc}`);
        switch (op) {
            case OPS.PUSH_CONST: inRange(a, constCount, `constant pc ${pc}`); break;
            case OPS.LOAD_LOCAL: case OPS.STORE_LOCAL: case OPS.FOR_NUM_PREP: local(a); if (op === OPS.FOR_NUM_PREP) jumpTarget(d, code.length, `for exit pc ${pc}`); break;
            case OPS.LOAD_UPVALUE: case OPS.STORE_UPVALUE: inRange(a, fn.upvalues.length, `upvalue pc ${pc}`); break;
            case OPS.LOAD_GLOBAL: case OPS.STORE_GLOBAL: case OPS.GET_MEMBER: case OPS.SET_MEMBER: case OPS.CALL_METHOD: case OPS.CALL_METHOD_MULTI: inRange(a, constCount, `constant operand pc ${pc}`); break;
            case OPS.CALL: case OPS.CALL_MULTI: if (a > 0xffffffff) fail(`call arity pc ${pc}`); break;
            case OPS.FOR_NUM_NEXT: jumpTarget(d, code.length, `for-next exit pc ${pc}`); break;
            case OPS.ITER_PREP: if (b >= fn.iteratorLayouts.length) fail(`iterator layout pc ${pc}`); jumpTarget(d, code.length, `iterator exit pc ${pc}`); break;
            case OPS.ITER_NEXT: jumpTarget(b, code.length, `iterator body pc ${pc}`); jumpTarget(d, code.length, `iterator exit pc ${pc}`); break;
            case OPS.JUMP: case OPS.JUMP_IF_FALSE: case OPS.JUMP_IF_TRUE: case OPS.BREAK: jumpTarget(decodeTarget(fn, a), code.length, `jump pc ${pc}`); break;
            case OPS.MAKE_FUNCTION: inRange(a, fnCount, `function pc ${pc}`); break;
            case OPS.FUSED_LOCAL_CONST_BIN_STORE: inRange(a, fn.localCount, `fused local pc ${pc}`); inRange(b, constCount, `fused constant pc ${pc}`); local(d); break;
            case OPS.FUSED_LOCAL_LOCAL_BIN_STORE: local(a); local(b); local(d); break;
            case OPS.FUSED_GLOBAL_CALL: inRange(a, constCount, `fused global pc ${pc}`); break;
            case OPS.UNPACK_MULTI: if (a > 0xffffffff) fail(`unpack arity pc ${pc}`); break;
            case OPS.SETLIST_MULTI: if (a > 0xffffffff) fail(`table start pc ${pc}`); break;
            case OPS.RETURN_MIXED: if (a > 0xffffffff) fail(`return prefix pc ${pc}`); break;
            default: break;
        }
    }
}

function verifyRegisterFunction(fn, fnCount, constCount) {
    const code = fn.code || [];
    const reg = v => inRange(v, fn.registerCount, 'register');
    const local = v => inRange(v, fn.localCount, 'local');
    for (let pc = 1; pc <= code.length; pc += 1) {
        const ins = code[pc - 1];
        const physicalOp = ins[0];
        const op = fn.opcodeDecode ? fn.opcodeDecode[physicalOp] : physicalOp;
        if (!op) fail(`opcode físico ${physicalOp} sin traducción en pc ${pc}`);
        const a = ins[1], b = ins[2], c = ins[3], d = ins[4];
        switch (op) {
            case REG_OPS.NOP: case REG_OPS.NOP_ALT: break;
            case REG_OPS.LOAD_CONST: case REG_OPS.LOAD_CONST_ALT: reg(a); inRange(b, constCount, `constant pc ${pc}`); break;
            case REG_OPS.LOAD_LOCAL: case REG_OPS.LOAD_LOCAL_ALT: reg(a); local(b); break;
            case REG_OPS.STORE_LOCAL: case REG_OPS.STORE_LOCAL_ALT: local(a); reg(b); break;
            case REG_OPS.LOAD_UPVALUE: reg(a); inRange(b, fn.upvalues.length, `upvalue pc ${pc}`); break;
            case REG_OPS.STORE_UPVALUE: inRange(a, fn.upvalues.length, `upvalue pc ${pc}`); reg(b); break;
            case REG_OPS.LOAD_GLOBAL: reg(a); inRange(b, constCount, `global constant pc ${pc}`); break;
            case REG_OPS.STORE_GLOBAL: inRange(a, constCount, `global constant pc ${pc}`); reg(b); break;
            case REG_OPS.GET_MEMBER: reg(a); reg(b); inRange(c, constCount, `member constant pc ${pc}`); break;
            case REG_OPS.SET_MEMBER: reg(a); inRange(b, constCount, `member constant pc ${pc}`); reg(c); break;
            case REG_OPS.GET_INDEX: reg(a); reg(b); reg(c); break;
            case REG_OPS.SET_INDEX: reg(a); reg(b); reg(c); break;
            case REG_OPS.MAKE_FUNCTION: reg(a); inRange(b, fnCount, `function pc ${pc}`); break;
            case REG_OPS.BIN: case REG_OPS.BIN_ALT: reg(a); reg(b); reg(c); break;
            case REG_OPS.FUSED_BIN_JUMP_FALSE: case REG_OPS.FUSED_BIN_JUMP_TRUE:
            case REG_OPS.FUSED_BIN_JUMP_FALSE_ALT: case REG_OPS.FUSED_BIN_JUMP_TRUE_ALT:
                reg(a); reg(b); if (!Number.isInteger(c) || c < 0 || c > 64) fail(`binary opcode pc ${pc}`); jumpTarget(decodeTarget(fn, d), code.length, `fused jump pc ${pc}`); break;
            case REG_OPS.UNARY: reg(a); reg(b); break;
            case REG_OPS.NEW_TABLE: reg(a); break;
            case REG_OPS.GET_VARARG: case REG_OPS.GET_VARARG_MULTI: reg(a); break;
            case REG_OPS.MOVE: case REG_OPS.MOVE_ALT: reg(a); reg(b); break;
            case REG_OPS.CALL: case REG_OPS.CALL_MULTI: reg(a); reg(b); if (b + c >= fn.registerCount) fail(`call window pc ${pc} excede registerCount`); break;
            case REG_OPS.CALL_EXPAND: reg(a); reg(b); reg(ins[4]); if (b + c >= fn.registerCount) fail(`call expand window pc ${pc} excede registerCount`); break;
            case REG_OPS.CALL_METHOD: case REG_OPS.CALL_METHOD_MULTI: reg(a); reg(b); inRange(c, constCount, `method constant pc ${pc}`); if (b + ins[4] >= fn.registerCount) fail(`method window pc ${pc} excede registerCount`); break;
            case REG_OPS.CALL_METHOD_EXPAND: { reg(a); reg(b); inRange(c, constCount, `method constant pc ${pc}`); const prefixCount = ins[4] & 0xFFFF; const tailReg = (Math.floor(ins[4] / 65536)) & 0xFFFF; reg(tailReg); if (b + prefixCount >= fn.registerCount) fail(`method expand window pc ${pc} excede registerCount`); break; }
            case REG_OPS.RETURN: case REG_OPS.RETURN_ALT: reg(a); break;
            case REG_OPS.RETURN_VOID: break;
            case REG_OPS.RETURN_MULTI: reg(a); if (a + b > fn.registerCount) fail(`return window pc ${pc}`); break;
            case REG_OPS.RETURN_MIXED: reg(a); reg(c); if (a + b > fn.registerCount) fail(`mixed return window pc ${pc}`); break;
            case REG_OPS.PACK_MULTI: reg(a); reg(b); if (b + c > fn.registerCount) fail(`pack window pc ${pc}`); break;
            case REG_OPS.UNPACK_MULTI: reg(a); reg(b); if (a + c > fn.registerCount) fail(`unpack window pc ${pc}`); break;
            case REG_OPS.SETLIST_MULTI: reg(a); reg(b); break;
            case REG_OPS.JUMP: case REG_OPS.JUMP_ALT: case REG_OPS.BREAK: jumpTarget(decodeTarget(fn, a), code.length, `jump pc ${pc}`); break;
            case REG_OPS.JUMP_IF_FALSE: case REG_OPS.JUMP_IF_TRUE: reg(a); jumpTarget(decodeTarget(fn, b), code.length, `conditional pc ${pc}`); break;
            case REG_OPS.FOR_NUM_PREP: local(a); reg(b); reg(c); reg(ins[4]); break;
            case REG_OPS.FOR_NUM_CHECK: jumpTarget(decodeTarget(fn, a), code.length, `for-check pc ${pc}`); break;
            case REG_OPS.FOR_NUM_NEXT: jumpTarget(decodeTarget(fn, a), code.length, `for-next pc ${pc}`); break;
            case REG_OPS.ITER_PREP: reg(a); if (b < 1 || b > fn.iteratorLayouts[c]?.length) fail(`iterator slot count pc ${pc}`); if (c >= fn.iteratorLayouts.length) fail(`iterator layout pc ${pc}`); jumpTarget(decodeTarget(fn, ins[4]), code.length, `iterator exit pc ${pc}`); break;
            case REG_OPS.ITER_NEXT: jumpTarget(decodeTarget(fn, a), code.length, `iterator body pc ${pc}`); jumpTarget(decodeTarget(fn, b), code.length, `iterator exit pc ${pc}`); break;
            case REG_OPS.FUSED_LOCAL_CONST_BIN_STORE: local(a); inRange(b, constCount, `fused constant pc ${pc}`); local(ins[4]); break;
            case REG_OPS.FUSED_LOCAL_LOCAL_BIN_STORE: local(a); local(b); local(ins[4]); break;
            case REG_OPS.FUSED_GLOBAL_CALL: reg(a); inRange(b, constCount, `fused global pc ${pc}`); break;
            default: fail(`opcode ${op} desconocido en pc ${pc}`);
        }
    }
}

function verifyProgram(program, options = {}) {
    if (!program || program.version !== 3 || !Array.isArray(program.functions) || !Array.isArray(program.constants)) fail('programa inválido');
    const register = program.backend === 'register' || options.backend === 'register';
    for (const fn of program.functions) {
        if (register) verifyRegisterFunction(fn, program.functions.length, program.constants.length);
        else verifyStackFunction(fn, program.functions.length, program.constants.length);
    }
    return program;
}

module.exports = { verifyProgram };
