const { OPS, BIN, UNARY } = require('./compiler3');
const { executeRegisterProgram } = require('./registerReferenceVm');

const MULTI = Symbol('Z3Multi');
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
        case BIN['//']: return Math.floor(left / right);
        case BIN['&']: return left & right; case BIN['|']: return left | right; case BIN['~']: return left ^ right;
        case BIN['<<']: return left << right; case BIN['>>']: return left >> right;
        default: throw new Error(`Z reference VM: binary opcode ${id}`);
    }
}
function luaUnary(id, value) {
    switch (id) { case UNARY.not: return !truthy(value); case UNARY['-']: return -value; case UNARY['#']: return luaLen(value); case UNARY['~']: return ~value; default: throw new Error(`Z reference VM: unary opcode ${id}`); }
}
function executeProgram(program, globals = {}, options = {}) {
    if (program && program.backend === 'register') return executeRegisterProgram(program, globals, { ...options, isExternalMulti: isMulti });
    const functions = program.functions;
    const constants = program.constants;
    function invoke(fn, args) {
        if (typeof fn !== 'function') throw new Error('Z reference VM: value is not callable');
        const result = fn(...args);
        return isMulti(result) ? result : multi([result]);
    }
    function makeFn(id, locals, upvalues) { return (...args) => exec(id, locals, upvalues, args); }
    function exec(id, parentLocals, parentUpvalues, args) {
        const def = functions[id];
        const locals = Array.from({ length: def.localCount || 0 }, () => ({ value: undefined }));
        const upvalues = [];
        for (let i = 0; i < (def.upvalues || []).length; i += 1) {
            const ref = def.upvalues[i];
            const cell = ref.kind === 'local' ? parentLocals?.[ref.index] : parentUpvalues?.[ref.index];
            if (!cell) throw new Error(`Z reference VM: unresolved upvalue ${i} in function ${id}`);
            upvalues[i] = cell;
        }
        for (let i = 0; i < def.params.length; i += 1) locals[def.params[i]].value = args[i];
        const varargs = def.vararg ? args.slice(def.params.length) : [];
        const stack = []; const loops = []; let pc = 1;
        const getLocal = slot => locals[slot]?.value;
        const setLocal = (slot, value) => { if (!locals[slot]) locals[slot] = { value: undefined }; locals[slot].value = value; };
        while (pc <= def.code.length) {
            const ins = def.code[pc - 1]; const op = ins[0]; const a = ins[1]; const b = ins[2]; const c = ins[3]; const d = ins[4]; pc += 1;
            if (op === OPS.PUSH_CONST) stack.push(constantValue(constants[a]));
            else if (op === OPS.LOAD_VAR) stack.push(undefined); // legacy ZIR v1 compatibility only
            else if (op === OPS.STORE_VAR) throw new Error('Z reference VM: legacy STORE_VAR is not emitted by ZIR v2');
            else if (op === OPS.LOAD_LOCAL) stack.push(getLocal(a));
            else if (op === OPS.STORE_LOCAL) setLocal(a, stack.pop());
            else if (op === OPS.LOAD_UPVALUE) stack.push(upvalues[a]?.value);
            else if (op === OPS.STORE_UPVALUE) { if (!upvalues[a]) throw new Error(`Z reference VM: invalid upvalue ${a}`); upvalues[a].value = stack.pop(); }
            else if (op === OPS.FUSED_LOCAL_CONST_BIN_STORE) { setLocal(d, luaBinary(c, getLocal(a), constantValue(constants[b]))); }
            else if (op === OPS.FUSED_LOCAL_LOCAL_BIN_STORE) { setLocal(d, luaBinary(c, getLocal(a), getLocal(b))); }
            else if (op === OPS.FUSED_GLOBAL_CALL) { const fn = globals[constantValue(constants[a])]; const result = invoke(fn, []); if (c) stack.push(result); else stack.push(result.values[0]); }
            else if (op === OPS.LOAD_GLOBAL) stack.push(globals[constantValue(constants[a])]);
            else if (op === OPS.STORE_GLOBAL) globals[constantValue(constants[a])] = stack.pop();
            else if (op === OPS.GET_MEMBER) { const obj = stack.pop(); stack.push(obj?.[constantValue(constants[a])]); }
            else if (op === OPS.SET_MEMBER) { const value = stack.pop(); const obj = stack.pop(); obj[constantValue(constants[a])] = value; }
            else if (op === OPS.GET_INDEX) { const key = stack.pop(); const obj = stack.pop(); stack.push(obj?.[key]); }
            else if (op === OPS.SET_INDEX) { const value = stack.pop(); const key = stack.pop(); const obj = stack.pop(); obj[key] = value; }
            else if (op === OPS.SETLIST_MULTI) {
                const value = stack.pop(); const obj = stack.pop();
                const values = isMulti(value) ? value.values : [value];
                for (let i = 0; i < values.length; i += 1) obj[a + i] = values[i];
            }
            else if (op === OPS.DUP) stack.push(stack[stack.length - 1]);
            else if (op === OPS.POP) stack.pop();
            else if (op === OPS.UNARY) stack.push(luaUnary(a, stack.pop()));
            else if (op === OPS.BIN) { const right = stack.pop(); const left = stack.pop(); stack.push(luaBinary(a, left, right)); }
            else if (op === OPS.JUMP) pc = a;
            else if (op === OPS.JUMP_IF_FALSE) { if (!truthy(stack.pop())) pc = a; }
            else if (op === OPS.JUMP_IF_TRUE) { if (truthy(stack.pop())) pc = a; }
            else if (op === OPS.MAKE_FUNCTION) stack.push(makeFn(a, locals, upvalues));
            else if (op === OPS.CALL || op === OPS.CALL_MULTI) {
                const callArgs = [];
                for (let i = a - 1; i >= 0; i -= 1) callArgs[i] = stack.pop();
                const fn = stack.pop(); const result = invoke(fn, callArgs);
                stack.push(op === OPS.CALL_MULTI ? result : result.values[0]);
            }
            else if (op === OPS.CALL_METHOD || op === OPS.CALL_METHOD_MULTI) {
                const callArgs = [];
                for (let i = b - 1; i >= 0; i -= 1) callArgs[i] = stack.pop();
                const obj = stack.pop(); const fn = obj?.[constantValue(constants[a])];
                const result = invoke(fn, [obj, ...callArgs]);
                stack.push(op === OPS.CALL_METHOD_MULTI ? result : result.values[0]);
            }
            else if (op === OPS.CALL_EXPAND) {
                const tail = stack.pop(); const callArgs = [];
                const tailValues = isMulti(tail) ? tail.values : [tail];
                for (let i = a - 1; i >= 0; i -= 1) callArgs[i] = stack.pop();
                callArgs.push(...tailValues);
                const fn = stack.pop(); const result = invoke(fn, callArgs);
                stack.push(result.values[0]);
            }
            else if (op === OPS.CALL_METHOD_EXPAND) {
                const tail = stack.pop(); const callArgs = [];
                const tailValues = isMulti(tail) ? tail.values : [tail];
                for (let i = b - 1; i >= 0; i -= 1) callArgs[i + 1] = stack.pop();
                const obj = stack.pop(); const fn = obj?.[constantValue(constants[a])];
                callArgs[0] = obj; callArgs.push(...tailValues);
                const result = invoke(fn, callArgs);
                stack.push(result.values[0]);
            }
            else if (op === OPS.RETURN_VOID) return multi([]);
            else if (op === OPS.RETURN) {
                const value = stack.pop();
                return isMulti(value) ? value : multi([value]);
            }
            else if (op === OPS.RETURN_MULTI) { const values = []; for (let i = a - 1; i >= 0; i -= 1) values[i] = stack.pop(); return multi(values); }
            else if (op === OPS.RETURN_MIXED) {
                const tail = stack.pop();
                const values = [];
                for (let i = a - 1; i >= 0; i -= 1) values[i] = stack.pop();
                if (isMulti(tail)) values.push(...tail.values); else values.push(tail);
                return multi(values);
            }
            else if (op === OPS.GET_VARARG) stack.push(varargs[0]);
            else if (op === OPS.GET_VARARG_MULTI) stack.push(multi(varargs.slice()));
            else if (op === OPS.UNPACK_MULTI) {
                const value = stack.pop();
                const values = isMulti(value) ? value.values : [value];
                for (let i = 0; i < a; i += 1) stack.push(values[i]);
            }
            else if (op === OPS.NEW_TABLE) stack.push({});
            else if (op === OPS.PACK_MULTI) { const values = []; for (let i = a - 1; i >= 0; i -= 1) values[i] = stack.pop(); stack.push(multi(values)); }
            else if (op === OPS.FOR_NUM_PREP) {
                const step = stack.pop(); const finish = stack.pop(); const start = stack.pop();
                if (step === 0) throw new Error('Z reference VM: numeric for step is zero');
                const frame = { slot: a, current: start, finish, step };
                const keep = step > 0 ? start <= finish : start >= finish;
                if (!keep) pc = d; else { loops.push(frame); setLocal(a, start); }
            }
            else if (op === OPS.FOR_NUM_NEXT) {
                const frame = loops[loops.length - 1]; frame.current += frame.step;
                const keep = frame.step > 0 ? frame.current <= frame.finish : frame.current >= frame.finish;
                if (keep) setLocal(frame.slot, frame.current); else { loops.pop(); pc = d; }
            }
            else if (op === OPS.ITER_PREP) {
                const iterator = stack.pop();
                if (!isMulti(iterator) || iterator.values.length < 3) throw new Error('Z reference VM: iterator setup');
                const [fn, state, control] = iterator.values;
                const first = invoke(fn, [state, control]);
                const slots = def.iteratorLayouts?.[b] || [];
                const frame = { fn, state, control: first.values[0], slots };
                if (frame.control == null) pc = d;
                else { loops.push(frame); for (let i = 0; i < slots.length; i += 1) setLocal(slots[i], first.values[i]); }
            }
            else if (op === OPS.ITER_NEXT) {
                const frame = loops[loops.length - 1]; const next = invoke(frame.fn, [frame.state, frame.control]); frame.control = next.values[0];
                if (frame.control == null) { loops.pop(); pc = d; }
                else { for (let i = 0; i < frame.slots.length; i += 1) setLocal(frame.slots[i], next.values[i]); pc = b; }
            }
            else if (op === OPS.BREAK) { loops.pop(); pc = a; }
            else if (op === OPS.NOP) {}
            else throw new Error(`Z reference VM: opcode ${op}`);
        }
        return multi([undefined]);
    }
    return exec(program.root, null, null, []).values[0];
}
module.exports = { executeProgram, multi, isMulti };
