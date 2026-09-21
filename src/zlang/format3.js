const { makeProtectionProfile, encodeU32, encodeOpcode, encodeConstantByte, seal } = require('./protection');

// Format 3.1: typed program container with per-function closure metadata.
// MAGIC changed so old decoders fail closed instead of silently misreading fields.
const MAGIC = [90, 51, 3];
const CONST_STRING = 1;
const CONST_NUMBER = 2;
const CONST_BOOLEAN = 3;
const CONST_NIL = 4;

function pushU16(out, value) {
    out.push((value >>> 8) & 255, value & 255);
}

function pushU32(out, value) {
    out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
}

function pushBytes(out, bytes) {
    for (const byte of bytes) out.push(byte);
}

function getProtection(program, options) {
    // Generate a fresh profile for every package by default. An explicit
    // profile is only used when callers need deterministic reproduction.
    return options.protection || makeProtectionProfile(program.functions.length);
}

function encodeConstantBytes(bytes, type, profile) {
    const out = [];
    for (let i = 0; i < bytes.length; i += 1) out.push(encodeConstantByte(bytes[i], profile.constant, i, type));
    return out;
}

function encodeProgram(program, options = {}) {
    const protection = getProtection(program, options);
    if (!protection || !protection.constant || !protection.operand || !protection.opcode) throw new Error('Z3 protection profile inválido.');
    if (protection.functions.length !== program.functions.length) throw new Error('Z3 protection profile: función count mismatch.');

    const out = [...MAGIC];
    // Backend tag: 0 = stack VM, 1 = register VM.
    out.push(program.backend === 'register' ? 1 : 0);
    out.push(protection.constant.seed, protection.constant.step, protection.constant.mul, protection.constant.inv);
    pushU32(out, protection.operand.seed);
    pushU32(out, protection.operand.step);
    pushU32(out, protection.operand.salt);
    pushU32(out, protection.operand.mul);
    pushU32(out, protection.operand.inv);
    pushU32(out, protection.operand.functionKey);
    out.push(protection.opcode.seed, protection.opcode.step, protection.opcode.mul, protection.opcode.inv);

    const sealOffset = out.length;
    pushU32(out, 0);
    const bodyStart = out.length;

    pushU32(out, program.constants.length);
    for (const constant of program.constants) {
        const type = constant.type & 255;
        out.push(type);
        let bytes;
        if (type === CONST_STRING) bytes = Buffer.from(String(constant.value), 'utf8');
        else if (type === CONST_NUMBER) bytes = Buffer.from(String(constant.value), 'utf8');
        else if (type === CONST_BOOLEAN) bytes = Uint8Array.from([Number(constant.value) ? 1 : 0]);
        else if (type === CONST_NIL) bytes = Uint8Array.from([0]);
        else throw new Error(`Z constant type inválido: ${constant.type}`);
        pushU32(out, bytes.length);
        pushBytes(out, encodeConstantBytes(bytes, type, protection));
    }

    pushU32(out, program.functions.length);
    for (let functionIndex = 0; functionIndex < program.functions.length; functionIndex += 1) {
        const fn = program.functions[functionIndex];
        const fnProfile = protection.functions[functionIndex];
        const upvalues = Array.isArray(fn.upvalues) ? fn.upvalues : [];
        const iteratorLayouts = Array.isArray(fn.iteratorLayouts) ? fn.iteratorLayouts : [];

        out.push(fnProfile.key, fnProfile.salt);
        const opcodeCount = program.backend === 'register' ? Math.max(1, require('./registerVm').REG_OPCODE_COUNT) : require('./compiler3').OPCODE_COUNT;
        const opcodeDecode = Array.isArray(fn.opcodeDecode) ? fn.opcodeDecode : [0, ...Array.from({ length: opcodeCount }, (_, index) => index + 1)];
        if (opcodeDecode.length < 2 || opcodeDecode.length > 256) throw new Error('Z opcode decode table inválida.');
        out.push(opcodeDecode.length - 1);
        for (let i = 1; i < opcodeDecode.length; i += 1) {
            const semantic = opcodeDecode[i];
            if (!Number.isInteger(semantic) || semantic < 1 || semantic > 255) throw new Error('Z opcode decode entry inválida.');
            out.push(semantic & 255);
        }
        const operandLayouts = Array.isArray(fn.operandLayouts) && fn.operandLayouts.length ? fn.operandLayouts : [[1, 2, 3, 4]];
        if (operandLayouts.length > 24) throw new Error('Z operand layout table demasiado grande.');
        out.push((operandLayouts.length + fnProfile.key + fnProfile.salt) & 255);
        for (let layoutIndex = 0; layoutIndex < operandLayouts.length; layoutIndex += 1) {
            const layout = operandLayouts[layoutIndex];
            if (!Array.isArray(layout) || layout.length !== 4 || new Set(layout).size !== 4 || layout.some(v => !Number.isInteger(v) || v < 1 || v > 4)) {
                throw new Error('Z operand layout inválido.');
            }
            for (let slot = 0; slot < 4; slot += 1) {
                out.push((layout[slot] + fnProfile.key + (layoutIndex + 1) * 19 + (slot + 1) * 7) & 255);
            }
        }
        pushU16(out, fn.params.length);
        out.push(fn.vararg ? 1 : 0);
        pushU32(out, fn.localCount >>> 0);
        pushU32(out, fn.registerCount >>> 0 || 0);
        pushU32(out, fn.pcTargetAdd >>> 0);
        pushU16(out, upvalues.length);

        for (let i = 0; i < upvalues.length; i += 1) {
            const ref = upvalues[i] || {};
            const kind = ref.kind === 'local' ? 0 : 1;
            out.push((kind + fnProfile.key + i * 17) & 255);
            pushU32(out, encodeU32(ref.index >>> 0, protection.operand, 0, 5, fnProfile.key));
        }

        pushU16(out, iteratorLayouts.length);
        for (const layout of iteratorLayouts) {
            if (!Array.isArray(layout) || layout.length > 255) throw new Error('Z iterator layout inválido.');
            out.push(layout.length & 255);
            for (let i = 0; i < layout.length; i += 1) {
                pushU32(out, encodeU32(layout[i] >>> 0, protection.operand, 0, 6 + i, fnProfile.key));
            }
        }

        for (let i = 0; i < fn.params.length; i += 1) {
            pushU32(out, encodeU32(fn.params[i] >>> 0, protection.operand, 0, 0, fnProfile.key));
        }

        pushU32(out, fn.code.length);
        for (let pc = 1; pc <= fn.code.length; pc += 1) {
            const instruction = fn.code[pc - 1];
            if (!Array.isArray(instruction) || instruction.length !== 5) throw new Error('Z instruction inválida.');
            const opcodeKey = (fnProfile.key + fnProfile.salt) & 255;
            out.push(encodeOpcode(instruction[0], protection.opcode, pc, opcodeKey));
            const schemaId = Array.isArray(fn.operandSchema) ? Number(fn.operandSchema[pc - 1] ?? 0) : 0;
            if (!Number.isInteger(schemaId) || schemaId < 0 || schemaId >= operandLayouts.length) throw new Error('Z operand schema inválido.');
            const operandPermutation = operandLayouts[schemaId];
            out.push((schemaId + fnProfile.key + pc * 13) & 255);
            const encodedFields = new Array(4);
            for (let field = 1; field <= 4; field += 1) {
                encodedFields[field - 1] = encodeU32(instruction[field], protection.operand, pc, field, fnProfile.key);
            }
            for (let slot = 1; slot <= 4; slot += 1) {
                const canonicalField = operandPermutation.indexOf(slot);
                pushU32(out, encodedFields[canonicalField]);
            }
        }
    }

    const body = out.slice(bodyStart);
    const bodySeal = seal(body);
    out[sealOffset] = (bodySeal >>> 24) & 255;
    out[sealOffset + 1] = (bodySeal >>> 16) & 255;
    out[sealOffset + 2] = (bodySeal >>> 8) & 255;
    out[sealOffset + 3] = bodySeal & 255;
    return Uint8Array.from(out);
}

module.exports = { MAGIC, CONST_STRING, CONST_NUMBER, CONST_BOOLEAN, CONST_NIL, encodeProgram };
