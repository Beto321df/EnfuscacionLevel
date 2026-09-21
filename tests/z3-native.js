const assert = require('assert');
const { tokenize, TOKEN_TYPES, parse, buildNativeProgram, compile } = require('../src/zlang');
const { executeProgram } = require('../src/zlang/referenceVm');

const tokens = tokenize('local 艾 = 0x2A\nprint(艾)');
assert(tokens.some(t => t.type === TOKEN_TYPES.IDENT && t.text === '艾'));
assert(tokens.some(t => t.type === TOKEN_TYPES.NUMBER && t.value === 42));

const ast = parse('local x:number = 10 + 20\nprint(x)');
assert.strictEqual(ast.type, 'Chunk');
assert.strictEqual(ast.body[0].type, 'LocalStatement');

function run(source) {
    const program = buildNativeProgram(source, { fallback: false });
    assert.strictEqual(program.stage, 'ZIR');
    assert.strictEqual(program.irVersion, 2);
    const out = [];
    executeProgram(program, { print: (...args) => out.push(...args) });
    return { program, out };
}

assert.deepStrictEqual(run('local x=10+20\nprint(x)').out, [30]);
assert.deepStrictEqual(run('local t={a=1,b=2}\nprint(t.a+t.b)').out, [3]);
assert.deepStrictEqual(run('local function add(a,b) return a+b end\nprint(add(2,3))').out, [5]);
assert.deepStrictEqual(run('local function make() local x=4 return function() return x+1 end end\nlocal f=make()\nprint(f())').out, [5]);
assert.deepStrictEqual(run('local x=0\nwhile x<3 do x=x+1 end\nprint(x)').out, [3]);
assert.deepStrictEqual(run('local x=0\nrepeat x=x+1 until x==3\nprint(x)').out, [3]);
assert.deepStrictEqual(run('local sum=0\nfor i=1,5 do sum=sum+i end\nprint(sum)').out, [15]);

const result = compile('print("ok")');
assert(result.bytecode instanceof Uint8Array);
console.log('Z3 native frontend tests: OK');
