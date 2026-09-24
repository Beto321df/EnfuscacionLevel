const crypto = require('crypto');
const { REG_OPS, REG_ALIAS_BASE, PC_INV, PC_MUL } = require('../zlang/registerVm');
const { buildNativeProgram } = require('../zlang/nativeCompiler');
const { buildEmissionPlan } = require('../zlang/emitter');
const { resolvePreset } = require('../zlang/presets');

const OP_NAME = Object.fromEntries(Object.entries(REG_OPS).map(([k, v]) => [v, k]));
const OP_COUNT = Object.keys(REG_OPS).length;
if (OP_COUNT !== 56) throw new Error('X7.1: la ISA register cambió; actualiza el runtime X7.1.');

const MAGIC = [88, 55, 71];
const PC_MOD = 4294967296;

function rand(min, max) { return crypto.randomInt(min, max + 1); }
function shuffle(values) {
    const out = values.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = rand(0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
function mod32(v) {
    v = Number(v);
    v %= PC_MOD;
    if (v < 0) v += PC_MOD;
    return v;
}
function mul32(a, b) {
    const al = a % 65536;
    const ah = Math.floor(a / 65536);
    const bl = b % 65536;
    const bh = Math.floor(b / 65536);
    return mod32(al * bl + (al * bh + ah * bl) * 65536);
}
function gcd32(a, b) {
    a = Math.abs(a | 0);
    b = Math.abs(b | 0);
    while (b) {
        const t = a % b;
        a = b;
        b = t;
    }
    return a || 1;
}
function randomOdd32() {
    let n = rand(1, 0xFFFFFFFE) >>> 0;
    n |= 1;
    if (gcd32(n, 4294967296) !== 1) n = (n + 2) >>> 0;
    return n >>> 0;
}
function invOdd32(a) {
    let x = 1 >>> 0;
    // Newton iteration modulo 2^32. This uses only integer multiplication.
    for (let i = 0; i < 5; i += 1) x = mul32(x, (2 - mul32(a, x)) >>> 0);
    return x >>> 0;
}
function mod12(v) {
    v = Number(v) % 4096;
    if (v < 0) v += 4096;
    return v;
}
function mul12(a, b) {
    return (mod12(a) * mod12(b)) % 4096;
}
function randomOdd12() {
    return (rand(1, 4095) | 1) & 4095;
}
function invOdd12(a) {
    let x = 1;
    for (let i = 0; i < 4; i += 1) x = mul12(x, 2 - mul12(a, x));
    return x & 4095;
}
function mod16(v) {
    v = Number(v) % 65536;
    if (v < 0) v += 65536;
    return v;
}
function mul16(a, b) {
    return (mod16(a) * mod16(b)) % 65536;
}
function randomOdd16() {
    return (rand(1, 65534) | 1) & 65535;
}
function invOdd16(a) {
    let x = 1;
    for (let i = 0; i < 4; i += 1) x = mul16(x, 2 - mul16(a, x));
    return x & 65535;
}
function canPack12(fn, options = {}) {
    if (options.packOperands12 === false) return false;
    if (fn.code.length > 4095 || fn.localCount > 4095 || fn.registerCount > 4095) return false;
    if (fn.params.some(v => v > 4095)) return false;
    if (fn.upvalues.some(v => v.index > 4095)) return false;
    for (const layout of fn.iteratorLayouts) {
        if (layout.some(v => v > 4095)) return false;
    }
    for (const ins of fn.code) {
        for (let i = 1; i < 5; i += 1) {
            if (!Number.isInteger(ins[i]) || ins[i] < 0 || ins[i] > 4095) return false;
        }
    }
    return true;
}
function canPack16(fn, options = {}) {
    if (options.packOperands16 === false) return false;
    if (fn.code.length > 65535 || fn.localCount > 65535 || fn.registerCount > 65535) return false;
    if (fn.params.some(v => v > 65535)) return false;
    if (fn.upvalues.some(v => v.index > 65535)) return false;
    for (const layout of fn.iteratorLayouts) {
        if (layout.some(v => v > 65535)) return false;
    }
    for (const ins of fn.code) {
        for (let i = 1; i < 5; i += 1) {
            if (!Number.isInteger(ins[i]) || ins[i] < 0 || ins[i] > 65535) return false;
        }
    }
    return true;
}
function u16(out, v) {
    if (!Number.isInteger(v) || v < 0 || v > 65535) throw new Error('X7.1 u16 fuera de rango.');
    out.push((v >>> 8) & 255, v & 255);
}
function u32(out, v) {
    v = mod32(v);
    out.push(Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256);
}
function readU32(bytes, at) {
    return bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
}
function baseName(id) {
    const name = OP_NAME[id];
    return name && REG_ALIAS_BASE[name] ? REG_ALIAS_BASE[name] : name;
}
function semanticOp(fn, id) {
    const decoded = Array.isArray(fn.opcodeDecode) ? (fn.opcodeDecode[id] || id) : id;
    return REG_OPS[baseName(decoded)] || decoded;
}
function targetFields(op) {
    switch (op) {
        case REG_OPS.JUMP:
        case REG_OPS.JUMP_ALT:
        case REG_OPS.BREAK:
            return [1];
        case REG_OPS.JUMP_IF_FALSE:
        case REG_OPS.JUMP_IF_TRUE:
            return [2];
        case REG_OPS.FOR_NUM_CHECK:
        case REG_OPS.FOR_NUM_NEXT:
            return [1];
        case REG_OPS.ITER_PREP:
            return [4];
        case REG_OPS.ITER_NEXT:
            return [1, 2];
        case REG_OPS.FUSED_BIN_JUMP_FALSE:
        case REG_OPS.FUSED_BIN_JUMP_TRUE:
        case REG_OPS.FUSED_BIN_JUMP_FALSE_ALT:
        case REG_OPS.FUSED_BIN_JUMP_TRUE_ALT:
            return [4];
        default:
            return [];
    }
}
function constantFields(op) {
    const name = baseName(op);
    switch (name) {
        case 'LOAD_CONST':
        case 'LOAD_CONST_ALT':
        case 'LOAD_GLOBAL':
        case 'STORE_GLOBAL':
        case 'GET_MEMBER':
        case 'SET_MEMBER':
        case 'CALL_METHOD':
        case 'CALL_METHOD_MULTI':
        case 'CALL_METHOD_EXPAND':
            return name === 'STORE_GLOBAL' ? [1] :
                name === 'GET_MEMBER' ? [3] :
                name === 'SET_MEMBER' ? [2] :
                (name === 'CALL_METHOD' || name === 'CALL_METHOD_MULTI' || name === 'CALL_METHOD_EXPAND') ? [3] : [2];
        case 'FUSED_LOCAL_CONST_BIN_STORE':
            return [2];
        case 'FUSED_GLOBAL_CALL':
            return [2];
        default:
            return [];
    }
}
function functionFields(op) {
    return baseName(op) === 'MAKE_FUNCTION' ? [2] : [];
}
function localFields(op) {
    switch (baseName(op)) {
        case 'LOAD_LOCAL':
        case 'LOAD_LOCAL_ALT':
            return [2];
        case 'STORE_LOCAL':
        case 'STORE_LOCAL_ALT':
            return [1];
        case 'FOR_NUM_PREP':
            return [1];
        case 'FUSED_LOCAL_CONST_BIN_STORE':
            return [1, 4];
        case 'FUSED_LOCAL_LOCAL_BIN_STORE':
            return [1, 2, 4];
        default:
            return [];
    }
}
function canonicalize(program) {
    const functions = (program.functions || []).map(fn => {
        const code = (fn.code || []).map(raw => {
            const ins = Array.from(raw);
            const op = semanticOp(fn, ins[0]);
            if (!Number.isInteger(op) || op < 1 || op > OP_COUNT) throw new Error('X7.1: opcode inválido.');
            const fields = targetFields(op);
            for (const field of fields) {
                const encoded = Boolean(fn.pcTargetEncoded);
                if (encoded) {
                    const mul = Number(PC_MUL) >>> 0;
                    const inv = Number(PC_INV) >>> 0;
                    const add = Number(fn.pcTargetAdd || 0) >>> 0;
                    let x = (ins[field] >>> 0);
                    if (inv) x = mul32((x - add) >>> 0, inv) >>> 0;
                    else x = mod32(x - add);
                    ins[field] = x;
                }
            }
            ins[0] = op;
            return ins;
        });
        return {
            params: Array.isArray(fn.params) ? fn.params.map(Number) : [],
            vararg: !!fn.vararg,
            localCount: Number(fn.localCount) || 0,
            registerCount: Number(fn.registerCount) || 0,
            upvalues: Array.isArray(fn.upvalues) ? fn.upvalues.map(x => ({ kind: x.kind === 'local' ? 0 : 1, index: Number(x.index) || 0 })) : [],
            iteratorLayouts: Array.isArray(fn.iteratorLayouts) ? fn.iteratorLayouts.map(x => Array.isArray(x) ? x.map(Number) : []) : [],
            code
        };
    });
    const constants = (program.constants || []).map(c => ({ type: Number(c.type), value: c.value }));
    if (functions.length > 65535 || constants.length > 65535) throw new Error('X7.1: contenedor excede sus límites.');
    return { functions, constants, root: Number.isInteger(program.root) ? program.root : 0 };
}

function encodeString(bytes, key, step) {
    const out = new Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) out[i] = (bytes[i] + key + i * step) & 255;
    return out;
}
function putBytes(dst, bytes) {
    // Never spread a large byte section into Array.prototype.push: V8 has an
    // argument-count limit and large scripts can otherwise fail with
    // "Maximum call stack size exceeded".
    for (let i = 0; i < bytes.length; i += 1) dst.push(bytes[i]);
}
function putMaskedU32(dst, value, key, step, index) { u32(dst, mul32(mod32(value + key + index * step), 65537)); }
function seal(bytes) {
    let a = 17;
    let b = 29;
    for (let i = 0; i < bytes.length; i += 1) {
        const v = bytes[i];
        a = (a + v * (i + 11)) % 65521;
        b = (b * 33 + v + i + 7) % 65521;
    }
    return (((a << 16) >>> 0) | (b & 65535)) >>> 0;
}

function buildDispatchPlan(program) {
    const used = new Set();
    for (const fn of (program.functions || [])) {
        for (const raw of (fn.code || [])) {
            const sem = semanticOp(fn, raw[0]);
            if (Number.isInteger(sem) && sem >= 1 && sem <= OP_COUNT && !REG_ALIAS_BASE[OP_NAME[sem]]) {
                used.add(sem);
            }
        }
    }

    // Canonical semantic operations are the only entries that may become
    // dispatcher handlers. Public/runtime opcode IDs are randomized from the
    // full ISA, but only canonical handlers referenced by this program receive
    // handler IDs that will actually be emitted into fn.q.
    const semantics = Array.from({ length: OP_COUNT }, (_, i) => i + 1)
        .filter(id => !REG_ALIAS_BASE[OP_NAME[id]]);
    if (!used.size) throw new Error('X7.1: programa sin instrucciones.');

    const handlerIds = shuffle(Array.from({ length: OP_COUNT }, (_, i) => i + 1))
        .slice(0, semantics.length);
    const map = {};
    for (let i = 0; i < semantics.length; i += 1) map[semantics[i]] = handlerIds[i];

    const usedSemantics = Array.from(used).sort((a, b) => a - b);
    const usedHandlers = usedSemantics.map(sem => map[sem]);
    if (usedHandlers.some(id => !Number.isInteger(id)) ||
        new Set(usedHandlers).size !== usedHandlers.length) {
        throw new Error('X7.1: plan de dispatcher inválido.');
    }

    return { map, handlerIds, semantics, used: usedSemantics, usedHandlers };
}

function buildContainer(program, options = {}) {
    const C = canonicalize(program);
    const encodeLocalOperands = options.encodeLocalOperands === true;
    const encodeInstructionRoute = options.encodeInstructionRoute === true;
    const encodeOperandFeedback = options.encodeOperandFeedback === true;
    const encodeConstantRoute = options.encodeConstantRoute === true;
    const encodeTargetTokens = options.encodeTargetTokens === true;
    for (const fn of C.functions) for (const ins of fn.code) {
        if ((ins[0] === REG_OPS.BIN || ins[0] === REG_OPS.BIN_ALT) && (!Number.isInteger(ins[4]) || ins[4] < 1 || ins[4] > 19)) {
            throw new Error('X7.1: BIN semántico inválido '+String(ins[4]));
        }
    }
    if (C.root < 0 || C.root >= C.functions.length) throw new Error('X7.1: root inválido.');

    const opcodeMaps = [];
    const dispatchPlan = options.dispatchPlan || buildDispatchPlan(C);
    for (let f = 0; f < C.functions.length; f += 1) {
        const semantics = Array.from({ length: OP_COUNT }, (_, i) => i + 1);
        const physical = shuffle(semantics);
        const encode = {};
        const decode = [0];
        semantics.forEach((semantic, i) => { encode[semantic] = physical[i]; decode[physical[i]] = semantic; });
        opcodeMaps.push({ encode, decode });
        for (const ins of C.functions[f].code) ins[0] = encode[ins[0]] || ins[0];
    }

    // Section A: encrypted constants, fragmented by entry.
    const constSection = [];
    u16(constSection, C.constants.length);
    const constantOrder = encodeConstantRoute
        ? shuffle(Array.from({ length: C.constants.length }, (_, n) => n))
        : Array.from({ length: C.constants.length }, (_, n) => n);
    if (encodeConstantRoute) {
        const logicalToPhysical = new Array(C.constants.length);
        for (let physicalIndex = 0; physicalIndex < constantOrder.length; physicalIndex += 1) {
            logicalToPhysical[constantOrder[physicalIndex]] = physicalIndex;
        }
        for (let logicalIndex = 0; logicalIndex < C.constants.length; logicalIndex += 1) {
            u32(constSection, logicalToPhysical[logicalIndex]);
        }
    }
    for (let physicalIndex = 0; physicalIndex < C.constants.length; physicalIndex += 1) {
        const i = constantOrder[physicalIndex];
        const c = C.constants[i];
        const type = c.type;
        let raw;
        if (type === 1 || type === 2) raw = Buffer.from(String(c.value), 'utf8');
        else if (type === 3) raw = Buffer.from([Number(c.value) ? 1 : 0]);
        else if (type === 4) raw = Buffer.from([0]);
        else throw new Error('X7.1: constante inválida.');
        const key = rand(0, 255);
        const step = rand(1, 255);
        const shards = Math.max(1, Math.min(6, 1 + (rand(0, 255) % 4)));
        const offsets = [0];
        for (let s = 1; s < shards; s += 1) offsets.push(rand(offsets[offsets.length - 1], raw.length));
        offsets.push(raw.length);
        const cuts = Array.from(new Set(offsets)).sort((a, b) => a - b);
        const actualShards = Math.max(1, cuts.length - 1);
        const order = shuffle(Array.from({ length: actualShards }, (_, n) => n));
        const packed = [];
        for (let j = 0; j < actualShards; j += 1) {
            const sourceShard = order[j];
            const slice = raw.subarray(cuts[sourceShard], cuts[sourceShard + 1]);
            packed.push({ index: sourceShard, bytes: encodeString(slice, key + sourceShard, step) });
        }
        const entrySeed = rand(0, 255);
        const entry = [];
        entry.push(type, key, step, entrySeed, packed.length);
        for (const shard of packed) {
            entry.push((shard.index + entrySeed) & 255); u16(entry, shard.bytes.length);
            putBytes(entry, shard.bytes);
        }
        u32(constSection, entry.length);
        putBytes(constSection, entry);
    }

    // Section B: compact function metadata. Function names/identifiers do not survive.
    const metaSection = [];
    u16(metaSection, C.functions.length);
    u16(metaSection, C.root);
    for (let i = 0; i < C.functions.length; i += 1) {
        const fn = C.functions[i];
        if (fn.params.length > 65535 || fn.upvalues.length > 65535 || fn.iteratorLayouts.length > 65535) throw new Error('X7.1: metadata de función fuera de rango.');
        const k = rand(0x10000, 0xFFFFFFFF) >>> 0;
        const st = (rand(1, 0xFFFF) | 1) >>> 0;
        // X7.1 metadata must be self-describing: persist both mask parameters.
        u32(metaSection, k);
        u32(metaSection, st);
        u16(metaSection, fn.vararg ? 1 : 0);
        putMaskedU32(metaSection, fn.localCount, k, st, 1);
        putMaskedU32(metaSection, fn.registerCount, k, st, 2);
        u16(metaSection, fn.params.length);
        for (let p = 0; p < fn.params.length; p += 1) putMaskedU32(metaSection, fn.params[p], k, st, 10 + p);
        u16(metaSection, fn.upvalues.length);
        for (let u = 0; u < fn.upvalues.length; u += 1) {
            metaSection.push((fn.upvalues[u].kind + k + u * 17) % 256);
            putMaskedU32(metaSection, fn.upvalues[u].index, k, st, 200 + u);
        }
        u16(metaSection, fn.iteratorLayouts.length);
        for (let j = 0; j < fn.iteratorLayouts.length; j += 1) {
            const it = fn.iteratorLayouts[j];
            u16(metaSection, it.length);
            for (let q = 0; q < it.length; q += 1) putMaskedU32(metaSection, it[q], k, st, 400 + j * 97 + q);
        }
    }

    // Section C: split opcode/operand planes. Eligible functions use 16-bit
    // lanes so the container does not spend four bytes on every small operand.
    const codeSection = [];
    u16(codeSection, C.functions.length);
    for (let i = 0; i < C.functions.length; i += 1) {
        const fn = C.functions[i];
        if (fn.code.length > 0xFFFFFFFF) throw new Error('X7.1: demasiadas instrucciones.');
        const packed12 = canPack12(fn, options);
        const packed16 = !packed12 && canPack16(fn, options);
        const layout = packed12 ? 12 : (packed16 ? 16 : 32);
        let writeOperand;
        let flushOperand = () => {};
        let transform;
        let modulus;
        let oddKey;
        let invert;
        if (packed12) {
            const state = { acc: 0, bits: 0 };
            writeOperand = (_out, value) => {
                value = mod12(value);
                state.acc += value * (2 ** state.bits);
                state.bits += 12;
                while (state.bits >= 8) {
                    codeSection.push(state.acc % 256);
                    state.acc = Math.floor(state.acc / 256);
                    state.bits -= 8;
                }
            };
            flushOperand = () => {
                if (state.bits > 0) {
                    codeSection.push(state.acc % 256);
                    state.acc = 0;
                    state.bits = 0;
                }
            };
            transform = mul12;
            modulus = 4096;
            oddKey = randomOdd12;
            invert = invOdd12;
        } else {
            writeOperand = packed16 ? u16 : u32;
            transform = packed16 ? mul16 : mul32;
            modulus = packed16 ? 65536 : PC_MOD;
            oddKey = packed16 ? randomOdd16 : randomOdd32;
            invert = packed16 ? invOdd16 : invOdd32;
        }
        const maxOperand = modulus - 1;

        const order = shuffle([1, 2, 3, 4]);
        const pcMul = oddKey();
        const pcInv = invert(pcMul);
        const pcAdd = rand(0, maxOperand) >>> 0;
        const fnMul = oddKey();
        const fnAdd = rand(0, maxOperand) >>> 0;
        const cMul = oddKey();
        const cAdd = rand(0, maxOperand) >>> 0;
        const lMul = encodeLocalOperands ? oddKey() : 1;
        const lAdd = encodeLocalOperands ? (rand(0, maxOperand) >>> 0) : 0;
        const feedbackKeys = encodeOperandFeedback
            ? Array.from({ length: 4 }, () => rand(0, maxOperand) >>> 0)
            : [0, 0, 0, 0];
        const targetTokens = encodeTargetTokens ? (() => {
            if (packed16) return [0, ...shuffle(Array.from({ length: fn.code.length }, (_, n) => n + 1))];
            const used = new Set();
            const tokens = new Array(fn.code.length + 1);
            for (let logicalPc = 1; logicalPc <= fn.code.length; logicalPc += 1) {
                let token;
                do token = rand(0, 0xFFFFFFFF) >>> 0; while (used.has(token));
                used.add(token);
                tokens[logicalPc] = token;
            }
            return tokens;
        })() : null;

        u32(codeSection, fn.code.length);
        codeSection.push(...order);
        codeSection.push(layout);
        writeOperand(codeSection, pcMul);
        writeOperand(codeSection, pcAdd);
        writeOperand(codeSection, fnMul);
        writeOperand(codeSection, fnAdd);
        writeOperand(codeSection, cMul);
        writeOperand(codeSection, cAdd);
        if (encodeLocalOperands) {
            writeOperand(codeSection, lMul);
            writeOperand(codeSection, lAdd);
        }
        if (encodeTargetTokens) {
            for (let logicalPc = 1; logicalPc <= fn.code.length; logicalPc += 1) {
                writeOperand(codeSection, targetTokens[logicalPc]);
            }
        }
        flushOperand();

        const physicalOrder = encodeInstructionRoute
            ? shuffle(Array.from({ length: fn.code.length }, (_, n) => n + 1))
            : Array.from({ length: fn.code.length }, (_, n) => n + 1);
        if (encodeInstructionRoute) {
            const logicalToPhysical = new Array(fn.code.length + 1);
            for (let physicalSlot = 1; physicalSlot <= physicalOrder.length; physicalSlot += 1) {
                logicalToPhysical[physicalOrder[physicalSlot - 1]] = physicalSlot;
            }
            for (let logicalPc = 1; logicalPc <= fn.code.length; logicalPc += 1) {
                writeOperand(codeSection, logicalToPhysical[logicalPc]);
            }
        }
        flushOperand();

        for (const logicalPc of physicalOrder) codeSection.push(fn.code[logicalPc - 1][0] & 255);
        const usedRaw = Array.from(new Set(fn.code.map(ins => ins[0]))).sort((a, b) => a - b);
        codeSection.push(usedRaw.length);
        for (const raw of usedRaw) {
            const sem = opcodeMaps[i].decode[raw] || raw;
            const hid = dispatchPlan.map[sem];
            if (!hid) throw new Error('X7.1: handler de opcode no encontrado.');
            codeSection.push(raw, hid);
        }
        flushOperand();

        const planes = [[], [], [], []];
        const planeKeys = [];
        const planeSteps = [];
        for (let p = 0; p < 4; p += 1) {
            planeKeys[p] = rand(0, maxOperand) >>> 0;
            planeSteps[p] = (rand(1, Math.max(1, maxOperand)) | 1) >>> 0;
            writeOperand(codeSection, planeKeys[p]);
            writeOperand(codeSection, planeSteps[p]);
        }

        for (let physicalPc = 0; physicalPc < fn.code.length; physicalPc += 1) {
            const logicalPc = physicalOrder[physicalPc];
            const ins = fn.code[logicalPc - 1];
            const sem = opcodeMaps[i].decode[ins[0]];
            let vals = [ins[1] >>> 0, ins[2] >>> 0, ins[3] >>> 0, ins[4] >>> 0];

            for (const field of targetFields(sem)) {
                const idx = field - 1;
                vals[idx] = encodeTargetTokens
                    ? targetTokens[vals[idx]]
                    : mod32(transform(vals[idx], pcMul) + pcAdd) % modulus;
            }
            for (const field of functionFields(sem)) {
                const idx = field - 1;
                vals[idx] = mod32(transform(vals[idx], fnMul) + fnAdd) % modulus;
            }
            for (const field of constantFields(sem)) {
                const idx = field - 1;
                vals[idx] = mod32(transform(vals[idx], cMul) + cAdd) % modulus;
            }
            if (encodeLocalOperands) {
                for (const field of localFields(sem)) {
                    const idx = field - 1;
                    vals[idx] = mod32(transform(vals[idx], lMul) + lAdd) % modulus;
                }
            }
            for (let field = 0; field < 4; field += 1) planes[order[field] - 1].push(vals[field]);
        }

        if (encodeOperandFeedback) {
            for (let p = 0; p < 4; p += 1) writeOperand(codeSection, feedbackKeys[p]);
        }
        for (let p = 0; p < 4; p += 1) {
            let previous = 0;
            for (let j = 0; j < planes[p].length; j += 1) {
                const feedback = encodeOperandFeedback ? transform(previous, feedbackKeys[p]) : 0;
                const v = (planes[p][j] + planeKeys[p] + j * planeSteps[p] + feedback) % modulus;
                writeOperand(codeSection, v);
                previous = v;
            }
        }
        flushOperand();
    }

    // Section D: a small verifier ledger. It proves the count/shape without exposing source metadata.
    const ledgerSection = [];
    u32(ledgerSection, C.functions.reduce((n, fn) => n + fn.code.length, 0));
    u32(ledgerSection, C.constants.length);
    u32(ledgerSection, C.functions.length);
    u32(ledgerSection, C.root);

    const sectionPairs = [
        [11, constSection],
        [19, metaSection],
        [37, codeSection],
        [53, ledgerSection]
    ];
    const featureMask = (encodeLocalOperands ? 1 : 0) | (encodeInstructionRoute ? 2 : 0) | (encodeOperandFeedback ? 4 : 0) | (encodeConstantRoute ? 8 : 0) | (encodeTargetTokens ? 16 : 0);
    if (featureMask) sectionPairs.push([71, [featureMask]]);
    const ordered = shuffle(sectionPairs);
    const bytes = [...MAGIC, ordered.length];
    for (const [id, section] of ordered) {
        bytes.push(id);
        u32(bytes, section.length);
        putBytes(bytes, section);
    }
    const s = seal(bytes);
    u32(bytes, s);
    return { bytes, dispatchPlan };
}

function validateContainer(bytes) {
    let p = 0;
    const need = n => { if (p + n > bytes.length) throw new Error('X7.1: contenedor truncado.'); };
    const u = () => { need(1); return bytes[p++]; };
    const U = () => { const a=u(),b=u(); return a*256+b; };
    const V = () => { const a=u(),b=u(),d=u(),e=u(); return a*16777216+b*65536+d*256+e; };
    if (bytes.length < 8 || u() !== 88 || u() !== 55 || u() !== 71) throw new Error('X7.1: magic inválido.');
    const sections = new Map();
    const count = u();
    for (let i = 0; i < count; i += 1) {
        const id = u();
        const len = V();
        need(len);
        sections.set(id, bytes.slice(p, p + len));
        p += len;
    }
    if (p + 4 !== bytes.length) throw new Error('X7.1: framing inválido.');
    const expected = readU32(bytes, p);
    const got = seal(bytes.slice(0, p));
    if (expected !== got) throw new Error('X7.1: seal interno inválido.');
    const C = sections.get(11), M = sections.get(19), I = sections.get(37), L = sections.get(53), F = sections.get(71);
    if (!C || !M || !I || !L) throw new Error('X7.1: faltan secciones.');
    if (F && (F.length !== 1 || (F[0] & 31) !== F[0])) throw new Error('X7.1: feature section inválida.');
    const localMask = Boolean(F && (F[0] & 1));
    const routeMask = Boolean(F && (F[0] & 2));
    const feedbackMask = Boolean(F && (F[0] & 4));
    const constantMask = Boolean(F && (F[0] & 8));
    const targetTokenMask = Boolean(F && (F[0] & 16));
    if (L.length !== 16) throw new Error('X7.1: ledger inválido.');

    const readSection = section => {
        let q = 0, b12 = 0, bits12 = 0;
        const one = () => { if (q >= section.length) throw new Error('X7.1: sección truncada.'); return section[q++]; };
        const two = () => { const a=one(),d=one(); return a*256+d; };
        const four = () => { const a=one(),d=one(),e=one(),g=one(); return a*16777216+d*65536+e*256+g; };
        const twelve = () => {
            while (bits12 < 12) { b12 += one() * (2 ** bits12); bits12 += 8; }
            const v = b12 % 4096;
            b12 = Math.floor(b12 / 4096);
            bits12 -= 12;
            return v;
        };
        const align = () => { b12 = 0; bits12 = 0; };
        return { b: section, one, two, four, twelve, align, get pos(){ return q; } };
    };

    const cs = readSection(C);
    const rc = cs.two();
    if (constantMask) for (let i = 0; i < rc; i += 1) cs.four();
    for (let i = 0; i < rc; i += 1) {
        const len = cs.four();
        const end = cs.pos + len;
        if (end > C.length) throw new Error('X7.1: constante fuera de rango.');
        cs.one(); cs.one(); cs.one(); cs.one(); cs.one();
        for (;;) {
            if (cs.pos >= end) break;
            cs.one();
            const shardLen = cs.two();
            for (let j = 0; j < shardLen; j += 1) cs.one();
        }
        if (cs.pos !== end) throw new Error('X7.1: constante mal enmarcada.');
    }
    if (cs.pos !== C.length) throw new Error('X7.1: cola en constantes.');

    const ms = readSection(M);
    const nf = ms.two();
    const root = ms.two();
    if (root >= nf) throw new Error('X7.1: root fuera de rango.');
    for (let i = 0; i < nf; i += 1) {
        ms.four(); // metadata mask key
        ms.four(); // metadata mask step
        ms.two();  // vararg flag
        ms.four(); ms.four();
        const np = ms.two(); for (let j=0;j<np;j+=1) ms.four();
        const nu = ms.two(); for (let j=0;j<nu;j+=1) { ms.one(); ms.four(); }
        const ni = ms.two();
        for (let j=0;j<ni;j+=1) { const n=ms.two(); for (let q=0;q<n;q+=1) ms.four(); }
    }
    if (ms.pos !== M.length) throw new Error('X7.1: cola en metadatos.');

    const is = readSection(I);
    const nfi = is.two();
    if (nfi !== nf) throw new Error('X7.1: count de funciones inconsistente.');
    let totalInstr = 0;
    for (let i = 0; i < nf; i += 1) {
        const countIns = is.four();
        totalInstr += countIns;
        for (let j=0;j<4;j+=1) is.one();
        const layout = is.one();
        if (layout !== 12 && layout !== 16 && layout !== 32) throw new Error('X7.1: layout de operandos inválido.');
        const operand = layout === 12 ? is.twelve : (layout === 16 ? is.two : is.four);
        for (let j=0;j<6;j+=1) operand();
        if (localMask) for (let j=0;j<2;j+=1) operand();
        if (targetTokenMask) for (let j=0;j<countIns;j+=1) operand();
        if (routeMask) for (let j=0;j<countIns;j+=1) operand();
        is.align();
        for (let j=0;j<countIns;j+=1) is.one();
        const mapCount = is.one();
        for (let j=0;j<mapCount;j+=1) { is.one(); is.one(); }
        is.align();
        for (let j=0;j<8;j+=1) operand();
        if (feedbackMask) for (let j=0;j<4;j+=1) operand();
        for (let j=0;j<countIns*4;j+=1) operand();
        is.align();
    }
    if (is.pos !== I.length) throw new Error('X7.1: cola en bytecode plano.');

    const ls = readSection(L);
    const ledgerInstr = ls.four();
    const ledgerConst = ls.four();
    const ledgerFn = ls.four();
    const ledgerRoot = ls.four();
    if (ledgerInstr !== totalInstr || ledgerConst !== rc || ledgerFn !== nf || ledgerRoot !== root) throw new Error('X7.1: ledger no coincide.');
    return true;
}

function alphabets() {
    const chars = [];
    for (let code = 33; code <= 126; code += 1) {
        if (code !== 39 && code !== 92) chars.push(String.fromCharCode(code));
    }
    return shuffle(chars).join('');
}
function encodePayload(bytes, seed, step, alphabet, rolling = false) {
    const chunks = [];
    let part = '';
    let k1 = seed & 255;
    let k2 = (seed * 7 + step + 13) & 255;
    let k3 = (seed * 31 + step * 17 + 17) & 255;
    const emit32 = value => {
        let v = value;
        for (let q = 0; q < 5; q += 1) {
            part += alphabet[v % 92];
            v = Math.floor(v / 92);
        }
    };
    for (let i = 0; i < bytes.length; i += 4) {
        const enc = [0,0,0,0];
        for (let q = 0; q < 4; q += 1) {
            const at = i + q;
            if (at >= bytes.length) break;
            let v = (bytes[at] + seed + at * step) & 255;
            if (rolling) {
                const pos = at + 1;
                const lane = pos % 3;
                if (lane === 1) v = (v + k1 + k3 + pos) & 255;
                else if (lane === 2) v = (v - k2 + k3 - pos) & 255;
                else v = (v + k2 - k1 + pos) & 255;
                k1 = (k1 * 13 + v + step) & 255;
                k2 = (k2 * 31 + 17 + pos) & 255;
                k3 = (k3 * 29 + v + 7 + seed) & 255;
            }
            enc[q] = v;
        }
        const value = enc[0] * 16777216 + enc[1] * 65536 + enc[2] * 256 + enc[3];
        emit32(value);
        if (part.length >= 8192) {
            chunks.push(part);
            part = '';
        }
    }
    if (part) chunks.push(part);
    return chunks.join('');
}
function luaQuote(s) { return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
function shellIdentifier(prefix) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let out = prefix || 'v';
    for (let i = 0; i < 7; i += 1) out += alphabet[rand(0, alphabet.length - 1)];
    return out;
}
function makeDispatchTokens() {
    const ids = Array.from({ length: 56 }, (_, i) => i + 1);
    const tokens = shuffle(ids.slice());
    const map = {};
    for (let i = 0; i < ids.length; i += 1) map[ids[i]] = tokens[i];
    if (tokens.every((v, i) => v === ids[i])) [tokens[0], tokens[1]] = [tokens[1], tokens[0]];
    return map;
}
function validateDispatcherPredicates(source) {
    const marker = 'local X;local F=';
    const split = source.indexOf(marker);
    if (split < 0) return source;
    const tail = source.slice(split);
    if (/o==[0-9]+ or o==[0-9]+ then/.test(tail)) {
        throw new Error('X7.1: dispatcher agrupado: cada handler debe tener un predicate único.');
    }
    const seen = new Set();
    const duplicate = new Set();
    for (const match of tail.matchAll(/\b(?:if|elseif) o==([0-9]+) then/g)) {
        const value = Number(match[1]);
        if (seen.has(value)) duplicate.add(value);
        seen.add(value);
    }
    if (duplicate.size) {
        throw new Error('X7.1: dispatcher duplicado: ' + Array.from(duplicate).join(','));
    }
    return source;
}

function validateDispatcherStructure(source) {
    const marker = 'local X;local F=';
    const split = source.indexOf(marker);
    if (split < 0) return source;
    const tail = source.slice(split);
    if (/\bif o==[0-9]+ then\s*(?:elseif|else error)/.test(tail)) {
        throw new Error('X7.1: dispatcher con handler vacío.');
    }
    return source;
}

function polymorphDispatchSource(source, map) {
    const marker = 'local X;local F=';
    const split = source.indexOf(marker);
    if (split < 0) return source;
    const head = source.slice(0, split);
    const tail = source.slice(split);
    const body = tail.replace(/o==([0-9]+)/g, (_, n) => {
        const id = Number(n);
        const mapped = map[id];
        if (!mapped) throw new Error('X7.1: handler de dispatcher sin mapeo: ' + id);
        return 'o==' + String(mapped);
    });
    return validateDispatcherStructure(validateDispatcherPredicates(head + body));
}

function parseDispatcherSource(source) {
    const marker = 'local X;local F=';
    const split = source.indexOf(marker);
    if (split < 0) return null;

    const tail = source.slice(split);
    const start = tail.indexOf('if o==');
    // The final dispatcher clause is followed by the while/function closing
    // ends. Match only the terminal error clause so the parser works before and
    // after runtime compaction.
    const endMarker = "else error('X71 opcode')end";
    const end = tail.indexOf(endMarker, start);
    if (start < 0 || end < 0) throw new Error('X7.1: no se encontró el cuerpo del dispatcher.');

    const chain = tail.slice(start, end);
    const branches = new Map();
    const branchRe = /\b(?:if|elseif) o==([0-9]+) then/g;
    const matches = Array.from(chain.matchAll(branchRe));
    if (!matches.length) throw new Error('X7.1: dispatcher sin handlers.');

    for (let i = 0; i < matches.length; i += 1) {
        const id = Number(matches[i][1]);
        if (branches.has(id)) throw new Error('X7.1: dispatcher plantilla duplicada: ' + id);
        const bodyStart = matches[i].index + matches[i][0].length;
        const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : chain.length;
        const body = chain.slice(bodyStart, bodyEnd).trim();
        if (!body) throw new Error('X7.1: dispatcher plantilla vacía: ' + id);
        branches.set(id, body);
    }

    return {
        prefix: source.slice(0, split + start),
        suffix: ' ' + tail.slice(end),
        branches
    };
}

function buildSpecializedDispatcherSource(source, plan) {
    if (!plan || !plan.map) return source;
    const parsed = parseDispatcherSource(source);
    if (!parsed) return source;

    const used = Array.from(new Set(plan.used || [])).filter(Number.isInteger);
    if (!used.length) throw new Error('X7.1: dispatcher sin handlers usados.');

    const emitted = new Set();
    const chain = used.map((semantic, index) => {
        const body = parsed.branches.get(semantic);
        const handlerId = Number(plan.map[semantic]);
        if (!body) throw new Error('X7.1: falta handler semántico ' + semantic);
        if (!Number.isInteger(handlerId) || handlerId < 1 || handlerId > OP_COUNT) {
            throw new Error('X7.1: handler semántico sin ID ' + semantic);
        }
        if (emitted.has(handlerId)) {
            throw new Error('X7.1: handler ID duplicado ' + handlerId);
        }
        emitted.add(handlerId);
        return (index === 0 ? 'if o==' : 'elseif o==') + handlerId + ' then ' + body;
    }).join(' ');

    return validateDispatcherStructure(
        validateDispatcherPredicates(parsed.prefix + chain + parsed.suffix)
    );
}

function pruneDispatcherHandlers(source, used) {
    if (!used || !used.size) return source;
    const map = {};
    for (const semantic of used) map[semantic] = semantic;
    return buildSpecializedDispatcherSource(source, {
        map,
        used: Array.from(used)
    });
}

function specializeDispatchSource(source, plan) {
    return buildSpecializedDispatcherSource(source, plan);
}

function makeShellNames() {
    const used = new Set();
    const take = prefix => {
        let name;
        do name = shellIdentifier(prefix); while (used.has(name));
        used.add(name);
        return name;
    };
    return {
        payload: take('p'), alphabet: take('a'),
        key: take('k'), step: take('s'), mode: take('m'), guard: take('g'),
        decoder: take('d'), executor: take('o'), runner: take('r')
    };
}
function payloadGuardHash(payload, hi, lo, key, step, mode = 0) {
    let h = 2166136261;
    for (let i = 0; i < payload.length; i += 1) {
        h = (h + payload.charCodeAt(i) * (i + 1) + 17) % 4294967296;
    }
    for (const part of [hi, lo]) {
        for (let i = 0; i < part.length; i += 1) h = (h + part.charCodeAt(i) * (i + 3) + 31) % 4294967296;
    }
    h = (h + (key % 256) * 257 + (step % 256) * 65537 + mode * 104729) % 4294967296;
    return h;
}
function compactRuntimeSource(source) {
    return source
        .replace("local dbg={};", "")
        .replace(/dbg\[#dbg\+1\]=count;/g, "")
        .replace(/fn\.q=\{\};fn\.q=\{\};/g, "fn.q={};")
        .replace(/;local function J\(op,f\).*?end;for pc=1,count do/, ";for pc=1,count do")
        .replace("local semanticByPhysical={};for q=1,56 do semanticByPhysical[q]=iu()end;fn.q=semanticByPhysical;", "fn.q={};local nq=iu();for j=1,nq do local raw=iu();local hid=iu();fn.q[raw]=hid end;")
        .replace(/'X71[^']*'/g, "''");
}

function specializeRuntimeSource(source, options = {}) {
    let out = source;
    const localMask = options.encodeLocalOperands === true;
    const routeMask = options.encodeInstructionRoute === true;
    const feedbackMask = options.encodeOperandFeedback === true;
    const constantMask = options.encodeConstantRoute === true;
    const targetTokenMask = options.encodeTargetTokens === true;
    const rolling = options.rollingPayload === true;

    if (!rolling) {
        out = out.replace(/if t\.m==1 then .*?rk3=\(rk3\*29\+e\+7\+t\.k\)%256 end;/, "");
    }
    if (!localMask) {
        out = out.replace(/;if localMask then fn\.x=\{mul=RV\(\),add=RV\(\),mode=layout\};fn\.x\.inv=INVK\(fn\.x\.mul,layout\)end;/, ";");
        out = out.replace(
            "local function LINV(fn,v)local z=fn.x;if not z then return v end;return D32((v-z.add)%4294967296,z.inv)end;",
            "local function LINV(fn,v)return v end;"
        );
    }
    if (!targetTokenMask) {
        out = out.replace(/;if targetTokenMask then fn\.z\.tokens=\{\};for logical=1,count do fn\.z\.tokens\[RV\(\)\]=logical end end;/, ";");
        out = out.replace(
            "local function INV(fn,v)local z=fn.z;if z.tokens then local pc=z.tokens[v];if not pc then error('X71 target token')end;return pc end;return D32((v-z.add)%4294967296,z.inv)end;",
            "local function INV(fn,v)local z=fn.z;return D32((v-z.add)%4294967296,z.inv)end;"
        );
    }
    if (!routeMask) {
        out = out.replace(/;local route;if routeMask then route=\{\};for logical=1,count do route\[logical\]=RV\(\)end end;/, ";");
        out = out.replace(";fn.y=route;", ";");
        out = out.replace("local e=fn.c[(fn.y and fn.y[pc] or pc)];", "local e=fn.c[pc];");
    }
    if (!feedbackMask) {
        out = out.replace(/;local feedbackKeys;if feedbackMask then feedbackKeys=\{\};for q=1,4 do feedbackKeys\[q\]=RV\(\)end end;/, ";");
        out = out.replace("-(feedbackMask and MUL(previous,feedbackKeys[q])or 0)", "");
    }
    if (!constantMask) {
        out = out.replace(/;local constantRoute;if constantMask then constantRoute=\{\};for logical=1,rc do constantRoute\[logical\]=cV\(\)\+1 end end;/, ";");
        out = out.replace("local physical=constantRoute and constantRoute[logical]or logical;", "local physical=logical;");
    }

    if (!(localMask || routeMask || feedbackMask || constantMask || targetTokenMask)) {
        out = out.replace(/;local FT=sec\[71\];local localMask=.*?targetTokenMask=FT and\(math\.floor\(FT\[1\]\/16\)%2==1\);/, ";");
    }
    return out;
}

function mangleRuntimeIdentifiers(source, reservedNames = []) {
    const candidates = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const names = [
        'UNPACK','INVK','D12','D16','D32','CINV','LINV','INV',
        'GG','SG','N','A','V','B','H','U','S','M','I','X','F'
    ];
    const reserved = new Set(reservedNames);
    const used = new Set((source.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []));
    const taken = new Set();
    const mapping = [];

    for (const original of names) {
        let replacement = null;
        for (const candidate of shuffle(candidates)) {
            if (!used.has(candidate) && !taken.has(candidate) && !reserved.has(candidate)) {
                replacement = candidate;
                break;
            }
        }
        if (!replacement) {
            let i = 0;
            do {
                replacement = 'x' + candidates[i % candidates.length] + Math.floor(i / candidates.length || 1);
                i += 1;
            } while (used.has(replacement) || taken.has(replacement) || reserved.has(replacement));
        }
        taken.add(replacement);
        mapping.push({ original, replacement });
    }

    // Rename through inert placeholders first. This prevents one generated
    // helper name from being mistaken for another helper during a second
    // replacement pass (the mode-16 D16/D32 path is particularly sensitive).
    let out = source;
    const staged = mapping.map((entry, index) => ({
        ...entry,
        token: '__X71_MANGLE_' + index + '__'
    }));
    for (const { original, token } of staged) {
        out = out.replace(new RegExp('\\b' + original + '\\b', 'g'), token);
    }
    for (const { replacement, token } of staged) {
        out = out.replaceAll(token, replacement);
    }
    return out;
}

function validateRuntimeBindings(source) {
    const modeMath = source.match(/fn\.f\.mode==12 and ([A-Za-z_][A-Za-z0-9_]*) or fn\.f\.mode==16 and ([A-Za-z_][A-Za-z0-9_]*) or ([A-Za-z_][A-Za-z0-9_]*)/);
    if (!modeMath) return source;

    const declared = name =>
        source.includes('local function ' + name + '(') ||
        source.includes('local ' + name + '=function(');

    for (const name of [modeMath[1], modeMath[2], modeMath[3]]) {
        if (!declared(name)) {
            throw new Error('X7.1: runtime helper inválido en la ruta de modo 12/16/32: ' + name);
        }
    }
    return source;
}

function makeCompactShellNames(sources = []) {
    const pool = shuffle("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz".split(""));
    const reserved = new Set(["n","h","P","v","z"]);
    const used = new Set();
    for (const source of sources) {
        for (const match of String(source || "").matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
            used.add(match[0]);
        }
    }
    for (let i = pool.length - 1; i >= 0; i -= 1) {
        if (reserved.has(pool[i]) || used.has(pool[i])) pool.splice(i, 1);
    }
    let fallbackIndex = 0;
    const take = () => {
        if (pool.length) return pool.pop();
        let candidate;
        do {
            candidate = 'x' + fallbackIndex++;
        } while (used.has(candidate) || reserved.has(candidate));
        used.add(candidate);
        return candidate;
    };
    return {
        payload: take(),
        alphabet: take(),
        key: take(),
        step: take(),
        mode: take(),
        guard: take(),
        decoder: take(),
        executor: take(),
        packer: take()
    };
}
function x71Loader(program, options = {}) {
    const dispatchPlan = buildDispatchPlan(program);
    const packed = buildContainer(program, { ...options, dispatchPlan });
    validateContainer(packed.bytes);
    const seed = rand(0, 255);
    const step = rand(1, 255);
    const cipherMode = options.rollingPayload === true ? 1 : 0;
    const alphabet = alphabets();
    const payload = encodePayload(packed.bytes, seed, step, alphabet, cipherMode === 1);
    let D = "D=function(t)local s=t.p;local o={};local n=t.n or 0;local rk1=t.k%256;local rk2=(t.k*7+t.s+13)%256;local rk3=(t.k*31+t.s*17+17)%256;local produced=0;local a=t.a;local function ix(ch)local v=string.find(a,ch,1,true);if not v then error('X71 glyph')end;return v-1 end;local function emit(v)if produced>=n then return end;local pos=produced+1;local e=v;if t.m==1 then if pos%3==1 then v=(e-rk1-rk3-pos)%256 elseif pos%3==2 then v=(e+rk2-rk3+pos)%256 else v=(e-rk2+rk1-pos)%256 end;rk1=(rk1*13+e+t.s)%256;rk2=(rk2*31+17+pos)%256;rk3=(rk3*29+e+7+t.k)%256 end;v=(v-t.k-(pos-1)*t.s)%256;produced=produced+1;o[produced]=string.char(v)end;if n<0 or #s%5~=0 then error('X71 payload')end;for i=1,#s,5 do local v=ix(string.sub(s,i,i))+ix(string.sub(s,i+1,i+1))*92+ix(string.sub(s,i+2,i+2))*8464+ix(string.sub(s,i+3,i+3))*778688+ix(string.sub(s,i+4,i+4))*71639296;if v>4294967295 then error('X71 payload value')end;local b1=math.floor(v/16777216);local b2=math.floor(v/65536)%256;local b3=math.floor(v/256)%256;local b4=v%256;emit(b1);emit(b2);emit(b3);emit(b4)end;if produced~=n then error('X71 payload size')end;local r=table.concat(o);local q=function(i)return string.byte(r,i)or error('X71 eof')end;local p=1;local function u()local v=q(p);p=p+1;return v end;local function U()local a,b=u(),u();return a*256+b end;local function V()local a,b,c,d=u(),u(),u(),u();return a*16777216+b*65536+c*256+d end;if q(1)~=88 or q(2)~=55 or q(3)~=71 then error('X71 header')end;p=4;local ns=u();local sec={};for i=1,ns do local id=u();local len=V();local e=p+len-1;local z={};while p<=e do z[#z+1]=u()end;sec[id]=z end;local sealPos=p;local aa=17;local bb=29;for i=1,sealPos-1 do local v=q(i);aa=(aa+v*(i+10))%65521;bb=(bb*33+v+i+6)%65521 end;local expect1=V();local got=(((aa*65536)%4294967296)+bb)%4294967296;if got~=expect1 then error('X71 seal')end;local C=sec[11];local M=sec[19];local I=sec[37];local L=sec[53];local FT=sec[71];local localMask=FT and(FT[1]%2==1);local routeMask=FT and(math.floor(FT[1]/2)%2==1);local feedbackMask=FT and(math.floor(FT[1]/4)%2==1);local constantMask=FT and(math.floor(FT[1]/8)%2==1);local targetTokenMask=FT and(math.floor(FT[1]/16)%2==1);local D12=function(a,b)return(a*b)%4096 end;local D16=function(a,b)return(a*b)%65536 end;local D32=function(a,b)local al=a%65536;local ah=math.floor(a/65536);local bl=b%65536;local bh=b and math.floor(b/65536)or 0;return(al*bl+(al*bh+ah*bl)*65536)%4294967296 end;local INVK=function(m,w)if w==12 then local x=1;for j=1,4 do x=D12(x,(2-D12(m,x))%4096)end;return x end;if w==16 then local x=1;for j=1,4 do x=D16(x,(2-D16(m,x))%65536)end;return x end;local x=1;for j=1,5 do x=D32(x,(2-D32(m,x))%4294967296)end;return x end;if not C or not M or not I or not L then error('X71 sections')end;local lli=1;local function lV()local a,b,c,d=L[lli],L[lli+1],L[lli+2],L[lli+3];lli=lli+4;if not d then error('X71 ledger eof')end;return a*16777216+b*65536+c*256+d end;local expectedInstr=lV();local expectedConst=lV();local expectedFn=lV();local expectedRoot=lV();local ci=1;local function cu()local v=C[ci];ci=ci+1;if not v then error('X71 const eof')end;return v end;local function cU()local a,b=cu(),cu();return a*256+b end;local function cV()local a,b,c,d=cu(),cu(),cu(),cu();return a*16777216+b*65536+c*256+d end;local rc=cU();if rc~=expectedConst then error('X71 const count')end;local constantRoute;if constantMask then constantRoute={};for logical=1,rc do constantRoute[logical]=cV()+1 end end;local physicalConstants={};for i=1,rc do local entryLen=cV();local entryEnd=ci+entryLen;local typ=cu();local key=cu();local st=cu();local es=cu();local shards=cu();local chunks={};for j=1,shards do local si=(cu()-es)%256;local ln=cU();local d={};for k=1,ln do d[k]=cu()end;chunks[#chunks+1]={i=si,d=d}end;table.sort(chunks,function(a,b)return a.i<b.i end);physicalConstants[i]={t=typ,k=key,s=st,c=chunks};if ci~=entryEnd then error('X71 const entry')end end;local function decodeConst(d)local raw={};local pos=0;for _,ch in ipairs(d.c)do for k=1,#ch.d do pos=pos+1;raw[pos]=(ch.d[k]-d.k-ch.i-(k-1)*d.s)%256 end end;local chars={};for i=1,#raw do chars[i]=string.char(raw[i])end;local str=table.concat(chars);if d.t==1 then return str elseif d.t==2 then return tonumber(str)elseif d.t==3 then return string.byte(str,1)==1 else return nil end end;local constants=setmetatable({},{__index=function(t,logical)local physical=constantRoute and constantRoute[logical]or logical;local d=physicalConstants[physical];if not d then return nil end;if d.done then return d.v end;local v=decodeConst(d);d.v=v;d.done=true;d.c=nil;t[logical]=v;return v end});local mi=1;local function mu()local v=M[mi];mi=mi+1;if not v then error('X71 meta eof')end;return v end;local function mU()local a,b=mu(),mu();return a*256+b end;local function mV()local a,b,c,d=mu(),mu(),mu(),mu();return a*16777216+b*65536+c*256+d end;local nf=mU();local root=mU();if nf~=expectedFn or root~=expectedRoot then error('X71 ledger mismatch')end;local f={};for i=1,nf do local mk=mV();local step=mV();local vararg=mU()==1;local function mv(index)local v=mV();local x=D32(v,4294901761);return (x-mk-index*step)%4294967296 end;local fn={p={},u={},i={},c={},l=mv(1),r=mv(2),v=vararg,q=nil,z=nil,f=nil,k=nil};local np=mU();for j=1,np do fn.p[j]=mv(10+j-1)end;local nu=mU();for j=1,nu do fn.u[j]={((mu()-(mk%256)-((j-1)*17))%256+256)%256,mv(200+j-1)}end;local ni=mU();for j=1,ni do local it={};local n=mU();for k=1,n do it[k]=mv(400+(j-1)*97+(k-1))end;fn.i[j]=it end;f[i]=fn end;local li=1;local function iu()local v=I[li];li=li+1;if not v then error('X71 code eof')end;return v end;local function iU()local a,b=iu(),iu();return a*256+b end;local iB=0;local iBits=0;local function i12()while iBits<12 do iB=iB+iu()*2^iBits;iBits=iBits+8 end;local v=iB%4096;iB=math.floor(iB/4096);iBits=iBits-12;return v end;local function iA()iB=0;iBits=0 end;local function iV()local a,b,c,d=iu(),iu(),iu(),iu();return a*16777216+b*65536+c*256+d end;local nfi=iU();if nfi~=nf then error('X71 fn count')end;local actualInstr=0;local dbg={};for i=1,nf do local fn=f[i];local count=iV();dbg[#dbg+1]=count;actualInstr=actualInstr+count;local order={iu(),iu(),iu(),iu()};local layout=iu();if layout~=12 and layout~=16 and layout~=32 then error('X71 layout')end;local RV=layout==12 and i12 or layout==16 and iU or iV;local MUL=layout==12 and D12 or layout==16 and D16 or D32;local MW=layout==12 and 4096 or layout==16 and 65536 or 4294967296;fn.z={mul=RV(),add=RV(),mode=layout};fn.z.inv=INVK(fn.z.mul,layout);fn.f={mul=RV(),add=RV(),mode=layout};fn.f.inv=INVK(fn.f.mul,layout);fn.k={mul=RV(),add=RV(),mode=layout};fn.k.inv=INVK(fn.k.mul,layout);if localMask then fn.x={mul=RV(),add=RV(),mode=layout};fn.x.inv=INVK(fn.x.mul,layout)end;if targetTokenMask then fn.z.tokens={};for logical=1,count do fn.z.tokens[RV()]=logical end end;local route;if routeMask then route={};for logical=1,count do route[logical]=RV()end end;iA();local opcodes={};for j=1,count do opcodes[j]=iu()end;fn.q={};local nq=iu();for j=1,nq do local raw=iu();local hid=iu();fn.q[raw]=hid end;iA();fn.y=route;local pk={};local ps={};for q=1,4 do pk[q]=RV();ps[q]=RV()end;local feedbackKeys;if feedbackMask then feedbackKeys={};for q=1,4 do feedbackKeys[q]=RV()end end;local planes={{},{},{},{}};for q=1,4 do local previous=0;for j=1,count do local encoded=RV();local v=(encoded-pk[q]-((j-1)*ps[q])-(feedbackMask and MUL(previous,feedbackKeys[q])or 0))%MW;planes[q][j]=v;previous=encoded end end;local function J(op,f)if(op==24 or op==32 or op==46)and f==1 then return true elseif(op==25 or op==26)and f==2 then return true elseif(op==28 or op==29)and f==1 then return true elseif op==30 and f==4 then return true elseif op==31 and(f==1 or f==2)then return true elseif(op==38 or op==39 or op==48 or op==49)and f==4 then return true end;return false end;for pc=1,count do local vals={0,0,0,0};for logical=1,4 do local oi=order[logical];local plane=planes[oi];if not plane then error('X71 plane map '..tostring(i)..':'..tostring(logical)..':'..tostring(oi))end;local pv=plane[pc];if pv==nil then error('X71 plane eof '..tostring(i)..':'..tostring(pc))end;vals[logical]=pv end;local phys=opcodes[pc];local sem=fn.q[phys];if not sem then error('X71 opcode map')end;local e={phys,vals[1],vals[2],vals[3],vals[4]};fn.c[pc]=e end end;iA();if actualInstr~=expectedInstr then error('X71 instruction count '..tostring(actualInstr)..'/'..tostring(expectedInstr))end;return{k=constants,f=f,r=root}end";
    let O = "O=function(t,P,id,pl,pu,a)local PACK=function(...)local z={...};z.n=select('#',...);return z end;local UNPACK=(type(unpack)=='function'and unpack)or function(v,i,j)i=i or 1;j=j or #v;if i>j then return end;return v[i],UNPACK(v,i+1,j)end;local M=function(v,n)return{z=1,n=n,v=v}end;local I=function(v)return type(v)=='table'and v.z==1 end;local GE=(type(getgenv)=='function'and getgenv())or nil;local RE=(type(getrenv)=='function'and getrenv())or nil;local FE;if type(getfenv)=='function'then local ok,e=pcall(getfenv,0);if ok then FE=e end end;local EE=type(_ENV)=='table'and _ENV or nil;local G=GE or RE or FE or EE or _G;local GG=function(k)local v=GE and GE[k]or nil;if v~=nil then return v end;v=RE and RE[k]or nil;if v~=nil then return v end;v=FE and FE[k]or nil;if v~=nil then return v end;v=EE and EE[k]or nil;if v~=nil then return v end;v=_G and _G[k]or nil;if v~=nil then return v end;v=G and G[k]or nil;if v~=nil then return v end;error('X71 global '..tostring(k))end;local SG=function(k,v)if GE then GE[k]=v elseif RE then RE[k]=v elseif FE then FE[k]=v elseif EE then EE[k]=v else G[k]=v end end;local U=function(x)x=x%4294967296;if x<0 then x=x+4294967296 end;return x end;local S=function(x)x=U(x);if x>=2147483648 then return x-4294967296 end;return x end;local B=function(x,y,m)x=U(x);y=U(y);local r=0;local b=1;for i=1,32 do local a=x%2>=1;local c=y%2>=1;if(m==1 and a and c)or(m==2 and(a or c))or(m==3 and(a~=c))then r=r+b end;x=math.floor(x/2);y=math.floor(y/2);b=b*2 end;return S(r)end;local H=function(x,y,m)local n=math.floor(y);if n<0 then n=-n;m=m==1 and 2 or 1 end;if n>=32 then if m==1 then return 0 end;return S(x)<0 and -1 or 0 end;local u=U(x);if m==1 then return S(u*2^n%4294967296)end;return math.floor(S(x)/2^n)end;local function N(o,x,y)if o==1 then return x+y elseif o==2 then return x-y elseif o==3 then return x*y elseif o==4 then return x/y elseif o==5 then return x%y elseif o==6 then return x^y elseif o==7 then return x..y elseif o==8 then return x==y elseif o==9 then return x~=y elseif o==10 then return x<y elseif o==11 then return x>y elseif o==12 then return x<=y elseif o==13 then return x>=y elseif o==14 then return math.floor(x/y) elseif o==15 then return B(x,y,1) elseif o==16 then return B(x,y,2) elseif o==17 then return B(x,y,3) elseif o==18 then return H(x,y,1) elseif o==19 then return H(x,y,2) end;error('X71 bin '..tostring(o)..':'..tostring(x)..':'..tostring(y))end;local function A(o,x)if o==1 then return not x elseif o==2 then return -x elseif o==3 then return#x elseif o==4 then return S(4294967295-U(x)) end;error('X71 unary')end;local function V(f,a)local r=PACK(f(UNPACK(a,1,a.n or#a)));if r.n==1 and I(r[1])then return r[1]end;return M(r,r.n)end;local function D12(a,b)return(a*b)%4096 end;local function D16(a,b)return(a*b)%65536 end;local function D32(a,b)local al=a%65536;local ah=math.floor(a/65536);local bl=b%65536;local bh=math.floor(b/65536);return(al*bl+(al*bh+ah*bl)*65536)%4294967296 end;local function INV(fn,v)local z=fn.z;if z.tokens then local pc=z.tokens[v];if not pc then error('X71 target token')end;return pc end;local fm=z.mode==12 and 4096 or z.mode==16 and 65536 or 4294967296;local fmul=z.mode==12 and D12 or z.mode==16 and D16 or D32;return fmul((v-z.add)%fm,z.inv)end;local function CINV(fn,v)local z=fn.k;local fm=z.mode==12 and 4096 or z.mode==16 and 65536 or 4294967296;local fmul=z.mode==12 and D12 or z.mode==16 and D16 or D32;return fmul((v-z.add)%fm,z.inv)end;local function LINV(fn,v)local z=fn.x;if not z then return v end;local fm=z.mode==12 and 4096 or z.mode==16 and 65536 or 4294967296;local fmul=z.mode==12 and D12 or z.mode==16 and D16 or D32;return fmul((v-z.add)%fm,z.inv)end;local X;local F=function(i,l,u)return function(...)return X(t,P,i,l,u,PACK(...),true)end end;X=function(t,P,id,pl,pu,a,raw)local fn=P.f[id+1];if not fn then error('X71 fn '..tostring(id)..'/'..tostring(#P.f))end;local lc={};for i=1,fn.l do lc[i]={v=nil}end;local uv={};for i=1,#fn.u do local q=fn.u[i];local z=q[1]==0 and pl and pl[q[2]+1]or pu and pu[q[2]+1];if not z then error('X71 upvalue')end;uv[i]=z end;for i=1,#fn.p do local q=fn.p[i]+1;if q>0 and q<=#lc then lc[q].v=a[i]end end;local va={n=0};if fn.v then for i=#fn.p+1,a.n do va.n=va.n+1;va[va.n]=a[i]end end;local r={};local pc=1;local lp={};local steps=0;while pc<=#fn.c do steps=steps+1;if steps>5000000 then error('X71 step')end;local e=fn.c[(fn.y and fn.y[pc] or pc)];pc=pc+1;local o=fn.q[e[1]];if not o then error('X71 opcode')end;local a1,b,c,d=e[2],e[3],e[4],e[5];if o==1 then pc=pc elseif o==2 then r[a1]=P.k[CINV(fn,b)+1] elseif o==3 then local q=lc[LINV(fn,b)+1];r[a1]=q and q.v elseif o==4 then local la=LINV(fn,a1);lc[la+1]=lc[la+1]or{v=nil};lc[la+1].v=r[b] elseif o==5 then r[a1]=GG(P.k[CINV(fn,b)+1]) elseif o==6 then SG(P.k[CINV(fn,a1)+1],r[b]) elseif o==36 then local q=uv[b+1];if not q then error('X71 upvalue')end;r[a1]=q.v elseif o==37 then local q=uv[a1+1];if not q then error('X71 upvalue')end;q.v=r[b] elseif o==7 then local q=r[b];r[a1]=q and q[P.k[CINV(fn,c)+1]] elseif o==8 then local q=r[a1];if not q then error('X71 member')end;q[P.k[CINV(fn,b)+1]]=r[c] elseif o==9 then local q=r[b];r[a1]=q and q[r[c]] elseif o==10 then local q=r[a1];if not q then error('X71 index')end;q[r[b]]=r[c] elseif o==11 then local fm=fn.f.mode==12 and 4096 or fn.f.mode==16 and 65536 or 4294967296;local fmul=fn.f.mode==12 and D12 or fn.f.mode==16 and D16 or D32;local fid=fmul((b-fn.f.add)%fm,fn.f.inv);r[a1]=F(fid,lc,uv) elseif o==12 then r[a1]=N(d,r[b],r[c]) elseif o==13 then r[a1]=A(c,r[b]) elseif o==14 then r[a1]={} elseif o==15 then r[a1]=va[1] elseif o==54 then r[a1]=M(va,va.n) elseif o==16 then r[a1]=r[b] elseif o==17 then local q={};for i=1,c do q[i]=r[b+i]end;local v=V(r[b],q);r[a1]=v.v[1] elseif o==18 then local q={};for i=1,c do q[i]=r[b+i]end;local v=V(r[b],q);r[a1]=v elseif o==19 then local q=r[b];local w={q};for i=1,d do w[i+1]=r[b+i]end;local cm=CINV(fn,c);local v=V(q[P.k[cm+1]],w);r[a1]=v.v[1] elseif o==20 then local q=r[b];local w={q};for i=1,d do w[i+1]=r[b+i]end;local cm=CINV(fn,c);local v=V(q[P.k[cm+1]],w);r[a1]=v elseif o==55 then local q={};for i=1,c do q[i]=r[b+i]end;local w=r[d];if I(w)then for i=1,w.n do q[c+i]=w.v[i]end else q[c+1]=w end;q.n=c+(I(w)and w.n or 1);r[a1]=V(r[b],q).v[1] elseif o==56 then local n=d%65536;local q=math.floor(d/65536)%65536;local w=r[b];local v={w};for i=1,n do v[i+1]=r[b+i]end;local x=r[q];if I(x)then for i=1,x.n do v[n+i+1]=x.v[i]end else v[n+2]=x end;v.n=n+(I(x)and x.n or 1)+1;local y=V(w[P.k[CINV(fn,c)+1]],v);r[a1]=y.v[1] elseif o==50 then if raw then return end;return M({},0) elseif o==21 then local v=r[a1];if raw then if I(v)then return UNPACK(v.v,1,v.n)end;return v end;return I(v)and v or M({v},1) elseif o==22 then local v={};for i=1,b do v[i]=r[a1+i-1]end;if raw then return UNPACK(v,1,b)end;return M(v,b) elseif o==23 then local v={};for i=1,c do v[i]=r[b+i-1]end;r[a1]=M(v,c) elseif o==51 then local v=r[b];local w=I(v)and v.v or{v};for i=1,c do r[a1+i-1]=w[i]end elseif o==52 then local v={};for i=1,b do v[i]=r[a1+i-1]end;local w=r[c];if I(w)then for i=1,w.n do v[b+i]=w.v[i]end else v[b+1]=w end;local rr=M(v,b+(I(w)and w.n or 1));if raw then return UNPACK(v,1,rr.n)end;return rr elseif o==53 then local v=r[a1];local w=r[b];local q=I(w)and w.v or{w};for i=1,#q do v[c+i-1]=q[i]end elseif o==24 then pc=INV(fn,e[2]) elseif o==25 then if not r[a1]then pc=INV(fn,b)end elseif o==26 then if r[a1]then pc=INV(fn,b)end elseif o==27 then local q={s=LINV(fn,a1),c=r[b],f=r[c],t=r[d]};if q.t==0 then error('X71 for')end;lp[#lp+1]=q elseif o==28 then local q=lp[#lp];local keep=q.t>0 and q.c<=q.f or q.t<0 and q.c>=q.f;if not keep then lp[#lp]=nil;pc=INV(fn,a1)else lc[q.s+1]=lc[q.s+1]or{v=nil};lc[q.s+1].v=q.c end elseif o==29 then local q=lp[#lp];q.c=q.c+q.t;local keep=q.t>0 and q.c<=q.f or q.t<0 and q.c>=q.f;if keep then lc[q.s+1].v=q.c else lp[#lp]=nil;pc=INV(fn,a1)end elseif o==30 then local q=r[a1];if not I(q)or q.n<3 then error('X71 iter')end;local w=q.v[1];local z=q.v[2];local y=q.v[3];local v=V(w,{z,y});local n=fn.i[c+1]or{};local x={fn=w,st=z,co=v.v[1],sl=n};if x.co==nil then pc=INV(fn,d)else lp[#lp+1]=x;for i=1,b do lc[n[i]+1]=lc[n[i]+1]or{v=nil};lc[n[i]+1].v=v.v[i]end end elseif o==31 then local q=lp[#lp];local w=V(q.fn,{q.st,q.co});q.co=w.v[1];if q.co==nil then lp[#lp]=nil;pc=INV(fn,b)else for i=1,#q.sl do lc[q.sl[i]+1].v=w.v[i]end;pc=INV(fn,a1)end elseif o==32 then lp[#lp]=nil;pc=INV(fn,a1)elseif o==33 then local la=LINV(fn,a1);local ld=LINV(fn,d);lc[ld+1]=lc[ld+1]or{v=nil};lc[ld+1].v=N(c,lc[la]and lc[la].v,P.k[CINV(fn,b)+1])elseif o==34 then local la=LINV(fn,a1);local lb=LINV(fn,b);local ld=LINV(fn,d);lc[ld+1]=lc[ld+1]or{v=nil};lc[ld+1].v=N(c,lc[la]and lc[la].v,lc[lb]and lc[lb].v)elseif o==35 then local v=V(GG(P.k[CINV(fn,b)+1]),{});r[a1]=c==1 and v or v.v[1]elseif o==38 then if not N(c,r[a1],r[b])then pc=INV(fn,d)end elseif o==39 then if N(c,r[a1],r[b])then pc=INV(fn,d)end else error('X71 opcode')end end;if raw then return nil end;return M({nil},1)end;return X(t,P,id,pl,pu,a)end";
    if (options.specializeDispatch !== false) {
        O = specializeDispatchSource(O, dispatchPlan);
    }

    if (options.preferNativeGlobals === true) {
        const oldEnv = "local G=GE or RE or FE or EE or _G;local GG=function(k)local v=GE and GE[k]or nil;if v~=nil then return v end;v=RE and RE[k]or nil;if v~=nil then return v end;v=FE and FE[k]or nil;if v~=nil then return v end;v=EE and EE[k]or nil;if v~=nil then return v end;v=_G and _G[k]or nil;if v~=nil then return v end;v=G and G[k]or nil;if v~=nil then return v end;error('X71 global '..tostring(k))end;local SG=function(k,v)if GE then GE[k]=v elseif RE then RE[k]=v elseif FE then FE[k]=v elseif EE then EE[k]=v else G[k]=v end end;";
        const newEnv = "local E={RE,FE,EE,_G,GE};local G=E[1]or E[2]or E[3]or E[4]or E[5];local GG=function(k)for i=1,#E do local e=E[i];local v=e and e[k];if v~=nil then return v end end;error('')end;local SG=function(k,v)if G then G[k]=v end end;";
        O = O.replace(oldEnv, newEnv);
    }
    // The dispatch plan already randomizes handler IDs. Applying a second textual
    // permutation here would desynchronize the runtime fn.q -> handler map.
    if (options.compactRuntime === true) {
        D = specializeRuntimeSource(D, options);
        D = compactRuntimeSource(D)
            .replace("D=function(t)local s=t.p;", "function(p,a,n,k,w,h)local s=p;")
            .replaceAll("t.a", "a")
            .replaceAll("t.n", "n")
            .replaceAll("t.k", "k")
            .replaceAll("t.s", "w")
            .replaceAll("t.m", "h");

        O = specializeRuntimeSource(O, options);
        O = compactRuntimeSource(O)
            .replace("O=function(t,P,id,pl,pu,a)", "function(P,id,pl,pu,a)")
            .replace("X=function(t,P,id,pl,pu,a,raw)", "X=function(P,id,pl,pu,a,raw)")
            .replaceAll("X(t,P,", "X(P,")
            .replace("local PACK=function(...)local z={...};z.n=select('#',...);return z end;", "")
            .replaceAll("PACK", "__X71_PACK__");

        // Shell names are selected only after both compact runtimes exist, so
        // none of the short outer identifiers can collide with D/O locals.
        const shell = makeCompactShellNames([D, O]);
        const shellNames = Object.values(shell);
        D = mangleRuntimeIdentifiers(D, shellNames);
        O = mangleRuntimeIdentifiers(O, shellNames);
        O = O.replaceAll("__X71_PACK__", shell.packer);
        O = validateRuntimeBindings(O);

        const guard = options.runtimeGuard ? payloadGuardHash(payload, alphabet, '', seed, step, cipherMode) : 0;

        const compactGuard = options.runtimeGuard === true;
        let wrapper = "return(function(" +
            shell.payload + "," + shell.alphabet + ",n," +
            shell.key + "," + shell.step +
            (compactGuard ? "," + shell.mode + "," + shell.guard : "") + ",...)";
        wrapper += "local " + shell.packer + "=function(...)local z={...};z.n=select('#',...);return z end;";
        wrapper += "local " + shell.decoder + "=(" + D + ");";
        wrapper += "local " + shell.executor + "=(" + O + ");";

        if (options.runtimeGuard) {
            wrapper += "local h=2166136261;";
            wrapper += "for i=1,#" + shell.payload + " do h=(h+string.byte(" + shell.payload + ",i)*i+17)%4294967296 end;";
            wrapper += "for j=1,#" + shell.alphabet + " do h=(h+string.byte(" + shell.alphabet + ",j)*(j+2)+31)%4294967296 end;";
            wrapper += "h=(h+(" + shell.key + "%256)*257+(" + shell.step + "%256)*65537+(" + shell.mode + "%256)*104729)%4294967296;";
            wrapper += "if h~=" + shell.guard + " then error('')end;";
        }

        wrapper += "local P=" + shell.decoder + "(" +
            shell.payload + "," + shell.alphabet + ",n," +
            shell.key + "," + shell.step +
            (options.rollingPayload === true ? "," + shell.mode : "") + ");";

        if (options.purgePayload === true) {
            wrapper += shell.payload + "=nil;" + shell.alphabet + "=nil;n=nil;" +
                shell.key + "=nil;" + shell.step + "=nil;" + shell.mode + "=nil;" +
                shell.guard + "=nil;";
        }

        wrapper += "local v=" + shell.executor + "(P,P.r,nil,nil," + shell.packer + "(...));";
        wrapper += "return v.v[1]end)(";
        wrapper += luaQuote(payload) + "," + luaQuote(alphabet) + "," + packed.bytes.length + "," +
            seed + "," + step +
            (compactGuard ? "," + cipherMode + "," + guard : "") + ",...)";
        return wrapper;
    }

    const shell = options.polymorphicShell
        ? (() => {
            const random = makeShellNames();
            return { payload: 'p', hi: 'h', lo: 'l', key: 'k', step: 's', mode: 'm', guard: 'g',
                decoder: random.decoder, executor: random.executor, runner: random.runner };
        })()
        : { payload: 'p', hi: 'h', lo: 'l', key: 'k', step: 's', mode: 'm', guard: 'g',
            decoder: 'D', executor: 'O', runner: 'R' };
    const guard = options.runtimeGuard ? payloadGuardHash(payload, alphabet, '', seed, step, cipherMode) : 0;
    const guardField = options.runtimeGuard ? "," + shell.guard + "=" + guard : "";
    let R = options.runtimeGuard
        ? "R=function(t,...)local PACK=function(...)local z={...};z.n=select('#',...);return z end;local h=2166136261;for i=1,#t.p do h=(h+string.byte(t.p,i)*i+17)%4294967296 end;for j=1,#t.a do h=(h+string.byte(t.a,j)*(j+2)+31)%4294967296 end;h=(h+(t.k%256)*257+(t.s%256)*65537+(t.m%256)*104729)%4294967296;if h~=t.g then error('X71 integrity guard')end;local P=t:D();local v=t:O(P,P.r,nil,nil,PACK(...));return v.v[1]end"
        : "R=function(t,...)local PACK=function(...)local z={...};z.n=select('#',...);return z end;local P=t:D();local v=t:O(P,P.r,nil,nil,PACK(...));return v.v[1]end";
    if (options.purgePayload === true) {
        R = R.replace("local P=t:D();", "local P=t:D();t.p=nil;t.a=nil;t.n=nil;t.k=nil;t.s=nil;t.m=nil;t.g=nil;");
    }

    if (options.compactRuntime === true) {
        R = compactRuntimeSource(R);
    }
    // D/O/R are generated as source fragments. X7.2 randomizes the public
    // field names on every build while preserving the VM semantics.
    const bindShell = src => src
        .replaceAll('t.p', 't.' + shell.payload)
        .replaceAll('t.a', 't.' + shell.alphabet)
        .replaceAll('t.k', 't.' + shell.key)
        .replaceAll('t.s', 't.' + shell.step)
        .replaceAll('t.g', 't.' + shell.guard)
        .replaceAll('t:D(', 't:' + shell.decoder + '(')
        .replaceAll('t:O(', 't:' + shell.executor + '(')
        .replaceAll('t:R(', 't:' + shell.runner + '(');
    const boundD = bindShell(D);
    const boundO = bindShell(O);
    const boundR = bindShell(R);
    const object =
        shell.payload + "=" + luaQuote(payload) +
        "," + shell.alphabet + "=" + luaQuote(alphabet) +
        ",n=" + packed.bytes.length +
        "," + shell.key + "=" + seed +
        "," + shell.step + "=" + step +
        "," + shell.mode + "=" + cipherMode +
        guardField +
        "," + shell.decoder + "=(" + boundD.slice(boundD.indexOf("=") + 1) + ")" +
        "," + shell.executor + "=(" + boundO.slice(boundO.indexOf("=") + 1) + ")" +
        "," + shell.runner + "=(" + boundR.slice(boundR.indexOf("=") + 1) + ")";
    return "return({" + object + "}):" + shell.runner + "(...)";
}
class X71CodeGenerator {
    generate(source, options = {}) {
        if (typeof source !== 'string' || !source.trim()) throw new Error('El código Lua/Luau está vacío.');
        const preset = resolvePreset(options.preset);
        const native = buildNativeProgram(source, { polymorphOptions: preset.polymorph });
        native.metadata = { ...(native.metadata || {}), strengthPreset: preset.name, engine: 'X7.1 layered' };
        const program = buildEmissionPlan(native, {
            backend: options.backend === undefined ? preset.backend : options.backend,
            diversify: options.diversify || preset.diversify,
            registers: { ...(options.registers || preset.registers || {}), chance: 0 },
            isa: options.isa || preset.isa
        });
        return x71Loader(program, {
            compactRuntime: options.compactRuntime !== false
        });
    }
}
X71CodeGenerator.buildContainer = buildContainer;
X71CodeGenerator.x71Loader = x71Loader;
X71CodeGenerator.payloadGuardHash = payloadGuardHash;
X71CodeGenerator.buildDispatchPlan = buildDispatchPlan;
X71CodeGenerator.specializeDispatchSource = specializeDispatchSource;
X71CodeGenerator.mangleRuntimeIdentifiers = mangleRuntimeIdentifiers;
X71CodeGenerator.validateRuntimeBindings = validateRuntimeBindings;
module.exports = X71CodeGenerator;
