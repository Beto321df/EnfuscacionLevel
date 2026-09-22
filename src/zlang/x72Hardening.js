const crypto = require('crypto');
const { OPS, BIN } = require('./compiler3');
const { validateIR } = require('./ir');
const { analyzeStackHeights } = require('./registerVm');

function rand(min, max) { return crypto.randomInt(min, max + 1); }

const constantCaches = new WeakMap();

function constantKey(type, value) {
    return String(type) + ':' + (typeof value === 'string' ? value : String(value));
}

function addConstant(program, type, value) {
    let cache = constantCaches.get(program);
    if (!cache) {
        cache = new Map();
        for (let i = 0; i < program.constants.length; i += 1) {
            cache.set(constantKey(program.constants[i].type, program.constants[i].value), i);
        }
        constantCaches.set(program, cache);
    }

    const key = constantKey(type, value);
    const existing = cache.get(key);
    if (existing !== undefined) return existing;

    const index = program.constants.length;
    program.constants.push({ type, value });
    cache.set(key, index);
    return index;
}

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

function compactConstantPool(program) {
    const used=new Set();
    for(const fn of program.functions||[]) {
        for(const ins of fn.code||[]) {
            for(const field of constantFields(ins[0])) {
                const index=ins[field];
                if(Number.isInteger(index)&&index>=0&&index<program.constants.length) used.add(index);
            }
        }
    }

    const valueMap=new Map();
    const map=new Map();
    const next=[];
    for(let i=0;i<program.constants.length;i+=1) {
        if(!used.has(i)) continue;
        const c=program.constants[i];
        const key=constantKey(c.type,c.value);
        const existing=valueMap.get(key);
        if(existing!==undefined) {
            map.set(i,existing);
            continue;
        }
        const newIndex=next.length;
        valueMap.set(key,newIndex);
        map.set(i,newIndex);
        next.push(c);
    }

    for(const fn of program.functions||[]) {
        for(const ins of fn.code||[]) {
            for(const field of constantFields(ins[0])) {
                if(map.has(ins[field])) ins[field]=map.get(ins[field]);
            }
        }
    }

    const removed=program.constants.length-next.length;
    program.constants=next;
    program.metadata={
        ...(program.metadata||{}),
        x72ConstantCompaction:{enabled:true,removed,remaining:next.length}
    };
    return program;
}

function remapTargets(code, map) {
    for (const ins of code) {
        for (const field of targetFields(ins[0])) {
            if (map.has(ins[field])) ins[field] = map.get(ins[field]);
        }
    }
}

function splitStringConstants(program, options = {}) {
    const chance = Math.max(0, Math.min(1, Number(options.chance === undefined ? 0.72 : options.chance)));
    let expanded = 0;
    let shards = 0;

    for (const fn of program.functions) {
        const oldCode = fn.code || [];
        if (!oldCode.length) continue;

        const nextCode = [];
        const oldToNew = new Map();

        for (let i = 0; i < oldCode.length; i += 1) {
            const oldPc = i + 1;
            oldToNew.set(oldPc, nextCode.length + 1);
            const ins = oldCode[i];

            if (ins[0] === OPS.PUSH_CONST && crypto.randomInt(0, 1000000) < Math.floor(chance * 1000000)) {
                const constant = program.constants[ins[1]];
                const value = constant && constant.type === 1 ? String(constant.value) : null;
                const chars = value === null ? null : Array.from(value);

                if (chars && chars.length >= 8) {
                    const maxParts = Math.min(4, Math.max(2, Math.floor(chars.length / 4)));
                    const parts = [];
                    let pos = 0;
                    while (pos < chars.length && parts.length < maxParts - 1) {
                        const remaining = chars.length - pos;
                        const minRemaining = maxParts - parts.length - 1;
                        const maxLen = remaining - minRemaining;
                        const len = Math.max(1, Math.min(maxLen, rand(2, Math.max(2, Math.min(8, maxLen)))));
                        parts.push(chars.slice(pos, pos + len).join(''));
                        pos += len;
                    }
                    parts.push(chars.slice(pos).join(''));

                    const partIndexes = parts.map(part => addConstant(program, 1, part));
                    for (let p = 0; p < partIndexes.length; p += 1) {
                        nextCode.push([OPS.PUSH_CONST, partIndexes[p], 0, 0, 0]);
                        if (p > 0) nextCode.push([OPS.BIN, BIN['..'], 0, 0, 0]);
                    }
                    expanded += 1;
                    shards += parts.length;
                    continue;
                }
            }

            nextCode.push(ins.slice());
        }

        oldToNew.set(oldCode.length + 1, nextCode.length + 1);
        remapTargets(nextCode, oldToNew);
        fn.code = nextCode;
    }

    program.metadata = {
        ...(program.metadata || {}),
        x72StringSplitting: { enabled: expanded > 0, constantsExpanded: expanded, shards }
    };
}

