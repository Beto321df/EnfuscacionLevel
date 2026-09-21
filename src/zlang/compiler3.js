let luaparse = null;
function getLuaParse() {
    if (!luaparse) luaparse = require('luaparse');
    return luaparse;
}

// ZIR v2: semantic slots are numeric, closures use explicit upvalue descriptors.
// The bytecode remains stack-oriented for now; the backend no longer stores
// compiler-generated local names in the constant pool.
const OPS = Object.freeze({
    PUSH_CONST: 1, LOAD_VAR: 2, STORE_VAR: 3, LOAD_GLOBAL: 4, STORE_GLOBAL: 5,
    GET_MEMBER: 6, SET_MEMBER: 7, GET_INDEX: 8, SET_INDEX: 9,
    CALL: 10, CALL_MULTI: 11, CALL_METHOD: 12, CALL_METHOD_MULTI: 13,
    MAKE_FUNCTION: 14, RETURN: 15, RETURN_MULTI: 16, POP: 17, DUP: 18,
    BIN: 19, UNARY: 20, JUMP: 21, JUMP_IF_FALSE: 22, JUMP_IF_TRUE: 23,
    NEW_TABLE: 24, GET_VARARG: 25, FOR_NUM_PREP: 26, FOR_NUM_NEXT: 27,
    ITER_PREP: 28, ITER_NEXT: 29, NOP: 30, PACK_MULTI: 31,
    LOAD_LOCAL: 32, STORE_LOCAL: 33, LOAD_UPVALUE: 34, STORE_UPVALUE: 35,
    BREAK: 36,
    FUSED_LOCAL_CONST_BIN_STORE: 37,
    FUSED_LOCAL_LOCAL_BIN_STORE: 38,
    FUSED_GLOBAL_CALL: 39,
    RETURN_VOID: 40,
    UNPACK_MULTI: 41,
    RETURN_MIXED: 42,
    SETLIST_MULTI: 43,
    GET_VARARG_MULTI: 44,
    CALL_EXPAND: 45,
    CALL_METHOD_EXPAND: 46
});

const OPCODE_COUNT = 46;

const BIN = Object.freeze({ '+': 1, '-': 2, '*': 3, '/': 4, '%': 5, '^': 6, '..': 7, '==': 8, '~=': 9, '<': 10, '>': 11, '<=': 12, '>=': 13, '//': 14, '&': 15, '|': 16, '~': 17, '<<': 18, '>>': 19 });
const UNARY = Object.freeze({ not: 1, '-': 2, '#': 3, '~': 4 });

class ProgramBuilder {
    constructor() { this.constants = []; this.constantMap = new Map(); this.functions = []; }
    constant(type, value) {
        const key = `${type}:${String(value)}`;
        if (this.constantMap.has(key)) return this.constantMap.get(key);
        const index = this.constants.length;
        this.constants.push({ type, value });
        this.constantMap.set(key, index);
        return index;
    }
    string(value) { return this.constant(1, String(value)); }
    number(value) { return this.constant(2, Number(value)); }
    boolean(value) { return this.constant(3, value ? 1 : 0); }
    nil() { return this.constant(4, 0); }
    addFunction(fn) { const id = this.functions.length; fn.id = id; this.functions.push(fn); return id; }
}

class FunctionBuilder {
    constructor(program, parent, name) {
        this.program = program;
        this.parent = parent;
        this.name = name || `<fn:${program.functions.length}>`;
        this.code = [];
        this.scopes = [new Map()];
        this.nextSlot = 0;
        this.loopStack = [];
        this.labels = new Map();
        this.pendingGotos = [];
        this.upvalues = [];
        this.upvalueMap = new Map();
        this.iteratorLayouts = [];
        this.fn = {
            id: -1,
            name: this.name,
            params: [],
            vararg: false,
            localCount: 0,
            upvalues: this.upvalues,
            iteratorLayouts: this.iteratorLayouts,
            code: this.code
        };
    }

