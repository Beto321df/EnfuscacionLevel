const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan }=require('../src/zlang/emitter');
const { REG_OPS, REG_ALIAS_BASE, REGISTER_FIELDS }=require('../src/zlang/registerVm');

const source=`local function branch(x)
    if x then
        local a=1
        if a==1 then return "yes" end
    end
    return "no"
end
print(branch(true),branch(false))`;

const native=buildNativeProgram(source,{fallback:false,polymorphOptions:{chance:0,maxPerFunction:0}});
const plan=buildEmissionPlan(native,{backend:'register',diversify:{stringChance:0,numberChance:0},registers:{chance:0},isa:{aliasChance:0}});

for(let fi=0;fi<plan.functions.length;fi++){
  const fn=plan.functions[fi];
  console.log('FUNCTION',fi,'rc',fn.registerCount,'codeLen',fn.code.length);
  for(let pi=0;pi<fn.code.length;pi++){
    const ins=fn.code[pi];
    const semanticOp=fn.opcodeDecode?.[ins[0]] ?? ins[0];
    const name=Object.keys(REG_OPS).find(k=>REG_OPS[k]===semanticOp);
    const base=REG_ALIAS_BASE[name]||name;
    const fields=REGISTER_FIELDS[base]||[];
    for(const field of fields){
      if(ins[field]>=fn.registerCount) console.log('BAD',fi,pi+1,'raw',ins[0],'sem',name,'base',base,'field',field,'value',ins[field],'rc',fn.registerCount,'ins',JSON.stringify(ins));
    }
  }
}
