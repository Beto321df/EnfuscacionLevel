const { REG_OPS } = require('../zlang/registerVm');
const crypto = require('crypto');

function randomInt(min, max) { return crypto.randomInt(min, max + 1); }

function registerVmLines(program, n) {
    const opNames = Object.keys(REG_OPS);
    const route = {};
    const used = new Set();
    for (const name of opNames) {
        let token;
        do token = randomInt(113, 12000); while (used.has(token));
        used.add(token); route[name] = token;
    }
    const dispatchEntries = opNames.map(name => `[${REG_OPS[name]}]=${route[name]}`).join(',');
    const R = k => route[k];

    const bin = `if ${n.d}==1 then ${n.regResult}=${n.left}+${n.right} elseif ${n.d}==2 then ${n.regResult}=${n.left}-${n.right} elseif ${n.d}==3 then ${n.regResult}=${n.left}*${n.right} elseif ${n.d}==4 then ${n.regResult}=${n.left}/${n.right} elseif ${n.d}==5 then ${n.regResult}=${n.left}%${n.right} elseif ${n.d}==6 then ${n.regResult}=${n.left}^${n.right} elseif ${n.d}==7 then ${n.regResult}=${n.left}..${n.right} elseif ${n.d}==8 then ${n.regResult}=${n.left}==${n.right} elseif ${n.d}==9 then ${n.regResult}=${n.left}~=${n.right} elseif ${n.d}==10 then ${n.regResult}=${n.left}<${n.right} elseif ${n.d}==11 then ${n.regResult}=${n.left}>${n.right} elseif ${n.d}==12 then ${n.regResult}=${n.left}<=${n.right} elseif ${n.d}==13 then ${n.regResult}=${n.left}>=${n.right} elseif ${n.d}==14 then ${n.regResult}=math.floor(${n.left}/${n.right}) elseif ${n.d}==15 then ${n.regResult}=${n.bwBand}(${n.left},${n.right}) elseif ${n.d}==16 then ${n.regResult}=${n.bwBor}(${n.left},${n.right}) elseif ${n.d}==17 then ${n.regResult}=${n.bwXor}(${n.left},${n.right}) elseif ${n.d}==18 then ${n.regResult}=${n.bwShl}(${n.left},${n.right}) elseif ${n.d}==19 then ${n.regResult}=${n.bwShr}(${n.left},${n.right}) else error('Z3 register bin') end`;
    const unary = `if ${n.c}==1 then ${n.regResult}=not ${n.registers}[${n.b}] elseif ${n.c}==2 then ${n.regResult}=-${n.registers}[${n.b}] elseif ${n.c}==3 then ${n.regResult}=#${n.registers}[${n.b}] elseif ${n.c}==4 then ${n.regResult}=${n.bwNot}(${n.registers}[${n.b}]) else error('Z3 register unary') end`;

    return [
        `local ${n.globals}=(type(getgenv)=='function' and getgenv()) or _G`,
        `local ${n.truth}=function(${n.v})return ${n.v}~=nil and ${n.v}~=false end`,
        `local ${n.gg}=function(${n.key})return ${n.globals}[${n.key}] end`,
        `local ${n.sg}=function(${n.key},${n.v})${n.globals}[${n.key}]=${n.v} end`,
        `local ${n.bwU}=function(v)v=v%4294967296;if v<0 then v=v+4294967296 end;return v end`,
        `local ${n.bwS}=function(v)v=${n.bwU}(v);if v>=2147483648 then return v-4294967296 end;return v end`,
        `local ${n.bwBand}=function(x,y)x=${n.bwU}(x);y=${n.bwU}(y);local r=0;local bit=1;for i=1,32 do local xb=math.floor(x/bit);local yb=math.floor(y/bit);if xb%2>=1 and yb%2>=1 then r=r+bit end;bit=bit*2 end;return ${n.bwS}(r) end`,
        `local ${n.bwBor}=function(x,y)x=${n.bwU}(x);y=${n.bwU}(y);local r=0;local bit=1;for i=1,32 do local xb=math.floor(x/bit);local yb=math.floor(y/bit);if xb%2>=1 or yb%2>=1 then r=r+bit end;bit=bit*2 end;return ${n.bwS}(r) end`,
        `local ${n.bwXor}=function(x,y)x=${n.bwU}(x);y=${n.bwU}(y);local r=0;local bit=1;for i=1,32 do local xb=math.floor(x/bit);local yb=math.floor(y/bit);if (xb%2>=1)~=(yb%2>=1) then r=r+bit end;bit=bit*2 end;return ${n.bwS}(r) end`,
        `local ${n.bwNot}=function(x)return ${n.bwS}(4294967295-${n.bwU}(x)) end`,
        `local ${n.mul32}=function(x,y)local al=x%65536;local ah=math.floor(x/65536);local bl=y%65536;local bh=math.floor(y/65536);return (al*bl+(al*bh+ah*bl)*65536)%4294967296 end`,
        `local ${n.bwShl},${n.bwShr};${n.bwShl}=function(x,y)local k=math.floor(y);if k<0 then return ${n.bwShr}(x,-k) end;if k>=32 then return 0 end;return ${n.bwS}(${n.bwU}(x)*2^k%4294967296) end;${n.bwShr}=function(x,y)local k=math.floor(y);if k<0 then return ${n.bwShl}(x,-k) end;if k>=32 then return (${n.bwS}(x)<0) and -1 or 0 end;return math.floor(${n.bwS}(x)/(2^k)) end`,
        `local ${n.isMulti}=function(${n.v})return type(${n.v})=='table' and ${n.v}.__z==1 end`,
        `local ${n.multi}=function(${n.v},${n.a})return{__z=1,n=${n.a},v=${n.v}} end`,
        `local ${n.invoke}=function(${n.fn},${n.args})if type(${n.fn})~='function' then error('Z3 call: not callable') end;local ${n.ok},${n.packed}=pcall(function()return table.pack(${n.fn}(table.unpack(${n.args},1,${n.args}.n or #${n.args}))) end);if not ${n.ok} then error(${n.packed}) end;return ${n.multi}(${n.packed},${n.packed}.n) end`,
        `local ${n.execReg}`,
        `local ${n.makeFn}=function(${n.a},${n.parent},${n.upvalues})return function(...)local ${n.args}=table.pack(...);return ${n.execReg}(${n.a},${n.parent},${n.upvalues},${n.args}) end end`,
        `${n.execReg}=function(${n.a},${n.parent},${n.upvalues},${n.args})`,
        `local ${n.def}=${n.functions}[${n.a}+1];if not ${n.def} then error('Z3 function index '..tostring(${n.a})) end`,
        `local ${n.pcDecode}=function(v) return ${n.mul32}((v-${n.def}.${n.pcTargetField})%4294967296,4294901761) end`,
        `local ${n.env}={locals={}};for ${n.idx}=1,${n.def}.localCount do ${n.env}.locals[${n.idx}]={v=nil} end`,
        `local ${n.parentUv}=${n.upvalues};local ${n.upvalues}={}`,
        `for ${n.upvalueIndex}=1,#${n.def}.upvalues do local ${n.upRef}=${n.def}.upvalues[${n.upvalueIndex}];if ${n.upRef}[1]==0 then if not ${n.parent} or not ${n.parent}[${n.upRef}[2]+1] then error('Z3 local upvalue capture') end;${n.upvalues}[${n.upvalueIndex}]=${n.parent}[${n.upRef}[2]+1] else if not ${n.parentUv} or not ${n.parentUv}[${n.upRef}[2]+1] then error('Z3 parent upvalue capture') end;${n.upvalues}[${n.upvalueIndex}]=${n.parentUv}[${n.upRef}[2]+1] end end`,
        `for ${n.idx}=1,#${n.def}.params do local ${n.slot}=${n.def}.params[${n.idx}]+1;${n.env}.locals[${n.slot}]={v=${n.args}[${n.idx}]} end`,
        `local ${n.varargs}={n=0};for ${n.idx}=#${n.def}.params+1,${n.args}.n do ${n.varargs}[${n.idx}-#${n.def}.params]=${n.args}[${n.idx}];${n.varargs}.n=${n.varargs}.n+1 end`,
        `local ${n.registers}={};local ${n.pc}=1;local ${n.loops}={};local ${n.dispatch}={${dispatchEntries}}`,
        `while ${n.pc}<=#${n.def}.code do local ${n.ins}=${n.def}.code[${n.pc}];${n.op}=${n.ins}[1];${n.route}=${n.dispatch}[${n.op}];if ${n.route}==nil then error('Z3 register opcode route') end;${n.a}=${n.ins}[2];${n.b}=${n.ins}[3];${n.c}=${n.ins}[4];${n.d}=${n.ins}[5];${n.pc}=${n.pc}+1`,
        `if ${n.route}==${R('NOP')} or ${n.route}==${R('NOP_ALT')} then`,
        `elseif ${n.route}==${R('LOAD_CONST')} or ${n.route}==${R('LOAD_CONST_ALT')} then ${n.registers}[${n.a}]=${n.constants}[${n.b}+1]`,
        `elseif ${n.route}==${R('LOAD_LOCAL')} or ${n.route}==${R('LOAD_LOCAL_ALT')} then ${n.registers}[${n.a}]=${n.env}.locals[${n.b}+1] and ${n.env}.locals[${n.b}+1].v`,
        `elseif ${n.route}==${R('STORE_LOCAL')} or ${n.route}==${R('STORE_LOCAL_ALT')} then ${n.env}.locals[${n.a}+1]=${n.env}.locals[${n.a}+1] or {v=nil};${n.env}.locals[${n.a}+1].v=${n.registers}[${n.b}]`,
        `elseif ${n.route}==${R('LOAD_GLOBAL')} then ${n.registers}[${n.a}]=${n.gg}(${n.constants}[${n.b}+1])`,
        `elseif ${n.route}==${R('STORE_GLOBAL')} then ${n.sg}(${n.constants}[${n.a}+1],${n.registers}[${n.b}])`,
        `elseif ${n.route}==${R('GET_MEMBER')} then local ${n.obj}=${n.registers}[${n.b}];${n.registers}[${n.a}]=${n.obj} and ${n.obj}[${n.constants}[${n.c}+1]]`,
        `elseif ${n.route}==${R('SET_MEMBER')} then local ${n.obj}=${n.registers}[${n.a}];if not ${n.obj} then error('Z3 member target') end;${n.obj}[${n.constants}[${n.b}+1]]=${n.registers}[${n.c}]`,
        `elseif ${n.route}==${R('GET_INDEX')} then local ${n.obj}=${n.registers}[${n.b}];${n.registers}[${n.a}]=${n.obj} and ${n.obj}[${n.registers}[${n.c}]]`,
        `elseif ${n.route}==${R('SET_INDEX')} then local ${n.obj}=${n.registers}[${n.a}];if not ${n.obj} then error('Z3 index target') end;${n.obj}[${n.registers}[${n.b}]]=${n.registers}[${n.c}]`,
        `elseif ${n.route}==${R('MAKE_FUNCTION')} then ${n.registers}[${n.a}]=${n.makeFn}(${n.b},${n.env}.locals,${n.upvalues})`,
        `elseif ${n.route}==${R('BIN')} or ${n.route}==${R('BIN_ALT')} then ${n.left}=${n.registers}[${n.b}];${n.right}=${n.registers}[${n.c}];${bin};${n.registers}[${n.a}]=${n.regResult}`,
        `elseif ${n.route}==${R('UNARY')} then ${unary};${n.registers}[${n.a}]=${n.regResult}`,
        `elseif ${n.route}==${R('NEW_TABLE')} then ${n.registers}[${n.a}]={}`,
        `elseif ${n.route}==${R('GET_VARARG')} then ${n.registers}[${n.a}]=${n.varargs}[1]`,
        `elseif ${n.route}==${R('GET_VARARG_MULTI')} then ${n.registers}[${n.a}]=${n.multi}(${n.varargs},#${n.varargs})`,
        `elseif ${n.route}==${R('LOAD_UPVALUE')} then local ${n.upRef}=${n.upvalues}[${n.b}+1];if not ${n.upRef} then error('Z3 upvalue load') end;${n.registers}[${n.a}]=${n.upRef}.v`,
        `elseif ${n.route}==${R('STORE_UPVALUE')} then local ${n.upRef}=${n.upvalues}[${n.a}+1];if not ${n.upRef} then error('Z3 upvalue store') end;${n.upRef}.v=${n.registers}[${n.b}]`,
        `elseif ${n.route}==${R('MOVE')} or ${n.route}==${R('MOVE_ALT')} then ${n.registers}[${n.a}]=${n.registers}[${n.b}]`,
        `elseif ${n.route}==${R('CALL')} or ${n.route}==${R('CALL_MULTI')} then local ${n.argsList}={};for ${n.idx}=1,${n.c} do ${n.argsList}[${n.idx}]=${n.registers}[${n.b}+${n.idx}] end;local ${n.fn}=${n.registers}[${n.b}];local ${n.result}=${n.invoke}(${n.fn},${n.argsList});if ${n.route}==${R('CALL_MULTI')} then ${n.registers}[${n.a}]=${n.result} else ${n.registers}[${n.a}]=${n.result}.v[1] end`,
        `elseif ${n.route}==${R('CALL_METHOD')} or ${n.route}==${R('CALL_METHOD_MULTI')} then local ${n.obj}=${n.registers}[${n.b}];local ${n.argsList}={};${n.argsList}[1]=${n.obj};for ${n.idx}=1,${n.d} do ${n.argsList}[${n.idx}+1]=${n.registers}[${n.b}+${n.idx}+1] end;local ${n.fn}=${n.obj}[${n.constants}[${n.c}+1]];local ${n.result}=${n.invoke}(${n.fn},${n.argsList});if ${n.route}==${R('CALL_METHOD_MULTI')} then ${n.registers}[${n.a}]=${n.result} else ${n.registers}[${n.a}]=${n.result}.v[1] end`,
        `elseif ${n.route}==${R('CALL_EXPAND')} then local ${n.argsList}={};for ${n.idx}=1,${n.c} do ${n.argsList}[${n.idx}]=${n.registers}[${n.b}+${n.idx}] end;local ${n.value}=${n.registers}[${n.d}];if ${n.isMulti}(${n.value}) then for ${n.idx}=1,${n.value}.n do ${n.argsList}[${n.c}+${n.idx}]=${n.value}.v[${n.idx}] end else ${n.argsList}[${n.c}+1]=${n.value} end;local ${n.fn}=${n.registers}[${n.b}];${n.argsList}.n=${n.c}+(${n.isMulti}(${n.value}) and ${n.value}.n or 1);local ${n.result}=${n.invoke}(${n.fn},${n.argsList});${n.registers}[${n.a}]=${n.result}.v[1]`,
        `elseif ${n.route}==${R('CALL_METHOD_EXPAND')} then local ${n.prefix}=(${n.d}%65536);local ${n.tailReg}=math.floor(${n.d}/65536);local ${n.obj}=${n.registers}[${n.b}];local ${n.argsList}={${n.obj}};for ${n.idx}=1,${n.prefix} do ${n.argsList}[${n.idx}+1]=${n.registers}[${n.b}+${n.idx}+1] end;local ${n.value}=${n.registers}[${n.tailReg}];if ${n.isMulti}(${n.value}) then for ${n.idx}=1,${n.value}.n do ${n.argsList}[${n.prefix}+${n.idx}+1]=${n.value}.v[${n.idx}] end else ${n.argsList}[${n.prefix}+2]=${n.value} end;local ${n.fn}=${n.obj}[${n.constants}[${n.c}+1]];${n.argsList}.n=${n.c}+(${n.isMulti}(${n.value}) and ${n.value}.n or 1);local ${n.result}=${n.invoke}(${n.fn},${n.argsList});${n.registers}[${n.a}]=${n.result}.v[1]`,
        `elseif ${n.route}==${R('RETURN_VOID')} then return ${n.multi}({},0)`,
        `elseif ${n.route}==${R('RETURN')} or ${n.route}==${R('RETURN_ALT')} then local ${n.value}=${n.registers}[${n.a}];if ${n.isMulti}(${n.value}) then return ${n.value} else return ${n.multi}({${n.value}},1) end`,
        `elseif ${n.route}==${R('RETURN_MULTI')} then local ${n.retValues}={};for ${n.idx}=1,${n.b} do ${n.retValues}[${n.idx}]=${n.registers}[${n.a}+${n.idx}] end;return ${n.multi}(${n.retValues},${n.b})`,
        `elseif ${n.route}==${R('RETURN_MIXED')} then local ${n.retValues}={};for ${n.idx}=1,${n.b} do ${n.retValues}[${n.idx}]=${n.registers}[${n.a}+${n.idx}] end;local ${n.value}=${n.registers}[${n.c}];if ${n.isMulti}(${n.value}) then for ${n.idx}=1,${n.value}.n do ${n.retValues}[${n.b}+${n.idx}]=${n.value}.v[${n.idx}] end else ${n.retValues}[${n.b}+1]=${n.value} end;return ${n.multi}(${n.retValues},${n.b}+(${n.isMulti}(${n.value}) and ${n.value}.n or 1))`,
        `elseif ${n.route}==${R('PACK_MULTI')} then local ${n.retValues}={};for ${n.idx}=1,${n.c} do ${n.retValues}[${n.idx}]=${n.registers}[${n.b}+${n.idx}] end;${n.registers}[${n.a}]=${n.multi}(${n.retValues},${n.c})`,
        `elseif ${n.route}==${R('UNPACK_MULTI')} then local ${n.value}=${n.registers}[${n.b}];local ${n.multiValues}=${n.isMulti}(${n.value}) and ${n.value}.v or {${n.value}};for ${n.idx}=1,${n.c} do ${n.registers}[${n.a}+${n.idx}-1]=${n.multiValues}[${n.idx}] end`,
        `elseif ${n.route}==${R('SETLIST_MULTI')} then local ${n.value}=${n.registers}[${n.b}];local ${n.multiValues}=${n.isMulti}(${n.value}) and ${n.value}.v or {${n.value}};local ${n.obj}=${n.registers}[${n.a}];for ${n.idx}=1,${n.isMulti}(${n.value}) and ${n.value}.n or 1 do ${n.obj}[${n.c}+${n.idx}-1]=${n.multiValues}[${n.idx}] end`,
        `elseif ${n.route}==${R('JUMP')} or ${n.route}==${R('JUMP_ALT')} then ${n.pc}=${n.pcDecode}(${n.a})`,
        `elseif ${n.route}==${R('JUMP_IF_FALSE')} then if not ${n.truth}(${n.registers}[${n.a}]) then ${n.pc}=${n.pcDecode}(${n.b}) end`,
        `elseif ${n.route}==${R('JUMP_IF_TRUE')} then if ${n.truth}(${n.registers}[${n.a}]) then ${n.pc}=${n.pcDecode}(${n.b}) end`,
        `elseif ${n.route}==${R('FOR_NUM_PREP')} then local ${n.frame}={slot=${n.a},current=${n.registers}[${n.b}],finish=${n.registers}[${n.c}],step=${n.registers}[${n.d}]};if ${n.frame}.step==0 then error('Z3 numeric for step zero') end;${n.loops}[#${n.loops}+1]=${n.frame}`,
        `elseif ${n.route}==${R('FOR_NUM_CHECK')} then local ${n.frame}=${n.loops}[#${n.loops}];local ${n.keep}=(${n.frame}.step>0 and ${n.frame}.current<=${n.frame}.finish) or (${n.frame}.step<0 and ${n.frame}.current>=${n.frame}.finish);if not ${n.keep} then ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.pcDecode}(${n.a}) else ${n.env}.locals[${n.frame}.slot+1]=${n.env}.locals[${n.frame}.slot+1] or {v=nil};${n.env}.locals[${n.frame}.slot+1].v=${n.frame}.current end`,
        `elseif ${n.route}==${R('FOR_NUM_NEXT')} then local ${n.frame}=${n.loops}[#${n.loops}];${n.frame}.current=${n.frame}.current+${n.frame}.step;local ${n.keep}=(${n.frame}.step>0 and ${n.frame}.current<=${n.frame}.finish) or (${n.frame}.step<0 and ${n.frame}.current>=${n.frame}.finish);if ${n.keep} then ${n.env}.locals[${n.frame}.slot+1].v=${n.frame}.current else ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.pcDecode}(${n.a}) end`,
        `elseif ${n.route}==${R('ITER_PREP')} then local ${n.packed}=${n.registers}[${n.a}];if type(${n.packed})~='table' or ${n.packed}.__z~=1 or ${n.packed}.n<3 then error('Z3 iterator setup') end;local ${n.iter}=${n.packed}.v[1];local ${n.state}=${n.packed}.v[2];local ${n.control}=${n.packed}.v[3];local ${n.first}=${n.invoke}(${n.iter},{${n.state},${n.control}});local ${n.layout}=${n.def}.iteratorLayouts[${n.c}+1] or {};local ${n.frame}={fn=${n.iter},state=${n.state},control=${n.first}.v[1],layout=${n.layout}};if ${n.frame}.control==nil then ${n.pc}=${n.pcDecode}(${n.d}) else ${n.loops}[#${n.loops}+1]=${n.frame};for ${n.idx}=1,${n.b} do ${n.env}.locals[${n.layout}[${n.idx}]+1]=${n.env}.locals[${n.layout}[${n.idx}]+1] or {v=nil};${n.env}.locals[${n.layout}[${n.idx}]+1].v=${n.first}.v[${n.idx}] end end`,
        `elseif ${n.route}==${R('ITER_NEXT')} then local ${n.frame}=${n.loops}[#${n.loops}];local ${n.next}=${n.invoke}(${n.frame}.fn,{${n.frame}.state,${n.frame}.control});${n.frame}.control=${n.next}.v[1];if ${n.frame}.control==nil then ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.pcDecode}(${n.b}) else for ${n.idx}=1,#${n.frame}.layout do ${n.env}.locals[${n.frame}.layout[${n.idx}]+1].v=${n.next}.v[${n.idx}] end;${n.pc}=${n.pcDecode}(${n.a}) end`,
        `elseif ${n.route}==${R('BREAK')} then ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.pcDecode}(${n.a})`,
        `elseif ${n.route}==${R('FUSED_LOCAL_CONST_BIN_STORE')} then ${n.left}=${n.env}.locals[${n.a}+1] and ${n.env}.locals[${n.a}+1].v;${n.right}=${n.constants}[${n.b}+1];${bin};${n.env}.locals[${n.d}+1]=${n.env}.locals[${n.d}+1] or {v=nil};${n.env}.locals[${n.d}+1].v=${n.regResult}`,
        `elseif ${n.route}==${R('FUSED_LOCAL_LOCAL_BIN_STORE')} then ${n.left}=${n.env}.locals[${n.a}+1] and ${n.env}.locals[${n.a}+1].v;${n.right}=${n.env}.locals[${n.b}+1] and ${n.env}.locals[${n.b}+1].v;${bin};${n.env}.locals[${n.d}+1]=${n.env}.locals[${n.d}+1] or {v=nil};${n.env}.locals[${n.d}+1].v=${n.regResult}`,
        `elseif ${n.route}==${R('FUSED_GLOBAL_CALL')} then local ${n.fn}=${n.gg}(${n.constants}[${n.b}+1]);local ${n.result}=${n.invoke}(${n.fn},{});if ${n.c}==1 then ${n.registers}[${n.a}]=${n.result} else ${n.registers}[${n.a}]=${n.result}.v[1] end`,
        `elseif ${n.route}==${R('FUSED_BIN_JUMP_FALSE')} or ${n.route}==${R('FUSED_BIN_JUMP_FALSE_ALT')} then ${n.left}=${n.registers}[${n.a}];${n.right}=${n.registers}[${n.b}];${bin};if not ${n.truth}(${n.regResult}) then ${n.pc}=${n.pcDecode}(${n.d}) end`,
        `elseif ${n.route}==${R('FUSED_BIN_JUMP_TRUE')} or ${n.route}==${R('FUSED_BIN_JUMP_TRUE_ALT')} then ${n.left}=${n.registers}[${n.a}];${n.right}=${n.registers}[${n.b}];${bin};if ${n.truth}(${n.regResult}) then ${n.pc}=${n.pcDecode}(${n.d}) end`,
        `else error('Z3 register opcode') end end`,
        `return ${n.multi}({nil},1)`,
        `end`,
        `return ${n.execReg}(0,nil,nil,{})`
    ];
}

module.exports = { registerVmLines };
