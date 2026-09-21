const { TOKEN_TYPES, tokenize } = require('./lexer');
const { node } = require('./ast');

const BINARY = new Map([
    ['or', 1], ['||', 1],
    ['and', 2], ['&&', 2],
    ['==', 3], ['~=', 3], ['<', 3], ['>', 3], ['<=', 3], ['>=', 3],
    ['|', 4], ['~', 5], ['&', 6], ['<<', 7], ['>>', 7],
    ['..', 8],
    ['+', 9], ['-', 9],
    ['*', 10], ['/ ', 10], ['/', 10], ['//', 10], ['%', 10],
    ['^', 12]
]);
const RIGHT_ASSOC = new Set(['^', '..']);
const UNARY = new Set(['not', '-', '#', '~']);
const ASSIGN = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '..=']);
const STOP_BLOCK = new Set(['end', 'else', 'elseif', 'until']);

class ZParser {
    constructor(source, options = {}) {
        this.source = source;
        this.options = options;
        this.tokens = tokenize(source);
        this.pos = 0;
    }

    current() { return this.tokens[this.pos]; }
    at(text) { return this.current().text === text; }
    eof() { return this.current().type === TOKEN_TYPES.EOF; }
    peek(offset = 1) { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }

    advance() { const t = this.current(); if (!this.eof()) this.pos += 1; return t; }
    accept(text) { if (this.at(text)) { return this.advance(); } return null; }
    expect(text) {
        if (!this.at(text)) this.error(`esperaba '${text}'`, this.current());
        return this.advance();
    }
    error(message, token = this.current()) {
        const suffix = token && token.line ? ` (línea ${token.line}, columna ${token.column})` : '';
        throw new SyntaxError(`Z parser: ${message}${suffix}. Cerca de '${token && token.text ? token.text : '<eof>'}'.`);
    }

    parse() {
        const body = this.parseBlock(new Set());
        if (!this.eof()) this.error('token inesperado', this.current());
        return node('Chunk', { body });
    }

    parseBlock(stopWords) {
        const body = [];
        while (!this.eof()) {
            if (stopWords.has(this.current().text)) break;
            const stmt = this.parseStatement();
            if (stmt) body.push(stmt);
        }
        return body;
    }

    parseStatement() {
        const t = this.current();
        switch (t.text) {
            case ';': this.advance(); return node('EmptyStatement');
            case 'local': return this.parseLocal();
            case 'function': return this.parseFunctionDeclaration(false);
            case 'if': return this.parseIf();
            case 'while': return this.parseWhile();
            case 'repeat': return this.parseRepeat();
            case 'do': return this.parseDo();
            case 'for': return this.parseFor();
            case 'return': return this.parseReturn();
            case 'break': this.advance(); return node('BreakStatement');
            case 'continue': this.advance(); return node('ContinueStatement');
            case 'goto': return this.parseGoto();
            case '::': return this.parseLabel();
            case 'type':
            case 'export':
                return this.parseTypeDeclaration();
            default: return this.parseAssignmentOrCall();
        }
    }

    parseLocal() {
        this.expect('local');
        if (this.at('function')) return this.parseFunctionDeclaration(true);
        const variables = [this.parseTypedIdentifier()];
        while (this.accept(',')) variables.push(this.parseTypedIdentifier());
        const init = this.accept('=') ? this.parseExpressionList() : [];
        return node('LocalStatement', { variables, init });
    }

    parseTypedIdentifier() {
        const ident = this.parseIdentifierNode();
        if (this.accept(':')) this.skipTypeExpression(new Set([',', '=', ')', 'do']));
        return ident;
    }

    skipTypeExpression(stop) {
        let depth = 0;
        while (!this.eof()) {
            const t = this.current().text;
            if (depth === 0 && stop.has(t)) return;
            if (['<', '{', '[', '('].includes(t)) depth += 1;
            else if (['>', '}', ']', ')'].includes(t) && depth > 0) depth -= 1;
            this.advance();
        }
    }

