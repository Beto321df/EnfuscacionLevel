const { OPCODES } = require('./compiler');

function decodeIR(bytes) {
    const data = Buffer.from(bytes);
    if (data.length < 4 || data[0] !== 90 || data[1] !== 2 || data[2] !== 1) {
        throw new Error('Z IR header inválido.');
    }

    let pc = 3;
    let source = '';
    while (pc < data.length) {
        const op = data[pc++];
        if (op === OPCODES.END) break;
        if (op !== OPCODES.TOKEN) throw new Error('Z IR opcode inválido.');
        if (pc + 3 > data.length) throw new Error('Z IR truncado.');
        pc += 1; // token type
        const len = (data[pc++] << 8) | data[pc++];
        if (pc + len > data.length) throw new Error('Z IR token truncado.');
        source += data.subarray(pc, pc + len).toString('utf8');
        pc += len;
    }
    return source;
}

module.exports = { decodeIR };
