const crypto=require('crypto');
const {REG_OPS,REG_ALIAS_BASE,validateRegisterProgram}=require('../zlang/registerVm');
const {verifyProgram}=require('../zlang/verifier');
const {buildNativeProgram}=require('../zlang/nativeCompiler');
const {buildEmissionPlan}=require('../zlang/emitter');
const {resolvePreset}=require('../zlang/presets');

const OP_NAME=Object.fromEntries(Object.entries(REG_OPS).map(([k,v])=>[v,k]));
const OP_COUNT=Object.keys(REG_OPS).length;
if(OP_COUNT!==56)throw new Error('X7: la ISA register cambió; actualiza el runtime X7.');
const PC_INV=4294901761;
const MAGIC=[88,55,7];

function rand(min,max){return crypto.randomInt(min,max+1)}
function shuffle(a){for(let i=a.length-1;i>0;i-=1){const j=rand(0,i);[a[i],a[j]]=[a[j],a[i]]}return a}
function u16(out,v){if(!Number.isInteger(v)||v<0||v>65535)throw new Error('X7 u16 fuera de rango.');out.push((v>>>8)&255,v&255)}
function u32(out,v){v=Number(v);if(!Number.isFinite(v)||v<0||v>0xFFFFFFFF)throw new Error('X7 u32 fuera de rango.');out.push(Math.floor(v/16777216)%256,Math.floor(v/65536)%256,Math.floor(v/256)%256,v%256)}
function mul32(a,b){const al=a%65536,ah=Math.floor(a/65536),bl=b%65536,bh=Math.floor(b/65536);return (al*bl+(al*bh+ah*bl)*65536)%4294967296}
function decodeTarget(fn,v){if(!fn.pcTargetEncoded)return v>>>0;return mul32(((v>>>0)-(fn.pcTargetAdd>>>0))>>>0,PC_INV)>>>0}
function baseOp(id){
    const name=OP_NAME[id];
    return name&&REG_ALIAS_BASE[name]?REG_OPS[REG_ALIAS_BASE[name]]:id;
}
function semanticOp(fn,id){
    const decoded=Array.isArray(fn.opcodeDecode)?(fn.opcodeDecode[id]||id):id;
    return baseOp(decoded);
}
function targetFields(op){
    switch(op){
        case REG_OPS.JUMP:
        case REG_OPS.BREAK:return [1];
        case REG_OPS.JUMP_IF_FALSE:
        case REG_OPS.JUMP_IF_TRUE:return [2];
        case REG_OPS.FOR_NUM_CHECK:
        case REG_OPS.FOR_NUM_NEXT:return [1];
        case REG_OPS.ITER_PREP:return [4];
        case REG_OPS.ITER_NEXT:return [1,2];
        case REG_OPS.FUSED_BIN_JUMP_FALSE:
        case REG_OPS.FUSED_BIN_JUMP_TRUE:return [4];
        default:return [];
    }
}
function normalizeProgram(program){
    // buildEmissionPlan stores per-function shuffled opcode IDs and encoded
    // control-flow targets. Validate only after restoring the semantic view.
    // Validating the packed form with validateRegisterProgram() would interpret
    // random opcode IDs using the wrong REGISTER_FIELDS table and can mistake an
    // encoded PC (for example 0x9e505080) for a register.
    const canonicalFunctions=(program.functions||[]).map(fn=>{
        const code=(fn.code||[]).map(raw=>{
            const ins=Array.from(raw);
            const op=semanticOp(fn,ins[0]);
            if(!Number.isInteger(op)||op<1||op>OP_COUNT)throw new Error(`X7: opcode inválido ${op}.`);
            for(const field of targetFields(op))ins[field]=decodeTarget(fn,ins[field]);
            ins[0]=op;
            return ins;
        });
        return {...fn,code};
    });
    // buildEmissionPlan already validated the semantic register program before
    // control-target packing. Do not run the generic ZRVM validator again here:
    // the container intentionally contains encoded PCs at this stage.
    const ids=shuffle(Array.from({length:OP_COUNT},(_,i)=>i+1));
    const physical=Array(OP_COUNT+1);
    ids.forEach((semantic,index)=>{physical[semantic]=index+1});
    const q=Array(OP_COUNT+1);
    for(let i=1;i<=OP_COUNT;i+=1)q[i]=ids[i-1];
    const constants=(program.constants||[]).map(c=>({type:Number(c.type),value:c.value}));
    if(constants.length>65535)throw new Error('X7: demasiadas constantes.');
    const functions=canonicalFunctions.map(fn=>{
        if((fn.localCount||0)>65535||(fn.registerCount||0)>65535||(fn.params||[]).length>65535||(fn.upvalues||[]).length>65535||(fn.iteratorLayouts||[]).length>65535)throw new Error('X7: metadata de función fuera de rango.');
        if((fn.code||[]).length>65535)throw new Error('X7: demasiadas instrucciones en una función.');
        const code=(fn.code||[]).map(raw=>{
            const ins=Array.from(raw);
            const op=ins[0];
            if(!Number.isInteger(op)||op<1||op>OP_COUNT)throw new Error(`X7: opcode inválido ${op}.`);
            ins[0]=physical[op];
            return ins;
        });
        return {
            params:Array.isArray(fn.params)?fn.params.map(Number):[],
            vararg:!!fn.vararg,
            localCount:Number(fn.localCount)||0,
            registerCount:Number(fn.registerCount)||0,
            upvalues:Array.isArray(fn.upvalues)?fn.upvalues.map(x=>({kind:x.kind==='local'?0:1,index:Number(x.index)||0})):[],
            iteratorLayouts:Array.isArray(fn.iteratorLayouts)?fn.iteratorLayouts.map(x=>Array.isArray(x)?x.map(Number):[]):[],
            code
        };
    });
    for(const fn of functions){
        for(const p of fn.params)if(!Number.isInteger(p)||p<0||p>65535)throw new Error('X7: parámetro fuera de rango.');
        for(const u of fn.upvalues)if(!Number.isInteger(u.index)||u.index<0||u.index>65535)throw new Error('X7: upvalue fuera de rango.');
        for(const it of fn.iteratorLayouts){
            if(it.length>65535)throw new Error('X7: iterator layout fuera de rango.');
            for(const slot of it)if(!Number.isInteger(slot)||slot<0||slot>65535)throw new Error('X7: iterator slot fuera de rango.');
        }
    }
    if(functions.length>65535)throw new Error('X7: demasiadas funciones.');
    const root=Number.isInteger(program.root)?program.root:0;
    if(root<0||root>=functions.length)throw new Error('X7: root inválido.');
    const out=[...MAGIC,rand(0,255),rand(1,255),0,0];
    out.push(...q.slice(1));
    u16(out,constants.length);
    for(const c of constants){
        const type=c.type;
        if(type<1||type>4)throw new Error(`X7: constante tipo ${type}.`);
        let data;
        if(type===1||type===2)data=Buffer.from(String(c.value),'utf8');
        else if(type===3)data=Buffer.from([Number(c.value)?1:0]);
        else data=Buffer.from([0]);
        out.push(type);
        u32(out,data.length);
        out.push(...data);
    }
    u16(out,functions.length);
    u16(out,root);
    for(const fn of functions){
        u16(out,fn.params.length);
        out.push(fn.vararg?1:0);
        u16(out,fn.localCount);
        u16(out,fn.registerCount);
        u16(out,fn.upvalues.length);
        for(const u of fn.upvalues){out.push(u.kind);u16(out,u.index)}
        u16(out,fn.iteratorLayouts.length);
        for(const it of fn.iteratorLayouts){u16(out,it.length);for(const slot of it)u16(out,slot)}
        u16(out,fn.code.length);
        for(const ins of fn.code){out.push(ins[0]);u32(out,ins[1]);u32(out,ins[2]);u32(out,ins[3]);u32(out,ins[4])}
    }
    let seal=0;
    for(let i=7;i<out.length;i+=1)seal=(seal+out[i]*(i-6))%65521;
    out[5]=Math.floor(seal/256);out[6]=seal%256;
    return {bytes:out,root,seed:out[3],step:out[4],q,functions,constants};
}
function alphabets(){
    return [shuffle(Array.from('abcdefghijklmnop')).join(''),shuffle(Array.from('qrstuvwxyzABCDEF')).join('')];
}
function encodePayload(bytes,seed,step,h,l){
    let s='';
    for(let i=0;i<bytes.length;i+=1){
        const v=(bytes[i]+seed+(i*step))%256;
        s+=h[Math.floor(v/16)]+l[v%16];
    }
    return s;
}
function luaQuote(s){return `'${s.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}'`}
function x7Loader(program){
    const normalized=normalizeProgram(program);
    const [h,l]=alphabets();
    const payload=encodePayload(normalized.bytes,normalized.seed,normalized.step,h,l);
    const body=[
`p=${luaQuote(payload)}`,
`h=${luaQuote(h)}`,
`l=${luaQuote(l)}`,
`k=${normalized.seed}`,
`s=${normalized.step}`,
`D=function(t)local s=t.p;local o={};local n=#s;if n%2~=0 then error('X7 payload')end;for i=1,n,2 do local a=string.find(t.h,string.sub(s,i,i),1,true);local b=string.find(t.l,string.sub(s,i+1,i+1),1,true);if not a or not b then error('X7 glyph')end;local j=(i-1)/2;local v=(a-1)*16+b-1-t.k-j*t.s;o[#o+1]=string.char(v%256)end;local r=table.concat(o);if #r<7 or string.byte(r,1)~=88 or string.byte(r,2)~=55 or string.byte(r,3)~=7 then error('X7 header')end;local w=string.byte(r,6)*256+string.byte(r,7);local q=0;for i=8,#r do q=(q+string.byte(r,i)*(i-7))%65521 end;if q~=w then error('X7 seal')end;local p=8;local function u()local v=string.byte(r,p);if not v then error('X7 eof')end;p=p+1;return v end;local function U()local a,b=u(),u();return a*256+b end;local function V()local a,b,c,d=u(),u(),u(),u();return a*16777216+b*65536+c*256+d end;local q={};for i=1,56 do q[i]=u()end;local c={};local nc=U();for i=1,nc do local z=u();local n=V();local v=string.sub(r,p,p+n-1);p=p+n;if z==1 then c[i]=v elseif z==2 then c[i]=tonumber(v) elseif z==3 then c[i]=string.byte(v,1)==1 elseif z==4 then c[i]=nil else error('X7 const')end end;local nf=U();local root=U();local f={};for i=1,nf do local x={p={},u={},i={},c={}};local np=U();for j=1,np do x.p[j]=U() end;x.v=u()==1;x.l=U();x.r=U();local nu=U();for j=1,nu do x.u[j]={u(),U()} end;local ni=U();for j=1,ni do local it={};local n=U();for k=1,n do it[k]=U() end;x.i[j]=it end;local nc2=U();for j=1,nc2 do x.c[j]={u(),V(),V(),V(),V()} end;f[i]=x end;return{q=q,k=c,f=f,r=root}end`,
`O=function(t,P,id,pl,pu,a)local M=function(v,n)return{z=1,n=n,v=v}end;local I=function(v)return type(v)=='table'and v.z==1 end;local G=(type(getgenv)=='function'and getgenv())or _G;local U=function(x)x=x%4294967296;if x<0 then x=x+4294967296 end;return x end;local S=function(x)x=U(x);if x>=2147483648 then return x-4294967296 end;return x end;local B=function(x,y,m)x=U(x);y=U(y);local r=0;local b=1;for i=1,32 do local a=x%2>=1;local c=y%2>=1;if(m==1 and a and c)or(m==2 and(a or c))or(m==3 and(a~=c))then r=r+b end;x=math.floor(x/2);y=math.floor(y/2);b=b*2 end;return S(r)end;local H=function(x,y,m)local n=math.floor(y);if n<0 then n=-n;m=m==1 and 2 or 1 end;if n>=32 then if m==1 then return 0 end;return S(x)<0 and -1 or 0 end;local u=U(x);if m==1 then return S(u*2^n%4294967296)end;return math.floor(S(x)/2^n)end;local function N(o,x,y)if o==1 then return x+y elseif o==2 then return x-y elseif o==3 then return x*y elseif o==4 then return x/y elseif o==5 then return x%y elseif o==6 then return x^y elseif o==7 then return x..y elseif o==8 then return x==y elseif o==9 then return x~=y elseif o==10 then return x<y elseif o==11 then return x>y elseif o==12 then return x<=y elseif o==13 then return x>=y elseif o==14 then return math.floor(x/y) elseif o==15 then return B(x,y,1) elseif o==16 then return B(x,y,2) elseif o==17 then return B(x,y,3) elseif o==18 then return H(x,y,1) elseif o==19 then return H(x,y,2) end;error('X7 bin')end;local function A(o,x)if o==1 then return not x elseif o==2 then return -x elseif o==3 then return#x elseif o==4 then return S(4294967295-U(x)) end;error('X7 unary')end;local function V(fn,a)if type(fn)~='function'then error('X7 call')end;local ok,r=pcall(function()return table.pack(fn(table.unpack(a,1,a.n or#a)))end);if not ok then error(r)end;if r.n==1 and I(r[1])then return r[1]end;return M(r,r.n)end;local X;local F=function(i,l,u)return function(...)return X(t,P,i,l,u,table.pack(...))end end;X=function(t,P,id,pl,pu,a)local fn=P.f[id+1];if not fn then error('X7 fn')end;local lc={};for i=1,fn.l do lc[i]={v=nil}end;local uv={};for i=1,#fn.u do local q=fn.u[i];local z=q[1]==0 and pl and pl[q[2]+1]or pu and pu[q[2]+1];if not z then error('X7 upvalue')end;uv[i]=z end;for i=1,#fn.p do local q=fn.p[i]+1;if q>0 and q<=#lc then lc[q].v=a[i]end end;local va={n=0};if fn.v then for i=#fn.p+1,a.n do va.n=va.n+1;va[va.n]=a[i]end end;local r={};local pc=1;local lp={};local steps=0;while pc<=#fn.c do steps=steps+1;if steps>5000000 then error('X7 step')end;local e=fn.c[pc];pc=pc+1;local o=P.q[e[1]];if not o then error('X7 opcode')end;local a1,b,c,d=e[2],e[3],e[4],e[5];if o==1 then elseif o==2 or o==41 then r[a1]=P.k[b+1] elseif o==3 or o==42 then local q=lc[b+1];r[a1]=q and q.v elseif o==4 or o==43 then lc[a1+1]=lc[a1+1]or{v=nil};lc[a1+1].v=r[b] elseif o==5 then r[a1]=G[P.k[b+1]] elseif o==6 then G[P.k[a1+1]]=r[b] elseif o==7 then local q=r[b];r[a1]=q and q[P.k[c+1]] elseif o==8 then local q=r[a1];if not q then error('X7 member')end;q[P.k[b+1]]=r[c] elseif o==9 then local q=r[b];r[a1]=q and q[r[c]] elseif o==10 then local q=r[a1];if not q then error('X7 index')end;q[r[b]]=r[c] elseif o==11 then r[a1]=F(b,lc,uv) elseif o==12 or o==45 then r[a1]=N(d,r[b],r[c]) elseif o==13 then r[a1]=A(c,r[b]) elseif o==14 then r[a1]={} elseif o==15 then r[a1]=va[1] elseif o==54 then r[a1]=M(va,va.n) elseif o==16 or o==44 then r[a1]=r[b] elseif o==17 or o==18 then local q={};for i=1,c do q[i]=r[b+i]end;local v=V(r[b],q);r[a1]=o==18 and v or v.v[1] elseif o==19 or o==20 then local q=r[b];local w={q};for i=1,d do w[i+1]=r[b+i+1]end;local v=V(q[P.k[c+1]],w);r[a1]=o==20 and v or v.v[1] elseif o==55 then local q={};for i=1,c do q[i]=r[b+i]end;local w=r[d];if I(w)then for i=1,w.n do q[c+i]=w.v[i]end else q[c+1]=w end;q.n=c+(I(w)and w.n or 1);r[a1]=V(r[b],q).v[1] elseif o==56 then local n=d%65536;local q=math.floor(d/65536)%65536;local w=r[b];local v={w};for i=1,n do v[i+1]=r[b+i+1]end;local x=r[q];if I(x)then for i=1,x.n do v[n+i+1]=x.v[i]end else v[n+2]=x end;v.n=n+(I(x)and x.n or 1)+1;local y=V(w[P.k[c+1]],v);r[a1]=y.v[1] elseif o==50 then return M({},0) elseif o==21 or o==47 then local v=r[a1];return I(v)and v or M({v},1) elseif o==22 then local v={};for i=1,b do v[i]=r[a1+i-1]end;return M(v,b) elseif o==23 then local v={};for i=1,c do v[i]=r[b+i-1]end;r[a1]=M(v,c) elseif o==51 then local v=r[b];local w=I(v)and v.v or{v};for i=1,c do r[a1+i-1]=w[i]end elseif o==52 then local v={};for i=1,b do v[i]=r[a1+i-1]end;local w=r[c];if I(w)then for i=1,w.n do v[b+i]=w.v[i]end else v[b+1]=w end;return M(v,b+(I(w)and w.n or 1)) elseif o==53 then local v=r[a1];local w=r[b];local q=I(w)and w.v or{w};for i=1,#q do v[c+i-1]=q[i]end elseif o==24 or o==46 then pc=e[2] elseif o==25 then if not r[a1]then pc=b end elseif o==26 then if r[a1]then pc=b end elseif o==27 then local q={s=a1,c=r[b],f=r[c],t=r[d]};if q.t==0 then error('X7 for')end;lp[#lp+1]=q elseif o==28 then local q=lp[#lp];local keep=q.t>0 and q.c<=q.f or q.t<0 and q.c>=q.f;if not keep then lp[#lp]=nil;pc=a1 else lc[q.s+1]=lc[q.s+1]or{v=nil};lc[q.s+1].v=q.c end elseif o==29 then local q=lp[#lp];q.c=q.c+q.t;local keep=q.t>0 and q.c<=q.f or q.t<0 and q.c>=q.f;if keep then lc[q.s+1].v=q.c else lp[#lp]=nil;pc=a1 end elseif o==30 then local q=r[a1];if not I(q)or q.n<3 then error('X7 iter')end;local w=q.v[1];local z=q.v[2];local y=q.v[3];local v=V(w,{z,y});local n=fn.i[c+1]or{};local x={fn=w,st=z,co=v.v[1],sl=n};if x.co==nil then pc=d else lp[#lp+1]=x;for i=1,b do lc[n[i]+1]=lc[n[i]+1]or{v=nil};lc[n[i]+1].v=v.v[i]end end elseif o==31 then local q=lp[#lp];local w=V(q.fn,{q.st,q.co});q.co=w.v[1];if q.co==nil then lp[#lp]=nil;pc=b else for i=1,#q.sl do lc[q.sl[i]+1].v=w.v[i]end;pc=a1 end elseif o==32 then lp[#lp]=nil;pc=a1 elseif o==33 then lc[d+1]=lc[d+1]or{v=nil};lc[d+1].v=N(c,lc[a1]and lc[a1].v,P.k[b+1]) elseif o==34 then lc[d+1]=lc[d+1]or{v=nil};lc[d+1].v=N(c,lc[a1]and lc[a1].v,lc[b]and lc[b].v) elseif o==35 then local v=V(G[P.k[b+1]],{});r[a1]=c==1 and v or v.v[1] elseif o==38 or o==48 then if not N(c,r[a1],r[b])then pc=d end elseif o==39 or o==49 then if N(c,r[a1],r[b])then pc=d end else error('X7 opcode')end end;return M({nil},1)end;return X(t,P,id,pl,pu,a)end`,
`R=function(t,...)local P=t:D();local v=t:O(P,P.r,nil,nil,table.pack(...));return v.v[1]end`
    ];
    return "return setmetatable({" + body.join(",") + "},{}):R(...)"
}
class X7CodeGenerator{
    generate(source,options={}){
        if(typeof source!=='string'||!source.trim())throw new Error('El código Lua/Luau está vacío.');
        const preset=resolvePreset(options.preset);
        const native=buildNativeProgram(source,{polymorphOptions:preset.polymorph});
        native.metadata={...(native.metadata||{}),strengthPreset:preset.name};
        const program=buildEmissionPlan(native,{
            backend:options.backend===undefined?preset.backend:options.backend,
            diversify:options.diversify||preset.diversify,
            registers:options.registers||preset.registers,
            isa:options.isa||preset.isa
        });
        // buildEmissionPlan is the owner of semantic validation. Its final
        // register program intentionally contains packed control targets and
        // shuffled physical opcodes, so validating it again here with the
        // canonical ZRVM validator causes encoded PCs to be mistaken for
        // registers on non-trivial control flow.
        return x7Loader(program);
    }
}
module.exports=X7CodeGenerator;