function splitNumericConstants(program, options = {}) {
    const chance = Math.max(0, Math.min(1, Number(options.chance === undefined ? 0.58 : options.chance)));
    let expanded = 0;

    for (const fn of program.functions) {
        const oldCode = fn.code || [];
        if (!oldCode.length) continue;

        const nextCode = [];
        const oldToNew = new Map();

        for (let i = 0; i < oldCode.length; i += 1) {
            const oldPc = i + 1;
            oldToNew.set(oldPc, nextCode.length + 1);
            const ins = oldCode[i];

            if (ins[0] === OPS.PUSH_CONST &&
                crypto.randomInt(0, 1000000) < Math.floor(chance * 1000000)) {
                const constant = program.constants[ins[1]];
                const value = constant && constant.type === 2 ? Number(constant.value) : null;

                if (value !== null && Number.isSafeInteger(value)) {
                    const delta = rand(1, Math.min(97, Math.max(1, Math.abs(value) || 1)));
                    const left = addConstant(program, 2, value - delta);
                    const right = addConstant(program, 2, delta);
                    nextCode.push([OPS.PUSH_CONST, left, 0, 0, 0]);
                    nextCode.push([OPS.PUSH_CONST, right, 0, 0, 0]);
                    nextCode.push([OPS.BIN, BIN['+'], 0, 0, 0]);
                    expanded += 1;
                    continue;
                }
            }

            nextCode.push(ins.slice());
        }

        oldToNew.set(oldCode.length + 1, nextCode.length + 1);
        remapTargets(nextCode, oldToNew);
        fn.code = nextCode;
    }

    program.metadata = {
        ...(program.metadata || {}),
        x72NumericSplitting: { enabled: expanded > 0, constantsExpanded: expanded }
    };
}

