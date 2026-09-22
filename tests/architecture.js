const assert = require('assert');
const { OPS } = require('../src/zlang/compiler3');
const { buildEmissionPlan } = require('../src/zlang/emitter');
const { encodeProgram } = require('../src/zlang/format3');
const { REG_OPS, REG_OPCODE_COUNT, validateRegisterProgram } = require('../src/zlang/registerVm');
const { verifyProgram } = require('../src/zlang/verifier');
const { analyzeProgram } = require('../src/zlang/analysis');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');

function directProgram() {
    return {
        version: 3,
        irVersion: 2,
        stage: 'ZIR',
        root: 0,
        constants: [
            { type: 1, value: 'print' },
            { type: 2, value: 41 }
        ],
        functions: [{
            id: 0,
            name: '<main>',
            params: [],
            vararg: false,
            localCount: 1,
            upvalues: [],
            iteratorLayouts: [],
            code: [
                [OPS.PUSH_CONST, 1, 0, 0, 0],
                [OPS.STORE_LOCAL, 0, 0, 0, 0],
                [OPS.LOAD_GLOBAL, 0, 0, 0, 0],
                [OPS.LOAD_LOCAL, 0, 0, 0, 0],
                [OPS.CALL, 1, 0, 0, 0],
                [OPS.RETURN, 0, 0, 0, 0]
            ]
        }]
    };
}

const emitted = buildEmissionPlan(directProgram(), {
    backend: 'register',
    diversify: { stringChance: 0, numberChance: 0 },
    registers: { chance: 0 },
    isa: { aliasChance: 1 }
});

assert.strictEqual(emitted.backend, 'register');
assert.strictEqual(emitted.metadata.emission.opcodeCount, REG_OPCODE_COUNT);
assert.strictEqual(emitted.functions.length, 1);
assert(Array.isArray(emitted.functions[0].opcodeDecode));
assert.strictEqual(emitted.functions[0].opcodeDecode.length, REG_OPCODE_COUNT + 1);
assert.strictEqual(new Set(emitted.functions[0].opcodeDecode.slice(1)).size, REG_OPCODE_COUNT);
assert(emitted.functions[0].opcodeDecode.slice(1).includes(1));
assert(emitted.metadata.analysisBeforePacking);
assert(emitted.metadata.analysis);
validateRegisterProgram(emitted);
verifyProgram(emitted, { backend: 'register' });

const profile = emitted.metadata.emission.protection;
const encoded = encodeProgram(emitted, { protection: profile });
assert(encoded.length > 32);
assert.deepStrictEqual(Array.from(encoded.slice(0, 3)), [90, 51, 3]);

// Parse just the function header enough to prove the per-function opcode map is
// physically present in format 3 before parameter/bytecode data.
let pos = 0;
const u8 = () => encoded[pos++];
const u32 = () => { const v = encoded[pos]*16777216 + encoded[pos+1]*65536 + encoded[pos+2]*256 + encoded[pos+3]; pos += 4; return v >>> 0; };
const u16 = () => { const v = encoded[pos]*256 + encoded[pos+1]; pos += 2; return v; };
assert.deepStrictEqual([u8(), u8(), u8()], [90, 51, 3]);
u8(); pos += 4 + 24 + 4 + 4; // backend + constant affine params + 6 operand u32s + opcode affine params + seal
const constantCount = u32();
for (let i = 0; i < constantCount; i++) { const type = u8(); const len = u32(); pos += len; assert(type >= 1 && type <= 4); }
const fnCount = u32();
assert.strictEqual(fnCount, 1);
const fnKey = u8(); const fnSalt = u8();
const decodeCount = u8();
assert.strictEqual(decodeCount, REG_OPCODE_COUNT);
const table = [];
for (let i = 0; i < decodeCount; i++) table.push(u8());
assert.strictEqual(table.length, REG_OPCODE_COUNT);
assert.strictEqual(new Set(table).size, REG_OPCODE_COUNT);
assert(table.every(value => value >= 1 && value <= REG_OPCODE_COUNT));
const encodedLayoutCount = u8();
const layoutCount = (encodedLayoutCount - fnKey - fnSalt) & 255;
assert(layoutCount >= 1 && layoutCount <= 24);
const layouts = [];
for (let i = 0; i < layoutCount; i += 1) { const layout = []; for (let slot = 1; slot <= 4; slot += 1) { layout.push((u8() - fnKey - (i + 1) * 19 - slot * 7) & 255); } assert.deepStrictEqual([...layout].sort((a,b) => a-b), [1,2,3,4]); layouts.push(layout); }
const paramCount = u16();
assert.strictEqual(paramCount, 0);

const stats = analyzeProgram(emitted);
assert(stats.functionCount === 1 && stats.instructionCount > 0 && stats.blockCount > 0);
assert(stats.maxLiveRegisters >= 0);

// Registerizer CFG regression: dead blocks after return/break/continue must not
// participate in stack-height merges.
const cfgCases = [
    `local function choose(x)
    if x > 0 then
        return 10
    else
        return 20
    end
    print("unreachable")
end
print(choose(1))`,
    `local total=0
while total < 10 do
    total = total + 1
    if total == 4 then
        break
    end
    if total == 2 then
        continue
    end
    total = total + 1
end
print(total)`,
    `local function branch(x)
    if x then
        local a=1
        if a==1 then return "yes" end
    end
    return "no"
end
print(branch(true),branch(false))`
];

for (const source of cfgCases) {
    const native = buildNativeProgram(source, {
        fallback: false,
        polymorphOptions: { chance: 0, maxPerFunction: 0 }
    });
    const plan = buildEmissionPlan(native, {
        backend: 'register',
        diversify: { stringChance: 0, numberChance: 0 },
        registers: { chance: 0 },
        isa: { aliasChance: 0 }
    });
    validateRegisterProgram(plan);
    verifyProgram(plan, { backend: 'register' });
}


console.log('Z3 architecture v3.2-dev.5: opcode table, format layout, verifier and CFG/liveness analysis: OK');
