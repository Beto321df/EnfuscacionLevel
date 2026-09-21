const TOKEN_TYPES = Object.freeze({
    IDENT: 1,
    NUMBER: 2,
    STRING: 3,
    OPERATOR: 4,
    PUNCT: 5,
    KEYWORD: 6,
    WHITESPACE: 7,
    COMMENT: 8,
    OTHER: 9,
    EOF: 10
});

const KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if',
    'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
    'continue', 'goto', 'type', 'export'
]);

const MULTI_OPS = [
    '...', '::', '==', '~=', '<=', '>=', '..', '//', '+=', '-=', '*=', '/=', '%=', '^=',
    '&&', '||', '<<', '>>', '->', '=>', '..=', '::'
];

function isIdStart(ch) {
    return !!ch && (ch === '_' || /\p{L}/u.test(ch));
}

function isIdContinue(ch) {
    return !!ch && (isIdStart(ch) || /\p{N}/u.test(ch));
}

function isDigit(ch) { return !!ch && /[0-9]/.test(ch); }

function isHex(ch) { return !!ch && /[0-9A-Fa-f]/.test(ch); }

function isBin(ch) { return ch === '0' || ch === '1'; }

function readLongBracket(source, start) {
    if (source[start] !== '[') return null;
    let i = start + 1;
    let equals = 0;
    while (source[i] === '=') { equals += 1; i += 1; }
    if (source[i] !== '[') return null;
    const close = ']' + '='.repeat(equals) + ']';
    const end = source.indexOf(close, i + 1);
    const finish = end < 0 ? source.length : end + close.length;
    return { end: finish, equals, close };
}

function readQuoted(source, start, quote) {
    let i = start + 1;
    let escaped = false;
    while (i < source.length) {
        const ch = source[i];
        if (escaped) { escaped = false; i += 1; continue; }
        if (ch === '\\') { escaped = true; i += 1; continue; }
        if (ch === quote) return i + 1;
        if (ch === '\n' || ch === '\r') throw new SyntaxError(`Z lexer: cadena sin cerrar en ${start}.`);
        i += 1;
    }
    throw new SyntaxError(`Z lexer: cadena sin cerrar en ${start}.`);
}

function readNumber(source, start) {
    let i = start;
    if (source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        i += 2;
        while (isHex(source[i]) || source[i] === '_') i += 1;
        if (source[i] === '.') {
            i += 1;
            while (isHex(source[i]) || source[i] === '_') i += 1;
        }
        if (source[i] === 'p' || source[i] === 'P') {
            i += 1;
            if (source[i] === '+' || source[i] === '-') i += 1;
            while (isDigit(source[i]) || source[i] === '_') i += 1;
        }
        return i;
    }
    if (source[i] === '0' && (source[i + 1] === 'b' || source[i + 1] === 'B')) {
        i += 2;
        while (isBin(source[i]) || source[i] === '_') i += 1;
        return i;
    }
    if (source[i] === '0' && (source[i + 1] === 'o' || source[i + 1] === 'O')) {
        i += 2;
        while ((source[i] >= '0' && source[i] <= '7') || source[i] === '_') i += 1;
        return i;
    }
    while (isDigit(source[i]) || source[i] === '_') i += 1;
    if (source[i] === '.' && source[i + 1] !== '.') {
        i += 1;
        while (isDigit(source[i]) || source[i] === '_') i += 1;
    }
    if (source[i] === 'e' || source[i] === 'E') {
        i += 1;
        if (source[i] === '+' || source[i] === '-') i += 1;
        while (isDigit(source[i]) || source[i] === '_') i += 1;
    }
    return i;
}

