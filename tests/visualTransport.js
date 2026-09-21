const assert = require('assert');
const luaparse = require('luaparse');
const { encodeVisual,decodeVisual,OUTER_FIRST,OUTER_SECOND,CJK_GLYPH_COUNT,GROUP_SIZE,SEPARATOR,CHUNK_BYTES,wrapVisual } = require('../src/zlang/visualTransport');
const isCjk=ch=>/[\u4E00-\u9FFF]/u.test(ch);
assert.strictEqual(Array.from(OUTER_FIRST).length,32);assert.strictEqual(Array.from(OUTER_SECOND).length,32);assert.strictEqual(new Set(Array.from(OUTER_FIRST)).size,32);assert.strictEqual(new Set(Array.from(OUTER_SECOND)).size,32);assert.strictEqual(CJK_GLYPH_COUNT,8);assert.strictEqual(SEPARATOR,'/ ');assert.strictEqual(GROUP_SIZE,19);assert.strictEqual(CHUNK_BYTES,30*1024);
const source=Array.from({length:4096},(_,i)=>String.fromCharCode(32+(i%95))).join(''),packet=encodeVisual(source);
assert.strictEqual(Buffer.from(decodeVisual(packet)).toString('utf8'),source);assert(packet.lines.length>1);
for(const line of packet.lines){assert(Array.from(line).length<=GROUP_SIZE);assert(!/[\s]/u.test(line));}
const payload=packet.payload;assert(/\d/.test(payload),'visual payload debe usar numeros');assert(/[!@#$%^&*()+="?:;>|}{~]/u.test(payload),'visual payload debe usar signos');assert(Array.from(payload).some(isCjk),'visual payload debe contener CJK');
const chars=Array.from(payload).filter(ch=>ch!=='/'&&!/\s/u.test(ch));const ratio=chars.filter(isCjk).length/chars.length;assert(ratio>0 && ratio<=0.4,'CJK debe mantenerse en una franja visual razonable');
for(let i=1;i<chars.length;i++)assert(chars[i]!==chars[i-1],'no debe repetir el mismo glyph inmediatamente');
const loader=wrapVisual('print("ok")');
assert(loader.startsWith('return(function(t,...)'),'El loader visual debe usar el envoltorio return(function(...).');
assert(loader.includes('local l=t.L'),'El envoltorio debe recibir el paquete visual como primer argumento.');
assert(loader.includes('return c(...)'),'El entrypoint debe reenviar los varargs al chunk decodificado.');
assert(!loader.includes('return({L={'),'No debe volver al formato de tabla :R del loader anterior.');
assert(loader.includes('math.floor(i/2)'));assert(!loader.includes('>>'));assert(loader.includes('[=['));assert(!loader.includes('print'));assert(loader.endsWith(')'));assert(!/--/u.test(loader.slice(-16)));luaparse.parse(loader,{wait:false,comments:false,luaVersion:'5.1'});
console.log('Z visual: return(function(...)) wrapper, mixed glyphs, round-trip and Lua syntax OK');
