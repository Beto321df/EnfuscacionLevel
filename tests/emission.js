const assert = require('assert');
const { OPS } = require('../src/zlang/compiler3');
const { REG_OPCODE_COUNT } = require('../src/zlang/registerVm');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');
const { executeProgram, multi } = require('../src/zlang/referenceVm');
const { buildEmissionPlan } = require('../src/zlang/emitter');
const { encodeProgram } = require('../src/zlang/format3');

function inverseOpcodes(program) {
    const map = program.metadata.emission.opcodePermutation;
    const inverse = {};
    for (const [oldId, newId] of Object.entries(map)) inverse[newId] = Number(oldId);
    return inverse;
}

function restoreOpcodeIds(program) {
    const out = JSON.parse(JSON.stringify(program));
    const inverse = inverseOpcodes(program);
    for (const fn of out.functions) {
        if (Array.isArray(fn.opcodeDecode) && fn.opcodeDecode.length > 1) {
            for (const ins of fn.code) ins[0] = fn.opcodeDecode[ins[0]] ?? ins[0];
        } else {
            for (const ins of fn.code) ins[0] = inverse[ins[0]] ?? ins[0];
        }
    }
    return out;
}

function run(source, expected, setup = {}) {
    const original = buildNativeProgram(source, { fallback: false });
    const emitted = buildEmissionPlan(original);

    assert.strictEqual(emitted.metadata.emission.localsOpaque, true);
    assert.strictEqual(emitted.metadata.emission.constantsShuffled, true);
    assert.strictEqual(emitted.metadata.emission.functionsShuffled, true);
    assert.strictEqual(emitted.metadata.emission.controlFlowPermuted, true);
    assert.strictEqual(emitted.metadata.emission.stringLayer, 2);
    assert.strictEqual(emitted.metadata.emission.constantLayer, 2);
    assert.strictEqual(emitted.metadata.emission.operandLayer, 1);
    assert.strictEqual(emitted.metadata.emission.opcodeLayer, 2);
    assert.strictEqual(emitted.metadata.emission.integrityLayer, 2);
    assert.strictEqual(emitted.metadata.emission.vmDispatch, 'indirect-routing');
    assert.strictEqual(emitted.metadata.emission.backend, 'register');
    assert.strictEqual(emitted.metadata.emission.protection.functions.length, emitted.functions.length);

    const opcodeMap = emitted.metadata.emission.opcodePermutation;
    const opcodeValues = Object.values(opcodeMap);
    const opcodeCount = emitted.metadata.emission.opcodeCount;
    assert.strictEqual(opcodeCount, REG_OPCODE_COUNT);
    assert.strictEqual(Object.keys(opcodeMap).length, opcodeCount);
    assert.strictEqual(new Set(opcodeValues).size, opcodeCount);
    assert(opcodeValues.every(value => value >= 1 && value <= opcodeCount));

    const restored = restoreOpcodeIds(emitted);
    const output = [];
    executeProgram(restored, { print: (...args) => output.push(...args), ...setup });
    if (expected) assert.deepStrictEqual(output, expected, source);
    return emitted;
}

run('local secretVariableName=10\nlocal otherSecret=20\nif secretVariableName<otherSecret then print("branch-ok") end', ['branch-ok']);
run('local x=0\nwhile x<3 do x=x+1 end\nprint(x)', [3]);
run('local total=0\nfor i=1,5 do total=total+i end\nprint(total)', [15]);
run('local total=0\nfor i=1,5 do if i==3 then continue end total=total+i end\nprint(total)', [12]);
run('local x=0\nwhile x<5 do x=x+1 if x==3 then continue end print(x) end', [1,2,4,5]);
run('local x=0\nrepeat x=x+1 if x==2 then continue end until x==4\nprint(x)', [4]);
const nextGlobal = (table, key) => {
    const keys = Object.keys(table).sort();
    let index = key == null ? 0 : keys.indexOf(String(key)) + 1;
    const nextKey = keys[index];
    return nextKey === undefined ? multi([]) : multi([nextKey, table[nextKey]]);
};
run('local t={a=1,b=2}\nfor k,v in next,t do print(k,v) end', ['a',1,'b',2], { next: nextGlobal });
run('local function hiddenName(value) if value>2 then return "high" else return "low" end end\nprint(hiddenName(4))', ['high']);
run('local secret="superSecretLiteral"\nprint(secret)', ['superSecretLiteral']);
run('print(5 & 3, 4 | 1, 7 ~ 3, 1 << 3, 16 >> 2)', [1,5,4,8,4]);
run('print(~0)', [-1]);

const locals = buildNativeProgram('local secretVariableName=1\nlocal anotherReadableName=2\nprint(secretVariableName+anotherReadableName)', { fallback: false });
const localConstants = locals.constants.map(entry => String(entry.value));
assert(!localConstants.includes('@0:local:0:secretVariableName'));
assert(!localConstants.includes('@0:local:1:anotherReadableName'));

const emittedStringProgram = buildEmissionPlan(buildNativeProgram('print("superSecretLiteral")', { fallback: false }));
const rawA = encodeProgram(emittedStringProgram);
const rawB = encodeProgram(emittedStringProgram);
assert.notStrictEqual(Buffer.from(rawA).toString('hex'), Buffer.from(rawB).toString('hex'));
assert.deepStrictEqual(Array.from(rawA.slice(0,3)), [90,51,3]);
assert.deepStrictEqual(Array.from(rawB.slice(0,3)), [90,51,3]);
assert(!Buffer.from(rawA).includes(Buffer.from('superSecretLiteral')));
assert(!Buffer.from(rawB).includes(Buffer.from('superSecretLiteral')));

console.log('Z3 professional emission: opaque locals, shuffled constants/functions, control-flow permutation, opcode polymorphism and protected strings: OK');