    parseFunctionDeclaration(isLocal) {
        this.expect('function');
        const identifier = this.parseFunctionName();
        const { parameters, isVararg } = this.parseParameters();
        const body = this.parseBlock(new Set(['end']));
        this.expect('end');
        return node('FunctionDeclaration', { identifier, parameters, isVararg, body, isLocal: !!isLocal });
    }

    parseFunctionName() {
        let result = this.parseIdentifierNode();
        while (this.at('.') || this.at(':')) {
            const indexer = this.advance().text;
            const property = this.parseIdentifierNode();
            result = node('MemberExpression', { base: result, indexer, identifier: property });
        }
        return result;
    }

    parseParameters() {
        this.expect('(');
        const parameters = [];
        let isVararg = false;
        if (!this.at(')')) {
            for (;;) {
                if (this.accept('...')) { isVararg = true; break; }
                const param = this.parseTypedIdentifier();
                parameters.push(param);
                if (!this.accept(',')) break;
            }
        }
        this.expect(')');
        if (this.accept(':')) this.skipTypeExpression(new Set(['local', 'function', 'if', 'while', 'for', 'return', 'end', 'do', 'repeat']));
        return { parameters, isVararg };
    }

    parseIf() {
        this.expect('if');
        const clauses = [];
        clauses.push(node('IfClause', { condition: this.parseExpression(), body: this.parseClauseBody() }));
        while (this.accept('elseif')) clauses.push(node('IfClause', { condition: this.parseExpression(), body: this.parseClauseBody() }));
        if (this.accept('else')) clauses.push(node('ElseClause', { body: this.parseClauseBody(false) }));
        this.expect('end');
        return node('IfStatement', { clauses });
    }

    parseClauseBody(expectThen = true) {
        if (expectThen) this.expect('then');
        return this.parseBlock(new Set(['elseif', 'else', 'end']));
    }

    parseWhile() {
        this.expect('while');
        const condition = this.parseExpression();
        this.expect('do');
        const body = this.parseBlock(new Set(['end']));
        this.expect('end');
        return node('WhileStatement', { condition, body });
    }

    parseRepeat() {
        this.expect('repeat');
        const body = this.parseBlock(new Set(['until']));
        this.expect('until');
        const condition = this.parseExpression();
        return node('RepeatStatement', { body, condition });
    }

    parseDo() {
        this.expect('do');
        const body = this.parseBlock(new Set(['end']));
        this.expect('end');
        return node('DoStatement', { body });
    }

    parseFor() {
        this.expect('for');
        const first = this.parseTypedIdentifier();
        if (this.accept('=')) {
            const start = this.parseExpression();
            this.expect(',');
            const end = this.parseExpression();
            let step = null;
            if (this.accept(',')) step = this.parseExpression();
            this.expect('do');
            const body = this.parseBlock(new Set(['end']));
            this.expect('end');
            return node('ForNumericStatement', { variable: first, start, end, step, body });
        }
        const variables = [first];
        while (this.accept(',')) variables.push(this.parseTypedIdentifier());
        this.expect('in');
        const iterators = this.parseExpressionList();
        this.expect('do');
        const body = this.parseBlock(new Set(['end']));
        this.expect('end');
        return node('ForGenericStatement', { variables, iterators, body });
    }

    parseReturn() {
        this.expect('return');
        if (this.at('end') || this.at('elseif') || this.at('else') || this.at('until') || this.at(';') || this.eof()) return node('ReturnStatement', { arguments: [] });
        const args = this.parseExpressionList();
        this.accept(';');
        return node('ReturnStatement', { arguments: args });
    }

    parseGoto() {
        this.expect('goto');
        const label = this.parseIdentifierNode();
        return node('GotoStatement', { label });
    }

    parseLabel() {
        this.expect('::');
        const label = this.parseIdentifierNode();
        this.expect('::');
        return node('LabelStatement', { label });
    }