function makeOpaqueGuard(program, variant) {
    const out = [];
    if (variant === 1) {
        const r = rand(17, 9999);
        const a = addConstant(program, 2, r);
        const b = addConstant(program, 2, r + 1);
        const two = addConstant(program, 2, 2);
        const zero = addConstant(program, 2, 0);
        out.push(
            [OPS.PUSH_CONST, a, 0, 0, 0],
            [OPS.PUSH_CONST, b, 0, 0, 0],
            [OPS.BIN, BIN['*'], 0, 0, 0],
            [OPS.PUSH_CONST, two, 0, 0, 0],
            [OPS.BIN, BIN['%'], 0, 0, 0],
            [OPS.PUSH_CONST, zero, 0, 0, 0],
            [OPS.BIN, BIN['=='], 0, 0, 0]
        );
    } else if (variant === 2) {
        const r = rand(31, 9999);
        const a = addConstant(program, 2, r);
        const b = addConstant(program, 2, 1337);
        out.push(
            [OPS.PUSH_CONST, a, 0, 0, 0],
            [OPS.PUSH_CONST, b, 0, 0, 0],
            [OPS.BIN, BIN['+'], 0, 0, 0],
            [OPS.PUSH_CONST, a, 0, 0, 0],
            [OPS.BIN, BIN['>'], 0, 0, 0]
        );
    } else {
        const a = addConstant(program, 1, 'z' + String(rand(100, 9999)));
        const b = addConstant(program, 1, 'n' + String(rand(100, 9999)));
        const expected = addConstant(program, 1, String(program.constants[a].value + program.constants[b].value));
        out.push(
            [OPS.PUSH_CONST, a, 0, 0, 0],
            [OPS.PUSH_CONST, b, 0, 0, 0],
            [OPS.BIN, BIN['..'], 0, 0, 0],
            [OPS.PUSH_CONST, expected, 0, 0, 0],
            [OPS.BIN, BIN['=='], 0, 0, 0]
        );
    }

    const branchIndex = out.length;
    out.push([OPS.JUMP_IF_FALSE, 0, 0, 0, 0]);

    const trueA = addConstant(program, 2, rand(1000, 999999));
    const trueB = addConstant(program, 2, rand(1000, 999999));
    out.push(
        [OPS.PUSH_CONST, trueA, 0, 0, 0],
        [OPS.PUSH_CONST, trueB, 0, 0, 0],
        [OPS.BIN, BIN['+'], 0, 0, 0],
        [OPS.POP, 0, 0, 0, 0]
    );

    const jumpIndex = out.length;
    out.push([OPS.JUMP, 0, 0, 0, 0]);

    const deadStart = out.length;
    const deadA = addConstant(program, 2, rand(1000, 999999));
    const deadB = addConstant(program, 2, rand(2, 31));
    out.push(
        [OPS.PUSH_CONST, deadA, 0, 0, 0],
        [OPS.PUSH_CONST, deadB, 0, 0, 0],
        [OPS.BIN, BIN['%'], 0, 0, 0],
        [OPS.POP, 0, 0, 0, 0]
    );

    const continuation = out.length;
    out[branchIndex][1] = deadStart + 1;
    out[jumpIndex][1] = continuation + 1;

    return {
        code: out,
        branchIndex,
        jumpIndex,
        deadStart,
        continuation
    };
}

