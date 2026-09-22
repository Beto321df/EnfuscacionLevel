const util=require('util');
const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan, shuffleControlFlow }=require('../src/zlang/emitter');
const { registerizeProgram, fuseRegisterComparisons, permuteRegisterFile, diversifyRegisterIsa, validateRegisterProgram }=require('../src/zlang/registerVm');
const { executeProgram }=require('../src/zlang/referenceVm');
const source=`local total=0
for i=1,5 do if i==3 then continue end total=total+i end
print(total)`;

function restoreOpcode(p){
  const out=JSON.parse(JSON.stringify(p));
  for(const fn of out.functions){
    if(Array.isArray(fn.opcodeDecode)&&fn.opcodeDecode.length>1)
      for(const ins of fn.code) ins[0]=fn.opcodeDecode[ins[0]]??ins[0];
  }
  return out;
}
function run(label,p){
  try {
    const out=[];
    executeProgram(restoreOpcode(p),{print:(...a)=>out.push(...a)});
    console.log(label,util.inspect(out));
  } catch(e){ console.log(label,'ERROR',e.message); }
}
const native=buildNativeProgram(source,{fallback:false,optimize:true,polymorphic:true});
console.log('NATIVE funcs',native.functions.length);
run('native',native);

const reg=registerizeProgram(JSON.parse(JSON.stringify(native)));
validateRegisterProgram(reg);
run('registerize only',reg);

const fused=JSON.parse(JSON.stringify(reg));
fuseRegisterComparisons(fused);
validateRegisterProgram(fused);
run('registerize+fuse',fused);

const shuffled=JSON.parse(JSON.stringify(native));
for(const fn of shuffled.functions) fn.code=shuffleControlFlow(fn.code);
const regSh=registerizeProgram(shuffled);
validateRegisterProgram(regSh);
run('shuffleCF+registerize',regSh);

const fusedSh=JSON.parse(JSON.stringify(regSh));
fuseRegisterComparisons(fusedSh);
validateRegisterProgram(fusedSh);
run('shuffleCF+registerize+fuse',fusedSh);

const emitted=buildEmissionPlan(native,{backend:'register'});
run('full emitter',emitted);
