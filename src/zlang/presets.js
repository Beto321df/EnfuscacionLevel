const PRESETS = Object.freeze({
    balanced: Object.freeze({
        backend: 'register',
        polymorph: Object.freeze({ chance: 0.10, maxPerFunction: 8 }),
        diversify: Object.freeze({ stringChance: 0.30, numberChance: 0.20, maxStringShards: 3 }),
        registers: Object.freeze({ chance: 0.70 }),
        isa: Object.freeze({ aliasChance: 0.18 })
    }),
    strong: Object.freeze({
        backend: 'register',
        polymorph: Object.freeze({ chance: 0.18, maxPerFunction: 16 }),
        diversify: Object.freeze({ stringChance: 0.62, numberChance: 0.48, maxStringShards: 4 }),
        registers: Object.freeze({ chance: 1.00 }),
        isa: Object.freeze({ aliasChance: 0.34 })
    }),
    maximum: Object.freeze({
        backend: 'register',
        polymorph: Object.freeze({ chance: 0.28, maxPerFunction: 32 }),
        diversify: Object.freeze({ stringChance: 0.90, numberChance: 0.78, maxStringShards: 6 }),
        registers: Object.freeze({ chance: 1.00 }),
        isa: Object.freeze({ aliasChance: 0.55 })
    })
});

function resolvePreset(name = 'strong') {
    const key = String(name || 'strong').toLowerCase();
    if (!PRESETS[key]) throw new Error(`Z3 preset desconocido: ${name}`);
    const preset = PRESETS[key];
    return {
        name: key,
        backend: preset.backend,
        polymorph: { ...preset.polymorph },
        diversify: { ...preset.diversify },
        registers: { ...preset.registers },
        isa: { ...preset.isa }
    };
}

module.exports = { PRESETS, resolvePreset };
