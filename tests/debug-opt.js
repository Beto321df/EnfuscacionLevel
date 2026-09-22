const util=require('util');
const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan }=require('../src/zlang/emitter');
const { executeProgram }=require('../src/zlang/referenceVm');

const source=`local total=0
for i=1,5 do if i==3 then continue end total=total+i end
print(total)`;

function restore(p){
  const out=JSON.parse(JSON.stringify(p));
  for(const fn of out.functions){
    if(Array.isArray(fn.opcodeDecode)&&fn.opcodeDecode.length>1){
      for(const ins of fn.code) ins[0]=fn.opcodeDecode[ins[0]]??ins[0];
    }
  }
  return out;
}
function run(label,p){
  const out=[];
  executeProgram(restore(p),{print:(...a)=>out.push(...a)});
  console.log(label,util.inspect(out));
  return out;
}

for(const cfg of [
  ['native-opt-poly-off',{fallback:false,optimize:true,polymorphic:false}],
  ['native-opt-poly-on',{fallback:false,optimize:true,polymorphic:true}],
  ['native-noopt-poly-on',{fallback:false,optimize:false,polymorphic:true}]
]){
  const p=buildNativeProgram(source,cfg[1]);
  console.log('\n'+cfg[0], 'code',JSON.stringify(p.functions[0].code));
  run(cfg[0],p);
}

for(const cfg of [
  ['emit-opt-poly-on',{fallback:false,optimize:true,polymorphic:true}],
  ['emit-noopt-poly-on',{fallback:false,optimize:false,polymorphic:true}],
  ['emit-opt-poly-off',{fallback:false,optimize:true,polymorphic:false}]
]){
  const native=buildNativeProgram(source,cfg[1]);
  const e=buildEmissionPlan(native,{backend:'register'});
  console.log('\n'+cfg[0], 'code',JSON.stringify(e.functions[0].code),'meta',e.metadata.emission);
  run(cfg[0],e);
}
