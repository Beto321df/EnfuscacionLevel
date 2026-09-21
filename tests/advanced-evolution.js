const assert = require('assert');
const CodeGenerator = require('../src/generator/codegen');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');
const { buildEmissionPlan } = require('../src/zlang/emitter');
const { executeProgram } = require('../src/zlang/referenceVm');
const { REG_OPCODE_COUNT } = require('../src/zlang/registerVm');

function restoreOpcodeIds(program) {
    const out = JSON.parse(JSON.stringify(program));
    const map = out.metadata.emission.opcodePermutation;
    const inverse = {};
    for (const [oldId, newId] of Object.entries(map)) inverse[newId] = Number(oldId);
    for (const fn of out.functions) {
        if (Array.isArray(fn.opcodeDecode) && fn.opcodeDecode.length > 1) {
            for (const ins of fn.code) ins[0] = fn.opcodeDecode[ins[0]] ?? inverse[ins[0]] ?? ins[0];
        } else {
            for (const ins of fn.code) ins[0] = inverse[ins[0]] ?? ins[0];
        }
    }
    return out;
}

function run(source, expected, requireStringShard = false) {
    const native = buildNativeProgram(source, { fallback: false });
    const emitted = buildEmissionPlan(native, {
        backend: 'register',
        diversify: { stringChance: 1, numberChance: 1, maxStringShards: 5 },
        registers: { chance: 1 },
        isa: { aliasChance: 1 }
    });
    assert.strictEqual(emitted.backend, 'register');
    assert.strictEqual(emitted.metadata.emission.opcodeCount, REG_OPCODE_COUNT);
    if (requireStringShard) assert(emitted.metadata.constantDiversification.stringShards >= 1); else assert(emitted.metadata.constantDiversification.stringShards >= 0);
    assert(emitted.metadata.constantDiversification.numericExpressions >= 1);
    assert(emitted.metadata.isaPolymorphism.substituted >= 1);
    assert(emitted.metadata.registerPolymorphism.enabled === true || emitted.functions.every(fn => fn.registerCount < 2));
    assert.strictEqual(emitted.metadata.controlTargetEncoding.enabled, true);
    assert(emitted.functions.every(fn => Number.isInteger(fn.pcTargetAdd)));
    const restored = restoreOpcodeIds(emitted);
    const output = [];
    executeProgram(restored, { print: (...args) => output.push(...args) });
    assert.deepStrictEqual(output, expected, source);
    return emitted;
}

const fusionProbe = buildEmissionPlan(buildNativeProgram('local a=10\nif a>5 then print(\"fused\") end', { fallback: false }), { backend: 'register', diversify: { stringChance: 0, numberChance: 0 }, registers: { chance: 0 }, isa: { aliasChance: 0 } });
assert(fusionProbe.metadata.registerFusions.comparisonJumps >= 1, 'comparison fusion should trigger on a basic conditional');

run('local a=41\nlocal b=1\nlocal token="closure-proof-long-literal"\nlocal function outer(x) local base=x+1 return function(y) return base+y end end\nlocal f=outer(a)\nif f(b)==43 then print(token) end', ['closure-proof-long-literal'], true);
run('local total=0\nfor i=1,6 do total=total+i end\nprint("value:"..total)', ['value:21']);
run('local x=15\nif x>10 then print("branch:"..(x+2)) end', ['branch:17']);

const generated = new CodeGenerator().generate('local secretVariableName=10\nlocal longLiteralName="very-long-secret-literal"\nprint(longLiteralName, secretVariableName+2)', { preset: 'maximum' });
assert(generated.includes('setmetatable'), 'El decoder de constantes debe ser lazy.');
assert(generated.includes('pcTargetAdd') === false, 'Los nombres internos no deben aparecer literalmente en el loader.');
assert(!generated.includes('secretVariableName'));
assert(!generated.includes('longLiteralName'));

const a = new CodeGenerator().generate('print("same-program")', { preset: 'maximum' });
const b = new CodeGenerator().generate('print("same-program")', { preset: 'maximum' });
assert.notStrictEqual(a, b, 'Dos builds deben diversificarse.');

console.log('Z3 advanced evolution: register permutation, encoded control targets, aggressive diversification and lazy constants: OK');
