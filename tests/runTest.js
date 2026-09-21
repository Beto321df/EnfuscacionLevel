const assert = require('assert');
const CodeGenerator = require('../src/generator/codegen.js');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');
const { OPS, OPCODE_COUNT } = require('../src/zlang/compiler3');
const { encodeProgram } = require('../src/zlang/format3');
const { encodeBytecode, decodeBytecode, ALPHABET } = require('../src/zlang/codec');
const { executeProgram, multi } = require('../src/zlang/referenceVm');

function assertVisualPacket(packet) {
    assert.strictEqual(packet.v, 3);
    assert.strictEqual(packet.a, ALPHABET);
    assert.strictEqual(packet.b, 40);
    assert.strictEqual(packet.w, 12);
    for (const part of packet.z) {
        assert(Array.isArray(part.s));
        for (const line of part.s) {
            const width = Array.from(line).length;
            assert(width >= 1 && width <= 12);
            for (const symbol of Array.from(line)) assert(Array.from(ALPHABET).includes(symbol));
        }
    }
}

function validateProgram(program) {
    assert.strictEqual(program.version, 3);
    assert(program.functions.length >= 1);
    for (const fn of program.functions) {
        assert(Array.isArray(fn.code));
        for (const ins of fn.code) {
            assert(Array.isArray(ins) && ins.length === 5);
            assert(Number.isInteger(ins[0]) && ins[0] >= 1 && ins[0] <= OPCODE_COUNT);
            for (let i = 1; i < 5; i += 1) assert(Number.isInteger(ins[i]) && ins[i] >= 0);
        }
    }
}

function runReference(source, expected, setup = {}) {
    const program = buildNativeProgram(source, { fallback: false });
    validateProgram(program);
    const output = [];
    const globals = {
        print: (...args) => { output.push(...args); },
        pairs: table => {
            const keys = Object.keys(table);
            let index = 0;
            return multi([(_state, _control) => {
                index += 1;
                const key = keys[index - 1];
                return key === undefined ? multi([]) : multi([key, table[key]]);
            }, null, null]);
        },
        ipairs: table => {
            let index = 0;
            return multi([(_state, _control) => {
                index += 1;
                return index > table.length ? multi([]) : multi([index, table[index]]);
            }, null, 0]);
        },
        ...setup
    };
    executeProgram(program, globals);
    if (expected) assert.deepStrictEqual(output, expected, source);
    return program;
}

const samples = [
    { source: 'print("Hello from Z3")', expected: ['Hello from Z3'] },
    { source: 'local x = 10 + 20\nprint(x)', expected: [30] },
    { source: 'local t = {a = 1, b = "ok"}\nprint(t.a, t.b)', expected: [1, 'ok'] },
    { source: 'local sum = 0\nfor i = 1, 5 do sum = sum + i end\nprint(sum)', expected: [15] },
    { source: 'local x = 0\nwhile x < 3 do x = x + 1 end\nprint(x)', expected: [3] },
    { source: 'local function add(a,b) return a+b end\nprint(add(2,3))', expected: [5] },
    { source: 'for k,v in pairs({a=1,b=2}) do print(k,v) end', expectedCount: 4 },
    { source: 'local game = {GetService=function(self,name) return {Name=name} end}\nprint(game:GetService("Players").Name)', expected: ['Players'] },
    { source: 'local t={};t.value=42\nprint(t.value)', expected: [42] },
    { source: 'local t={};t["value"]=42\nprint(t["value"])', expected: [42] }
];

for (const sample of samples) {
    const program = runReference(sample.source, sample.expected);
    if (sample.expectedCount) {
        const out = [];
        const globals = {
            print: (...args) => out.push(...args),
            pairs: table => {
                const keys = Object.keys(table);
                let index = 0;
                return multi([(_s, _c) => {
                    index += 1;
                    const key = keys[index - 1];
                    return key === undefined ? multi([]) : multi([key, table[key]]);
                }, null, null]);
            }
        };
        executeProgram(program, globals);
        assert.strictEqual(out.length, sample.expectedCount, sample.source);
    }

    const raw = encodeProgram(program);
    assert(raw.length > 16);
    const packet = encodeBytecode(raw);
    assertVisualPacket(packet);
    const decoded = decodeBytecode(packet);
    assert.strictEqual(Buffer.from(decoded).toString('hex'), Buffer.from(raw).toString('hex'));

    const generator = new CodeGenerator();
    const generatedA = generator.generate(sample.source);
    const generatedB = new CodeGenerator().generate(sample.source);
    assert.strictEqual(typeof generatedA, 'string');
    assert(generatedA.length > sample.source.length);
    assert(generatedA.includes('丝'));
    assert(/\[[A-Za-z_][A-Za-z0-9_]*\+1\]/.test(generatedA), 'La VM debe compensar el índice 0-based del bytecode.');
    assert(/return [A-Za-z_][A-Za-z0-9_]*\(0,nil,nil,\{\}\)\s*$/.test(generatedA), 'La VM debe ejecutar la función raíz 0-based con closure context.');
    assert.notStrictEqual(generatedA, generatedB, 'Dos compilaciones Z3 deben poder variar su representación.');
}

console.log('Z-Lang 3 visual Unicode stack VM pipeline: OK');
console.log(`Muestras compiladas y ejecutadas en native ZIR VM: ${samples.length}`);
