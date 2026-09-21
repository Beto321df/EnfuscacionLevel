const { buildProgram } = require('../zlang/compiler3');
const { executeProgram } = require('../zlang/referenceVm');
const { encodeProgram } = require('../zlang/format3');

class LuauInterpreterGenerator {
    compile(source) {
        return buildProgram(source);
    }

    run(sourceOrProgram, globals = {}) {
        const program = typeof sourceOrProgram === 'string'
            ? buildProgram(sourceOrProgram)
            : sourceOrProgram;
        if (!program || program.version !== 3) throw new Error('Z-Lang 3 runtime recibió un programa inválido.');
        return executeProgram(program, globals);
    }

    decode(program) {
        if (!program || program.version !== 3) throw new Error('Z-Lang 3 runtime recibió bytecode inválido.');
        return program;
    }

    generateRunner(source) {
        const program = typeof source === 'string' ? buildProgram(source) : source;
        if (!program || program.version !== 3) throw new Error('Z-Lang 3 runner recibió un programa inválido.');
        const encoded = Buffer.from(encodeProgram(program)).toString('base64');
        return `-- Z-Lang 3 reference runner\nreturn ${JSON.stringify(encoded)}`;
    }
}

module.exports = LuauInterpreterGenerator;
