const { parse: parseNative } = require('../zlang/parser');
const ASTNode = require('./ast.js');

class Parser {
    constructor(tokens) {
        this.tokens = Array.isArray(tokens) ? tokens : [];
        this.pos = 0;
    }

    parse() {
        if (!this.tokens.length) return new ASTNode('Chunk', { body: [] });
        const source = this.tokens
            .filter(token => token && token.type !== 'EOF')
            .map(token => token.value === null || token.value === undefined ? '' : String(token.value))
            .join(' ');
        const ast = parseNative(source);
        return new ASTNode(ast.type, ast);
    }
}

module.exports = Parser;
