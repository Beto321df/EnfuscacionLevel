function longBracketLiteral(source) {
    const value = String(source);
    let level = 0;
    while (value.includes(']' + '='.repeat(level) + ']')) level += 1;
    const marker = '='.repeat(level);
    return '[' + marker + '[' + value + ']' + marker + ']';
}

function buildCompatLoader(source, cause) {
    const literal = longBracketLiteral(source);
    const reason = cause && cause.message ? String(cause.message) : '';
    const reasonLiteral = longBracketLiteral(reason);
    return `return(function(p)local f=(loadstring or load);local s,e=f(p);if not s then error('Z3 compatibility loader failed: '..tostring(e)..' :: '..${reasonLiteral})end;return s()end)(${literal})`;
}

module.exports = { longBracketLiteral, buildCompatLoader };
