const { OPS, OPCODE_COUNT, BIN, UNARY, buildProgram } = require('./compiler3');
const { buildNativeProgram, parseNative } = require('./nativeCompiler');
const { encodeProgram } = require('./format3');
const { encodeBytecode, decodeBytecode, ALPHABET, checksum } = require('./codec');
const { IR_VERSION, validateIR, normalizeIR, walkIR, transformIR, polymorphIR } = require('./ir');
const { analyzeFunction, analyzeProgram } = require('./analysis');
const { buildEmissionPlan, shuffleControlFlow, shuffleConstants, shuffleFunctions, shuffleOpcodes, fuseSuperinstructions } = require('./emitter');
const { REG_OPS, REG_OPCODE_COUNT, REG_ALIAS_BASE, registerizeProgram, diversifyRegisterIsa, validateRegisterProgram } = require('./registerVm');
const { executeRegisterProgram, multi: registerMulti, isMulti: isRegisterMulti } = require('./registerReferenceVm');
const { verifyProgram } = require('./verifier');
const { diversifyConstants } = require('./diversify');
const { PRESETS, resolvePreset } = require('./presets');
const protection = require('./protection');
const { TOKEN_TYPES, tokenize } = require('./lexer');
const { ZParser, parse } = require('./parser');

function compile(source, options = {}) {
    const program = buildNativeProgram(source, options);
    validateIR(program);
    return {
        program,
        bytecode: encodeProgram(program)
    };
}

module.exports = {
    OPS,
    OPCODE_COUNT,
    BIN,
    UNARY,
    ALPHABET,
    checksum,
    IR_VERSION,
    TOKEN_TYPES,
    tokenize,
    parse,
    parseNative,
    ZParser,
    validateIR,
    normalizeIR,
    walkIR,
    transformIR,
    polymorphIR,
    analyzeFunction,
    analyzeProgram,
    buildProgram,
    buildNativeProgram,
    encodeProgram,
    encodeBytecode,
    decodeBytecode,
    compile,
    buildEmissionPlan,
    shuffleControlFlow,
    shuffleConstants,
    shuffleFunctions,
    shuffleOpcodes,
    fuseSuperinstructions,
    REG_OPS,
    REG_OPCODE_COUNT,
    REG_ALIAS_BASE,
    registerizeProgram,
    diversifyRegisterIsa,
    validateRegisterProgram,
    executeRegisterProgram,
    registerMulti,
    isRegisterMulti,
    verifyProgram,
    diversifyConstants,
    PRESETS,
    resolvePreset,
    ...protection
};
