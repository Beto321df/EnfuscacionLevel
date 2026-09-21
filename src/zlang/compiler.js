const { TOKEN_TYPES } = require('./lexer');

const OPCODES = Object.freeze({
    TOKEN: 17,
    DATA: 29,
    END: 47
});

function writeU16(out, value) {
    out.push((value >>> 8) & 255, value & 255);
}

class ZCompiler {
    compile(tokens) {
        if (!Array.isArray(tokens)) throw new TypeError('Z compiler esperaba tokens.');

        const ir = [90, 2, 1]; // Z2 / IR stream v1
        for (const token of tokens) {
            const type = Number(token.type) || TOKEN_TYPES.OTHER;
            const data = Buffer.from(String(token.text ?? ''), 'utf8');
            ir.push(OPCODES.TOKEN, type & 255);
            writeU16(ir, data.length);
            for (const byte of data) ir.push(byte);
        }
        ir.push(OPCODES.END);
        return Uint8Array.from(ir);
    }
}

module.exports = { ZCompiler, OPCODES };
