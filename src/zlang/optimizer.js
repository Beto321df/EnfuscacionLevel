const { OPS, BIN, UNARY } = require('./compiler3');
const { validateIR } = require('./ir');

function targetFields(op) {
    switch (op) {
        case OPS.JUMP:
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
        case OPS.BREAK:
            return [1];
        case OPS.FOR_NUM_PREP:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_PREP:
            return [4];
        case OPS.ITER_NEXT:
            return [2, 4];
        default:
            return [];
    }
}

function constantFields(op) {
    switch (op) {
        case OPS.PUSH_CONST:
        case OPS.LOAD_GLOBAL:
        case OPS.STORE_GLOBAL:
        case OPS.GET_MEMBER:
        case OPS.SET_MEMBER:
        case OPS.CALL_METHOD:
        case OPS.CALL_METHOD_MULTI:
        case OPS.CALL_METHOD_EXPAND:
        case OPS.FUSED_GLOBAL_CALL:
            return [1];
        default:
            return [];
    }
}

function successors(code, pc) {
    const ins = code[pc - 1] || [];
    const op = ins[0];
    const next = pc + 1;
    switch (op) {
        case OPS.JUMP:
        case OPS.BREAK:
            return [ins[1]];
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
            return [ins[1], next];
        case OPS.FOR_NUM_PREP:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_PREP:
            return [ins[4], next];
        case OPS.ITER_NEXT:
            return [ins[2], ins[4]];
        case OPS.RETURN:
        case OPS.RETURN_MULTI:
        case OPS.RETURN_VOID:
        case OPS.RETURN_MIXED:
            return [];
        default:
            return [next];
    }
}

function reachable(code) {
    const seen = new Set();
    const queue = [1];
    while (queue.length) {
        const pc = queue.shift();
        if (pc < 1 || pc > code.length || seen.has(pc)) continue;
        seen.add(pc);
        for (const target of successors(code, pc)) {
            if (target >= 1 && target <= code.length && !seen.has(target)) queue.push(target);
        }
    }
    return seen;
}

function remapCode(code, keepPredicate) {
    const oldToNew = new Map();
    const next = [];
    for (let oldPc = 1; oldPc <= code.length; oldPc += 1) {
        if (keepPredicate(oldPc)) {
            oldToNew.set(oldPc, next.length + 1);
            next.push(code[oldPc - 1].slice());
        }
    }
    oldToNew.set(code.length + 1, next.length + 1);
    for (const ins of next) {
        for (const field of targetFields(ins[0])) {
            const target = oldToNew.get(ins[field]);
            if (target !== undefined) ins[field] = target;
        }
    }
    return next;
}

function constantKey(c) {
    return `${c.type}:${typeof c.value === 'string' ? c.value : String(c.value)}`;
}

function compactConstantPool(program) {
    const firstIndex = new Map();
    const remap = new Map();
    const constants = [];

    for (let i = 0; i < program.constants.length; i += 1) {
        const c = program.constants[i];
        const key = constantKey(c);
        let target = firstIndex.get(key);
        if (target === undefined) {
            target = constants.length;
            firstIndex.set(key, target);
            constants.push(c);
        }
        remap.set(i, target);
    }

    let changed = program.constants.length !== constants.length;
    for (const fn of program.functions) {
        for (const ins of fn.code) {
            for (const field of constantFields(ins[0])) {
                const target = remap.get(ins[field]);
                if (target !== undefined && target !== ins[field]) {
                    ins[field] = target;
                    changed = true;
                }
            }
        }
    }

    program.constants = constants;
    return {
        removed: remap.size - constants.length,
        changed
    };
}

function primitiveEqual(a, b) {
    return !!a && !!b && a.type === b.type && a.value === b.value;
}

function luaTruthy(constant) {
    return constant.type !== 4 && !(constant.type === 3 && Number(constant.value) === 0);
}

