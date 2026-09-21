const { tokenize, TOKEN_TYPES } = require('../zlang/lexer');
const { TokenType } = require('./tokens.js');

const TYPE_MAP = Object.freeze({
    [TOKEN_TYPES.KEYWORD]: TokenType.KEYWORD,
    [TOKEN_TYPES.IDENT]: TokenType.IDENTIFIER,
    [TOKEN_TYPES.NUMBER]: TokenType.NUMBER,
    [TOKEN_TYPES.STRING]: TokenType.STRING,
    [TOKEN_TYPES.OPERATOR]: TokenType.OPERATOR,
    [TOKEN_TYPES.PUNCT]: TokenType.SYMBOL,
    [TOKEN_TYPES.OTHER]: TokenType.SYMBOL,
    [TOKEN_TYPES.EOF]: TokenType.EOF
});

class Tokenizer {
    constructor(input) {
        this.input = input;
        this.pos = 0;
    }

    tokenize() {
        return tokenize(this.input).map(token => ({
            type: TYPE_MAP[token.type] || TokenType.SYMBOL,
            value: token.type === TOKEN_TYPES.NUMBER || token.type === TOKEN_TYPES.STRING ? token.value : token.text
        }));
    }
}

module.exports = Tokenizer;
