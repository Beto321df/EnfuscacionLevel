const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan }=require('../src/zlang/emitter');
const { validateRegisterProgram, REG_OPS, REG_ALIAS_BASE, REGISTER_FIELDS }=require('../src/zlang/registerVm');

const cases=[
['choose',`local function choose(x)
    if x > 0 then
        return 10
    else
        return 20
    end
    print("unreachable")
end
print(choose(1))`],
['break-continue',`local total=0
while total < 10 do
    total = total + 1
    if total == 4 then
        break
    end
    if total == 2 then
        continue
    end
    total = total + 1
end
print(total)`],
['branch',`local function branch(x)
    if x then
        local a=1
        if a==1 then return "yes" end
    end
    return "no"
end
print(branch(true),branch(false))`]
];

for(const [name,source] of cases){
  console.log('\nCASE',name);
  const native=buildNativeProgram(source,{fallback:false,polymorphOptions:{chance:0,maxPerFunction:0}});
  const plan=buildEmissionPlan(native,{backend:'register',diversify:{stringChance:0,numberChance:0},registers:{chance:0},isa:{aliasChance:0}});
  try { validateRegisterProgram(plan); console.log('VALID'); }
  catch(e){
    console.log('ERROR',e.message);
    for(let fi=0;fi<plan.functions.length;fi++){
      const fn=plan.functions[fi];
      for(let pi=0;pi<fn.code.length;pi++){
        const ins=fn.code[pi];
        const name=Object.keys(REG_OPS).find(k=>REG_OPS[k]===ins[0]);
        const base=REG_ALIAS_BASE[name]||name;
        const fields=REGISTER_FIELDS[base]||[];
        for(const field of fields){
          if(ins[field]>=fn.registerCount) console.log('BAD',fi,pi+1,name,'base',base,'field',field,'value',ins[field],'rc',fn.registerCount,'ins',JSON.stringify(ins));
        }
      }
    }
  }
}
