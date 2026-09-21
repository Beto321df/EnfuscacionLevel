const { buildProgram, OPS, BIN, UNARY } = require('../zlang/compiler3');
const { encodeProgram } = require('../zlang/format3');

class BytecodeCompiler {
    compileSource(source) {
        const program = buildProgram(source);
        const bytecode = encodeProgram(program);
        return {
            constants: program.constants,
            functions: program.functions,
            program,
            bytecode,
            instructions: program.functions[program.root].code
        };
    }

    compile(astOrSource) {
        if (typeof astOrSource === 'string') return this.compileSource(astOrSource);
        if (astOrSource && typeof astOrSource.source === 'string') return this.compileSource(astOrSource.source);
        throw new Error('Z-Lang 3 compiler requiere código fuente Lua/Luau.');
    }
}

module.exports = { BytecodeCompiler, OPS, BIN, UNARY };
