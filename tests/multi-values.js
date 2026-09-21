const assert = require('assert');
const { buildProgramFromAst } = require('../src/zlang/compiler3');
const { executeProgram } = require('../src/zlang/referenceVm');
const { registerizeProgram } = require('../src/zlang/registerVm');
const { verifyProgram } = require('../src/zlang/verifier');

const id = name => ({ type: 'Identifier', name });
const num = value => ({ type: 'NumericLiteral', value });
const call = (name, args = []) => ({ type: 'CallExpression', base: id(name), arguments: args });
const fn = body => ({ type: 'FunctionExpression', parameters: [], isVararg: false, body });

function buildAndRun(ast) {
    const stack = buildProgramFromAst(ast);
    verifyProgram(stack, { backend: 'stack' });
    const stackResult = executeProgram(stack, {});
    const register = registerizeProgram(buildProgramFromAst(ast));
    verifyProgram(register, { backend: 'register' });
    const registerResult = executeProgram(register, {});
    return { stackResult, registerResult, stack, register };
}

const ast = {
    type: 'Chunk',
    body: [
        { type: 'LocalStatement', variables: [id('f')], init: [fn([
            { type: 'ReturnStatement', arguments: [num(10), num(20), num(30)] }
        ])] },
        { type: 'LocalStatement', variables: [id('a'), id('b')], init: [call('f')] },
        { type: 'LocalStatement', variables: [id('c'), id('d'), id('e')], init: [num(1), num(2)] },
        { type: 'LocalStatement', variables: [id('t')], init: [{
            type: 'TableConstructorExpression',
            fields: [
                { type: 'TableValue', value: num(1) },
                { type: 'TableValue', value: call('f') }
            ]
        }] },
        { type: 'AssignmentStatement', variables: [id('a'), id('b')], init: [num(7), call('f')] },
        { type: 'ReturnStatement', arguments: [id('t')] }
    ]
};

const out = buildAndRun(ast);
for (const result of [out.stackResult, out.registerResult]) {
    assert.strictEqual(result[1], 1);
    assert.strictEqual(result[2], 10);
    assert.strictEqual(result[3], 20);
    assert.strictEqual(result[4], 30);
}
assert(out.stack.functions[0].code.some(ins => ins[0] !== undefined));
assert(out.register.functions[0].code.some(ins => ins[0] !== undefined));

console.log('Z3 multi-value compiler/VM: stack + register semantics, table expansion, normalization: OK');
