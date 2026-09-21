const crypto = require('crypto');

// Z3 visual alphabet. The first 26 glyphs are a visual substitution for the
// exact QWERTY sequence requested by the project, followed by the project's
// punctuation set. In particular, s -> 丝. The payload itself is always
// emitted as glyph pairs, never as a visible numeric byte array.
const KEYBOARD_ALPHABET = 'qwertyuioplkjhgfdsazxcvbnm';
const CJK_GLYPHS = '青龙月风木雨火水金土石日天云山海星丝玄黄地雷电梦花草';
const SIGN_GLYPHS = '!@#$?":>|}{%^/';
const ALPHABET = `${CJK_GLYPHS}${SIGN_GLYPHS}`;
const SYMBOLS = Array.from(ALPHABET);
const BASE = SYMBOLS.length;
if (KEYBOARD_ALPHABET.length !== 26) throw new Error('Z codec keyboard alphabet inválido.');
if (Array.from(CJK_GLYPHS).length !== 26) throw new Error('Z codec CJK alphabet inválido.');
if (Array.from(SIGN_GLYPHS).length !== 14) throw new Error('Z codec symbol alphabet inválido.');
if (BASE !== 40) throw new Error(`Z codec requires 40 symbols, got ${BASE}.`);

const VISUAL_MAP = Object.freeze(Object.fromEntries(
    Array.from(KEYBOARD_ALPHABET, (letter, index) => [letter, Array.from(CJK_GLYPHS)[index]])
));

const BOOTSTRAP_PARAMS = Object.freeze({ seed: 0, salt: 1, step: 1, add: 0, mul: 1, inv: 1 });
const VISUAL_MAGIC = [90, 86, 1];

function randomInt(min, max) {
    return crypto.randomInt(min, max + 1);
}

function inverseMod256(value) {
    for (let i = 1; i < 256; i += 2) {
        if (((value * i) & 255) === 1) return i;
    }
    throw new Error('Z codec no pudo encontrar inverso modular.');
}

function mixByte(value, index, params) {
    const state = (params.seed + index * params.step + ((index + 1) * (index + params.salt))) & 255;
    return (value * params.mul + params.add + state) & 255;
}

function unmixByte(value, index, params) {
    const state = (params.seed + index * params.step + ((index + 1) * (index + params.salt))) & 255;
    return (((value - params.add - state) & 255) * params.inv) & 255;
}

function encodeByte(value) {
    const hi = Math.floor(value / BASE);
    const lo = value % BASE;
    return SYMBOLS[hi] + SYMBOLS[lo];
}

function encode(bytes, params) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += encodeByte(mixByte(bytes[i], i, params));
    return out;
}

function decode(text, params) {
    const chars = Array.from(text);
    if (chars.length % 2 !== 0) throw new Error('Z payload corrupto: longitud impar.');
    const out = new Uint8Array(chars.length / 2);
    for (let i = 0, p = 0; i < chars.length; i += 2, p += 1) {
        const a = SYMBOLS.indexOf(chars[i]);
        const b = SYMBOLS.indexOf(chars[i + 1]);
        if (a < 0 || b < 0) throw new Error('Z payload contiene un símbolo inválido.');
        const mixed = a * BASE + b;
        if (mixed > 255) throw new Error('Z pair fuera de rango.');
        out[p] = unmixByte(mixed, p, params);
    }
    return out;
}

function makeParams() {
    const mul = (randomInt(1, 127) * 2) - 1;
    const inv = inverseMod256(mul);
    return {
        seed: randomInt(0, 255),
        salt: randomInt(1, 255),
        step: randomInt(1, 255),
        add: randomInt(0, 255),
        mul,
        inv
    };
}

function checksum(bytes) {
    let a = 61;
    let b = 167;
    for (let i = 0; i < bytes.length; i += 1) {
        a = (a + bytes[i] + i) % 256;
        b = (b + bytes[i] + a + i * 13) % 256;
    }
    return (a * 256 + b) >>> 0;
}

function chunk(input, size) {
    const out = [];
    for (let i = 0; i < input.length; i += size) out.push(input.slice(i, i + size));
    return out;
}

function splitVisualLines(encoded, width = 12) {
    const chars = Array.from(encoded);
    const lines = [];
    for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(''));
    return lines;
}