    here() { return this.code.length + 1; }
    emit(op, a = 0, b = 0, c = 0, d = 0) {
        const at = this.code.length;
        this.code.push([op, a >>> 0, b >>> 0, c >>> 0, d >>> 0]);
        return at;
    }
    patch(at, slot, value) { this.code[at][slot] = value >>> 0; }
    jump(op) { return this.emit(op); }
    pushScope() { this.scopes.push(new Map()); }
    popScope() { if (this.scopes.length > 1) this.scopes.pop(); }

    findLocal(name) {
        for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
            const found = this.scopes[i].get(name);
            if (found !== undefined) return found;
        }
        return null;
    }

    allocLocal(sourceName) {
        const slot = this.nextSlot++;
        if (sourceName !== undefined && sourceName !== null) this.scopes[this.scopes.length - 1].set(sourceName, slot);
        return slot;
    }

    allocTemp() { return this.allocLocal(null); }

    addUpvalue(name, parentBinding) {
        const existing = this.upvalueMap.get(name);
        if (existing !== undefined) return existing;
        const index = this.upvalues.length;
        this.upvalues.push({ kind: parentBinding.kind, index: parentBinding.index });
        this.upvalueMap.set(name, index);
        return index;
    }

    resolveForChild(name) {
        const local = this.findLocal(name);
        if (local !== null) return { kind: 'local', index: local };
        const ownUpvalue = this.upvalueMap.get(name);
        if (ownUpvalue !== undefined) return { kind: 'upvalue', index: ownUpvalue };
        if (!this.parent) return null;
        const parentBinding = this.parent.resolveForChild(name);
        if (!parentBinding) return null;
        return { kind: 'upvalue', index: this.addUpvalue(name, parentBinding) };
    }

    resolve(name) {
        const local = this.findLocal(name);
        if (local !== null) return { kind: 'local', index: local };
        const existing = this.upvalueMap.get(name);
        if (existing !== undefined) return { kind: 'upvalue', index: existing };
        if (this.parent) {
            const parentBinding = this.parent.resolveForChild(name);
            if (parentBinding) return { kind: 'upvalue', index: this.addUpvalue(name, parentBinding) };
        }
        return { kind: 'global', index: name };
    }

    loadName(name) {
        const r = this.resolve(name);
        if (r.kind === 'local') this.emit(OPS.LOAD_LOCAL, r.index);
        else if (r.kind === 'upvalue') this.emit(OPS.LOAD_UPVALUE, r.index);
        else this.emit(OPS.LOAD_GLOBAL, this.program.string(r.index));
    }

    storeName(name) {
        const r = this.resolve(name);
        if (r.kind === 'local') this.emit(OPS.STORE_LOCAL, r.index);
        else if (r.kind === 'upvalue') this.emit(OPS.STORE_UPVALUE, r.index);
        else this.emit(OPS.STORE_GLOBAL, this.program.string(r.index));
    }

    addIteratorLayout(slots) {
        const index = this.iteratorLayouts.length;
        this.iteratorLayouts.push(slots.slice());
        return index;
    }

    compileBlock(body, scoped = true) {
        if (scoped) this.pushScope();
        for (const stmt of body || []) this.emitStatement(stmt);
        if (scoped) this.popScope();
    }

    isMultiProducer(node) {
        if (!node) return false;
        return node.type === 'CallExpression' || node.type === 'TableCallExpression' ||
            node.type === 'StringCallExpression' || node.type === 'VarargLiteral';
    }

    emitValueList(expressions, targetCount) {
        const values = expressions || [];
        const targets = Math.max(0, targetCount | 0);
        if (targets === 0) {
            for (let i = 0; i < values.length; i += 1) this.emitExpr(values[i], false);
            for (let i = 0; i < values.length; i += 1) this.emit(OPS.POP);
            return;
        }

        const lastIndex = values.length - 1;
        const expandLast = lastIndex >= 0 && this.isMultiProducer(values[lastIndex]) && values.length <= targets;
        const prefixCount = expandLast ? lastIndex : Math.min(values.length, targets);

        // Every non-final expression is adjusted to one result. If there are
        // more expressions than destinations, still evaluate them for side effects.
        for (let i = 0; i < values.length; i += 1) {
            if (expandLast && i === lastIndex) {
                this.emitExpr(values[i], true);
                this.emit(OPS.UNPACK_MULTI, targets - prefixCount);
            } else {
                this.emitExpr(values[i], false);
            }
        }

        // Extra RHS results are discarded from the top of the stack.
        if (!expandLast && values.length > targets) {
            for (let i = values.length; i > targets; i -= 1) this.emit(OPS.POP);
        }
        // Missing RHS values are nil-padded.
        const produced = expandLast ? targets : Math.min(values.length, targets);
        for (let i = produced; i < targets; i += 1) this.emit(OPS.PUSH_CONST, this.program.nil());
    }

    emitExpr(node, wantMulti = false) {
        if (!node) return this.emit(OPS.PUSH_CONST, this.program.nil());
        const stackSafe = new Set([
            'BinaryExpression',
            'UnaryExpression',
            'LogicalExpression',
            'MemberExpression',
            'IndexExpression',
            'TableConstructorExpression',
            'CallExpression',
            'TableCallExpression',
            'StringCallExpression'
        ]);
        if (stackSafe.has(node.type)) return this.emitExprStackSafe(node, wantMulti);
        switch (node.type) {
            case 'Identifier': this.loadName(node.name); return;
            case 'StringLiteral': this.emit(OPS.PUSH_CONST, this.program.string(node.value)); return;
            case 'NumericLiteral': this.emit(OPS.PUSH_CONST, this.program.number(node.value)); return;
            case 'BooleanLiteral': this.emit(OPS.PUSH_CONST, this.program.boolean(node.value)); return;
            case 'NilLiteral': this.emit(OPS.PUSH_CONST, this.program.nil()); return;
            case 'VarargLiteral': this.emit(wantMulti ? OPS.GET_VARARG_MULTI : OPS.GET_VARARG); return;
            case 'FunctionExpression': this.emitFunction(node, false); return;
            default: throw new Error(`Z expression no soportada: ${node.type}.`);
        }
    }

    emitExprStackSafe(root, wantMulti = false) {
        const tasks = [{ kind: 'eval', node: root, wantMulti: !!wantMulti }];
        const logicalState = new Map();
        while (tasks.length) {
            const task = tasks.pop();
            if (task.kind === 'logicalPatch') {
                const branch = logicalState.get(task.node);
                if (!branch) throw new Error('Z logical expression patch missing.');
                this.patch(branch, 1, this.here());
                logicalState.delete(task.node);
                continue;
            }
            if (task.kind === 'logicalBranch') {
                const branch = this.jump(task.node.operator === 'and' ? OPS.JUMP_IF_FALSE : OPS.JUMP_IF_TRUE);
                logicalState.set(task.node, branch);
                continue;
            }
            if (task.kind === 'logicalDup') {
                this.emit(OPS.DUP);
                continue;
            }
            if (task.kind === 'logicalPop') {
                this.emit(OPS.POP);
                continue;
            }
            if (task.kind === 'binaryEmit') {
                this.emit(OPS.BIN, BIN[task.operator]);
                continue;
            }
            if (task.kind === 'unaryEmit') {
                this.emit(OPS.UNARY, UNARY[task.operator]);
                continue;
            }
            if (task.kind === 'memberEmit') {
                this.emit(OPS.GET_MEMBER, this.program.string(task.name));
                continue;
            }
            if (task.kind === 'indexEmit') {
                this.emit(OPS.GET_INDEX);
                continue;
            }
            if (task.kind === 'pushConst') {
                this.emit(OPS.PUSH_CONST, task.value);
                continue;
            }
            if (task.kind === 'tableSetIndex') {
                this.emit(OPS.SET_INDEX);
                continue;
            }
            if (task.kind === 'tableSetList') {
                this.emit(OPS.SETLIST_MULTI, task.index);
                continue;
            }
            if (task.kind === 'callEmit') {
                this.emitCallFromStack(task.node, task.wantMulti);
                continue;
            }

            const n = task.node;
            if (!n) {
                this.emit(OPS.PUSH_CONST, this.program.nil());
                continue;
            }
            if (n.type === 'BinaryExpression') {
                if (BIN[n.operator] === undefined) throw new Error(`Z no soporta operador binary ${n.operator}.`);
                tasks.push({ kind: 'binaryEmit', operator: n.operator });
                tasks.push({ kind: 'eval', node: n.right, wantMulti: false });
                tasks.push({ kind: 'eval', node: n.left, wantMulti: false });
                continue;
            }
            if (n.type === 'UnaryExpression') {
                if (UNARY[n.operator] === undefined) throw new Error(`Z no soporta operador unary ${n.operator}.`);
                tasks.push({ kind: 'unaryEmit', operator: n.operator });
                tasks.push({ kind: 'eval', node: n.argument, wantMulti: false });
                continue;
            }
            if (n.type === 'LogicalExpression') {
                if (n.operator !== 'and' && n.operator !== 'or') throw new Error(`Z lógica inválida: ${n.operator}`);
                tasks.push({ kind: 'logicalPatch', node: n });
                tasks.push({ kind: 'eval', node: n.right, wantMulti: task.wantMulti });
                tasks.push({ kind: 'logicalPop' });
                tasks.push({ kind: 'logicalBranch', node: n });
                tasks.push({ kind: 'logicalDup' });
                tasks.push({ kind: 'eval', node: n.left, wantMulti: false });
                continue;
            }

            if (n.type === 'MemberExpression') {
                tasks.push({ kind: 'memberEmit', name: n.identifier.name });
                tasks.push({ kind: 'eval', node: n.base, wantMulti: false });
                continue;
            }
            if (n.type === 'IndexExpression') {
                tasks.push({ kind: 'indexEmit' });
                tasks.push({ kind: 'eval', node: n.index, wantMulti: false });
                tasks.push({ kind: 'eval', node: n.base, wantMulti: false });
                continue;
            }
            if (n.type === 'TableConstructorExpression') {
                this.emit(OPS.NEW_TABLE);
                const fields = n.fields || [];
                const plans = [];
                let arrayIndex = 1;
                for (let index = 0; index < fields.length; index += 1) {
                    const field = fields[index];
                    const lastArrayValue = field.type === 'TableValue' &&
                        index === fields.length - 1 &&
                        this.isMultiProducer(field.value);
                    if (field.type === 'TableValue' && !lastArrayValue) {
                        plans.push({ field, arrayIndex });
                        arrayIndex += 1;
                    } else plans.push({ field, arrayIndex, lastArrayValue });
                }
                for (let index = plans.length - 1; index >= 0; index -= 1) {
                    const plan = plans[index];
                    const field = plan.field;
                    if (field.type === 'TableKeyString') {
                        tasks.push({ kind: 'tableSetIndex' });
                        tasks.push({ kind: 'eval', node: field.value, wantMulti: false });
                        tasks.push({ kind: 'pushConst', value: this.program.string(field.key.name) });
                        tasks.push({ kind: 'logicalDup' });
                    } else if (field.type === 'TableKey') {
                        tasks.push({ kind: 'tableSetIndex' });
                        tasks.push({ kind: 'eval', node: field.value, wantMulti: false });
                        tasks.push({ kind: 'eval', node: field.key, wantMulti: false });
                        tasks.push({ kind: 'logicalDup' });
                    } else if (field.type === 'TableValue') {
                        if (plan.lastArrayValue) {
                            tasks.push({ kind: 'tableSetList', index: plan.arrayIndex });
                            tasks.push({ kind: 'eval', node: field.value, wantMulti: true });
                            tasks.push({ kind: 'logicalDup' });
                        } else {
                            tasks.push({ kind: 'tableSetIndex' });
                            tasks.push({ kind: 'eval', node: field.value, wantMulti: false });
                            tasks.push({ kind: 'pushConst', value: this.program.number(plan.arrayIndex) });
                            tasks.push({ kind: 'logicalDup' });
                        }
                    } else throw new Error(`Z table field no soportado: ${field.type}.`);
                }
                continue;
            }
            if (n.type === 'CallExpression' || n.type === 'TableCallExpression' || n.type === 'StringCallExpression') {
                const call = n.type === 'CallExpression'
                    ? n
                    : n.type === 'TableCallExpression'
                        ? { type: 'CallExpression', base: n.base, arguments: n.arguments || [] }
                        : { type: 'CallExpression', base: n.base, arguments: [n.argument] };
                tasks.push({ kind: 'callEmit', node: call, wantMulti: task.wantMulti });
                const args = call.arguments || [];
                const expandsLast = args.length > 0 && this.isMultiProducer(args[args.length - 1]);
                for (let i = args.length - 1; i >= 0; i -= 1) {
                    tasks.push({ kind: 'eval', node: args[i], wantMulti: expandsLast && i === args.length - 1 });
                }
                // For Lua/Luau method calls (obj:method(...)), CALL_METHOD
                // consumes the receiver and resolves the method name itself.
                // Evaluating the whole MemberExpression here would instead
                // push obj.method as the receiver and later index that function
                // with the method name.
                const receiver = call.base && call.base.type === 'MemberExpression' && call.base.indexer === ':'
                    ? call.base.base
                    : call.base;
                tasks.push({ kind: 'eval', node: receiver, wantMulti: false });
                continue;
            }
            if (n.type === 'FunctionExpression') {
                this.emitFunction(n, false);
                continue;
            }
            this.emitExpr(n, task.wantMulti);
        }
    }

    emitCallFromStack(node, wantMulti) {
        const base = node.base;
        const args = node.arguments || [];
        const expandsLast = args.length > 0 && this.isMultiProducer(args[args.length - 1]);
        if (base && base.type === 'MemberExpression' && base.indexer === ':') {
            if (expandsLast) this.emit(OPS.CALL_METHOD_EXPAND, this.program.string(base.identifier.name), args.length - 1);
            else this.emit(wantMulti ? OPS.CALL_METHOD_MULTI : OPS.CALL_METHOD, this.program.string(base.identifier.name), args.length);
            return;
        }
        if (expandsLast) {
            this.emit(OPS.CALL_EXPAND, args.length - 1);
        } else {
            this.emit(wantMulti ? OPS.CALL_MULTI : OPS.CALL, args.length);
        }
    }

    emitCall(node, wantMulti) {
        return this.emitExprStackSafe(node, wantMulti);
        const args = node.arguments || [];
        const expandsLast = args.length > 0 && this.isMultiProducer(args[args.length - 1]);
        if (base && base.type === 'MemberExpression' && base.indexer === ':') {
            this.emitExpr(base.base);
            if (expandsLast) {
                for (let i = 0; i < args.length - 1; i += 1) this.emitExpr(args[i], false);
                this.emitExpr(args[args.length - 1], true);
                this.emit(OPS.CALL_METHOD_EXPAND, this.program.string(base.identifier.name), args.length - 1);
            } else {
                for (const arg of args) this.emitExpr(arg, false);
                this.emit(wantMulti ? OPS.CALL_METHOD_MULTI : OPS.CALL_METHOD, this.program.string(base.identifier.name), args.length);
            }
            return;
        }
        this.emitExpr(base);
        if (expandsLast) {
            for (let i = 0; i < args.length - 1; i += 1) this.emitExpr(args[i], false);
            this.emitExpr(args[args.length - 1], true);
            this.emit(OPS.CALL_EXPAND, args.length - 1);
        } else {
            for (const arg of args) this.emitExpr(arg, false);
            this.emit(wantMulti ? OPS.CALL_MULTI : OPS.CALL, args.length);
        }
    }

    emitFunction(node, implicitSelf) {
        const child = new FunctionBuilder(this.program, this, `fn${this.program.functions.length}`);
        const id = this.program.addFunction(child.fn);
        child.fn.id = id;
        child.fn.vararg = !!node.isVararg;
        if (implicitSelf) child.fn.params.push(child.allocLocal('self'));
        for (const param of node.parameters || []) {
            if (param.type !== 'Identifier') throw new Error('Z solo soporta parámetros identificadores simples.');
            child.fn.params.push(child.allocLocal(param.name));
        }
        child.compileBlock(node.body || [], false);
        child.emit(OPS.PUSH_CONST, this.program.nil());
        child.emit(OPS.RETURN, 1);
        child.resolveGotos();
        child.fn.localCount = child.nextSlot;
        child.fn.upvalues = child.upvalues;
        child.fn.iteratorLayouts = child.iteratorLayouts;
        this.emit(OPS.MAKE_FUNCTION, id);
    }

    emitAssignmentTarget(node, tempSlot) {
        if (node.type === 'Identifier') {
            this.emit(OPS.LOAD_LOCAL, tempSlot);
            this.storeName(node.name);
            return;
        }
        if (node.type === 'MemberExpression') {
            this.emitExpr(node.base);
            this.emit(OPS.LOAD_LOCAL, tempSlot);
            this.emit(OPS.SET_MEMBER, this.program.string(node.identifier.name));
            return;
        }
        if (node.type === 'IndexExpression') {
            this.emitExpr(node.base);
            this.emitExpr(node.index);
            this.emit(OPS.LOAD_LOCAL, tempSlot);
            this.emit(OPS.SET_INDEX);
            return;
        }
        throw new Error(`Z assignment destino no soportado: ${node.type}.`);
    }

    emitStatement(node) {
        if (!node) return;
        switch (node.type) {
            case 'LocalStatement': {
                const init = node.init || [];
                const vars = node.variables || [];
                this.emitValueList(init, vars.length);
                const slots = vars.map(v => {
                    if (v.type !== 'Identifier') throw new Error('Z local complejo no soportado.');
                    return this.allocLocal(v.name);
                });
                for (let i = slots.length - 1; i >= 0; i -= 1) this.emit(OPS.STORE_LOCAL, slots[i]);
                return;
            }
            case 'AssignmentStatement': {
                const vars = node.variables || [];
                const init = node.init || [];
                this.emitValueList(init, vars.length);
                // The value stack is LIFO. Allocate all temporary slots first,
                // then pop from the stack in reverse so a,b=x,y preserves a=x,b=y.
                const temps = new Array(vars.length);
                for (let i = 0; i < vars.length; i += 1) temps[i] = this.allocTemp();
                for (let i = vars.length - 1; i >= 0; i -= 1) this.emit(OPS.STORE_LOCAL, temps[i]);
                for (let i = 0; i < vars.length; i += 1) this.emitAssignmentTarget(vars[i], temps[i]);
                return;
            }
            case 'CallStatement': this.emitExpr(node.expression); this.emit(OPS.POP); return;
            case 'ReturnStatement': {
                const args = node.arguments || [];
                if (!args.length) this.emit(OPS.RETURN_VOID);
                else if (args.length === 1) { this.emitExpr(args[0], true); this.emit(OPS.RETURN, 1); }
                else {
                    const last = args[args.length - 1];
                    for (let i = 0; i < args.length - 1; i += 1) this.emitExpr(args[i], false);
                    if (this.isMultiProducer(last)) { this.emitExpr(last, true); this.emit(OPS.RETURN_MIXED, args.length - 1); }
                    else { this.emitExpr(last, false); this.emit(OPS.RETURN_MULTI, args.length); }
                }
                return;
            }
            case 'IfStatement': {
                const endJumps = [];
                for (let i = 0; i < (node.clauses || []).length; i += 1) {
                    const clause = node.clauses[i];
                    if (clause.type === 'ElseClause') { this.compileBlock(clause.body, true); continue; }
                    this.emitExpr(clause.condition);
                    const no = this.jump(OPS.JUMP_IF_FALSE);
                    this.compileBlock(clause.body, true);
                    if (i < node.clauses.length - 1) endJumps.push(this.jump(OPS.JUMP));
                    this.patch(no, 1, this.here());
                }
                const end = this.here();
                for (const at of endJumps) this.patch(at, 1, end);
                return;
            }
            case 'WhileStatement': {
                const start = this.here();
                this.emitExpr(node.condition);
                const exit = this.jump(OPS.JUMP_IF_FALSE);
                const loop = { breaks: [], continues: [] };
                this.loopStack.push(loop);
                this.compileBlock(node.body, true);
                this.emit(OPS.JUMP, start);
                const end = this.here();
                this.patch(exit, 1, end);
                for (const at of loop.breaks) this.patch(at, 1, end);
                for (const at of loop.continues) this.patch(at, 1, start);
                this.loopStack.pop();
                return;
            }
            case 'RepeatStatement': {
                const start = this.here();
                const loop = { breaks: [], continues: [] };
                this.loopStack.push(loop);
                this.compileBlock(node.body, true);
                const conditionPc = this.here();
                for (const at of loop.continues) this.patch(at, 1, conditionPc);
                this.emitExpr(node.condition);
                const back = this.jump(OPS.JUMP_IF_FALSE);
                this.patch(back, 1, start);
                const end = this.here();
                for (const at of loop.breaks) this.patch(at, 1, end);
                this.loopStack.pop();
                return;
            }
            case 'DoStatement': this.compileBlock(node.body, true); return;
            case 'BreakStatement': {
                const loop = this.loopStack[this.loopStack.length - 1];
                if (!loop) throw new Error('Z encontró break fuera de un loop.');
                const at = this.emit(OPS.BREAK);
                loop.breaks.push(at);
                return;
            }
            case 'ContinueStatement': {
                const loop = this.loopStack[this.loopStack.length - 1];
                if (!loop) throw new Error('Z encontró continue fuera de un loop.');
                const at = this.emit(OPS.JUMP);
                loop.continues.push(at);
                return;
            }
            case 'ForNumericStatement': {
                if (!node.variable || node.variable.type !== 'Identifier') throw new Error('Z numeric for variable inválida.');
                this.emitExpr(node.start);
                this.emitExpr(node.end);
                this.emitExpr(node.step || { type: 'NumericLiteral', value: 1 });
                this.pushScope();
                const slot = this.allocLocal(node.variable.name);
                const prep = this.emit(OPS.FOR_NUM_PREP, slot);
                const bodyStart = this.here();
                const loop = { breaks: [], continues: [] };
                this.loopStack.push(loop);
                this.compileBlock(node.body, false);
                const nextPc = this.here();
                for (const at of loop.continues) this.patch(at, 1, nextPc);
                const nextInsn = this.emit(OPS.FOR_NUM_NEXT);
                this.emit(OPS.JUMP, bodyStart);
                const end = this.here();
                this.patch(prep, 4, end);
                this.patch(nextInsn, 4, end);
                for (const at of loop.breaks) this.patch(at, 1, end);
                this.loopStack.pop();
                this.popScope();
                return;
            }
            case 'ForGenericStatement': {
                const vars = node.variables || [];
                const iterators = node.iterators || [];
                if (!vars.length || !iterators.length || iterators.length > 3) throw new Error('Z generic for soporta uno a tres valores de iterador.');
                if (iterators.length === 1) this.emitExpr(iterators[0], true);
                else {
                    for (const iterator of iterators) this.emitExpr(iterator);
                    for (let i = iterators.length; i < 3; i += 1) this.emit(OPS.PUSH_CONST, this.program.nil());
                    this.emit(OPS.PACK_MULTI, 3);
                }
                this.pushScope();
                const slots = vars.map(v => {
                    if (v.type !== 'Identifier') throw new Error('Z generic for variable inválida.');
                    return this.allocLocal(v.name);
                });
                const layout = this.addIteratorLayout(slots);
                const prep = this.emit(OPS.ITER_PREP, slots.length, layout);
                const bodyStart = this.here();
                const loop = { breaks: [], continues: [] };
                this.loopStack.push(loop);
                this.compileBlock(node.body, false);
                const next = this.here();
                for (const at of loop.continues) this.patch(at, 1, next);
                const nextInsn = this.emit(OPS.ITER_NEXT, 0, bodyStart, 0, 0);
                const end = this.here();
                this.patch(prep, 4, end);
                this.patch(nextInsn, 4, end);
                for (const at of loop.breaks) this.patch(at, 1, end);
                this.loopStack.pop();
                this.popScope();
                return;
            }
            case 'FunctionDeclaration': {
                const identifier = node.identifier;
                const implicitSelf = identifier && identifier.type === 'MemberExpression' && identifier.indexer === ':';
                let localSlot = null;
                if (node.isLocal && identifier.type === 'Identifier') localSlot = this.allocLocal(identifier.name);
                this.emitFunction(node, !!implicitSelf);
                if (identifier.type === 'Identifier') {
                    if (node.isLocal) this.emit(OPS.STORE_LOCAL, localSlot);
                    else this.emit(OPS.STORE_GLOBAL, this.program.string(identifier.name));
                } else if (identifier.type === 'MemberExpression') {
                    this.emitExpr(identifier.base);
                    this.emit(OPS.SET_MEMBER, this.program.string(identifier.identifier.name));
                } else throw new Error(`Z function target no soportado: ${identifier.type}.`);
                return;
            }
            case 'GotoStatement': this.pendingGotos.push({ at: this.emit(OPS.JUMP), label: node.label.name }); return;
            case 'LabelStatement': this.labels.set(node.label.name, this.here()); return;
            case 'EmptyStatement': this.emit(OPS.NOP); return;
            default: throw new Error(`Z statement no soportada: ${node.type}.`);
        }
    }

    resolveGotos() {
        for (const item of this.pendingGotos) {
            const target = this.labels.get(item.label);
            if (target === undefined) throw new Error(`Z label no encontrada: ${item.label}.`);
            this.patch(item.at, 1, target);
        }
    }
}

