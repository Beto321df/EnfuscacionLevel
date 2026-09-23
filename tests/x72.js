const assert=require('assert');
const luaparse=require('luaparse');
const X72=require('../src/generator/x72Codegen');
const {buildNativeProgram}=require('../src/zlang/nativeCompiler');
const {executeProgram}=require('../src/zlang/referenceVm');
const {hardenProgram}=require('../src/zlang/x72Hardening');

const source=`local seed=17
local total=0
local state={value=11,enabled=true,name="Z-Nexus-Long-String"}
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
    if x>50 then y=y+19
    elseif x>20 then y=y-4
    else y=y+2 end
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
for i=1,#values do
    local v=values[i]
    if v%2==0 then total=total+transform(v,i) else total=total-transform(v,i) end
end
total=total+100
while total<1000 do
    total=total+(total%17)+3
    if total%11==0 then total=total-7 end
end
print(state.name,total)`;

const native=buildNativeProgram(source,{fallback:false,polymorphOptions:{chance:0,maxPerFunction:0}});
const originalFunctionCount=native.functions.length;
const hardenedBaselineOutput=[];
executeProgram(native,{print:(...args)=>hardenedBaselineOutput.push(...args)});

hardenProgram(native,{
    strings:{chance:1},
    numbers:{chance:1},
    opaque:{minFunctionLength:8},
    decoys:{count:3}
});

assert(native.metadata.x72StringSplitting.enabled,'X7.2 debe partir strings largas');
assert(native.metadata.x72NumericSplitting.enabled,'X7.2 debe transformar números constantes');
assert(native.metadata.x72OpaqueGuards.enabled,'X7.2 debe insertar opaque guards');
assert(native.metadata.x72DistributedOpaqueGuards.enabled,'X7.2 debe distribuir opaque guards');
assert(native.metadata.x72ConstantCompaction?.enabled,'X7.2 debe compactar el pool de constantes');
assert(native.metadata.x72DecoyFunctions?.inserted===3,'X7.2 debe insertar 3 funciones señuelo');
assert.strictEqual(native.functions.length,originalFunctionCount+3,'X7.2 debe conservar el root y agregar solo señuelos');
assert(native.constants.every(c=>c.value!=='Z-Nexus-Long-String'),'X7.2 no debe conservar el literal original después de partirlo');
for(const fn of native.functions)for(const ins of fn.code)assert(Array.isArray(ins)&&ins.length===5,'X7.2 IR debe conservar instrucciones de 5 operandos');

const hardenedOutput=[];
executeProgram(native,{print:(...args)=>hardenedOutput.push(...args)});
assert.deepStrictEqual(hardenedOutput,hardenedBaselineOutput,'X7.2 IR hardening debe conservar la semántica del programa');

// Generated shell checks.
for(let i=0;i<2;i+=1){
    const out=new X72().generate(source,{preset:'maximum'});
    assert.strictEqual(out.includes('\\n'),false,'X7.2 debe ser una sola línea');
    assert(out.startsWith('return(function('),'X7.2 debe reutilizar la carcasa anónima compacta');
    assert(out.includes('=(function(p,a,n,k,w,h)'), 'X7.2 debe incluir un decoder anónimo');
    assert(out.includes('=(function(P,id,pl,pu,a)'), 'X7.2 debe incluir una VM anónima');
    assert(!out.includes('D=function'),'X7.2 no debe fijar el nombre del decoder');
    assert(!out.includes('O=function'),'X7.2 no debe fijar el nombre de la VM');
    assert(!out.includes('R=function'),'X7.2 no debe fijar el nombre del runner');
    assert(!/\\bbit32\\b|\\bbit64\\b|\\bxor\\b/i.test(out),'X7.2 no debe usar APIs bitwise prohibidas');
    for(const marker of ['Z-Nexus-Long-String','makeCounter','counterA','transform']){
        assert(!out.includes(marker),'X7.2 no debe exponer '+marker);
    }
    luaparse.parse(out,{wait:false,comments:false,luaVersion:'5.1'});
}

