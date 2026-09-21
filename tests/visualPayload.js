const assert = require('assert');
const luaparse = require('luaparse');
const CodeGenerator = require('../src/generator/codegen.js');
const { buildCompatLoader } = require('../src/zlang/compatLoader');
const { buildNativeProgram } = require('../src/zlang/nativeCompiler');
const { encodeProgram } = require('../src/zlang/format3');
const {
    KEYBOARD_ALPHABET,
    CJK_GLYPHS,
    SIGN_GLYPHS,
    VISUAL_MAP,
    ALPHABET,
    encodeVisualPayload,
    decodeVisualPayload
} = require('../src/zlang/codec');

assert.strictEqual(KEYBOARD_ALPHABET, 'qwertyuioplkjhgfdsazxcvbnm');
assert.strictEqual(Object.keys(VISUAL_MAP).length, 26);
assert.strictEqual(VISUAL_MAP.s, '丝');
assert.strictEqual(Array.from(CJK_GLYPHS).length, 26);
assert.strictEqual(Array.from(SIGN_GLYPHS).length, 14);
assert.strictEqual(Array.from(ALPHABET).length, 40);

const source = 'local x = 7\nprint(x * 6)';
const program = buildNativeProgram(source, { fallback: false });
const raw = encodeProgram(program);
const packet = encodeVisualPayload(raw);
const decoded = decodeVisualPayload(packet);

assert.strictEqual(Buffer.from(decoded).toString('hex'), Buffer.from(raw).toString('hex'));
assert.strictEqual(packet.w, 12);
assert.strictEqual(packet.glyphs, Array.from(packet.lines.join('')).length);
for (const line of packet.lines) {
    assert(Array.from(line).length >= 1 && Array.from(line).length <= 12);
    assert(!/[0-9]/.test(line));
    for (const glyph of Array.from(line)) assert(ALPHABET.includes(glyph));
}

const generator = new CodeGenerator();
const generated = generator.generate(source);
assert(!/local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*\{\{\s*\d/.test(generated), 'No debe volver el payload numerico por chunks.');
assert(!/\{\s*\d+\s*,\s*\d+\s*,\s*\{\s*\d/.test(generated), 'No debe existir una tabla visible de bytes.');
assert(generated.includes('丝'), 'La salida Z3 debe contener el alfabeto visual CJK.');

// Regression: a local function must not go through the incompatible raw
// luaparse-AST path and must still produce a syntactically valid outer loader.
const functionGenerated = generator.generate('local function add(a,b) return a+b end\nprint(add(2,3))');
assert(functionGenerated.includes('丝'), 'El loader de funciones también debe conservar el transporte visual CJK.');

// Regression: the VM chunk must execute its 0-based root function when loaded
// by the visual transport. Returning a function here would make the transport
// return silently without invoking the actual Z3 program.
assert(/return\s+[A-Za-z_][A-Za-z0-9_]*\(0,nil,nil,\{\}\)\s*$/.test(generated), 'El payload VM debe ejecutar la función raíz 0-based.');
assert(/return\s+[A-Za-z_][A-Za-z0-9_]*\(0,nil,nil,\{\}\)\s*$/.test(generated), 'El entrypoint final debe ejecutar la raíz Z3.');

// Regression: the compatibility fallback must preserve arbitrary source text
// without relying on quoted Lua strings, which break on literal newlines,
// apostrophes, backslashes, or closing long-bracket markers.
const trickySource = 'local s = "uno\\dos \' tres"\n--]]==]\nprint(s)\n';
const compat = buildCompatLoader(trickySource, new Error('native parser failed'));
luaparse.parse(compat, { wait: false, comments: false, luaVersion: '5.1' });
assert(compat.includes('[=[') || compat.includes('[==['), 'El fallback debe usar long-bracket strings.');
assert(compat.includes(trickySource), 'El fallback debe conservar el source exacto.');

console.log('Z3 visual payload: CJK/QWERTY substitution + glyph-only byte stream: OK');