function finalizeFunction(fn) {
    fn.localCount = Number(fn.localCount || 0);
    fn.upvalues = Array.isArray(fn.upvalues) ? fn.upvalues : [];
    fn.iteratorLayouts = Array.isArray(fn.iteratorLayouts) ? fn.iteratorLayouts : [];
    return fn;
}

function buildProgramFromAst(ast) {
    if (!ast || !Array.isArray(ast.body)) throw new TypeError('Z compiler esperaba un AST Chunk.');
    const program = new ProgramBuilder();
    const root = new FunctionBuilder(program, null, '<main>');
    const rootId = program.addFunction(root.fn);
    root.fn.id = rootId;
    root.compileBlock(ast.body, false);
    root.emit(OPS.PUSH_CONST, program.nil());
    root.emit(OPS.RETURN, 1);
    root.resolveGotos();
    root.fn.localCount = root.nextSlot;
    root.fn.upvalues = root.upvalues;
    root.fn.iteratorLayouts = root.iteratorLayouts;
    program.functions.forEach(finalizeFunction);
    return {
        version: 3,
        irVersion: 2,
        stage: 'ZIR',
        root: rootId,
        constants: program.constants,
        functions: program.functions
    };
}

function buildProgram(source) {
    const ast = getLuaParse().parse(source, { wait: false, comments: false, scope: false, locations: false, ranges: false, luaVersion: '5.1' });
    return buildProgramFromAst(ast);
}

module.exports = { OPS, OPCODE_COUNT, BIN, UNARY, buildProgram, buildProgramFromAst };
