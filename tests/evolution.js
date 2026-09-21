const assert = require('assert');
const CodeGenerator = require('../src/generator/codegen');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');
const { OPS } = require('../src/zlang/compiler3');
const { buildEmissionPlan } = require('../src/zlang/emitter');
const { encodeProgram } = require('../src/zlang/format3');
const { resolvePreset } = require('../src/zlang/presets');
const { makeProtectionProfile, encodeU32, decodeU32, encodeOpcode, decodeOpcode, encodeConstantByte, decodeConstantByte, seal } = require('../src/zlang/protection');

function compile(source, preset = 'strong') {
    const profile = resolvePreset(preset);
    const program = buildNativeProgram(source, { fallback: false, polymorphOptions: profile.polymorph });
    program.metadata = { ...(program.metadata || {}), strengthPreset: profile.name };
    return buildEmissionPlan(program);
}

const protection = makeProtectionProfile(2);
for (const value of [0, 1, 17, 0x7fffffff, 0xffffffff]) {
    const encoded = encodeU32(value, protection.operand, 19, 3, 47);
    assert.strictEqual(decodeU32(encoded, protection.operand, 19, 3, 47), value >>> 0);
}
for (const opcode of [1, 7, 19, 32]) {
    const encoded = encodeOpcode(opcode, protection.opcode, 13, 101);
    assert.strictEqual(decodeOpcode(encoded, protection.opcode, 13, 101), opcode);
}
for (const value of [0, 1, 42, 255]) {
    const encoded = encodeConstantByte(value, protection.constant, 9, 1);
    assert.strictEqual(decodeConstantByte(encoded, protection.constant, 9, 1), value);
}
const sealed = Buffer.from('z3-integrity');
assert.notStrictEqual(seal(sealed), seal(Buffer.from('z3-integrity!')));

const source = [
    'local secretAlpha = 11',
    'local secretBeta = 31',
    'local function hidden(value)',
    '    if value > 10 then return "hidden-high" end',
    '    return "hidden-low"',
    'end',
    'for i = 1, 12 do',
    '    if i == 4 then continue end',
    '    secretAlpha = secretAlpha + (i & 3)',
    'end',
    'print(hidden(secretAlpha), secretBeta, ~3)'
].join('\n');

const a = compile(source, 'maximum');
const b = compile(source, 'maximum');

assert.strictEqual(a.version, 3);
assert.strictEqual(a.irVersion, 2);
assert.strictEqual(a.metadata.emission.controlFlowPermuted, true);
assert.strictEqual(a.metadata.emission.constantsShuffled, true);
assert.strictEqual(a.metadata.emission.functionsShuffled, true);
assert.strictEqual(a.metadata.emission.localsOpaque, true);
assert(a.functions.some(fn => Array.isArray(fn.upvalues)));
assert(a.functions.some(fn => Number.isInteger(fn.localCount)));
assert.strictEqual(a.metadata.emission.vmDispatch, 'indirect-routing');
assert.strictEqual(a.metadata.emission.backend, 'register');
assert.strictEqual(a.metadata.emission.opcodeCount, require('../src/zlang/registerVm').REG_OPCODE_COUNT);
assert.strictEqual(a.metadata.emission.integrityLayer, 2);
assert.strictEqual(a.metadata.controlTargetEncoding.enabled, true);
assert.strictEqual(a.metadata.controlTargetEncoding.multiplier, 65537);
assert.strictEqual(a.functions.every(fn => Number.isInteger(fn.pcTargetAdd)), true);
assert.strictEqual(a.metadata.registerPolymorphism.enabled, true);

const rawA = encodeProgram(a);
const rawB = encodeProgram(b);
assert.deepStrictEqual(Array.from(rawA.slice(0, 3)), [90, 51, 3]);
assert.deepStrictEqual(Array.from(rawB.slice(0, 3)), [90, 51, 3]);
assert.notStrictEqual(Buffer.from(rawA).toString('hex'), Buffer.from(rawB).toString('hex'));

const clearMarkers = [
    'secretAlpha',
    'secretBeta',
    'hidden-high',
    'hidden-low'
];
for (const marker of clearMarkers) {
    assert(!Buffer.from(rawA).includes(Buffer.from(marker)), 'raw bytecode leaked: ' + marker);
}

const names = a.constants.map(entry => String(entry.value));
assert(!names.some(value => /secretAlpha|secretBeta/.test(value)));
assert(a.metadata.emission.protection.functions.every(item =>
    Number.isInteger(item.key) && Number.isInteger(item.salt)
));

assert.deepStrictEqual(
    Object.keys(resolvePreset('maximum')).sort(),
    ['backend', 'diversify', 'isa', 'name', 'polymorph', 'registers']
);
assert.strictEqual(resolvePreset('balanced').polymorph.maxPerFunction, 8);
assert.strictEqual(resolvePreset('strong').polymorph.maxPerFunction, 16);
assert.strictEqual(resolvePreset('maximum').polymorph.maxPerFunction, 32);
assert.strictEqual(resolvePreset('strong').diversify.maxStringShards, 4);
assert.strictEqual(resolvePreset('maximum').isa.aliasChance, 0.55);

const { fuseSuperinstructions } = require('../src/zlang/emitter');

const closureSource = 'local function outer(a) local base=a+1 return function(b) return base+b end end\nlocal f=outer(4)\nprint(f(6))';
const closureProgram = buildNativeProgram(closureSource, { fallback: false, polymorphic: false });
assert(closureProgram.functions.length >= 3);
assert(closureProgram.functions.some(fn => fn.upvalues.length > 0), 'ZIR v2 debe representar upvalues explícitamente.');
assert(closureProgram.functions.every(fn => fn.params.every(slot => Number.isInteger(slot))));
assert(!closureProgram.constants.some(entry => String(entry.value).includes('@0:local:')));

const fusedProgram = buildNativeProgram('local x=1\nlocal y=2\nx=x+y\nprint(x)', { fallback: false, polymorphic: false });
fuseSuperinstructions(fusedProgram);
assert(fusedProgram.functions[0].code.some(ins => ins[0] === OPS.FUSED_LOCAL_LOCAL_BIN_STORE), 'Debe existir una superinstrucción local-local.');

const opaqueGenerated = new CodeGenerator().generate('local secretVariableName=1\nlocal anotherReadableName=2\nprint(secretVariableName+anotherReadableName)');
assert(!opaqueGenerated.includes('secretVariableName'));
assert(!opaqueGenerated.includes('anotherReadableName'));

console.log('Z3 evolution invariants: per-build ISA/data protection, opaque names, integrity, presets: OK');
