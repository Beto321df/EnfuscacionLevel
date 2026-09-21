const {buildNativeProgram}=require('../src/zlang/nativeCompiler');
const {buildEmissionPlan}=require('../src/zlang/emitter');
const {REG_OPS,REG_ALIAS_BASE,registerizeProgram}=require('../src/zlang/registerVm');
const {resolvePreset}=require('../src/zlang/presets');

const source=`local function makeCounter(base)
    return function(step)
        return base+step
    end
end
local counterA=makeCounter(5)
local counterB=makeCounter(13)
local function process(tbl,fn)
    local acc=0
    for i=1,#tbl do
        local v=tbl[i]
        acc=acc+fn(v,i)
    end
    return acc
end
local values={4,9,16}
local function transform(v,i)
    return v+i
end
local result=process(values,transform)
print(result)`;

const preset=resolvePreset('strong');
const native=buildNativeProgram(source,{polymorphOptions:preset.polymorph});
const plan=buildEmissionPlan(native,{backend:'register',diversify:preset.diversify,registers:{...preset.registers,chance:0},isa:{...preset.isa,aliasChance:0}});
const name=ins=>REG_ALIAS_BASE[Object.keys(REG_OPS).find(k=>REG_OPS[k]===ins[0])]||Object.keys(REG_OPS).find(k=>REG_OPS[k]===ins[0]);
const nativeRoot=buildNativeProgram(source,{polymorphOptions:preset.polymorph}).functions[0];
console.log('NATIVE_ROOT');
for(const [i,ins] of nativeRoot.code.entries()){
    if([2,3,14,10,11,32,33].includes(ins[0])) console.log('  ',i+1,JSON.stringify(ins));
}

const sem=(fn,ins)=>fn.opcodeDecode?fn.opcodeDecode[ins[0]]:ins[0];

for(let id=0;id<plan.functions.length;id++){
    const fn=plan.functions[id];
    console.log('FN',id,fn.name,'params='+fn.params.length,'locals='+fn.localCount,'regs='+fn.registerCount,'code='+fn.code.length);
    for(let i=0;i<fn.code.length;i++){
        const ins=fn.code[i], s=sem(fn,ins);
        const n=name(ins);
        if([2,3,4,11,16,17,18,19,20,41,42,43,44,55,56].includes(s) || ['MAKE_FUNCTION','LOAD_LOCAL','STORE_LOCAL','CALL','CALL_MULTI'].includes(n))
            console.log('  ',i+1,n,'sem='+s,JSON.stringify(ins.slice(1)));
    }
}
const directProgram=registerizeProgram(native);
console.log('DIRECT_REGISTER_ROOT');
const directRoot=directProgram.functions[0];
for(const [i,ins] of directRoot.code.entries()){
    if(i>=1&&i<=90) console.log('  ',i+1,JSON.stringify(ins));
}
console.log('DIAG DONE');