function injectOpaqueGuards(program, options = {}) {
    const minLength = Math.max(4, Number(options.minFunctionLength || 6));
    let guards = 0;

    for (const fn of program.functions) {
        const code = fn.code || [];
        if (code.length < minLength) continue;
        // Large functions with existing branches are the most sensitive to
        // prefix relocation. Keep opaque guards on linear large functions and
        // leave branch-heavy functions to the distributed guard pass.
        if (code.length >= 96 && code.some(ins => targetFields(ins[0]).length > 0)) continue;

        const count = code.length >= 96 ? 3 : code.length >= 24 ? 2 : 1;
        const prefix = [];
        const guardMeta = [];

        for (let i = 0; i < count; i += 1) {
            const offset = prefix.length;
            const guard = makeOpaqueGuard(program, (i + fn.id) % 3 + 1);
            prefix.push(...guard.code);
            guardMeta.push({ offset, ...guard });
        }

        for (const meta of guardMeta) {
            const branch = prefix[meta.offset + meta.branchIndex];
            const jump = prefix[meta.offset + meta.jumpIndex];
            const nextStart = meta.offset + meta.continuation + 1;
            const deadStart = meta.offset + meta.deadStart + 1;
            branch[1] = deadStart;
            jump[1] = nextStart;
        }

        const delta = prefix.length;
        const original = code.map(ins => ins.slice());
        const map = new Map();
        for (let i = 1; i <= original.length + 1; i += 1) map.set(i, i + delta);
        remapTargets(original, map);

        fn.code = prefix.concat(original);
        guards += count;
    }

    program.metadata = {
        ...(program.metadata || {}),
        x72OpaqueGuards: { enabled: guards > 0, inserted: guards }
    };
}
function injectDistributedOpaqueGuards(program, options = {}) {
    const minLength = Math.max(24, Number(options.minFunctionLength || 48));
    const interval = Math.max(16, Number(options.interval || 48));
    let inserted = 0;

    for (const fn of program.functions) {
        const code = fn.code || [];
        if (code.length < minLength) continue;

        const targets = new Set();
        for (const ins of code) {
            for (const field of targetFields(ins[0])) {
                const target = ins[field];
                if (Number.isInteger(target) && target >= 1 && target <= code.length) targets.add(target);
            }
        }

        const positions = [];
        let heights;
        try {
            heights = analyzeStackHeights(code);
        } catch (_) {
            continue;
        }
        for (let pos = interval; pos < code.length; pos += interval) {
            const position = pos + 1;
            if (targets.has(position)) continue;
            if (code[pos - 1] && targetFields(code[pos - 1][0]).length > 0) continue;
            if (!heights.has(position) || heights.get(position) !== 0) continue;
            positions.push(position);
        }
        if (!positions.length) continue;

        const inserts = new Map();
        let variant = fn.id % 3;
        for (const position of positions) {
            const guard = makeOpaqueGuard(program, variant % 3 + 1);
            variant += 1;
            inserts.set(position, guard.code.map(ins => ins.slice()));
        }

        // Build the mapping from the actual output layout. The previous
        // implementation precomputed offsets and then inserted fragments,
        // which made long backward jumps vulnerable to landing on the
        // pre-guard address. That creates false stack merges in the
        // registerizer. Here every old PC is mapped to the original
        // instruction *after* its inserted guard.
        const oldToNew = new Map();
        const output = [];

        for (let oldPc = 1; oldPc <= code.length; oldPc += 1) {
            const frag = inserts.get(oldPc);
            if (frag) {
                const fragmentBase = output.length + 1;
                for (const ins of frag) {
                    for (const field of targetFields(ins[0])) {
                        if (Number.isInteger(ins[field]) && ins[field] >= 1 && ins[field] <= frag.length) {
                            ins[field] = fragmentBase + ins[field] - 1;
                        }
                    }
                    output.push(ins);
                }
            }

            oldToNew.set(oldPc, output.length + 1);
            output.push(code[oldPc - 1].slice());
        }
        oldToNew.set(code.length + 1, output.length + 1);

        // Remap only the original instructions. Guard-internal targets were
        // already resolved against their own fragment above.
        for (let oldPc = 1; oldPc <= code.length; oldPc += 1) {
            const outputPc = oldToNew.get(oldPc);
            const ins = output[outputPc - 1];
            for (const field of targetFields(ins[0])) {
                if (oldToNew.has(ins[field])) ins[field] = oldToNew.get(ins[field]);
            }
        }

        fn.code = output;
        inserted += positions.length;
    }

    program.metadata = {
        ...(program.metadata || {}),
        x72DistributedOpaqueGuards: { enabled: inserted > 0, inserted, interval }
    };
}
function snapshotProgram(program) {
    return {
        constants: JSON.parse(JSON.stringify(program.constants || [])),
        functions: JSON.parse(JSON.stringify(program.functions || [])),
        metadata: JSON.parse(JSON.stringify(program.metadata || {}))
    };
}

function restoreProgram(program, snapshot) {
    program.constants = snapshot.constants;
    program.functions = snapshot.functions;
    program.metadata = snapshot.metadata;
    return program;
}

