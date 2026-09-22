const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan, shuffleControlFlow }=require('../src/zlang/emitter');
const { registerizeProgram, fuseRegisterComparisons, permuteRegisterFile, diversifyRegisterIsa, validateRegisterProgram }=require('../src/zlang/registerVm');
const { executeProgram }=require('../src/zlang/referenceVm');

function restoreOpcode(p){
  const out=JSON.parse(JSON.stringify(p));
  const map=out.metadata?.emission?.opcodePermutation;
  const inv={};
  if(map) for(const [oldId,newId] of Object.entries(map)) inv[newId]=Number(oldId);
  for(const fn of out.functions){
    for(const ins of fn.code) ins[0]=fn.opcodeDecode?.[ins[0]] ?? inv[ins[0]] ?? ins[0];
  }
  return out;
}
function run(p){
  const out=[];
  executeProgram(restoreOpcode(p),{print:(...a)=>out.push(...a)});
  return out.join(',');
}
const cases=[
  ['numeric','local total=0\nfor i=1,5 do total=total+i end\nprint(total)','15'],
  ['continue','local total=0\nfor i=1,5 do if i==3 then continue end total=total+i end\nprint(total)','12']
];
for(const [name,source,expected] of cases){
  const native=buildNativeProgram(source,{fallback:false,optimize:true,polymorphic:true});
  const counts={};
  for(let i=0;i<50;i++){
    const e=buildEmissionPlan(native,{backend:'register'});
    const v=run(e);
    counts[v]=(counts[v]||0)+1;
  }
  console.log(name,counts,'expected',expected);
}
