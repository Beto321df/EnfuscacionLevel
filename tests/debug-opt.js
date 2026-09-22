const util=require('util');
const { buildNativeProgram }=require('../src/zlang/nativeCompiler');
const { buildEmissionPlan }=require('../src/zlang/emitter');
const { executeProgram }=require('../src/zlang/referenceVm');
const source=`local total=0
for i=1,5 do if i==3 then continue end total=total+i end
print(total)`;
const native=buildNativeProgram(source,{fallback:false,polymorphic:false});
console.log('NATIVE');
for(const [i,fn] of native.functions.entries()) console.log(i,JSON.stringify(fn.code), 'locals',fn.localCount);
const emitted=buildEmissionPlan(native,{backend:'register'});
console.log('EMITTED');
for(const [i,fn] of emitted.functions.entries()) console.log(i,JSON.stringify(fn.code), 'rc',fn.registerCount);
const out=[];
executeProgram(emitted,{print:(...a)=>out.push(...a)});
console.log('OUT',util.inspect(out));
