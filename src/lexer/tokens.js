const TokenType = {
    KEYWORD: 'KEYWORD',
    IDENTIFIER: 'IDENTIFIER',
    NUMBER: 'NUMBER',
    STRING: 'STRING',
    OPERATOR: 'OPERATOR',
    SYMBOL: 'SYMBOL',
    EOF: 'EOF'
};

const KEYWORDS = new Set([
    'local', 'function', 'return', 'if', 'then', 'else', 'elseif', 'end',
    'while', 'do', 'for', 'in', 'break', 'true', 'false', 'nil', 'and', 'or', 'not'
]);

module.exports = { TokenType, KEYWORDS };
