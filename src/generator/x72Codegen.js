const X71CodeGenerator = require('./x71Codegen');
const { buildNativeProgram } = require('../zlang/nativeCompiler');
const { buildEmissionPlan } = require('../zlang/emitter');
const { resolvePreset } = require('../zlang/presets');
const { hardenProgram } = require('../zlang/x72Hardening');

const MAX_OUTPUT = 1024 * 1024;

function hardeningPlan(name, attempt, sourceLines) {
    const max = String(name).toLowerCase() === 'maximum';
    const profiles = max
        ? [
            { stringChance: 0.82, numberChance: 0.68, opaqueMin: 8, distributedMin: 48, interval: 48, decoys: 6 },
            { stringChance: 0.68, numberChance: 0.54, opaqueMin: 12, distributedMin: 64, interval: 64, decoys: 4 },
            { stringChance: 0.52, numberChance: 0.42, opaqueMin: 20, distributedMin: 96, interval: 96, decoys: 2 },
            { stringChance: 0.38, numberChance: 0.30, opaqueMin: 28, distributedMin: 128, interval: 128, decoys: 0 }
        ]
        : [
            { stringChance: 0.78, numberChance: 0.64, opaqueMin: 8, distributedMin: 48, interval: 48, decoys: 4 },
            { stringChance: 0.64, numberChance: 0.50, opaqueMin: 14, distributedMin: 72, interval: 72, decoys: 2 },
            { stringChance: 0.48, numberChance: 0.38, opaqueMin: 22, distributedMin: 112, interval: 112, decoys: 0 }
        ];
    const base = profiles[Math.min(attempt, profiles.length - 1)];
    // Very large sources already provide plenty of semantic material. Avoid
    // multiplying the IR excessively before we know whether the payload fits.
    if (sourceLines > 3500 && attempt === 0) {
        return { ...base, stringChance: Math.min(base.stringChance, 0.70), numberChance: Math.min(base.numberChance, 0.56), interval: Math.max(base.interval, 64) };
    }
    return base;
}

class X72CodeGenerator {
    generate(source, options = {}) {
        if (typeof source !== 'string' || !source.trim()) {
            throw new Error('El código Lua/Luau está vacío.');
        }

        const preset = resolvePreset(options.preset || 'maximum');
        const lineCount = source.split(/\r?\n/).length;
        const plan = hardeningPlan(preset.name, 0, lineCount);

        const native = buildNativeProgram(source, {
            polymorphOptions: preset.polymorph
        });

        native.metadata = {
            ...(native.metadata || {}),
            strengthPreset: preset.name,
            engine: 'X7.2 hardened',
            hardeningAttempt: 0
        };

        hardenProgram(native, {
            strings: {
                chance: options.stringSplitChance === undefined ? plan.stringChance : options.stringSplitChance
            },
            numbers: {
                chance: options.numberSplitChance === undefined ? plan.numberChance : options.numberSplitChance
            },
            opaque: {
                minFunctionLength: options.opaqueMinFunctionLength || plan.opaqueMin
            },
            distributedOpaque: {
                minFunctionLength: options.distributedOpaqueMinFunctionLength || plan.distributedMin,
                interval: options.distributedOpaqueInterval || plan.interval
            },
            decoys: {
                count: options.decoyFunctions === undefined ? plan.decoys : options.decoyFunctions
            }
        });

        const program = buildEmissionPlan(native, {
            backend: options.backend === undefined ? preset.backend : options.backend,
            diversify: options.diversify || preset.diversify,
            registers: options.registers || preset.registers || {},
            isa: options.isa || preset.isa
        });

        return X71CodeGenerator.x71Loader(program, {
            runtimeGuard: true,
            preferNativeGlobals: true,
            purgePayload: true,
            encodeLocalOperands: true,
            encodeInstructionRoute: true,
            encodeOperandFeedback: true,
            encodeConstantRoute: true,
            encodeTargetTokens: true,
            polymorphicShell: true,
            polymorphicDispatch: true,
            rollingPayload: true,
            lazyConstants: true
        });
    }
}

module.exports = X72CodeGenerator;
