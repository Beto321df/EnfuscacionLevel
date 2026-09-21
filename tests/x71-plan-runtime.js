const {buildNativeProgram}=require('../src/zlang/nativeCompiler');
const {registerizeProgram}=require('../src/zlang/registerVm');
const {executeRegisterProgram}=require('../src/zlang/registerReferenceVm');
const {resolvePreset}=require('../src/zlang/presets');

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
for i=1,4 do
    local x=counterA(i)
    local y=counterB(i+1)
    if (x+y)%3==0 then total=total+x*y else total=total+x+y end
end
while total<1000 do
    total=total+(result%17)+3
    if total%11==0 then total=total-7 end
end
print(state.name,result,total)`;

const preset=resolvePreset('strong');
const native=buildNativeProgram(source,{polymorphOptions:preset.polymorph});
const program=registerizeProgram(native);
const out=[];
executeRegisterProgram(program,{print:(...args)=>out.push(args.join('|'))});
if(out.length!==1) throw new Error('register reference produced unexpected call count');
console.log('X71_REGISTER_PLAN_OK',out[0]);
