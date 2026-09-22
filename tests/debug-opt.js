const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan }=require('../src/zlang/emitter');
const { registerizeProgram }=require('../src/zlang/registerVm');
const { executeProgram }=require('../src/zlang/referenceVm');
const { REG_OPS, REG_ALIAS_BASE, REGISTER_FIELDS, validateRegisterProgram }=require('../src/zlang/registerVm');

const cases=[
['choose',`local function choose(x)
    if x > 0 then return 10 else return 20 end
    print("unreachable")
end
print(choose(1))`],
['break-continue',`local total=0
while total < 10 do
    total = total + 1
    if total == 4 then break end
    if total == 2 then continue end
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
  const native=buildNativeProgram(source,{fallback:false,polymorphOptions:{chance:0,maxPerFunction:0}});
  const plan=buildEmissionPlan(native,{backend:'register',diversify:{stringChance:0,numberChance:0},registers:{chance:0},isa:{aliasChance:0}});
  console.log('\nCASE',name,'functions',plan.functions.length);
  try { validateRegisterProgram(plan); console.log('VALID'); }
  catch(e){
    console.log('ERROR',e.message);
    for(let fi=0;fi<plan.functions.length;fi++){
      const fn=plan.functions[fi];
      for(let pi=0;pi<fn.code.length;pi++){
        const ins=fn.code[pi];
        const sem=fn.opcodeDecode?.[ins[0]] ?? ins[0];
        const name2=Object.keys(REG_OPS).find(k=>REG_OPS[k]===sem);
        const base=REG_ALIAS_BASE[name2]||name2;
        const fields=REGISTER_FIELDS[base]||[];
        for(const field of fields){
          if(ins[field]>=fn.registerCount)
            console.log('BAD',fi,pi+1,'raw',ins[0],'sem',name2,'base',base,'field',field,'value',ins[field],'rc',fn.registerCount,'ins',JSON.stringify(ins));
        }
      }
    }
  }
}

const genericSource=`local t={a=1,b=2}
for k,v in next,t do print(k,v) end`;
try {
  const native=buildNativeProgram(genericSource,{fallback:false,polymorphOptions:{chance:0,maxPerFunction:0}});
  console.log('NATIVE',JSON.stringify(native.functions[0].code.slice(0,16)));
  native.functions[0].__debugCompact=true;
  const reg=registerizeProgram(JSON.parse(JSON.stringify(native)));
  validateRegisterProgram(reg);
  const output=[];
  executeProgram(reg,{next:(table,key)=>{
    const keys=Object.keys(table).sort();
    const index=key==null?0:keys.indexOf(String(key))+1;
    const nextKey=keys[index];
    return nextKey===undefined ? require('../src/zlang/referenceVm').multi([]) : require('../src/zlang/referenceVm').multi([nextKey,table[nextKey]]);
  },print:(...args)=>output.push(...args)});
  console.log('GENERIC REGISTER OK',JSON.stringify(output));
} catch(e) {
  console.error('GENERIC REGISTER ERROR',e.stack||e.message);
  const native=buildNativeProgram(genericSource,{fallback:false,polymorphOptions:{chance:0,maxPerFunction:0}});
  const reg=registerizeProgram(JSON.parse(JSON.stringify(native)));
  for(const [fi,fn] of reg.functions.entries()) console.log('FN',fi,'rc',fn.registerCount,'code',JSON.stringify(fn.code));
  process.exitCode=1;
}
