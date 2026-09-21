const fs=require('fs');
const {spawnSync}=require('child_process');
const X72=require('../src/generator/x72Codegen');

const source=`local service=game:GetService("ReplicatedStorage")
local nested={}
nested.Value=service.Name
local function calc(a,b)
    local x=a*3+b
    if x>20 then
        return x-5
    end
    return x+5
end
local result=calc(7,4)
print(nested.Value,result)`;

const out=new X72().generate(source,{preset:'strong'});
if(!out.startsWith('return ({p=')) throw new Error('X7.2 runtime shell missing');
if(out.includes('\n')) throw new Error('X7.2 runtime must be one line');

const path='/tmp/x72-method.lua';
// Deliberately shadow game inside getgenv(). The X7.2 resolver must prefer the
// actual execution environment/global game over this executor-side value.
const shim=`local realGame={GetService=function(self,name)return{Name=name}end}
game=realGame
getrenv=function()return{game=realGame}end
getgenv=function()return{game=function()error("shadow game used")end}end
`;
fs.writeFileSync(path,shim+out,'utf8');

const lua=spawnSync(process.env.LUA_BIN||'lua5.4',[path],{encoding:'utf8'});
if(lua.error) throw lua.error;
if(lua.status!==0){
    process.stderr.write(lua.stderr||'');
    throw new Error('X7.2 runtime failed: '+(lua.stderr||'').trim());
}
const stdout=(lua.stdout||'').trim();
if(!stdout.includes('ReplicatedStorage')||!stdout.includes('25')) {
    throw new Error('X7.2 runtime unexpected output: '+stdout);
}

// Large-source generation regression: ~1000 lines of repeated GUI-like code.
const longSource=Array.from({length:1000},(_,i)=>`local cfg${i}={id=${i},enabled=${i%2===0},name="item-${i}"}
cfg${i}.value=(${i}*3+${i%7})%101
if cfg${i}.enabled then cfg${i}.tag=cfg${i}.name else cfg${i}.tag="off" end`).join('\n');
const longOut=new X72().generate(longSource,{preset:'strong'});
if(!longOut.startsWith('return ({p=' )||longOut.includes('\n')) throw new Error('X7.2 large runtime generation failed');

console.log(JSON.stringify({
    size:out.length,
    oneLine:true,
    nativeGameResolver:true,
    runtimeExecuted:true,
    stdout
}));