    parseTypeDeclaration() {
        const exported = this.accept('export');
        if (!this.accept('type')) this.error('declaración export no soportada', this.current());
        if (!this.at('IDENT') && this.current().type !== TOKEN_TYPES.IDENT && this.current().type !== TOKEN_TYPES.KEYWORD) this.error('nombre de tipo inválido');
        this.advance();
        if (this.accept('(')) this.skipTypeExpression(new Set([')']));
        if (this.accept('=')) this.skipTypeExpression(new Set(['local', 'function', 'if', 'while', 'for', 'return', 'end', 'do', 'repeat', ';']));
        this.accept(';');
        return node('EmptyStatement', { typeOnly: true, exported: !!exported });
    }

    parseAssignmentOrCall() {
        const first = this.parsePrefixExpression();
        if (ASSIGN.has(this.current().text) || this.at(',')) {
            const variables = [this.toAssignmentTarget(first)];
            while (this.accept(',')) variables.push(this.toAssignmentTarget(this.parsePrefixExpression()));
            const op = this.current().text;
            if (!ASSIGN.has(op)) this.error('se esperaba operador de asignación');
            this.advance();
            let init = this.parseExpressionList();
            if (op !== '=') {
                if (variables.length !== 1 || init.length !== 1 || variables[0].type !== 'Identifier') this.error(`asignación compuesta '${op}' requiere un destino simple`);
                const operator = op.slice(0, -1);
                init = [node('BinaryExpression', { operator, left: variables[0], right: init[0] })];
            }
            return node('AssignmentStatement', { variables, init });
        }
        if (first && ['CallExpression', 'TableCallExpression', 'StringCallExpression'].includes(first.type)) return node('CallStatement', { expression: first });
        this.error('sentencia no soportada', this.current());
    }

    toAssignmentTarget(expr) {
        if (['Identifier', 'MemberExpression', 'IndexExpression'].includes(expr.type)) return expr;
        this.error('destino de asignación inválido');
    }

    parseExpressionList() {
        const out = [this.parseExpression()];
        while (this.accept(',')) out.push(this.parseExpression());
        return out;
    }

    parseExpression() {
        // Shunting-yard style expression parsing keeps very deep right-associative
        // chains (notably ^ and ..) off the JavaScript call stack.
        const values = [this.parseUnaryOrPrimary()];
        const operators = [];
        const reduce = () => {
            const op = operators.pop();
            const right = values.pop();
            const left = values.pop();
            const logical = op === 'and' || op === 'or' || op === '&&' || op === '||';
            values.push(node(logical ? 'LogicalExpression' : 'BinaryExpression', {
                operator: op === '&&' ? 'and' : op === '||' ? 'or' : op,
                left,
                right
            }));
        };

        for (;;) {
            const op = this.current().text;
            const precedence = BINARY.get(op);
            if (precedence === undefined) break;

            this.advance();
            while (operators.length) {
                const top = operators[operators.length - 1];
                const topPrecedence = BINARY.get(top);
                if (topPrecedence === undefined) break;
                const incomingRightAssociative = RIGHT_ASSOC.has(op);
                if (topPrecedence > precedence || (topPrecedence === precedence && !incomingRightAssociative)) reduce();
                else break;
            }
            operators.push(op);
            values.push(this.parseUnaryOrPrimary());
        }

        while (operators.length) reduce();
        return values[0];
    }

    parseUnaryOrPrimary() {
        const operators = [];
        while (UNARY.has(this.current().text)) operators.push(this.advance().text);
        let expr = this.parsePrefixExpression();
        for (let i = operators.length - 1; i >= 0; i -= 1) {
            expr = node('UnaryExpression', { operator: operators[i], argument: expr });
        }
        return expr;
    }

