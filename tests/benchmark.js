const CodeGenerator = require('../src/generator/codegen');
const lines = [
    'local total = 0',
    'local marker = "benchmark-secret"',
    'for i = 1, 120 do',
    '    if i % 7 == 0 then continue end',
    '    total = total + (i & 15)',
    'end',
    'local function derive(value)',
    '    if value > 500 then return marker .. ":high" end',
    '    return marker .. ":low"',
    'end',
    'print(derive(total))'
];
const source = lines.join('\n');

function measure(preset, iterations = 8) {
    const generator = new CodeGenerator();
    const start = process.hrtime.bigint();
    let totalBytes = 0;

    for (let i = 0; i < iterations; i += 1) {
        totalBytes += Buffer.byteLength(generator.generate(source, { preset }));
    }

    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    return {
        preset,
        iterations,
        totalMs: Number(elapsedMs.toFixed(2)),
        averageMs: Number((elapsedMs / iterations).toFixed(2)),
        averageOutputBytes: Math.round(totalBytes / iterations)
    };
}

for (const preset of ['balanced', 'strong', 'maximum']) {
    console.log(JSON.stringify(measure(preset)));
}
