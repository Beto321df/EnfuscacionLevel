const crypto = require('crypto');
const { OPS, BIN } = require('./compiler3');

function randomInt(min, max) { return crypto.randomInt(min, max + 1); }
function chance(probability) { return probability > 0 && crypto.randomInt(0, 1000000) < Math.floor(Math.min(1, probability) * 1000000); }
function shuffle(values) {
    const out = values.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = randomInt(0, i);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
function boundedTargetCount(candidateCount, probability, budget) {
    const p = Math.max(0, Math.min(1, Number(probability) || 0));
    return Math.min(budget, Math.max(0, Math.round(candidateCount * p)));
}

function targetFields(ins) {
    switch (ins[0]) {
        case OPS.JUMP:
        case OPS.JUMP_IF_FALSE:
        case OPS.JUMP_IF_TRUE:
        case OPS.BREAK: return [1];
        case OPS.FOR_NUM_PREP:
        case OPS.FOR_NUM_NEXT:
        case OPS.ITER_PREP: return [4];
        case OPS.ITER_NEXT: return [2, 4];
        default: return [];
    }
}

function addConstant(program, type, value, cache) {
    const key = `${type}:${String(value)}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing;
    const index = program.constants.length;
    program.constants.push({ type, value });
    cache.set(key, index);
    return index;
}

function makeCache(program) {
    const cache = new Map();
    for (let i = 0; i < program.constants.length; i += 1) {
        const c = program.constants[i];
        cache.set(`${c.type}:${String(c.value)}`, i);
    }
    return cache;
}

function splitStringConstant(program, index, cache, maxShards) {
    const constant = program.constants[index];
    if (!constant || constant.type !== 1) return null;
    const value = String(constant.value);
    if (value.length < 8) return null;
    const shardCount = Math.max(2, Math.min(maxShards, randomInt(2, Math.max(2, Math.min(maxShards, value.length)))));
    const cuts = [];
    let remaining = value.length;
    for (let i = 0; i < shardCount - 1; i += 1) {
        const minLeft = shardCount - i - 1;
        const size = randomInt(1, remaining - minLeft);
        cuts.push(size);
        remaining -= size;
    }
    cuts.push(remaining);

    const indices = [];
    let offset = 0;
    for (const size of cuts) {
        indices.push(addConstant(program, 1, value.slice(offset, offset + size), cache));
        offset += size;
    }
    return indices;
}

function splitNumberConstant(program, index, cache) {
    const constant = program.constants[index];
    if (!constant || constant.type !== 2) return null;
    const value = Number(constant.value);
    if (!Number.isSafeInteger(value) || Math.abs(value) > 0x3fffffff) return null;
    const delta = value === 0 ? 1 : randomInt(1, Math.min(32, Math.max(1, Math.abs(value))));
    const left = value - delta;
    const right = delta;
    return [
        addConstant(program, 2, left, cache),
        addConstant(program, 2, right, cache)
    ];
}

function diversifyConstants(program, options = {}) {
    const stringChance = options.stringChance === undefined ? 0.62 : Number(options.stringChance);
    const numberChance = options.numberChance === undefined ? 0.48 : Number(options.numberChance);
    const maxShards = options.maxStringShards === undefined ? 4 : Math.max(2, Math.min(8, Number(options.maxStringShards)));
    const cache = makeCache(program);
    let strings = 0;
    let numbers = 0;
    const instructionCount = (program.functions || []).reduce((n, fn) => n + ((fn.code || []).length), 0);

    // The budget is deliberately separate from the probability. We choose the
    // exact number of expansions once, then randomize their locations. This
    // keeps protection diversity while making output size predictable.
    const defaultBudget = Math.min(2048, Math.max(64, Math.floor(Math.max(1, instructionCount) * 0.18)));
    const stringBudget = Number.isFinite(options.maxStringExpansions)
        ? Math.max(0, Math.floor(Number(options.maxStringExpansions)))
        : defaultBudget;
    const numberBudget = Number.isFinite(options.maxNumberExpansions)
        ? Math.max(0, Math.floor(Number(options.maxNumberExpansions)))
        : defaultBudget;

    const stringCandidates = [];
    const numberCandidates = [];
    for (let f = 0; f < program.functions.length; f += 1) {
        const code = program.functions[f].code || [];
        for (let pc = 0; pc < code.length; pc += 1) {
            const ins = code[pc];
            if (ins?.[0] !== OPS.PUSH_CONST) continue;
            const constant = program.constants[ins[1]];
            if (constant?.type === 1 && String(constant.value).length >= 8) {
                stringCandidates.push([f, pc]);
            } else if (
                constant?.type === 2 &&
                Number.isSafeInteger(Number(constant.value)) &&
                Math.abs(Number(constant.value)) <= 0x3fffffff
            ) {
                numberCandidates.push([f, pc]);
            }
        }
    }

    const selectedStrings = new Set(
        shuffle(stringCandidates)
            .slice(0, boundedTargetCount(stringCandidates.length, stringChance, stringBudget))
            .map(([f, pc]) => f + ':' + pc)
    );
    const selectedNumbers = new Set(
        shuffle(numberCandidates)
            .slice(0, boundedTargetCount(numberCandidates.length, numberChance, numberBudget))
            .map(([f, pc]) => f + ':' + pc)
    );

    for (let f = 0; f < program.functions.length; f += 1) {
        const fn = program.functions[f];
        const original = Array.isArray(fn.code) ? fn.code : [];
        if (!original.length) continue;
        const oldToNew = new Map();
        const next = [];
        for (let oldPc = 1; oldPc <= original.length; oldPc += 1) {
            const ins = original[oldPc - 1];
            oldToNew.set(oldPc, next.length + 1);
            if (ins[0] !== OPS.PUSH_CONST) {
                next.push(ins.slice());
                continue;
            }
            const key = f + ':' + (oldPc - 1);
            const constant = program.constants[ins[1]];
            if (constant?.type === 1 && selectedStrings.has(key)) {
                const pieces = splitStringConstant(program, ins[1], cache, maxShards);
                if (pieces && pieces.length > 1) {
                    next.push([OPS.PUSH_CONST, pieces[0], 0, 0, 0]);
                    for (let i = 1; i < pieces.length; i += 1) {
                        next.push([OPS.PUSH_CONST, pieces[i], 0, 0, 0]);
                        next.push([OPS.BIN, BIN['..'], 0, 0, 0]);
                    }
                    strings += 1;
                    continue;
                }
            }
            if (constant?.type === 2 && selectedNumbers.has(key)) {
                const parts = splitNumberConstant(program, ins[1], cache);
                if (parts) {
                    next.push([OPS.PUSH_CONST, parts[0], 0, 0, 0]);
                    next.push([OPS.PUSH_CONST, parts[1], 0, 0, 0]);
                    next.push([OPS.BIN, BIN['+'], 0, 0, 0]);
                    numbers += 1;
                    continue;
                }
            }
            next.push(ins.slice());
        }
        oldToNew.set(original.length + 1, next.length + 1);
        for (let oldPc = 1; oldPc <= original.length; oldPc += 1) {
            const oldIns = original[oldPc - 1];
            const start = oldToNew.get(oldPc);
            const newIns = next[start - 1];
            const fields = targetFields(oldIns);
            if (!newIns || fields.length === 0) continue;
            for (const field of fields) newIns[field] = oldToNew.get(oldIns[field]) ?? oldIns[field];
        }
        fn.code = next;
    }

    program.metadata = {
        ...(program.metadata || {}),
        constantDiversification: {
            stringShards: strings,
            numericExpressions: numbers,
            maxStringShards: maxShards
        }
    };
    return program;
}
module.exports = { diversifyConstants };
