const X71CodeGenerator = require('./x71Codegen');
const { buildNativeProgram } = require('../zlang/nativeCompiler');
const { buildEmissionPlan } = require('../zlang/emitter');
const { resolvePreset } = require('../zlang/presets');
const { hardenProgram } = require('../zlang/x72Hardening');

function hardeningPlan(name, attempt, sourceLines) {
    const max = String(name).toLowerCase() === 'maximum';
    const profiles = max
        ? [
            { stringChance: 0.46, numberChance: 0.24, opaqueMin: 12, distributedMin: 64, interval: 112, decoys: 3 },
            { stringChance: 0.36, numberChance: 0.18, opaqueMin: 16, distributedMin: 96, interval: 144, decoys: 2 },
            { stringChance: 0.28, numberChance: 0.12, opaqueMin: 24, distributedMin: 128, interval: 192, decoys: 1 },
            { stringChance: 0.20, numberChance: 0.08, opaqueMin: 32, distributedMin: 192, interval: 256, decoys: 0 }
        ]
        : [
            { stringChance: 0.34, numberChance: 0.16, opaqueMin: 16, distributedMin: 96, interval: 160, decoys: 2 },
            { stringChance: 0.26, numberChance: 0.12, opaqueMin: 20, distributedMin: 128, interval: 192, decoys: 1 },
            { stringChance: 0.18, numberChance: 0.08, opaqueMin: 28, distributedMin: 192, interval: 256, decoys: 0 }
        ];
    return profiles[Math.min(attempt, profiles.length - 1)];
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
