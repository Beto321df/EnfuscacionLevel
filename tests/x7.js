const assert=require('assert');
const luaparse=require('luaparse');
const CodeGenerator=require('../src/generator/x7Codegen');

const cases=[
    ['local x=10+20\nprint(x)',['x']],
    ['local function add(a,b)return a+b end\nprint(add(2,3))',['add']],
    ['local total=0\nfor i=1,5 do total=total+i end\nprint(total)',['total']]
];

for(const [source,markers] of cases){
    const out=new CodeGenerator().generate(source,{preset:'strong'});
    assert.strictEqual(typeof out,'string');
    assert(out.length>source.length);
    assert.strictEqual(out.includes('\n'),false,'X7 debe ser una sola línea');
    assert(out.startsWith('return setmetatable({p='),'X7 debe comenzar con la carcasa compacta');
    assert(out.includes('D=function'),'X7 debe contener el decoder propio');
    assert(out.includes('O=function'),'X7 debe contener la VM propia');
    assert(out.includes('R=function'),'X7 debe contener el runner propio');
    assert(out.endsWith('):R(...)'),'X7 debe terminar en el entrypoint R');
    assert(!/\bbit32\b|\bbit64\b|\bxor\b/i.test(out),'X7 no debe depender de librerías bitwise externas');
    for(const marker of markers){
        if(marker.length < 2) continue;
        assert(!out.includes(marker),`X7 no debe exponer el identificador fuente ${marker}`);
    }
    if(source.includes('print'))assert(!out.includes('print'),'X7 no debe exponer nombres fuente');
    luaparse.parse(out,{wait:false,comments:false,luaVersion:'5.1'});
}

// Regression: this shape previously triggered a false register overflow because
// X7 validated shuffled opcode IDs before restoring the semantic instruction view.
const complexSource=`local seed=17
local total=0
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
    if x>50 then y=y+19
    elseif x>20 then y=y-4
    else y=y+2 end
    return x,y
end
local function process(tbl,fn)
    local acc=0
    for i=1,#tbl do
        local v=tbl[i]
        if v%2==0 then acc=acc+fn(v,i)
        else acc=acc-fn(v,i) end
    end
    return acc
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
local result=process(values,transform)
local nested={alpha={value=result,tag=state.name},beta={enabled=state.enabled,seed=seed}}
for i=1,4 do
    local x=counterA(i)
    local y=counterB(i+1)
    if (x+y)%3==0 then total=total+x*y
    else total=total+x+y end
end
while total<1000 do
    total=total+(result%17)+3
    if total%11==0 then total=total-7 end
end
local function finalize(a,b)
    local out={}
    out[1]=a
    out[2]=b
    out.sum=a+b
    out.valid=(a>0 and b>0)
    return out
end
local final=finalize(result,total)
print(state.name,final[1],final[2],final.sum,final.valid,nested.alpha.tag)`;

for(let i=0;i<4;i+=1){
    const out=new CodeGenerator().generate(complexSource,{preset:'strong'});
    assert(out.startsWith('return setmetatable({p='),'X7 complex regression must generate');
    assert.strictEqual(out.includes('\\n'),false,'X7 complex regression must remain one line');
}

const longSource=Array.from({length:4999},(_,i)=>`local v${i}= ${i}`).join('\\n')+
    '\\nprint(v4998)';
const longOut=new CodeGenerator().generate(longSource,{preset:'strong'});
assert(longOut.startsWith('return setmetatable({p='),'X7 debe aceptar un script de 5000 líneas');
assert.strictEqual(longOut.includes('\\n'),false,'X7 5000-line output must remain one line');

const a=new CodeGenerator().generate('print("same")',{preset:'strong'});
const b=new CodeGenerator().generate('print("same")',{preset:'strong'});
assert.notStrictEqual(a,b,'X7 debe diversificar cada build');
assert(a.length<20000,'El loader X7 compacto no debe crecer innecesariamente en un script pequeño');

console.log('X7 compact runtime: syntax, one-line shell, own VM, source hiding and per-build diversification OK');
