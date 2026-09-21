const fs=require('fs');
const {spawnSync}=require('child_process');
const X71=require('../src/generator/x71Codegen');

const cases=[
  {
    name:'direct-call',
    source:`local function add(a,b,c) return a+b+c end
print(add(1,2,3))`,
    expected:'6'
  },
  {
    name:'closure-call',
    source:`local function outer(x) return function(y) return x+y end end
local f=outer(10)
print(f(2))`,
    expected:'12'
  },
  {
    name:'multi-return-call',
    source:`local function f() return 7,9 end
local a,b=f()
print(a,b)`,
    expected:'7\\t9'
  },
  {
    name:'if-modulo-arithmetic',
    source:`local x=17
if x%2==1 then x=x+5 else x=x-5 end
print(x)`,
    expected:'22'
  },
  {
    name:'numeric-for',
    source:`local total=0
for i=1,5 do total=total+i end
print(total)`,
    expected:'15'
  },
  {
    name:'multi-return-arithmetic',
    source:`local function f(a,b,c) return a*3+b-c,(a+b)%7 end
local x,y=f(4,17,2)
print(x,y)`,
    expected:'27\\t0'
  },
  {
    name:'call-inside-numeric-for',
    source:`local function inc(v,i) return v+i end
local values={4,9,16,23}
local total=0
for i=1,#values do
    total=total+inc(values[i],i)
end
print(total)`,
    expected:'64'
  },
  {
    name:'method-call',
    source:`local service=game:GetService("ReplicatedStorage")
print(service.Name)`,
    prelude:'game={GetService=function(self,name)return{Name=name}end}',
    expected:'ReplicatedStorage'
  },
  {
    name:'method-call-expand',
    source:`local function pair() return "A","B" end
local obj={join=function(self,a,b)return a..b end}
print(obj:join(pair()))`,
    expected:'AB'
  }
]

for(const item of cases){
  const out=new X71().generate(item.source,{preset:'strong'});
  const file='/tmp/nyvex-probe-'+item.name+'.lua';
  fs.writeFileSync(file,(item.prelude?item.prelude+String.fromCharCode(10):'')+out+String.fromCharCode(10),'utf8');
  const run=spawnSync(process.env.LUA_BIN||'lua5.4',[file],{encoding:'utf8'});
  if(run.error) throw run.error;
  if(run.status!==0){
    console.error('PROBE_FAIL',item.name);
    console.error((run.stdout||'')+(run.stderr||''));
    process.exit(1);
  }
  const actual=(run.stdout||'').trim();
  if(actual!==item.expected){
    console.error('PROBE_BAD_OUTPUT',item.name,'expected='+item.expected,'actual='+actual);
    process.exit(1);
  }
  console.log('PROBE_OK',item.name,actual);
}
console.log('X7.1 call probes OK');
