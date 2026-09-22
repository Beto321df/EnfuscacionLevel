const X71CodeGenerator = require('./x71Codegen');
const { buildNativeProgram } = require('../zlang/nativeCompiler');
const { buildEmissionPlan } = require('../zlang/emitter');
const { resolvePreset } = require('../zlang/presets');
const { hardenProgram } = require('../zlang/x72Hardening');

const MAX_OUTPUT = 1024 * 1024;

function hardeningPlan(name, attempt, sourceLines) {
    const max = String(name).toLowerCase() === 'maximum';
    // Large real-world scripts need density, not dozens of extra IR nodes.
    // Keep the semantic hardening layers enabled, but make them sparse as the
    // source grows so the final payload stays practical for script executors.
    if (sourceLines > 250) {
        const large = [
            { stringChance: 0.28, numberChance: 0.22, opaqueMin: 24, distributedMin: 192, interval: 192, decoys: 0 },
            { stringChance: 0.18, numberChance: 0.14, opaqueMin: 48, distributedMin: 320, interval: 320, decoys: 0 },
            { stringChance: 0.10, numberChance: 0.08, opaqueMin: 72, distributedMin: 512, interval: 512, decoys: 0 },
            { stringChance: 0.04, numberChance: 0.04, opaqueMin: 128, distributedMin: 1024, interval: 1024, decoys: 0 }
        ];
        return large[Math.min(attempt, large.length - 1)];
    }
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
    return profiles[Math.min(attempt, profiles.length - 1)];
}

class X72CodeGenerator {
    generate(source, options = {}) {
        if (typeof source !== 'string' || !source.trim()) {
            throw new Error('El código Lua/Luau está vacío.');
        }

        const preset = resolvePreset(options.preset || 'maximum');
        const lineCount = source.split(/\r?\n/).length;
        const maxAttempts = options.fitToLimit === false ? 1 : 4;
        let lastOutput = null;
        let lastError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            try {
                const native = buildNativeProgram(source, {
                    polymorphOptions: preset.polymorph
                });

                native.metadata = {
                    ...(native.metadata || {}),
                    strengthPreset: preset.name,
                    engine: 'X7.2 hardened',
                    hardeningAttempt: attempt
                };

                const plan = hardeningPlan(preset.name, attempt, lineCount);
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

                const generated = X71CodeGenerator.x71Loader(program, {
                    runtimeGuard: true,
                    preferNativeGlobals: true,
                    purgePayload: true,
                    encodeLocalOperands: true,
                    // For large scripts, compact routing keeps the same logical
                    // indirection without spending 8-16 bytes per instruction.
                    encodeInstructionRoute: lineCount <= 250,
                    encodeOperandFeedback: true,
                    encodeConstantRoute: true,
                    encodeTargetTokens: true,
                    compactRoutes: true,
                    variableOperands: true,
                    polymorphicShell: true,
                    polymorphicDispatch: true,
                    rollingPayload: true,
                    compactPayload: true,
                    lazyConstants: true
                });

                lastOutput = generated;
                if (generated.length <= MAX_OUTPUT) return generated;
            } catch (error) {
                lastError = error;
                // A smaller hardening profile is only a size fallback. Compiler
                // errors are retried because each attempt rebuilds a fresh IR.
            }
        }

        if (lastOutput && lastOutput.length > MAX_OUTPUT) {
            throw new Error(`X72: salida protegida de ${lastOutput.length} caracteres supera el límite de ${MAX_OUTPUT}.`);
        }
        throw lastError || new Error('X72: no se pudo generar una salida protegida.');
    }
}

module.exports = X72CodeGenerator;