const exactSource=`local seed = 17
local total = 0
local state = {
    value = 11,
    enabled = true,
    name = "Z-Nexus",
}

local function makeCounter(base)
    local n = base
    return function(step)
        n = n + step
        return n
    end
end

local counterA = makeCounter(5)
local counterB = makeCounter(13)

local function mix(a, b, c)
    local x = a * 3 + b - c
    local y = (x % 7) * 11

    if x > 50 then
        y = y + 19
    elseif x > 20 then
        y = y - 4
    else
        y = y + 2
    end

    return x, y
end

local function process(tbl, fn)
    local acc = 0
    for i = 1, #tbl do
        local v = tbl[i]
        if v % 2 == 0 then
            acc = acc + fn(v, i)
        else
            acc = acc - fn(v, i)
        end
    end
    return acc
end

local values = {4, 9, 16, 23, 31, 42, 57, 64}

local function transform(v, i)
    local a, b = mix(v, seed, i)
    if state.enabled then
        a = a + counterA(i)
        b = b + counterB(v % 5)
    end
    return (a * 2 + b) % 101
end

local result = process(values, transform)

local nested = {
    alpha = {
        value = result,
        tag = state.name,
    },
    beta = {
        enabled = state.enabled,
        seed = seed,
    },
}

for i = 1, 4 do
    local x = counterA(i)
    local y = counterB(i + 1)
    if (x + y) % 3 == 0 then
        total = total + x * y
    else
        total = total + x + y
    end
end

while total < 1000 do
    total = total + (result % 17) + 3
    if total % 11 == 0 then
        total = total - 7
    end
end

local function finalize(a, b)
    local out = {}
    out[1] = a
    out[2] = b
    out.sum = a + b
    out.valid = (a > 0 and b > 0)
    return out
end

local final = finalize(result, total)

print(state.name, final[1], final[2], final.sum, final.valid, nested.alpha.tag)`;

const exactOut=new X72().generate(exactSource,{preset:'maximum'});
assert(exactOut.startsWith('return(function('),'X7.2 exact benchmark debe generarse');
assert.strictEqual(exactOut.includes('\\n'),false,'X7.2 exact benchmark debe seguir en una sola línea');

const a=new X72().generate(`local x=10
local s="abcdefghijklmnop"
print(s,x)`,{preset:'maximum'});
const b=new X72().generate(`local x=10
local s="abcdefghijklmnop"
print(s,x)`,{preset:'maximum'});
assert.notStrictEqual(a,b,'X7.2 debe diversificar cada build');
assert(a.length>12000,'X7.2 debe conservar sus capas de runtime');
assert(a.length<1024*1024,'X7.2 debe respetar el límite de 1 MB');

const mediumSource=Array.from({length:500},(_,i)=>[
    `local cfg${i}={id=${i},enabled=${i%2===0},name="item-${i}"}`,
    `cfg${i}.value=(${i}*3+${i%11})%101`,
    `if cfg${i}.enabled then cfg${i}.tag=cfg${i}.name else cfg${i}.tag="off" end`
].join('\n')).join('\n');
const mediumOut=new X72().generate(mediumSource,{preset:'maximum'});
assert(mediumOut.length<=100*1024,'X7.2 500-line output should stay at or below 100KB');
assert(mediumOut.startsWith('return(function('),'X7.2 medium benchmark debe generar');
assert.strictEqual(mediumOut.includes('\\n'),false,'X7.2 medium benchmark debe seguir en una línea');
luaparse.parse(mediumOut,{wait:false,comments:false,luaVersion:'5.1'});

const longSource=Array.from({length:4999},(_,i)=>`local v${i}=${i}`).join('\n')+'\nprint(v4998)';
const longOut=new X72().generate(longSource,{preset:'strong'});
assert(longOut.startsWith('return(function('),'X7.2 debe aceptar 5000 líneas');
assert.strictEqual(longOut.includes('\\n'),false,'X7.2 5000 líneas debe seguir en una línea');
luaparse.parse(longOut,{wait:false,comments:false,luaVersion:'5.1'});

console.log('X7.2 hardening: strings, numeric expressions, opaque guards, X7.1 container, runtime guard and 5000-line syntax OK');