function shuffle(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = randomInt(0, i);
        [items[i], items[j]] = [items[j], items[i]];
    }
}

function writeU32(value) {
    return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function readU32(bytes, offset) {
    return (((bytes[offset] * 16777216) >>> 0) + (bytes[offset + 1] * 65536) + (bytes[offset + 2] * 256) + bytes[offset + 3]) >>> 0;
}

function encodeVisualPayload(bytecode) {
    const bytes = Uint8Array.from(bytecode);
    const params = makeParams();
    const header = Uint8Array.from([
        ...VISUAL_MAGIC,
        params.seed,
        params.salt,
        params.step,
        params.add,
        params.mul,
        params.inv,
        ...writeU32(bytes.length),
        ...writeU32(checksum(bytes))
    ]);
    const headerGlyphs = encode(header, BOOTSTRAP_PARAMS);
    const bodyGlyphs = encode(bytes, params);
    const visual = `${headerGlyphs}${bodyGlyphs}`;
    return {
        v: 2,
        w: 12,
        lines: splitVisualLines(visual, 12),
        glyphs: visual.length,
        bootstrapGlyphs: headerGlyphs.length,
        params
    };
}

function decodeVisualPayload(payload) {
    if (!payload || payload.v !== 2 || payload.w !== 12 || !Array.isArray(payload.lines)) {
        throw new Error('Z visual payload inválido.');
    }
    const joined = payload.lines.join('');
    const headerGlyphs = 34;
    const header = decode(joined.slice(0, headerGlyphs), BOOTSTRAP_PARAMS);
    if (header[0] !== VISUAL_MAGIC[0] || header[1] !== VISUAL_MAGIC[1] || header[2] !== VISUAL_MAGIC[2]) {
        throw new Error('Z visual header inválido.');
    }
    const params = {
        seed: header[3],
        salt: header[4],
        step: header[5],
        add: header[6],
        mul: header[7],
        inv: header[8]
    };
    const expectedLength = readU32(header, 9);
    const expectedChecksum = readU32(header, 13);
    const body = decode(joined.slice(headerGlyphs), params);
    if (body.length !== expectedLength || checksum(body) !== expectedChecksum) throw new Error('Z visual checksum inválido.');
    return body;
}

function encodeBytecode(bytecode) {
    const bytes = Buffer.from(bytecode);
    const size = randomInt(6, 30);
    const parts = chunk(bytes, size).map((part, logicalIndex) => {
        const params = makeParams();
        return {
            p: logicalIndex,
            n: part.length,
            s: splitVisualLines(encode(part, params), 12),
            x: params.seed,
            q: params.salt,
            t: params.step,
            a: params.add,
            m: params.mul
        };
    });
    shuffle(parts);
    return {
        v: 3,
        a: ALPHABET,
        b: 40,
        w: 12,
        c: bytes.length,
        h: checksum(bytes),
        z: parts
    };
}

function decodeBytecode(packet) {
    if (!packet || packet.v !== 3 || packet.a !== ALPHABET || packet.b !== BASE || packet.w !== 12) {
        throw new Error('Z packet version/alphabet inválidos.');
    }
    const parts = [...(packet.z || [])].sort((x, y) => x.p - y.p);
    const result = [];
    for (const part of parts) {
        const params = {
            seed: part.x,
            salt: part.q,
            step: part.t,
            add: part.a,
            mul: part.m,
            inv: inverseMod256(part.m)
        };
        const lines = Array.isArray(part.s) ? part.s : [part.s];
        for (const line of lines) {
            if (Array.from(line).length > 12) throw new Error('Z visual line too long.');
        }
        const decoded = decode(lines.join(''), params);
        if (decoded.length !== part.n) throw new Error('Z chunk corrupto.');
        for (const byte of decoded) result.push(byte);
    }
    const out = Uint8Array.from(result);
    if (out.length !== packet.c || checksum(out) !== packet.h) throw new Error('Z checksum inválido.');
    return out;
}

module.exports = {
    KEYBOARD_ALPHABET,
    CJK_GLYPHS,
    SIGN_GLYPHS,
    VISUAL_MAP,
    ALPHABET,
    SYMBOLS,
    BASE,
    BOOTSTRAP_PARAMS,
    encodeBytecode,
    decodeBytecode,
    encodeVisualPayload,
    decodeVisualPayload,
    makeParams,
    checksum,
    splitVisualLines
};
