const assert=require('assert');
const luaparse=require('luaparse');
const CodeGenerator=require('../src/generator/x71Codegen');

const implementation=require('fs').readFileSync(require.resolve('../src/generator/x71Codegen'),'utf8');
assert(implementation.includes("type(getrenv)=='function'"),'X7.1 debe considerar el entorno Roblox cuando getgenv no contiene un global');
assert(implementation.includes("local GG=function(k)"),'X7.1 debe usar un resolver de globales por capas');
assert(implementation.includes("(fn.upvalues[u].kind + k + u * 17) % 256"),'X7.1 debe codificar el tipo de upvalue con la misma máscara que usa el loader');
assert(implementation.includes("fn.u[j]={((mu()-(mk%256)-((j-1)*17))%256+256)%256,mv(200+j-1)}"),'X7.1 debe descifrar el tipo de upvalue al cargar');
assert(implementation.includes("lc[n[i]+1]=lc[n[i]+1]or{v=nil};lc[n[i]+1].v=v.v[i]"),'X7.1 debe desempaquetar correctamente los valores de ITER_PREP');
assert(implementation.includes("for i=1,#q.sl do lc[q.sl[i]+1].v=w.v[i]end"),'X7.1 debe desempaquetar correctamente los valores de ITER_NEXT');
assert(implementation.includes("v=RE and RE[k]or nil"),'X7.1 debe consultar getrenv para globals');
assert(implementation.includes("return{k=constants,f=f,r=root}end"),'X7.1 debe exponer la tabla de constantes con la clave que consume la VM');
assert(implementation.includes("elseif o==36 then local q=uv[b+1]"),'X7.1 debe ejecutar LOAD_UPVALUE');
assert(implementation.includes("elseif o==37 then local q=uv[a1+1]"),'X7.1 debe ejecutar STORE_UPVALUE');
assert(implementation.includes("v=_G and _G[k]or nil"),'X7.1 debe tener fallback explícito al _G activo');

assert(implementation.includes('u32(metaSection, st);'),'X7.1 debe persistir el step de metadata');
assert(implementation.includes('ms.four(); // metadata mask key'),'X7.1 validator debe leer metadata key');
assert(implementation.includes('ms.four(); // metadata mask step'),'X7.1 validator debe leer metadata step');
assert(implementation.includes('ms.two();  // vararg flag'),'X7.1 validator debe leer vararg como u16');
assert(implementation.includes('local vararg=mU()==1;'),'X7.1 loader debe leer vararg como u16');
assert(
    implementation.includes('local opcodes={};for j=1,count do opcodes[j]=iu()end;'),
    'X7.1 debe leer el stream de opcodes'
);
assert(
    implementation.includes('fn.q={};for q=1,56 do fn.q[q]=iu()end;'),
    'X7.1 debe reconstruir el mapa físico->semántico de forma compacta'
);

const source=`local seed=17
local state={value=11,enabled=true,name="Z-Nexus"}
local function makeCounter(base)
    local n=base
    return function(step)
        n=n+step
        return n
    end
end
local counterA=makeCounter(5)
local counterB=makeCounter(13)
local function mix(a,b,c)
    local x=a*3+b-c
    local y=(x%7)*11
    if x>50 then y=y+19 elseif x>20 then y=y-4 else y=y+2 end
    return x,y
end
local values={4,9,16,23,31,42,57,64}
local function transform(v,i)
    local a,b=mix(v,seed,i)
    if state.enabled then
        a=a+counterA(i)
        b=b+counterB(v%5)
    end
    return (a*2+b)%101
end
local total=0
for i=1,#values do
    local v=values[i]
    if v%2==0 then total=total+transform(v,i) else total=total-transform(v,i) end
end
while total<1000 do
    total=total+(total%17)+3
    if total%11==0 then total=total-7 end
end
local final={sum=total,tag=state.name,valid=(total>0)}
print(final.tag,final.sum,final.valid)`;

for(let i=0;i<4;i+=1){
    const out=new CodeGenerator().generate(source,{preset:'strong'});
    assert.strictEqual(typeof out,'string');
    assert.strictEqual(out.includes('\n'),false,'X7.1 debe ser una sola línea');
    assert(out.startsWith('return({'),'X7.1 debe usar la carcasa compacta sin dependencias externas');
    const shellFunctions = (out.match(/,[A-Za-z]=\(function/g) || []).length;
    assert(shellFunctions >= 3,'X7.1 debe incluir decoder, VM y runner propios');
    assert(!out.includes('table.pack'),'X7.1 no debe depender de table.pack');
    assert(!out.includes('table.unpack'),'X7.1 no debe depender de table.unpack');
    assert(out.includes('setmetatable('),'X7.1 ahora usa lazy constants mediante metatable');
    assert(out.includes("local PACK=function"),'X7.1 debe incluir pack propio');
    assert(/}\):[A-Za-z]\(\.\.\.\)$/.test(out),'X7.1 debe terminar en un runner compacto');
    assert(!/\bbit32\b|\bbit64\b|\bxor\b/i.test(out),'X7.1 no debe depender de APIs bitwise prohibidas');
    for(const marker of ['Z-Nexus','makeCounter','counterA','transform']){
        assert(!out.includes(marker),'X7.1 no debe exponer un identificador fuente');
    }
    luaparse.parse(out,{wait:false,comments:false,luaVersion:'5.1'});
}

