const fs = require('fs');
const path = require('path');
const codegen = fs.readFileSync(path.join(__dirname, '../src/generator/codegen.js'), 'utf8');
const match = codegen.match(/const fields = \[([\s\S]*?)\];/);
if (!match) throw new Error('names fields table not found');
const fields = new Set([...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]));
for (const file of ['codegen.js','registerVmCodegen.js','registerVmDecoder.js']) {
  const source = fs.readFileSync(path.join(__dirname, '../src/generator', file), 'utf8');
  const refs = [...source.matchAll(/\$\{n\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]);
  const missing = [...new Set(refs.filter(name => !fields.has(name)))];
  if (missing.length) throw new Error(`${file}: missing names fields: ${missing.join(', ')}`);
}
console.log('Z3z generator name audit: OK');