    parsePrefixExpression() {
        let expr = this.parsePrimary();
        for (;;) {
            if (this.accept('.')) {
                const identifier = this.parseIdentifierNode();
                expr = node('MemberExpression', { base: expr, indexer: '.', identifier });
            } else if (this.accept(':')) {
                const identifier = this.parseIdentifierNode();
                expr = node('MemberExpression', { base: expr, indexer: ':', identifier });
                if (this.at('(') || this.at('{') || this.current().type === TOKEN_TYPES.STRING) expr = this.finishCall(expr);
            } else if (this.accept('[')) {
                const index = this.parseExpression();
                this.expect(']');
                expr = node('IndexExpression', { base: expr, index });
            } else if (this.at('(') || this.at('{') || this.current().type === TOKEN_TYPES.STRING) {
                expr = this.finishCall(expr);
            } else break;
        }
        return expr;
    }

    finishCall(base) {
        if (this.at('(')) {
            this.expect('(');
            const args = this.at(')') ? [] : this.parseExpressionList();
            this.expect(')');
            return node('CallExpression', { base, arguments: args });
        }
        if (this.at('{')) return node('TableCallExpression', { base, arguments: [this.parsePrimary()] });
        const argument = this.parsePrimary();
        return node('StringCallExpression', { base, argument });
    }

    parsePrimary() {
        const t = this.current();
        if (t.type === TOKEN_TYPES.IDENT) return this.parseIdentifierNode();
        if (t.type === TOKEN_TYPES.KEYWORD && t.text === 'type') return this.parseIdentifierNode();
        if (t.type === TOKEN_TYPES.KEYWORD && !['true', 'false', 'nil', 'function'].includes(t.text)) this.error('palabra reservada inesperada', t);
        if (t.type === TOKEN_TYPES.NUMBER) { this.advance(); return node('NumericLiteral', { value: t.value }); }
        if (t.type === TOKEN_TYPES.STRING) { this.advance(); return node('StringLiteral', { value: t.value !== undefined ? t.value : t.text.slice(1, -1) }); }
        if (t.text === 'true' || t.text === 'false') { this.advance(); return node('BooleanLiteral', { value: t.text === 'true' }); }
        if (t.text === 'nil') { this.advance(); return node('NilLiteral'); }
        if (t.text === '...') { this.advance(); return node('VarargLiteral'); }
        if (t.text === '(') {
            this.advance();
            const expr = this.parseExpression();
            this.expect(')');
            return expr;
        }
        if (t.text === '{') return this.parseTable();
        if (t.text === 'function') return this.parseFunctionExpression();
        this.error('expresión inválida', t);
    }

    parseIdentifierNode() {
        const t = this.current();
        if (t.type !== TOKEN_TYPES.IDENT && !(t.type === TOKEN_TYPES.KEYWORD && (t.text === 'self' || t.text === 'type'))) this.error('se esperaba identificador', t);
        this.advance();
        return node('Identifier', { name: t.text });
    }

    parseFunctionExpression() {
        this.expect('function');
        if (this.at('<')) { this.advance(); this.skipTypeExpression(new Set(['>'])); this.expect('>'); }
        const { parameters, isVararg } = this.parseParameters();
        const body = this.parseBlock(new Set(['end']));
        this.expect('end');
        return node('FunctionExpression', { parameters, isVararg, body });
    }

    parseTable() {
        this.expect('{');
        const fields = [];
        while (!this.at('}') && !this.eof()) {
            let field;
            if (this.current().type === TOKEN_TYPES.IDENT && this.peek().text === '=') {
                const key = this.parseIdentifierNode(); this.expect('=');
                field = node('TableKeyString', { key, value: this.parseExpression() });
            } else if (this.accept('[')) {
                const key = this.parseExpression(); this.expect(']'); this.expect('=');
                field = node('TableKey', { key, value: this.parseExpression() });
            } else {
                field = node('TableValue', { value: this.parseExpression() });
            }
            fields.push(field);
            if (!this.accept(',') && !this.accept(';')) break;
        }
        this.expect('}');
        return node('TableConstructorExpression', { fields });
    }
}

function parse(source, options = {}) { return new ZParser(source, options).parse(); }

module.exports = { ZParser, parse };