const a=new CodeGenerator().generate('print("same")',{preset:'strong'});
const b=new CodeGenerator().generate('print("same")',{preset:'strong'});
assert.notStrictEqual(a,b,'X7.1 debe diversificar cada build');
assert(a.length>10000,'X7.1 debe incluir sus capas de runtime');
assert(a.length<60000,'X7.1 no debe crecer sin control en un script pequeño');

// Multi-assignment regression: values must retain source order on the LIFO stack.
const multiSource=`local a,b=1,2
a,b=b,a
print(a,b)`;
const {buildNativeProgram}=require('../src/zlang/nativeCompiler');
const multiProgram=buildNativeProgram(multiSource,{polymorphOptions:{chance:0,maxPerFunction:0}});
const multiCode=multiProgram.functions[0].code;
const multiStores=multiCode.filter(ins=>ins[0]===33);
assert(multiStores.length>=4,'multi-assignment must emit local stores');
assert.deepStrictEqual(multiStores.slice(-2).map(ins=>ins[1]),[0,1],'multi-assignment must preserve RHS order in the lowered local slots');


// Method-call regression: Lua/Luau obj:method(...) must pass obj as the
// receiver to CALL_METHOD instead of evaluating obj.method as the receiver.
const { buildNativeProgram: buildMethodProgram } = require('../src/zlang/nativeCompiler');
const { OPS: METHOD_OPS } = require('../src/zlang/compiler3');
const methodProgram = buildMethodProgram(`local service=game:GetService("ReplicatedStorage")
print(service)`, { fallback: false, polymorphOptions: { chance: 0, maxPerFunction: 0 } });
const methodCode = methodProgram.functions[0].code;
assert(methodCode.some(ins => ins[0] === METHOD_OPS.CALL_METHOD || ins[0] === METHOD_OPS.FUSED_GLOBAL_CALL), 'colon calls must lower to a method-aware call');
assert(!methodCode.some(ins => ins[0] === METHOD_OPS.GET_MEMBER), 'colon calls must not emit GET_MEMBER for the receiver');

const longSource=Array.from({length:4999},(_,i)=>`local v${i}= ${i}`).join('\n')+'\nprint(v4998)';
// Large GUI-like regression: many locals, tables, member calls and conditions.
const guiLikeSource=Array.from({length:1000},(_,i)=>[
    `local cfg${i}={id=${i},enabled=${i%2===0},name="item-${i}"}`,
    `cfg${i}.value=(${i}*3+${i%7})%101`,
    `if cfg${i}.enabled then cfg${i}.tag=cfg${i}.name else cfg${i}.tag="off" end`
].join('\n')).join('\n');
const guiLikeOut=new CodeGenerator().generate(guiLikeSource,{preset:'strong'});
assert(guiLikeOut.startsWith('return ({p='),'X7.1 debe aceptar una carga GUI-like de 1000 bloques');
assert.strictEqual(guiLikeOut.includes('\n'),false,'X7.1 GUI-like output debe seguir en una línea');

const longOut=new CodeGenerator().generate(longSource,{preset:'strong'});
assert(longOut.startsWith('return ({p='),'X7.1 acepta 5000 líneas');
assert.strictEqual(longOut.includes('\n'),false,'X7.1 5000-line output sigue en una línea');
luaparse.parse(longOut,{wait:false,comments:false,luaVersion:'5.1'});

// Deep-expression regression: ^ and .. are right-associative. These chains
// used to recurse through the JS parser/compiler and could overflow V8's stack.
const deepConcat=Array.from({length:1800},()=>`"x"`).join('..');
const deepSource=`local z=${deepConcat}\nprint(z)`;
const deepOut=new CodeGenerator().generate(deepSource,{preset:'strong'});
assert(deepOut.startsWith('return ({p='),'X7.1 debe soportar expresiones profundas');
assert.strictEqual(deepOut.includes('\\n'),false,'X7.1 deep expression output sigue en una línea');

console.log('X7.1 layered container: syntax, flattened planes, protected constants, control-token encoding and source hiding OK');
