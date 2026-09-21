const { REG_OPS } = require('./registerVm');
const { BIN, UNARY } = require('./compiler3');

const MULTI = Symbol('Z3RegisterMulti');
function multi(values) { return { [MULTI]: true, values }; }
function isMulti(value) { return !!value && typeof value === 'object' && value[MULTI] === true; }
function truthy(value) { return value !== null && value !== undefined && value !== false; }
function luaLen(value) {
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    if (value && typeof value === 'object') { let i = 1; while (Object.prototype.hasOwnProperty.call(value, i)) i += 1; return i - 1; }
    return 0;
}
function constantValue(entry) { return entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value') ? entry.value : entry; }
function luaBinary(id, left, right) {
    switch (id) {
        case BIN['+']: return left + right; case BIN['-']: return left - right; case BIN['*']: return left * right;
        case BIN['/']: return left / right; case BIN['%']: return left % right; case BIN['^']: return left ** right;
        case BIN['..']: return String(left) + String(right); case BIN['==']: return left === right; case BIN['~=']: return left !== right;
        case BIN['<']: return left < right; case BIN['>']: return left > right; case BIN['<=']: return left <= right; case BIN['>=']: return left >= right;
        case BIN['//']: return Math.floor(left / right); case BIN['&']: return left & right; case BIN['|']: return left | right;
        case BIN['~']: return left ^ right; case BIN['<<']: return left << right; case BIN['>>']: return left >> right;
        default: throw new Error(`Z register VM: binary opcode ${id}`);
    }
}
const PC_MUL = 65537;
const PC_INV = 4294901761;
function mul32(a, b) { const al=a%65536, ah=Math.floor(a/65536), bl=b%65536, bh=Math.floor(b/65536); return (al*bl+(al*bh+ah*bl)*65536)%4294967296; }
function decodePc(token, add, encoded = true) { return encoded ? (mul32((token - add) >>> 0, PC_INV) >>> 0) : (token >>> 0); }
function luaUnary(id, value) {
    switch (id) { case UNARY.not: return !truthy(value); case UNARY['-']: return -value; case UNARY['#']: return luaLen(value); case UNARY['~']: return ~value; default: throw new Error(`Z register VM: unary opcode ${id}`); }
}

function executeRegisterProgram(program, globals = {}, options = {}) {
    const functions = program.functions;
    const constants = program.constants;
    function constant(index) { return constantValue(constants[index]); }
    function invoke(fn, args) {
        if (typeof fn !== 'function') throw new Error('Z register VM: value is not callable');
        const result = fn(...args);
        if (isMulti(result)) return result;
        if (typeof options.isExternalMulti === 'function' && options.isExternalMulti(result)) return multi(result.values || []);
        return multi([result]);
    }
    function makeFn(id, locals, upvalues) { return (...args) => exec(id, locals, upvalues, args); }

    function exec(id, parentLocals, parentUpvalues, args) {
        const def = functions[id];
        if (!def) throw new Error(`Z register VM: missing function ${id}`);
        const locals = Array.from({ length: def.localCount || 0 }, () => ({ value: undefined }));
        const upvalues = [];
        for (let i = 0; i < (def.upvalues || []).length; i += 1) {
            const ref = def.upvalues[i];
            const cell = ref.kind === 'local' ? parentLocals?.[ref.index] : parentUpvalues?.[ref.index];
            if (!cell) throw new Error(`Z register VM: unresolved upvalue ${i} in function ${id}`);
            upvalues[i] = cell;
        }
        for (let i = 0; i < def.params.length; i += 1) locals[def.params[i]].value = args[i];
        const varargs = def.vararg ? args.slice(def.params.length) : [];
        const regs = [];
        const loops = [];
        const maxSteps = Number.isFinite(options.maxSteps) ? Math.max(1, Math.floor(options.maxSteps)) : 5_000_000;
        let steps = 0;
        let pc = 1;
        const pcAdd = def.pcTargetAdd >>> 0;
        const pcEncoded = def.pcTargetEncoded === true;
        const getLocal = slot => locals[slot]?.value;
        const setLocal = (slot, value) => { if (!locals[slot]) locals[slot] = { value: undefined }; locals[slot].value = value; };

        while (pc <= def.code.length) {
            if (++steps > maxSteps) throw new Error(`Z register VM: execution step limit exceeded in function ${id}`);
            const ins = def.code[pc - 1];
            const op = ins[0], a = ins[1], b = ins[2], c = ins[3], d = ins[4];
            pc += 1;
            switch (op) {
                case REG_OPS.NOP: case REG_OPS.NOP_ALT: break;
                case REG_OPS.LOAD_CONST: case REG_OPS.LOAD_CONST_ALT: regs[a] = constant(b); break;
                case REG_OPS.LOAD_LOCAL: case REG_OPS.LOAD_LOCAL_ALT: regs[a] = getLocal(b); break;
                case REG_OPS.STORE_LOCAL: case REG_OPS.STORE_LOCAL_ALT: setLocal(a, regs[b]); break;
                case REG_OPS.LOAD_UPVALUE: if (!upvalues[b]) throw new Error('Z register VM: invalid upvalue'); regs[a] = upvalues[b].value; break;
                case REG_OPS.STORE_UPVALUE: if (!upvalues[a]) throw new Error('Z register VM: invalid upvalue'); upvalues[a].value = regs[b]; break;
                case REG_OPS.LOAD_GLOBAL: regs[a] = globals[constant(b)]; break;
                case REG_OPS.STORE_GLOBAL: globals[constant(a)] = regs[b]; break;
                case REG_OPS.GET_MEMBER: regs[a] = regs[b]?.[constant(c)]; break;
                case REG_OPS.SET_MEMBER: regs[a][constant(b)] = regs[c]; break;
                case REG_OPS.GET_INDEX: regs[a] = regs[b]?.[regs[c]]; break;
                case REG_OPS.SET_INDEX: regs[a][regs[b]] = regs[c]; break;
                case REG_OPS.MAKE_FUNCTION: regs[a] = makeFn(b, locals, upvalues); break;
                case REG_OPS.BIN: case REG_OPS.BIN_ALT: regs[a] = luaBinary(d, regs[b], regs[c]); break;
                case REG_OPS.UNARY: regs[a] = luaUnary(c, regs[b]); break;
                case REG_OPS.NEW_TABLE: regs[a] = {}; break;
                case REG_OPS.GET_VARARG: regs[a] = varargs[0]; break;
                case REG_OPS.GET_VARARG_MULTI: regs[a] = multi(varargs.slice()); break;
                case REG_OPS.MOVE: case REG_OPS.MOVE_ALT: regs[a] = regs[b]; break;
                case REG_OPS.CALL:
                case REG_OPS.CALL_MULTI: {
                    const callArgs = [];
                    for (let i = 0; i < c; i += 1) callArgs.push(regs[b + i + 1]);
                    const result = invoke(regs[b], callArgs);
                    regs[a] = op === REG_OPS.CALL_MULTI ? result : result.values[0];
                    break;
                }
                case REG_OPS.CALL_METHOD:
                case REG_OPS.CALL_METHOD_MULTI: {
                    const obj = regs[b]; const callArgs = [obj];
                    for (let i = 0; i < d; i += 1) callArgs.push(regs[b + i + 1]);
                    const result = invoke(obj?.[constant(c)], callArgs);
                    regs[a] = op === REG_OPS.CALL_METHOD_MULTI ? result : result.values[0];
                    break;
                }
                case REG_OPS.CALL_EXPAND: {
                    const callArgs = [];
                    for (let i = 0; i < c; i += 1) callArgs.push(regs[b + i + 1]);
                    const tail = regs[d];
                    if (isMulti(tail)) callArgs.push(...tail.values); else callArgs.push(tail);
                    const result = invoke(regs[b], callArgs);
                    regs[a] = result.values[0];
                    break;
                }
                case REG_OPS.CALL_METHOD_EXPAND: {
                    const prefixCount = d & 0xFFFF; const tailReg = (Math.floor(d / 65536)) & 0xFFFF;
                    const obj = regs[b]; const callArgs = [obj];
                    for (let i = 0; i < prefixCount; i += 1) callArgs.push(regs[b + i + 1]);
                    const tail = regs[tailReg];
                    if (isMulti(tail)) callArgs.push(...tail.values); else callArgs.push(tail);
                    const result = invoke(obj?.[constant(c)], callArgs);
                    regs[a] = result.values[0];
                    break;
                }
                case REG_OPS.RETURN_VOID: return multi([]);
                case REG_OPS.RETURN: case REG_OPS.RETURN_ALT: {
                    const value = regs[a];
                    return isMulti(value) ? value : multi([value]);
                }
                case REG_OPS.RETURN_MULTI: {
                    const values = []; for (let i = 0; i < b; i += 1) values.push(regs[a + i]); return multi(values);
                }
                case REG_OPS.PACK_MULTI: {
                    const values = []; for (let i = 0; i < c; i += 1) values.push(regs[b + i]); regs[a] = multi(values); break;
                }
                case REG_OPS.UNPACK_MULTI: {
                    const source = regs[b]; const values = isMulti(source) ? source.values : [source];
                    for (let i = 0; i < c; i += 1) regs[a + i] = values[i];
                    break;
                }
                case REG_OPS.RETURN_MIXED: {
                    const values = [];
                    for (let i = 0; i < b; i += 1) values.push(regs[a + i]);
                    const tail = regs[c];
                    if (isMulti(tail)) values.push(...tail.values); else values.push(tail);
                    return multi(values);
                }
                case REG_OPS.SETLIST_MULTI: {
                    const obj = regs[a]; const value = regs[b];
                    const values = isMulti(value) ? value.values : [value];
                    for (let i = 0; i < values.length; i += 1) obj[c + i] = values[i];
                    break;
                }
                case REG_OPS.JUMP: case REG_OPS.JUMP_ALT: pc = decodePc(a, pcAdd, pcEncoded); break;
                case REG_OPS.JUMP_IF_FALSE: if (!truthy(regs[a])) pc = decodePc(b, pcAdd, pcEncoded); break;
                case REG_OPS.JUMP_IF_TRUE: if (truthy(regs[a])) pc = decodePc(b, pcAdd, pcEncoded); break;
                case REG_OPS.FOR_NUM_PREP: {
                    const frame = { slot: a, current: regs[b], finish: regs[c], step: regs[d] };
                    if (frame.step === 0) throw new Error('Z register VM: numeric for step zero');
                    loops.push(frame); break;
                }
                case REG_OPS.FOR_NUM_CHECK: {
                    const frame = loops[loops.length - 1];
                    const keep = frame.step > 0 ? frame.current <= frame.finish : frame.current >= frame.finish;
                    if (!keep) { loops.pop(); pc = decodePc(a, pcAdd, pcEncoded); } else setLocal(frame.slot, frame.current);
                    break;
                }
                case REG_OPS.FOR_NUM_NEXT: {
                    const frame = loops[loops.length - 1]; frame.current += frame.step;
                    const keep = frame.step > 0 ? frame.current <= frame.finish : frame.current >= frame.finish;
                    if (keep) setLocal(frame.slot, frame.current); else { loops.pop(); pc = decodePc(a, pcAdd, pcEncoded); }
                    break;
                }
                case REG_OPS.ITER_PREP: {
                    const iterator = regs[a];
                    if (!isMulti(iterator) || iterator.values.length < 3) throw new Error('Z register VM: iterator setup');
                    const [fn, state, control] = iterator.values;
                    const first = invoke(fn, [state, control]);
                    const slots = def.iteratorLayouts?.[c] || [];
                    const frame = { fn, state, control: first.values[0], slots };
                    if (frame.control == null) pc = decodePc(d, pcAdd, pcEncoded);
                    else { loops.push(frame); for (let i = 0; i < b; i += 1) setLocal(slots[i], first.values[i]); }
                    break;
                }
                case REG_OPS.ITER_NEXT: {
                    const frame = loops[loops.length - 1]; const next = invoke(frame.fn, [frame.state, frame.control]); frame.control = next.values[0];
                    if (frame.control == null) { loops.pop(); pc = decodePc(b, pcAdd, pcEncoded); }
                    else { for (let i = 0; i < frame.slots.length; i += 1) setLocal(frame.slots[i], next.values[i]); pc = decodePc(a, pcAdd, pcEncoded); }
                    break;
                }
                case REG_OPS.BREAK: loops.pop(); pc = decodePc(a, pcAdd, pcEncoded); break;
                case REG_OPS.FUSED_LOCAL_CONST_BIN_STORE: setLocal(d, luaBinary(c, getLocal(a), constant(b))); break;
                case REG_OPS.FUSED_LOCAL_LOCAL_BIN_STORE: setLocal(d, luaBinary(c, getLocal(a), getLocal(b))); break;
                case REG_OPS.FUSED_GLOBAL_CALL: {
                    const result = invoke(globals[constant(b)], []);
                    regs[a] = c ? result : result.values[0];
                    break;
                }
                case REG_OPS.FUSED_BIN_JUMP_FALSE:
                case REG_OPS.FUSED_BIN_JUMP_FALSE_ALT:
                    if (!truthy(luaBinary(c, regs[a], regs[b]))) pc = decodePc(d, pcAdd, pcEncoded);
                    break;
                case REG_OPS.FUSED_BIN_JUMP_TRUE:
                case REG_OPS.FUSED_BIN_JUMP_TRUE_ALT:
                    if (truthy(luaBinary(c, regs[a], regs[b]))) pc = decodePc(d, pcAdd, pcEncoded);
                    break;
                default: throw new Error(`Z register VM: opcode ${op}`);
            }
        }
        return multi([undefined]);
    }
    return exec(program.root, null, null, []).values[0];
}

module.exports = { executeRegisterProgram, multi, isMulti };
