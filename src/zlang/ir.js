const crypto = require('crypto');
const { OPS, OPCODE_COUNT } = require('./compiler3');
const { validateRegisterProgram } = require('./registerVm');

const IR_VERSION = 2;

function assertInstruction(ins, fnId, pc) {
    if (!Array.isArray(ins) || ins.length !== 5) throw new Error(`ZIR instrucción inválida en función ${fnId}, pc ${pc}.`);
    for (const value of ins) if (!Number.isInteger(value) || value < 0) throw new Error(`ZIR operando inválido en función ${fnId}, pc ${pc}.`);
    if (!Number.isInteger(ins[0]) || ins[0] < 1 || ins[0] > OPCODE_COUNT) throw new Error(`ZIR opcode inválido ${ins[0]} en función ${fnId}.`);
}

function validateIR(program) {
    if (!program || program.version !== 3 || !Array.isArray(program.constants) || !Array.isArray(program.functions)) {
        throw new TypeError('ZIR: programa Z3 inválido.');
    }
    if (program.irVersion !== undefined && program.irVersion !== IR_VERSION) {
        throw new Error(`ZIR versión incompatible: ${program.irVersion}. Se esperaba ${IR_VERSION}.`);
    }
    if (program.backend === 'register') {
        return validateRegisterProgram(program);
    }
    for (let fnId = 0; fnId < program.functions.length; fnId += 1) {
        const fn = program.functions[fnId];
        if (!fn || !Array.isArray(fn.params) || !Array.isArray(fn.code)) throw new Error(`ZIR función ${fnId} inválida.`);
        if (!Number.isInteger(fn.localCount) || fn.localCount < 0) throw new Error(`ZIR localCount inválido en función ${fnId}.`);
        for (const slot of fn.params) {
            if (!Number.isInteger(slot) || slot < 0 || slot >= fn.localCount) throw new Error(`ZIR parámetro fuera de localCount en función ${fnId}.`);
        }
        if (!Array.isArray(fn.upvalues) || !Array.isArray(fn.iteratorLayouts)) throw new Error(`ZIR metadata de función ${fnId} inválida.`);
        for (const ref of fn.upvalues) {
            if (!ref || (ref.kind !== 'local' && ref.kind !== 'upvalue') || !Number.isInteger(ref.index) || ref.index < 0) {
                throw new Error(`ZIR upvalue inválido en función ${fnId}.`);
            }
        }
        for (const layout of fn.iteratorLayouts) {
            if (!Array.isArray(layout) || layout.some(slot => !Number.isInteger(slot) || slot < 0 || slot >= fn.localCount)) {
                throw new Error(`ZIR iterator layout inválido en función ${fnId}.`);
            }
        }
        fn.code.forEach((ins, pc) => assertInstruction(ins, fnId, pc + 1));
    }
    return program;
}

function normalizeIR(program, meta = {}) {
    validateIR(program);
    return {
        ...program,
        irVersion: IR_VERSION,
        stage: 'ZIR',
        metadata: { frontend: 'native', ...meta }
    };
}

function walkIR(program, visitor) {
    validateIR(program);
    if (typeof visitor !== 'function') throw new TypeError('ZIR visitor debe ser una función.');
    for (let f = 0; f < program.functions.length; f += 1) {
        const fn = program.functions[f];
        for (let pc = 0; pc < fn.code.length; pc += 1) visitor(fn.code[pc], { functionId: f, pc });
    }
    return program;
}

function transformIR(program, passes = []) {
    const out = program;
    for (const pass of passes) {
        if (typeof pass !== 'function') throw new TypeError('ZIR transform debe ser una función.');
        pass(out);
        validateIR(out);
    }
    return out;
}

function randomUnit() { return crypto.randomBytes(4).readUInt32BE(0) / 0x100000000; }

function polymorphIR(program, options = {}) {
    validateIR(program);
    const chance = Math.max(0, Math.min(0.4, Number(options.chance === undefined ? 0.16 : options.chance)));
    const maxPerFunction = Math.max(0, Math.min(64, Number(options.maxPerFunction === undefined ? 12 : options.maxPerFunction)));

    for (const fn of program.functions) {
        const oldCode = fn.code;
        const nextCode = [];
        const map = new Map();
        let inserted = 0;

        for (let i = 0; i < oldCode.length; i += 1) {
            map.set(i + 1, nextCode.length + 1);
            const ins = oldCode[i].slice();
            nextCode.push(ins);
            const isReturn = ins[0] === OPS.RETURN || ins[0] === OPS.RETURN_MULTI || ins[0] === OPS.RETURN_VOID || ins[0] === OPS.RETURN_MIXED;
            if (!isReturn && inserted < maxPerFunction && randomUnit() < chance) {
                nextCode.push([OPS.NOP, 0, 0, 0, 0]);
                inserted += 1;
            }
        }
        map.set(oldCode.length + 1, nextCode.length + 1);

        for (const ins of nextCode) {
            switch (ins[0]) {
                case OPS.JUMP:
                case OPS.JUMP_IF_FALSE:
                case OPS.JUMP_IF_TRUE:
                case OPS.BREAK:
                    ins[1] = map.get(ins[1]) ?? ins[1];
                    break;
                case OPS.FOR_NUM_PREP:
                case OPS.FOR_NUM_NEXT:
                case OPS.ITER_PREP:
                    ins[4] = map.get(ins[4]) ?? ins[4];
                    break;
                case OPS.ITER_NEXT:
                    ins[2] = map.get(ins[2]) ?? ins[2];
                    ins[4] = map.get(ins[4]) ?? ins[4];
                    break;
                default:
                    break;
            }
        }
        fn.code = nextCode;
    }

    program.metadata = { ...(program.metadata || {}), polymorphic: true };
    return validateIR(program);
}

module.exports = { IR_VERSION, validateIR, normalizeIR, walkIR, transformIR, polymorphIR };