function safeHardeningPass(program, name, pass, skipped) {
    const snapshot = snapshotProgram(program);
    try {
        pass();
        validateIR(program);
        return true;
    } catch (error) {
        restoreProgram(program, snapshot);
        skipped.push({
            pass: name,
            error: error instanceof Error ? error.message : String(error)
        });
        return false;
    }
}
function injectDecoyFunctions(program, options = {}) {
    const requested = Math.max(0, Math.min(8, Number(options.count || 0)));
    if (!requested) {
        program.metadata = {
            ...(program.metadata || {}),
            x72DecoyFunctions: { enabled: false, inserted: 0 }
        };
        return program;
    }

    const variants = [];
    const addPair = (t, a, b) => {
        const ia=addConstant(program,t,a);
        const ib=addConstant(program,t,b);
        return [ia,ib];
    };

    for(let n=0;n<requested;n+=1) {
        const variant=n%4;
        let code=[];
        let localCount=0;

        if(variant===0) {
            const [a,b]=addPair(2,rand(17,9000),rand(31,7000));
            code=[
                [OPS.PUSH_CONST,a,0,0,0],
                [OPS.PUSH_CONST,b,0,0,0],
                [OPS.BIN,BIN['*'],0,0,0],
                [OPS.POP,0,0,0,0],
                [OPS.RETURN_VOID,0,0,0,0]
            ];
        } else if(variant===1) {
            const key=addConstant(program,1,'route_'+rand(1000,9999));
            const value=addConstant(program,2,rand(1000,999999));
            code=[
                [OPS.NEW_TABLE,0,0,0,0],
                [OPS.PUSH_CONST,key,0,0,0],
                [OPS.PUSH_CONST,value,0,0,0],
                [OPS.SET_INDEX,0,0,0,0],
                [OPS.RETURN_VOID,0,0,0,0]
            ];
        } else if(variant===2) {
            const yes=addConstant(program,3,1);
            const a=addConstant(program,2,rand(1000,999999));
            const b=addConstant(program,2,rand(1000,999999));
            const branch=1;
            const dead=6;
            const end=10;
            code=[
                [OPS.PUSH_CONST,yes,0,0,0],
                [OPS.JUMP_IF_FALSE,dead,0,0,0],
                [OPS.PUSH_CONST,a,0,0,0],
                [OPS.POP,0,0,0,0],
                [OPS.JUMP,end,0,0,0],
                [OPS.PUSH_CONST,b,0,0,0],
                [OPS.POP,0,0,0,0],
                [OPS.NOP,0,0,0,0],
                [OPS.NOP,0,0,0,0],
                [OPS.RETURN_VOID,0,0,0,0]
            ];
        } else {
            const a=addConstant(program,2,rand(100,9999));
            const b=addConstant(program,2,rand(11,97));
            const cst=addConstant(program,2,rand(2,13));
            code=[
                [OPS.PUSH_CONST,a,0,0,0],
                [OPS.PUSH_CONST,b,0,0,0],
                [OPS.BIN,BIN['+'],0,0,0],
                [OPS.PUSH_CONST,cst,0,0,0],
                [OPS.BIN,BIN['%'],0,0,0],
                [OPS.POP,0,0,0,0],
                [OPS.RETURN_VOID,0,0,0,0]
            ];
        }

        const id=program.functions.length;
        program.functions.push({
            id,
            name:`<decoy:${id}>`,
            params:[],
            vararg:false,
            localCount,
            upvalues:[],
            iteratorLayouts:[],
            code
        });
    }

    program.metadata={
        ...(program.metadata||{}),
        x72DecoyFunctions:{enabled:true,inserted:requested}
    };
    return program;
}

function hardenProgram(program, options = {}) {
    validateIR(program);
    const skipped = [];

    safeHardeningPass(program, 'string-splitting', () => splitStringConstants(program, options.strings || {}), skipped);
    safeHardeningPass(program, 'numeric-splitting', () => splitNumericConstants(program, options.numbers || {}), skipped);
    safeHardeningPass(program, 'opaque-guards', () => injectOpaqueGuards(program, options.opaque || {}), skipped);
    safeHardeningPass(program, 'distributed-opaque-guards', () => injectDistributedOpaqueGuards(program, options.distributedOpaque || {}), skipped);
    safeHardeningPass(program, 'decoy-functions', () => injectDecoyFunctions(program, options.decoys || {}), skipped);
    safeHardeningPass(program, 'constant-compaction', () => compactConstantPool(program), skipped);

    program.metadata = {
        ...(program.metadata || {}),
        x72Hardening: {
            transactional: true,
            skippedPasses: skipped
        }
    };
    validateIR(program);
    return program;
}

module.exports = { hardenProgram, splitStringConstants, splitNumericConstants, injectOpaqueGuards, injectDistributedOpaqueGuards, injectDecoyFunctions };