function readToken(source, start) {
    const ch = source[start];
    const next = source[start + 1];

    if (/\s/u.test(ch)) {
        let i = start + 1;
        while (i < source.length && /\s/u.test(source[i])) i += 1;
        return { type: TOKEN_TYPES.WHITESPACE, text: source.slice(start, i), next: i };
    }

    if (ch === '-' && next === '-') {
        const long = readLongBracket(source, start + 2);
        if (long) return { type: TOKEN_TYPES.COMMENT, text: source.slice(start, long.end), next: long.end };
        let i = source.indexOf('\n', start + 2);
        if (i < 0) i = source.length;
        return { type: TOKEN_TYPES.COMMENT, text: source.slice(start, i), next: i };
    }

    if (ch === '"' || ch === "'") {
        const end = readQuoted(source, start, ch);
        return { type: TOKEN_TYPES.STRING, text: source.slice(start, end), next: end };
    }

    const long = ch === '[' ? readLongBracket(source, start) : null;
    if (long) return { type: TOKEN_TYPES.STRING, text: source.slice(start, long.end), next: long.end };

    if (isIdStart(ch)) {
        let i = start + 1;
        while (i < source.length && isIdContinue(source[i])) i += 1;
        const text = source.slice(start, i);
        return { type: KEYWORDS.has(text) ? TOKEN_TYPES.KEYWORD : TOKEN_TYPES.IDENT, text, next: i };
    }

    if (isDigit(ch) || (ch === '.' && isDigit(next))) {
        const i = readNumber(source, start);
        return { type: TOKEN_TYPES.NUMBER, text: source.slice(start, i), next: i };
    }

    for (const op of MULTI_OPS) {
        if (source.startsWith(op, start)) return { type: TOKEN_TYPES.OPERATOR, text: op, next: start + op.length };
    }

    if ('+-*/%^#=<>~&|!?'.includes(ch)) return { type: TOKEN_TYPES.OPERATOR, text: ch, next: start + 1 };
    if ('(){}[];:,.'.includes(ch)) return { type: TOKEN_TYPES.PUNCT, text: ch, next: start + 1 };
    return { type: TOKEN_TYPES.OTHER, text: ch, next: start + 1 };
}

function decodeStringToken(text) {
    if (text[0] === '[') {
        let i = 1;
        while (text[i] === '=') i += 1;
        const open = i + 1;
        const close = text.length - (i - 1) - 2;
        return text.slice(open, close);
    }
    const quote = text[0];
    const body = text.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (ch !== '\\') { out += ch; continue; }
        const n = body[++i];
        const map = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
        if (n === 'z') { while (i + 1 < body.length && /\s/u.test(body[i + 1])) i += 1; continue; }
        if (map[n] !== undefined) { out += map[n]; continue; }
        if (n === '\n') { out += '\n'; continue; }
        if (n === '\r') { if (body[i + 1] === '\n') i += 1; out += '\n'; continue; }
        const digits = n && /[0-9]/.test(n) ? n + (body[i + 1] || '') + (body[i + 2] || '') : '';
        if (digits.length && /^\d{2,3}$/.test(digits)) { i += digits.length - 1; out += String.fromCharCode(Number(digits)); continue; }
        out += n || '';
    }
    return out;
}

function numberValue(text) {
    const clean = text.replace(/_/g, '');
    if (/^0[bB]/.test(clean)) return parseInt(clean.slice(2), 2);
    if (/^0[oO]/.test(clean)) return parseInt(clean.slice(2), 8);
    return Number(clean);
}

function tokenize(source, options = {}) {
    if (typeof source !== 'string') throw new TypeError('Z lexer esperaba una cadena.');
    const includeTrivia = !!options.includeTrivia;
    const tokens = [];
    let i = 0;
    let line = 1;
    let column = 1;
    while (i < source.length) {
        const token = readToken(source, i);
        if (!token || token.next <= i) throw new Error(`Z lexer atascado en ${i}.`);
        const start = i;
        const startLine = line;
        const startColumn = column;
        const text = token.text;
        for (const c of text) {
            if (c === '\n') { line += 1; column = 1; }
            else column += 1;
        }
        i = token.next;
        if (!includeTrivia && (token.type === TOKEN_TYPES.WHITESPACE || token.type === TOKEN_TYPES.COMMENT)) continue;
        tokens.push({
            type: token.type,
            text,
            start,
            end: i,
            line: startLine,
            column: startColumn,
            value: token.type === TOKEN_TYPES.STRING ? decodeStringToken(text) : token.type === TOKEN_TYPES.NUMBER ? numberValue(text) : undefined
        });
    }
    tokens.push({ type: TOKEN_TYPES.EOF, text: '', start: source.length, end: source.length, line, column });
    return tokens;
}

module.exports = { TOKEN_TYPES, KEYWORDS, tokenize, decodeStringToken, numberValue };
