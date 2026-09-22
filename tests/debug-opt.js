const util=require('util');
const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan, shuffleControlFlow }=require('../src/zlang/emitter');
const { registerizeProgram, fuseRegisterComparisons, permuteRegisterFile, diversifyRegisterIsa, validateRegisterProgram }=require('../src/zlang/registerVm');
const { executeProgram }=require('../src/zlang/referenceVm');

function restoreOpcode(p){
  const out=JSON.parse(JSON.stringify(p));
  for(const fn of out.functions){
    if(Array.isArray(fn.opcodeDecode)&&fn.opcodeDecode.length>1)
      for(const ins of fn.code) ins[0]=fn.opcodeDecode[ins[0]]??ins[0];
  }
  return out;
}
function run(label,p){
  try{
    const out=[];
    executeProgram(restoreOpcode(p),{print:(...a)=>out.push(...a)});
    console.log(label,util.inspect(out));
  }catch(e){console.log(label,'ERROR',e.message)}
}
for(const source of [
`local total=0
for i=1,5 do total=total+i end
print(total)`,
`local total=0
for i=1,5 do if i==3 then continue end total=total+i end
print(total)`
]){
  console.log('\nSOURCE',JSON.stringify(source));
  const native=buildNativeProgram(source,{fallback:false,optimize:true,polymorphic:true});
  run('native',native);

  const reg=registerizeProgram(JSON.parse(JSON.stringify(native)));
  validateRegisterProgram(reg);
  run('reg',reg);

  const fused=JSON.parse(JSON.stringify(reg));
  fuseRegisterComparisons(fused);
  validateRegisterProgram(fused);
  run('reg+fuse',fused);

  const sh=JSON.parse(JSON.stringify(native));
  for(const fn of sh.functions) fn.code=shuffleControlFlow(fn.code);
  const rsh=registerizeProgram(sh);
  validateRegisterProgram(rsh);
  run('shuffle+reg',rsh);

  const frsh=JSON.parse(JSON.stringify(rsh));
  fuseRegisterComparisons(frsh);
  validateRegisterProgram(frsh);
  run('shuffle+reg+fuse',frsh);

  const full=buildEmissionPlan(native,{backend:'register'});
  run('full',full);
}
