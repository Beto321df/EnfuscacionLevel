const crypto = require('crypto');

const U32 = 0x100000000;

function randomByte() {
    return crypto.randomInt(0, 256);
}

function randomU32() {
    return crypto.randomInt(0, U32);
}

function inverseMod32(value) {
    let x = value >>> 0;
    let y = 1;
    // Newton-Raphson in Z/(2^32): repeated x -> x*(2-a*x).
    for (let i = 0; i < 5; i += 1) y = Math.imul(y, (2 - Math.imul(x, y)) >>> 0) >>> 0;
    return y >>> 0;
}

function inverseMod256(value) {
    for (let i = 1; i < 256; i += 2) {
        if (((value * i) & 255) === 1) return i;
    }
    throw new Error('Z protection: no existe inverso modular.');
}

function makeAffineByte() {
    const mul = (crypto.randomInt(1, 128) * 2) - 1;
    return {
        seed: randomByte(),
        step: crypto.randomInt(1, 256),
        mul,
        inv: inverseMod256(mul)
    };
}

function makeProtectionProfile(functionCount) {
    const constant = makeAffineByte();
    const operandMul = (crypto.randomInt(1, 0x80000000) | 1) >>> 0;
    const operand = {
        seed: randomU32(),
        step: randomU32() | 1,
        salt: randomU32(),
        mul: operandMul,
        inv: 0,
        functionKey: randomU32()
    };
    operand.inv = inverseMod32(operand.mul);

    const opcode = {
        seed: randomByte(),
        step: crypto.randomInt(1, 256),
        mul: (crypto.randomInt(1, 128) * 2) - 1
    };
    opcode.inv = inverseMod256(opcode.mul);

    const functions = [];
    for (let i = 0; i < functionCount; i += 1) {
        functions.push({
            key: randomByte(),
            salt: randomByte()
        });
    }

    return {
        version: 2,
        constant,
        operand,
        opcode,
        functions
    };
}

function encodeU32(value, params, pc, field, functionKey = 0) {
    const mixed = Math.imul(value >>> 0, params.mul >>> 0) >>> 0;
    return (mixed + Number(params.seed >>> 0) +
        Math.imul(pc >>> 0, params.step >>> 0) +
        Math.imul(field >>> 0, params.salt >>> 0) +
        Math.imul(functionKey >>> 0, params.functionKey >>> 0)) >>> 0;
}

function decodeU32(value, params, pc, field, functionKey = 0) {
    const mixed = (Number(value >>> 0) - Number(params.seed >>> 0) -
        Math.imul(pc >>> 0, params.step >>> 0) -
        Math.imul(field >>> 0, params.salt >>> 0) -
        Math.imul(functionKey >>> 0, params.functionKey >>> 0)) >>> 0;
    return Math.imul(mixed, params.inv >>> 0) >>> 0;
}

function encodeOpcode(opcode, profile, pc, fnKey) {
    return ((opcode * profile.mul + profile.seed + pc * profile.step + fnKey) & 255) >>> 0;
}

function decodeOpcode(encoded, profile, pc, fnKey) {
    return (((encoded - profile.seed - pc * profile.step - fnKey) & 255) * profile.inv) & 255;
}

function encodeConstantByte(byte, profile, index, type) {
    return (byte * profile.mul + profile.seed + index * profile.step + type * 17) & 255;
}

function decodeConstantByte(byte, profile, index, type) {
    return (((byte - profile.seed - index * profile.step - type * 17) & 255) * profile.inv) & 255;
}

function seal(bytes) {
    let a = 83;
    let b = 211;
    for (let i = 0; i < bytes.length; i += 1) {
        const value = bytes[i] >>> 0;
        a = (a + value + i) & 255;
        b = (b + value + a + i * 17) & 255;
    }
    return ((a << 16) | (b << 8) | (bytes.length & 255)) >>> 0;
}

module.exports = {
    U32,
    randomByte,
    randomU32,
    inverseMod256,
    makeAffineByte,
    makeProtectionProfile,
    encodeU32,
    decodeU32,
    encodeOpcode,
    decodeOpcode,
    encodeConstantByte,
    decodeConstantByte,
    seal
};