function foldBinary(a, b, op) {
    if (!a || !b) return null;

    if (op === BIN['=='] || op === BIN['~=']) {
        if (![1, 2, 3, 4].includes(a.type) || a.type !== b.type) return null;
        const equal = primitiveEqual(a, b);
        return { type: 3, value: op === BIN['=='] ? (equal ? 1 : 0) : (equal ? 0 : 1) };
    }

    if (a.type === 2 && b.type === 2) {
        const x = Number(a.value);
        const y = Number(b.value);
        if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;

        let value;
        switch (op) {
            case BIN['+']: value = x + y; break;
            case BIN['-']: value = x - y; break;
            case BIN['*']: value = x * y; break;
            case BIN['%']:
                if (y === 0) return null;
                value = ((x % y) + y) % y;
                break;
            case BIN['//']:
                if (y === 0) return null;
                value = Math.floor(x / y);
                break;
            case BIN['<']: value = x < y ? 1 : 0; break;
            case BIN['>']: value = x > y ? 1 : 0; break;
            case BIN['<=']: value = x <= y ? 1 : 0; break;
            case BIN['>=']: value = x >= y ? 1 : 0; break;
            default:
                return null;
        }

        if (!Number.isSafeInteger(value)) return null;
        if (op >= BIN['<'] && op <= BIN['>=']) return { type: 3, value };
        return { type: 2, value };
    }

    if (a.type === 1 && b.type === 1 && op === BIN['..']) {
        return { type: 1, value: String(a.value) + String(b.value) };
    }

    return null;
}

function foldUnary(constant, op) {
    if (!constant) return null;

    switch (op) {
        case UNARY.not:
            return { type: 3, value: luaTruthy(constant) ? 0 : 1 };
        case UNARY['-']: {
            if (constant.type !== 2) return null;
            const value = Number(constant.value);
            if (!Number.isSafeInteger(value)) return null;
            const out = -value;
            return Number.isSafeInteger(out) ? { type: 2, value: out } : null;
        }
        case UNARY['#']: {
            if (constant.type !== 1) return null;
            const value = String(constant.value);
            if (![...value].every(ch => ch.charCodeAt(0) <= 127)) return null;
            return { type: 2, value: value.length };
        }
        default:
            return null;
    }
}

function makeConstantAdder(program) {
    const cache = new Map();
    for (let i = 0; i < program.constants.length; i += 1) {
        cache.set(constantKey(program.constants[i]), i);
    }

    return constant => {
        const key = constantKey(constant);
        const existing = cache.get(key);
        if (existing !== undefined) return existing;
        const index = program.constants.length;
        program.constants.push({ type: constant.type, value: constant.value });
        cache.set(key, index);
        return index;
    };
}

function foldLiterals(program) {
    const addConstant = makeConstantAdder(program);
    let foldedBinary = 0;
    let foldedUnary = 0;

    for (const fn of program.functions) {
        const code = fn.code || [];
        if (code.length < 2) continue;

        const targeted = new Set();
        for (const ins of code) {
            for (const field of targetFields(ins[0])) {
                if (Number.isInteger(ins[field])) targeted.add(ins[field]);
            }
        }

        const next = [];
        const oldToNew = new Map();
        let i = 0;

        while (i < code.length) {
            const oldPc = i + 1;
            const a = code[i];
            const b = code[i + 1];
            const c = code[i + 2];

            if (
                a && b && c &&
                a[0] === OPS.PUSH_CONST &&
                b[0] === OPS.PUSH_CONST &&
                c[0] === OPS.BIN &&
                !targeted.has(oldPc) &&
                !targeted.has(oldPc + 1) &&
                !targeted.has(oldPc + 2)
            ) {
                const folded = foldBinary(program.constants[a[1]], program.constants[b[1]], c[1]);
                if (folded) {
                    const index = addConstant(folded);
                    const newPc = next.length + 1;
                    oldToNew.set(oldPc, newPc);
                    oldToNew.set(oldPc + 1, newPc);
                    oldToNew.set(oldPc + 2, newPc);
                    next.push([OPS.PUSH_CONST, index, 0, 0, 0]);
                    i += 3;
                    foldedBinary += 1;
                    continue;
                }
            }

            if (
                a && b &&
                a[0] === OPS.PUSH_CONST &&
                b[0] === OPS.UNARY &&
                !targeted.has(oldPc) &&
                !targeted.has(oldPc + 1)
            ) {
                const folded = foldUnary(program.constants[a[1]], b[1]);
                if (folded) {
                    const index = addConstant(folded);
                    const newPc = next.length + 1;
                    oldToNew.set(oldPc, newPc);
                    oldToNew.set(oldPc + 1, newPc);
                    next.push([OPS.PUSH_CONST, index, 0, 0, 0]);
                    i += 2;
                    foldedUnary += 1;
                    continue;
                }
            }

            oldToNew.set(oldPc, next.length + 1);
            next.push(a.slice());
            i += 1;
        }

        oldToNew.set(code.length + 1, next.length + 1);
        for (const ins of next) {
            for (const field of targetFields(ins[0])) {
                const target = oldToNew.get(ins[field]);
                if (target !== undefined) ins[field] = target;
            }
        }
        fn.code = next;
    }

    return { foldedBinary, foldedUnary };
}

