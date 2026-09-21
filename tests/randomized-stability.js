const assert = require('assert');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');
const { buildEmissionPlan } = require('../src/zlang/emitter');
const { executeProgram } = require('../src/zlang/referenceVm');
const { CodeGenerator } = (() => ({ CodeGenerator: require('../src/generator/codegen') }))();

function restoreOpcodeIds(program) {
    const out = JSON.parse(JSON.stringify(program));
    for (const fn of out.functions) {
        if (Array.isArray(fn.opcodeDecode) && fn.opcodeDecode.length > 1) {
            for (const ins of fn.code) ins[0] = fn.opcodeDecode[ins[0]] ?? ins[0];
        }
    }
    return out;
}

const cases = [
    ['local a=10 local b=20 if a<b then print(a+b) end', [30]],
    ['local total=0 for i=1,8 do total=total+i end print(total)', [36]],
    ['local x=0 while x<5 do x=x+1 end print(x)', [5]],
    ['local function outer(x) local base=x+1 return function(y) return base+y end end print(outer(40)(2))', [43]],
    ['local t={a=1,b=2} print(t.a,t.b)', [1,2]],
    ['local x=15 if x>10 then print("ok:"..(x+2)) end', ['ok:17']],
    ['print(5 & 3, 4 | 1, 7 ~ 3, 1 << 3, 16 >> 2, ~0)', [1,5,4,8,4,-1]],
    ['local t={a=1,b=2} for k,v in next,t do print(k,v) end', ['a',1,'b',2]]
];

const nextGlobal = (table, key) => {
    const keys = Object.keys(table).sort();
    const index = key == null ? 0 : keys.indexOf(String(key)) + 1;
    const nextKey = keys[index];
    const { multi } = require('../src/zlang/referenceVm');
    return nextKey === undefined ? multi([]) : multi([nextKey, table[nextKey]]);
};

for (let round = 1; round <= 3; round += 1) {
    for (const [source, expected] of cases) {
        const emitted = buildEmissionPlan(buildNativeProgram(source, { fallback: false }));
        assert.strictEqual(emitted.backend, 'register');
        for (const fn of emitted.functions) {
            assert(Number.isInteger(fn.registerCount) && fn.registerCount < 1_000_000);
            assert(Array.isArray(fn.operandLayouts) && fn.operandLayouts.length >= 1);
            assert(Array.isArray(fn.opcodeDecode) && fn.opcodeDecode.length > 1);
        }
        const output = [];
        executeProgram(restoreOpcodeIds(emitted), { print: (...args) => output.push(...args), next: nextGlobal }, { maxSteps: 250000 });
        assert.deepStrictEqual(output, expected, source);
    }
}

const generator = new CodeGenerator();
for (let i = 0; i < 3; i += 1) {
    const output = generator.generate('local function f(a,b) return a+b end print(f(20,22))', { preset: 'maximum' });
    assert(output.length > 5000);
    assert(!output.includes('secretVariableName'));
}

console.log('Z3 randomized stability: 24 randomized compiler/VM builds + 3 generated maximum loaders: OK');
