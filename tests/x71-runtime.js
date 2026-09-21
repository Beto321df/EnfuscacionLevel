const fs=require('fs');
const {spawnSync}=require('child_process');
const CodeGenerator=require('../src/generator/x71Codegen');

const source=`local seed=17
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
    if x>50 then y=y+19 elseif x>20 then y=y-4 else y=y+2 end
    return x,y
end
local function process(tbl,fn)
    local acc=0
    for i=1,#tbl do
        local v=tbl[i]
        if v%2==0 then acc=acc+fn(v,i) else acc=acc-fn(v,i) end
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
    if (x+y)%3==0 then total=total+x*y else total=total+x+y end
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

const out=new CodeGenerator().generate(source,{preset:'strong'});
const miniPlanSource='print("X71-MINIMAL")';
const {buildNativeProgram}=require('../src/zlang/nativeCompiler');
const {buildEmissionPlan}=require('../src/zlang/emitter');
const {resolvePreset}=require('../src/zlang/presets');
const {REG_OPS,registerizeProgram}=require('../src/zlang/registerVm');
const preset=resolvePreset('strong');

// Shadow execution of the minimal register program, before X7.1 packing.
{
    const shadowPlan=buildEmissionPlan(
        buildNativeProgram(miniPlanSource,{polymorphOptions:preset.polymorph}),
        {backend:preset.backend,diversify:preset.diversify,registers:{...preset.registers,chance:0},isa:preset.isa}
    );
    const fn=shadowPlan.functions[0];
    const regs={};
    const sem=ins=>fn.opcodeDecode?fn.opcodeDecode[ins[0]]:ins[0];
    const constValue=i=>shadowPlan.constants[i]&&shadowPlan.constants[i].value;
    for(const ins of fn.code){
        const o=sem(ins),a=ins[1],b=ins[2],c=ins[3];
        if(o===5){regs[a]={kind:'global',name:String(constValue(b))};continue;}
        if(o===2||o===41){regs[a]={kind:'const',value:constValue(b)};continue;}
        if(o===16||o===44){regs[a]=regs[b];continue;}
        if(o===12||o===45){
            const x=regs[b],y=regs[c];
            if(ins[4]===7) regs[a]={kind:'const',value:String(x?.value??x?.name??x??'')+String(y?.value??y?.name??y??'')};
            else regs[a]={kind:'computed'};
            continue;
        }
        if(o===17||o===18){
            const callee=regs[b];
            if(callee?.kind!=='global'||callee.name!=='print'){
                throw new Error(`X7.1 pre-pack CALL lost print: r${b}=${JSON.stringify(callee)}`);
            }
            break;
        }
    }
}

const mini=new CodeGenerator().generate('print("X71-MINIMAL")',{preset:'strong'});
fs.writeFileSync('/tmp/nyvex-x71-minimal.lua',mini,'utf8');
const miniLua=spawnSync(process.env.LUA_BIN||'lua5.4',['/tmp/nyvex-x71-minimal.lua'],{encoding:'utf8'});
if(miniLua.error) throw miniLua.error;
if(miniLua.status!==0) throw new Error('X7.1 minimal failed: '+(miniLua.stderr||''));
if(!(miniLua.stdout||'').includes('X71-MINIMAL')) throw new Error('X7.1 minimal produced no print: '+(miniLua.stdout||''));
const path='/tmp/nyvex-x71-runtime.lua';
const tracedOut=out.replace(
    "local a1,b,c,d=e[2],e[3],e[4],e[5];",
    "local a1,b,c,d=e[2],e[3],e[4],e[5];if pc==2 then print('X71FRAME',id,#fn.p,a.n,type(a[1]),type(a[2]),type(a[3]))end;if o==17 or o==18 or o==19 or o==20 or o==55 or o==56 then print('X71TRACE',id,pc-1,a1,b,c,d,type(r[b]),type(r[a1]))end;"
);
fs.writeFileSync(path,tracedOut);
const luaparse=require('luaparse');
const ds=out.indexOf('D=(function'), os=out.indexOf(',O=(function',ds), rs=out.indexOf(',R=(function',os);
for(const [name,src] of [
    ['D','local D='+out.slice(ds+3,os-1)],
    ['O',out.slice(os+1,rs)],
    ['R',out.slice(rs+1,out.lastIndexOf('}):R(...)'))]
]) {
    try { luaparse.parse(src,{wait:false,comments:false,luaVersion:'5.1'}); console.log(name+' fragment OK'); }
    catch(e) {
        const m=String(e.message).match(/\[(?:\\d+):(\\d+)\]/);
        const at=m?Number(m[1])-1:0;
        console.error(name+' fragment:',e.message,'around:',src.slice(Math.max(0,at-120),at+180));
    }
}
try {
    luaparse.parse(out,{wait:false,comments:false,luaVersion:'5.1'});
    console.log('full luaparse OK');
} catch(e) {
    const at=Number(e.index)||0;
    console.error('full luaparse:',e.message);
    console.error('around:',out.slice(Math.max(0,at-220),at+220));
    console.error('char:',JSON.stringify(out[at]));
    process.exit(2);
}
const lua=spawnSync(process.env.LUA_BIN||'lua5.4',[path],{encoding:'utf8'});
if(lua.error) throw lua.error;
if(lua.status!==0){
    process.stderr.write(lua.stderr||'');
    process.stdout.write(lua.stdout||'');
    process.exit(lua.status||1);
}
const stdout=(lua.stdout||'').trim();
if(!stdout.includes('Z-Nexus')) throw new Error('X7.1 runtime produced unexpected output: '+stdout);
console.log('X7.1 runtime execution OK:',stdout);