function removeRedundantOps(program) {
    let removed = 0;

    for (const fn of program.functions) {
        const code = fn.code || [];
        const targeted = new Set();
        for (const ins of code) {
            for (const field of targetFields(ins[0])) {
                if (Number.isInteger(ins[field])) targeted.add(ins[field]);
            }
        }

        const keep = new Array(code.length).fill(true);
        for (let i = 0; i + 1 < code.length; i += 1) {
            if (targeted.has(i + 1) || targeted.has(i + 2)) continue;

            const load = code[i];
            const pop = code[i + 1];
            const sideEffectFree =
                load[0] === OPS.PUSH_CONST ||
                load[0] === OPS.LOAD_LOCAL ||
                load[0] === OPS.NEW_TABLE;

            if (sideEffectFree && pop[0] === OPS.POP) {
                keep[i] = false;
                keep[i + 1] = false;
                removed += 2;
                i += 1;
            }
        }

        fn.code = remapCode(code, pc => keep[pc - 1]);
    }

    return removed;
}

function removeUnreachableCode(program) {
    let removed = 0;
    for (const fn of program.functions) {
        const code = fn.code || [];
        if (!code.length) continue;
        const live = reachable(code);
        if (live.size === code.length) continue;
        removed += code.length - live.size;
        fn.code = remapCode(code, pc => live.has(pc));
    }
    return removed;
}

function optimizeProgram(program, options = {}) {
    validateIR(program);
    if (options.enabled === false) return program;

    let constantPoolRemoved = 0;
    let unreachableRemoved = 0;
    let redundantInstructionsRemoved = 0;
    let foldedBinary = 0;
    let foldedUnary = 0;

    const first = compactConstantPool(program);
    constantPoolRemoved += first.removed;

    unreachableRemoved += removeUnreachableCode(program);
    redundantInstructionsRemoved += removeRedundantOps(program);

    const folded = foldLiterals(program);
    foldedBinary += folded.foldedBinary;
    foldedUnary += folded.foldedUnary;

    const second = compactConstantPool(program);
    constantPoolRemoved += second.removed;

    program.metadata = {
        ...(program.metadata || {}),
        optimizer: {
            enabled: true,
            constantPoolRemoved,
            unreachableRemoved,
            redundantInstructionsRemoved,
            foldedBinary,
            foldedUnary,
            passes: [
                'constant-pool-dedup',
                'unreachable-trim',
                'safe-peepholes',
                'literal-fold'
            ]
        }
    };

    return validateIR(program);
}

module.exports = {
    optimizeProgram,
    compactConstantPool,
    removeUnreachableCode,
    removeRedundantOps,
    foldLiterals
};
