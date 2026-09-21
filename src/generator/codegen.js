const crypto = require('crypto');
let luaparse = null;
function getLuaParse() {
    if (!luaparse) luaparse = require('luaparse');
    return luaparse;
}
const { OPS: BASE_OPS } = require('../zlang/compiler3');
const { buildNativeProgram } = require('../zlang/nativeCompiler');
const { encodeProgram } = require('../zlang/format3');
const { encodeVisualPayload, ALPHABET } = require('../zlang/codec');
const { buildEmissionPlan } = require('../zlang/emitter');
const { resolvePreset } = require('../zlang/presets');
const { registerVmLines } = require('./registerVmCodegen');
const { registerVmDecoderLines } = require('./registerVmDecoder');
const { parse: nativeParse } = require('../zlang/parser');

class CodeGenerator {
    randomInt(min, max) { return crypto.randomInt(min, max + 1); }
    randomName(used) {
        const first = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const rest = first + '0123456789';
        for (;;) {
            let out = first[this.randomInt(0, first.length - 1)];
            const length = this.randomInt(6, 10);
            for (let i = 1; i < length; i += 1) out += rest[this.randomInt(0, rest.length - 1)];
            if (!used.has(out)) { used.add(out); return out; }
        }
    }
    names() {
        const used = new Set();
        const fields = ['alphabet','map','payload','stream','glyphs','part','buf','program','pos','u16','u32','read','readValue','constants','functions','ctype','size','fn','params','idx','globals','truth','getv','setv','gg','sg','multi','invoke','packed','ok','exec','makeFn','stack','sp','env','varargs','loops','push','pop','ins','op','a','b','c','d','v','key','obj','args','callArgs','result','left','right','frame','iter','keys','start','finish','step','current','keep','code','def','ret','state','control','first','next','parent','cp','symbol','digit','mixed','byteIndex','line','pending','value','header','hindex','bodyStart','expected','actual','seed','salt','localCount','upvalueCount','upvalueIndex','upvalueKind','iteratorCount','iteratorIndex','layoutLen','layout','locals','upvalues','upRef','slot','parentUv','add','mul','inv','i','bi','strSeed','strStep','strOut','strByte','j','handlers','ctx','handler','ret','fnKey','fnSalt','constSeed','constStep','constMul','constInv','operandSeed','operandStep','operandSalt','operandMul','operandInv','operandFunction','opcodeSeed','opcodeStep','opcodeMul','opcodeInv','expectedSeal','sealA','sealB','decodedOp','paramIndex','rawConstants','functionIndex','dispatch','route','bwU','bwS','bwBand','bwBor','bwXor','bwNot','bwShl','bwShr','mul32','backend','registerCount','pcTargetAdd','pcTargetField','raw','bytes','out','text','decoded','codeCount','iteratorField','registers','pcDecode','execReg','regResult','argsList','retValues','isMulti','multiValues','count','multiCount','pc','byte','opcodeDecodeCount','opcodeDecode','opcodeDecodeIndex','decodedPhysicalOp','prefix','tailReg','operandPermutation','operandLayouts','layoutCount','layoutId'];
        const out = {};
        for (const field of fields) out[field] = this.randomName(used);
        return out;
    }
    lintGenerated(output) {
        try {
            getLuaParse().parse(output, { wait: false, comments: false, luaVersion: '5.1' });
            return;
        } catch (error) {
            if (!(error && error.code === 'MODULE_NOT_FOUND' && /luaparse/.test(error.message || ''))) {
                throw new Error(`Z generó un loader inválido: ${error.message}`);
            }
        }

        // The container image used for development may not ship npm dependencies.
        // Do not feed the large generated VM to the intentionally smaller native
        // parser: adversarially deep generated expressions can make a grammar-only
        // parser consume unbounded memory. Instead, run a linear structural scan
        // here. Full syntax validation is still performed by luaparse when present.
        const stack = [];
        let quote = null;
        let escaped = false;
        let longLevel = null;
        const blocks = [];
        const tokens = [];
        for (let i = 0; i < output.length;) {
            const ch = output[i];
            if (longLevel !== null) {
                const close = ']' + '='.repeat(longLevel) + ']';
                const end = output.indexOf(close, i);
                if (end < 0) throw new Error('Z generó un loader inválido: cadena larga sin cerrar.');
                i = end + close.length;
                longLevel = null;
                continue;
            }
            if (quote) {
                if (escaped) { escaped = false; i += 1; continue; }
                if (ch === '\\') { escaped = true; i += 1; continue; }
                if (ch === quote) quote = null;
                i += 1;
                continue;
            }
            if (ch === '-' && output[i + 1] === '-') {
                const eol = output.indexOf('\n', i + 2);
                i = eol < 0 ? output.length : eol + 1;
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; i += 1; continue; }
            if (ch === '[') {
                let j = i + 1;
                let eq = 0;
                while (output[j] === '=') { eq += 1; j += 1; }
                if (output[j] === '[') { longLevel = eq; i = j + 1; continue; }
            }
            if ('([{'.includes(ch)) stack.push(ch);
            else if (')]}'.includes(ch)) {
                const expected = ch === ')' ? '(' : ch === ']' ? '[' : '{';
                const got = stack.pop();
                if (got !== expected) throw new Error(`Z generó un loader inválido: delimitador ${ch} desbalanceado.`);
            }
            if (/[A-Za-z_]/.test(ch)) {
                let j = i + 1;
                while (j < output.length && /[A-Za-z0-9_]/.test(output[j])) j += 1;
                tokens.push(output.slice(i, j));
                i = j;
                continue;
            }
            i += 1;
        }
        if (quote || longLevel !== null || stack.length) throw new Error('Z generó un loader inválido: estructura sin cerrar.');
        for (const token of tokens) {
            if (token === 'function' || token === 'if' || token === 'for' || token === 'while' || token === 'repeat') blocks.push(token);
            else if (token === 'until') {
                const top = blocks.pop();
                if (top !== 'repeat') throw new Error('Z generó un loader inválido: until fuera de repeat.');
            } else if (token === 'end') {
                const top = blocks.pop();
                if (!top || top === 'repeat') throw new Error('Z generó un loader inválido: end desbalanceado.');
            }
        }
        if (blocks.length) throw new Error('Z generó un loader inválido: bloques sin cerrar.');
        if (/\bundefined\b/.test(output)) throw new Error('Z generó un loader inválido: identificador undefined.');
    }
    decodeLines(lines, n) {
        const luaQuote = value => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        const alphabet = Array.from(ALPHABET).map(luaQuote).join(',');
        const visual = lines.map(luaQuote).join(',');
        return [
            `local ${n.alphabet}={${alphabet}}`,
            `local ${n.map}={}`,
            `for ${n.idx},${n.symbol} in ipairs(${n.alphabet}) do ${n.map}[${n.symbol}]=${n.idx}-1 end`,
            `local ${n.payload}={${visual}}`,
            `local ${n.stream}=table.concat(${n.payload})`,
            `local ${n.glyphs}={}`,
            `for _,${n.cp} in utf8.codes(${n.stream}) do ${n.glyphs}[#${n.glyphs}+1]=utf8.char(${n.cp}) end`,
            `local ${n.read}=function(${n.i},${n.bi},${n.seed},${n.salt},${n.step},${n.add},${n.mul},${n.inv})local ${n.a}=${n.map}[${n.glyphs}[${n.i}]]local ${n.b}=${n.map}[${n.glyphs}[${n.i}+1]]if ${n.a}==nil or ${n.b}==nil then error(\\\"Z3 glyph\\\") end;local ${n.mixed}=${n.a}*40+${n.b};if ${n.mixed}>255 then error(\\\"Z3 glyph pair\\\") end;local ${n.state}=(${n.seed}+${n.bi}*${n.step}+(${n.bi}+1)*(${n.bi}+${n.salt}))%256;return (((${n.mixed}-${n.add}-${n.state})%256)*${n.inv})%256 end`,
            `if #${n.glyphs}<34 then error(\\\"Z3 visual payload corto\\\") end`,
            `local ${n.header}={}`,
            `for ${n.hindex}=1,34,2 do ${n.header}[(${n.hindex}+1)/2]=${n.read}(${n.hindex},(${n.hindex}-1)/2,0,1,1,0,1,1) end`,
            `if ${n.header}[1]~=90 or ${n.header}[2]~=86 or ${n.header}[3]~=1 then error(\\\"Z3 visual header\\\") end`,
            `local ${n.seed}=${n.header}[4]`,
            `local ${n.salt}=${n.header}[5]`,
            `local ${n.step}=${n.header}[6]`,
            `local ${n.add}=${n.header}[7]`,
            `local ${n.mul}=${n.header}[8]`,
            `local ${n.inv}=${n.header}[9]`,
            `local ${n.size}=${n.header}[10]*16777216+${n.header}[11]*65536+${n.header}[12]*256+${n.header}[13]`,
            `local ${n.expected}=${n.header}[14]*16777216+${n.header}[15]*65536+${n.header}[16]*256+${n.header}[17]`,
            `if (#${n.glyphs}-34)%2~=0 then error(\\\"Z3 visual payload impar\\\") end`,
            `local ${n.buf}={}`,
            `for ${n.i}=35,#${n.glyphs},2 do ${n.buf}[#${n.buf}+1]=string.char(${n.read}(${n.i},(${n.i}-35)/2,${n.seed},${n.salt},${n.step},${n.add},${n.mul},${n.inv})) end`,
            `local ${n.program}=table.concat(${n.buf})`,
            `if #${n.buf}~=${n.size} then error(\\\"Z3 visual length\\\") end`,
            `local ${n.a}=61`,
            `local ${n.b}=167`,
            `for ${n.idx}=1,#${n.buf} do local ${n.value}=string.byte(${n.buf}[${n.idx}]);${n.a}=(${n.a}+${n.value}+${n.idx}-1)%256;${n.b}=(${n.b}+${n.value}+${n.a}+(${n.idx}-1)*13)%256 end`,
            `local ${n.actual}=(${n.a}*256+${n.b})`,
            `if ${n.actual}~=${n.expected} then error(\\\"Z3 visual checksum\\\") end`
        ];
    }
    vmLines(program, n, options = {}) {
        if (program.backend === 'register' || (program.metadata && program.metadata.emission && program.metadata.emission.backend === 'register')) {
            return [...registerVmDecoderLines(program, n), ...registerVmLines(program, n)];
        }
        const baseOps = BASE_OPS;
        const opcodeMap = options.opcodeMap || (program.metadata && program.metadata.emission && program.metadata.emission.opcodePermutation);
        const OPS = opcodeMap ? Object.fromEntries(Object.entries(baseOps).map(([name, id]) => [name, opcodeMap[id] || id])) : baseOps;
        const routeTokens = {};
        const routeUsed = new Set();
        for (const name of Object.keys(OPS)) {
            let token;
            do token = this.randomInt(97, 10000); while (routeUsed.has(token));
            routeUsed.add(token);
            routeTokens[name] = token;
        }
        const dispatchEntries = Object.keys(OPS).map(name => `[${OPS[name]}]=${routeTokens[name]}`).join(',');
        const stringSeed = options.stringSeed === undefined ? 1 : options.stringSeed & 255;
        const stringStep = options.stringStep === undefined ? 1 : options.stringStep & 255;
        return [
            `local ${n.u16}=function(${n.program},${n.pos})local ${n.v}=string.byte(${n.program},${n.pos})*256+string.byte(${n.program},${n.pos}+1)return ${n.v},${n.pos}+2 end`,
            `local ${n.u32}=function(${n.program},${n.pos})local ${n.v}=string.byte(${n.program},${n.pos})*16777216+string.byte(${n.program},${n.pos}+1)*65536+string.byte(${n.program},${n.pos}+2)*256+string.byte(${n.program},${n.pos}+3)return ${n.v},${n.pos}+4 end`,
            `local ${n.mul32}=function(a,b)local al=a%65536;local ah=math.floor(a/65536);local bl=b%65536;local bh=math.floor(b/65536);return (al*bl+(al*bh+ah*bl)*65536)%4294967296 end`,
            `local ${n.readValue}=function(${n.program},${n.pos})local ${n.v};${n.v},${n.pos}=${n.u32}(${n.program},${n.pos});local ${n.value}=string.sub(${n.program},${n.pos},${n.pos}+${n.v}-1);return ${n.value},${n.pos}+${n.v} end`,
            `if string.byte(${n.program},1)~=90 or string.byte(${n.program},2)~=51 or string.byte(${n.program},3)~=3 then error(\"Z3 program header\") end`,
            `local ${n.pos}=4;local ${n.backend}=string.byte(${n.program},${n.pos});if ${n.backend}~=0 and ${n.backend}~=1 then error(\"Z3 backend\") end;${n.pos}=${n.pos}+1`,
            `local ${n.constSeed}=string.byte(${n.program},${n.pos});local ${n.constStep}=string.byte(${n.program},${n.pos}+1);local ${n.constMul}=string.byte(${n.program},${n.pos}+2);local ${n.constInv}=string.byte(${n.program},${n.pos}+3);${n.pos}=${n.pos}+4`,
            `local ${n.operandSeed};${n.operandSeed},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `local ${n.operandStep};${n.operandStep},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `local ${n.operandSalt};${n.operandSalt},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `local ${n.operandMul};${n.operandMul},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `local ${n.operandInv};${n.operandInv},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `local ${n.operandFunction};${n.operandFunction},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `local ${n.opcodeSeed}=string.byte(${n.program},${n.pos});local ${n.opcodeStep}=string.byte(${n.program},${n.pos}+1);local ${n.opcodeMul}=string.byte(${n.program},${n.pos}+2);local ${n.opcodeInv}=string.byte(${n.program},${n.pos}+3);${n.pos}=${n.pos}+4`,
            `local ${n.expectedSeal};${n.expectedSeal},${n.pos}=${n.u32}(${n.program},${n.pos});local ${n.bodyStart}=${n.pos}`,
            `local ${n.sealA}=83;local ${n.sealB}=211;for ${n.idx}=${n.bodyStart},#${n.program} do local ${n.byteIndex}=${n.idx}-${n.bodyStart};local ${n.value}=string.byte(${n.program},${n.idx});${n.sealA}=(${n.sealA}+${n.value}+${n.byteIndex})%256;${n.sealB}=(${n.sealB}+${n.value}+${n.sealA}+${n.byteIndex}*17)%256 end;local ${n.actual}=${n.sealA}*65536+${n.sealB}*256+(#${n.program}-${n.bodyStart}+1)%256;if ${n.actual}~=${n.expectedSeal} then error(\"Z3 integrity seal\") end`,
            `local ${n.pos}=${n.bodyStart}`,
            `local ${n.constants}={};local ${n.rawConstants}={}`,
            `local ${n.size};${n.size},${n.pos}=${n.u32}(${n.program},${n.pos})`,
            `for ${n.idx}=1,${n.size} do local ${n.ctype}=string.byte(${n.program},${n.pos});${n.pos}=${n.pos}+1;local ${n.v};${n.v},${n.pos}=${n.u32}(${n.program},${n.pos});${n.rawConstants}[${n.idx}]={${n.ctype},string.sub(${n.program},${n.pos},${n.pos}+${n.v}-1)};${n.pos}=${n.pos}+${n.v} end`,
            `setmetatable(${n.constants},{__index=function(t,k)local ${n.strStep}Raw=${n.rawConstants}[k];if not ${n.strStep}Raw then return nil end;local ${n.ctype}=${n.strStep}Raw[1];local ${n.strStep}Bytes=${n.strStep}Raw[2];local ${n.strOut}={};for ${n.j}=0,#${n.strStep}Bytes-1 do local ${n.strByte}=string.byte(${n.strStep}Bytes,${n.j}+1);${n.strOut}[${n.j}+1]=string.char(((((${n.strByte}-${n.constSeed}-${n.j}*${n.constStep}-${n.ctype}*17)%256)*${n.constInv})%256)) end;local ${n.strStep}Text=table.concat(${n.strOut});local value;if ${n.ctype}==1 then value=${n.strStep}Text elseif ${n.ctype}==2 then value=tonumber(${n.strStep}Text) elseif ${n.ctype}==3 then value=string.byte(${n.strStep}Text,1)==1 elseif ${n.ctype}==4 then value=nil else error("Z3 constant") end;${n.rawConstants}[k]=nil;if value~=nil then rawset(t,k,value) end;return value end})`,
            `local ${n.functions}={}`,
            `for ${n.functionIndex}=1,${n.size} do local ${n.fn}={params={},vararg=false,code={},upvalues={},iteratorLayouts={},localCount=0,registerCount=0};local ${n.fnKey}=string.byte(${n.program},${n.pos});local ${n.fnSalt}=string.byte(${n.program},${n.pos}+1);${n.pos}=${n.pos}+2;local ${n.opcodeDecodeCount}=string.byte(${n.program},${n.pos});${n.pos}=${n.pos}+1;if not ${n.opcodeDecodeCount} or ${n.opcodeDecodeCount}<1 or ${n.opcodeDecodeCount}>255 then error("Z3 opcode table") end;local ${n.opcodeDecode}={};for ${n.opcodeDecodeIndex}=1,${n.opcodeDecodeCount} do ${n.opcodeDecode}[${n.opcodeDecodeIndex}]=string.byte(${n.program},${n.pos});${n.pos}=${n.pos}+1 end;local ${n.layoutCount}=(string.byte(${n.program},${n.pos})-${n.fnKey}-${n.fnSalt})%256;${n.pos}=${n.pos}+1;if ${n.layoutCount}<1 or ${n.layoutCount}>24 then error("Z3 operand layout count") end;local ${n.operandLayouts}={};for ${n.idx}=1,${n.layoutCount} do local ${n.layout}={};for ${n.j}=1,4 do ${n.layout}[${n.j}]=(string.byte(${n.program},${n.pos})-${n.fnKey}-${n.idx}*19-${n.j}*7)%256;${n.pos}=${n.pos}+1 end;if ${n.layout}[1]<1 or ${n.layout}[1]>4 or ${n.layout}[2]<1 or ${n.layout}[2]>4 or ${n.layout}[3]<1 or ${n.layout}[3]>4 or ${n.layout}[4]<1 or ${n.layout}[4]>4 or ${n.layout}[1]+${n.layout}[2]+${n.layout}[3]+${n.layout}[4]~=10 or ${n.layout}[1]*${n.layout}[2]*${n.layout}[3]*${n.layout}[4]~=24 then error("Z3 operand layout") end;${n.operandLayouts}[${n.idx}]=${n.layout} end;local ${n.params};${n.params},${n.pos}=${n.u16}(${n.program},${n.pos});${n.fn}.vararg=string.byte(${n.program},${n.pos})==1;${n.pos}=${n.pos}+1;${n.localCount},${n.pos}=${n.u32}(${n.program},${n.pos});${n.fn}.localCount=${n.localCount};local ${n.registerCount};${n.registerCount},${n.pos}=${n.u32}(${n.program},${n.pos});${n.fn}.registerCount=${n.registerCount};local ${n.upvalueCount};${n.upvalueCount},${n.pos}=${n.u16}(${n.program},${n.pos});for ${n.upvalueIndex}=1,${n.upvalueCount} do local ${n.upvalueKind}=string.byte(${n.program},${n.pos});${n.pos}=${n.pos}+1;${n.upvalueKind}=(${n.upvalueKind}-${n.fnKey}-(${n.upvalueIndex}-1)*17)%256;if ${n.upvalueKind}>1 then error(\"Z3 upvalue descriptor\") end;local ${n.b};${n.b},${n.pos}=${n.u32}(${n.program},${n.pos});${n.b}=(${n.b}-${n.operandSeed}-5*${n.operandSalt}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.b}=${n.mul32}(${n.b},${n.operandInv});${n.fn}.upvalues[${n.upvalueIndex}]={${n.upvalueKind},${n.b}} end;${n.iteratorCount},${n.pos}=${n.u16}(${n.program},${n.pos});for ${n.iteratorIndex}=1,${n.iteratorCount} do local ${n.layout}={};${n.layoutLen}=string.byte(${n.program},${n.pos});${n.pos}=${n.pos}+1;for ${n.b}=1,${n.layoutLen} do local ${n.c};${n.c},${n.pos}=${n.u32}(${n.program},${n.pos});${n.c}=(${n.c}-${n.operandSeed}-(6+${n.b}-1)*${n.operandSalt}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.c}=${n.mul32}(${n.c},${n.operandInv});${n.layout}[${n.b}]=${n.c} end;${n.fn}.iteratorLayouts[${n.iteratorIndex}]=${n.layout} end;for ${n.paramIndex}=1,${n.params} do local ${n.b};${n.b},${n.pos}=${n.u32}(${n.program},${n.pos});${n.b}=(${n.b}-${n.operandSeed}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.b}=${n.mul32}(${n.b},${n.operandInv});${n.fn}.params[${n.paramIndex}]=${n.b} end;local ${n.size};${n.size},${n.pos}=${n.u32}(${n.program},${n.pos});for ${n.a}=1,${n.size} do local ${n.op}=string.byte(${n.program},${n.pos});local ${n.decodedOp}=((((${n.op}-${n.opcodeSeed}-${n.a}*${n.opcodeStep}-(${n.fnKey}+${n.fnSalt}))%256)*${n.opcodeInv})%256);${n.pos}=${n.pos}+1;local ${n.layoutId}=((string.byte(${n.program},${n.pos})-${n.fnKey}-${n.a}*13)%256)+1;${n.pos}=${n.pos}+1;if ${n.layoutId}<1 or ${n.layoutId}>${n.layoutCount} then error("Z3 operand schema") end;local ${n.operandPermutation}=${n.operandLayouts}[${n.layoutId}];local ${n.raw}={};for ${n.idx}=1,4 do ${n.raw}[${n.idx}],${n.pos}=${n.u32}(${n.program},${n.pos}) end;local ${n.b}=(${n.raw}[${n.operandPermutation}[1]]-${n.operandSeed}-${n.a}*${n.operandStep}-${n.operandSalt}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.b}=${n.mul32}(${n.b},${n.operandInv});local ${n.c}=(${n.raw}[${n.operandPermutation}[2]]-${n.operandSeed}-${n.a}*${n.operandStep}-2*${n.operandSalt}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.c}=${n.mul32}(${n.c},${n.operandInv});local ${n.d}=(${n.raw}[${n.operandPermutation}[3]]-${n.operandSeed}-${n.a}*${n.operandStep}-3*${n.operandSalt}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.d}=${n.mul32}(${n.d},${n.operandInv});local ${n.v}=(${n.raw}[${n.operandPermutation}[4]]-${n.operandSeed}-${n.a}*${n.operandStep}-4*${n.operandSalt}-(${n.fnKey}*${n.operandFunction}))%4294967296;${n.v}=${n.mul32}(${n.v},${n.operandInv});${n.fn}.code[${n.a}]={${n.decodedOp},${n.b},${n.c},${n.d},${n.v}} end;${n.functions}[${n.functionIndex}-1]=${n.fn} end`,
            `local ${n.globals}=(type(getgenv)==\\\"function\\\" and getgenv()) or _G`,
            `local ${n.truth}=function(${n.v})return ${n.v}~=nil and ${n.v}~=false end`,
            `local ${n.getv}=function(${n.env},${n.key})local ${n.state}=${n.env};while ${n.state} do local ${n.frame}=rawget(${n.state},${n.key});if ${n.frame}~=nil then return ${n.frame}.v end;${n.state}=rawget(${n.state},\\\"__p\\\") end;return nil end`,
            `local ${n.setv}=function(${n.env},${n.key},${n.v})local ${n.state}=${n.env};while ${n.state} do local ${n.frame}=rawget(${n.state},${n.key});if ${n.frame}~=nil then ${n.frame}.v=${n.v};return end;${n.state}=rawget(${n.state},\\\"__p\\\") end;rawset(${n.env},${n.key},{v=${n.v}}) end`,
            `local ${n.gg}=function(${n.key})return ${n.globals}[${n.key}] end`,
            `local ${n.sg}=function(${n.key},${n.v})${n.globals}[${n.key}]=${n.v} end`,
            `local ${n.bwU}=function(v)v=v%4294967296;if v<0 then v=v+4294967296 end;return v end`,
            `local ${n.bwS}=function(v)v=${n.bwU}(v);if v>=2147483648 then return v-4294967296 end;return v end`,
            `local ${n.bwBand}=function(x,y)x=${n.bwU}(x);y=${n.bwU}(y);local r=0;local bit=1;for i=1,32 do local xb=math.floor(x/(bit));local yb=math.floor(y/(bit));if xb%2>=1 and yb%2>=1 then r=r+bit end;bit=bit*2 end;return ${n.bwS}(r) end`,
            `local ${n.bwBor}=function(x,y)x=${n.bwU}(x);y=${n.bwU}(y);local r=0;local bit=1;for i=1,32 do local xb=math.floor(x/(bit));local yb=math.floor(y/(bit));if xb%2>=1 or yb%2>=1 then r=r+bit end;bit=bit*2 end;return ${n.bwS}(r) end`,
            `local ${n.bwXor}=function(x,y)x=${n.bwU}(x);y=${n.bwU}(y);local r=0;local bit=1;for i=1,32 do local xb=math.floor(x/(bit));local yb=math.floor(y/(bit));if (xb%2>=1)~=(yb%2>=1) then r=r+bit end;bit=bit*2 end;return ${n.bwS}(r) end`,
            `local ${n.bwNot}=function(x)return ${n.bwS}(4294967295-${n.bwU}(x)) end`,
            `local ${n.bwShl}=function(x,y)local n=math.floor(y);if n<0 then local k=-n;if k>=32 then return ${n.bwS}(0) end;return math.floor(${n.bwS}(x)/(2^k)) end;if n>=32 then return 0 end;return ${n.bwS}(${n.bwU}(x)*2^n%4294967296) end`,
            `local ${n.bwShr}=function(x,y)local n=math.floor(y);if n<0 then local k=-n;if k>=32 then return 0 end;return ${n.bwShl}(x,k) end;if n>=32 then return ${n.bwS}((${n.bwS}(x)<0) and 4294967295 or 0) end;return math.floor(${n.bwS}(x)/(2^n)) end`,
            `local ${n.isMulti}=function(${n.v})return type(${n.v})=='table' and ${n.v}.__z==1 end`,
            `local ${n.multi}=function(${n.v},${n.a})return{__z=1,n=${n.a},v=${n.v}} end`,
            `local ${n.invoke}=function(${n.fn},${n.args})if type(${n.fn})~=\\\"function\\\" then error(\\\"Z3 call: not callable\\\") end;local ${n.ok},${n.packed}=pcall(function()return table.pack(${n.fn}(table.unpack(${n.args},1,${n.args}.n or #${n.args}))) end);if not ${n.ok} then error(${n.packed}) end;return ${n.multi}(${n.packed},${n.packed}.n) end`,
            `local ${n.exec}`,
            `local ${n.exec}`,
            `local ${n.makeFn}=function(${n.a},${n.parent},${n.upvalues})return function(...)local ${n.args}=table.pack(...);return ${n.exec}(${n.a},${n.parent},${n.upvalues},${n.args}) end end`,
            `${n.exec}=function(${n.a},${n.parent},${n.upvalues},${n.args})`,
            `local ${n.def}=${n.functions}[${n.a}];if not ${n.def} then error(\"Z3 function index \\\"..tostring(${n.a})) end;local ${n.env}={locals={}};for ${n.idx}=1,${n.def}.localCount do ${n.env}.locals[${n.idx}]={v=nil} end;local ${n.parentUv}=${n.upvalues};local ${n.upvalues}={};for ${n.upvalueIndex}=1,#${n.def}.upvalues do local ${n.upRef}=${n.def}.upvalues[${n.upvalueIndex}];if ${n.upRef}[1]==0 then if not ${n.parent} or not ${n.parent}[${n.upRef}[2]+1] then error(\"Z3 local upvalue capture\") end;${n.upvalues}[${n.upvalueIndex}]=${n.parent}[${n.upRef}[2]+1] else if not ${n.parentUv} or not ${n.parentUv}[${n.upRef}[2]+1] then error(\"Z3 parent upvalue capture\") end;${n.upvalues}[${n.upvalueIndex}]=${n.parentUv}[${n.upRef}[2]+1] end end;local ${n.varargs}={n=0};for ${n.idx}=#${n.def}.params+1,${n.args}.n do ${n.varargs}[${n.idx}-#${n.def}.params]=${n.args}[${n.idx}];${n.varargs}.n=${n.varargs}.n+1 end`,
            `for ${n.idx}=1,#${n.def}.params do local ${n.slot}=${n.def}.params[${n.idx}]+1;if not ${n.env}.locals[${n.slot}] then ${n.env}.locals[${n.slot}]={v=nil} end;${n.env}.locals[${n.slot}].v=${n.args}[${n.idx}] end`,
            `local ${n.stack}={};local ${n.sp}=0;local ${n.pc}=1;local ${n.loops}={}`,
            `local function ${n.push}(${n.v})${n.sp}=${n.sp}+1;${n.stack}[${n.sp}]=${n.v} end`,
            `local function ${n.pop}()local ${n.v}=${n.stack}[${n.sp}];${n.stack}[${n.sp}]=nil;${n.sp}=${n.sp}-1;return ${n.v} end`,
            `local ${n.dispatch}={${dispatchEntries}}`,
            `while ${n.pc}<=#${n.def}.code do local ${n.ins}=${n.def}.code[${n.pc}];${n.op}=${n.ins}[1];${n.route}=${n.dispatch}[${n.op}];if ${n.route}==nil then error(\\"Z3 opcode route\\") end;${n.a}=${n.ins}[2];${n.b}=${n.ins}[3];${n.c}=${n.ins}[4];${n.d}=${n.ins}[5];${n.pc}=${n.pc}+1`,
            `if ${n.route}==${routeTokens.PUSH_CONST} then ${n.push}(${n.constants}[${n.a}+1]) elseif ${n.route}==${routeTokens.LOAD_LOCAL} then local ${n.frame}=${n.env}.locals[${n.a}+1];${n.push}(${n.frame} and ${n.frame}.v or nil) elseif ${n.route}==${routeTokens.STORE_LOCAL} then local ${n.frame}=${n.env}.locals[${n.a}+1];if not ${n.frame} then ${n.frame}={v=nil};${n.env}.locals[${n.a}+1]=${n.frame} end;${n.frame}.v=${n.pop}() elseif ${n.route}==${routeTokens.FUSED_LOCAL_CONST_BIN_STORE} then local ${n.left}=${n.env}.locals[${n.a}+1] and ${n.env}.locals[${n.a}+1].v;local ${n.right}=${n.constants}[${n.b}];local ${n.result};if ${n.c}==1 then ${n.result}=${n.left}+${n.right} elseif ${n.c}==2 then ${n.result}=${n.left}-${n.right} elseif ${n.c}==3 then ${n.result}=${n.left}*${n.right} elseif ${n.c}==4 then ${n.result}=${n.left}/${n.right} elseif ${n.c}==5 then ${n.result}=${n.left}%${n.right} elseif ${n.c}==6 then ${n.result}=${n.left}^${n.right} elseif ${n.c}==7 then ${n.result}=${n.left}..${n.right} elseif ${n.c}==8 then ${n.result}=${n.left}==${n.right} elseif ${n.c}==9 then ${n.result}=${n.left}~=${n.right} elseif ${n.c}==10 then ${n.result}=${n.left}<${n.right} elseif ${n.c}==11 then ${n.result}=${n.left}>${n.right} elseif ${n.c}==12 then ${n.result}=${n.left}<=${n.right} elseif ${n.c}==13 then ${n.result}=${n.left}>=${n.right} elseif ${n.c}==14 then ${n.result}=math.floor(${n.left}/${n.right}) elseif ${n.c}==15 then ${n.result}=${n.bwBand}(${n.left},${n.right}) elseif ${n.c}==16 then ${n.result}=${n.bwBor}(${n.left},${n.right}) elseif ${n.c}==17 then ${n.result}=${n.bwXor}(${n.left},${n.right}) elseif ${n.c}==18 then ${n.result}=${n.bwShl}(${n.left},${n.right}) elseif ${n.c}==19 then ${n.result}=${n.bwShr}(${n.left},${n.right}) else error("Z3 fused bin") end;${n.env}.locals[${n.d}+1]=${n.env}.locals[${n.d}+1] or {v=nil};${n.env}.locals[${n.d}+1].v=${n.result} elseif ${n.route}==${routeTokens.FUSED_LOCAL_LOCAL_BIN_STORE} then local ${n.left}=${n.env}.locals[${n.a}+1] and ${n.env}.locals[${n.a}+1].v;local ${n.right}=${n.env}.locals[${n.b}+1] and ${n.env}.locals[${n.b}+1].v;local ${n.result};if ${n.c}==1 then ${n.result}=${n.left}+${n.right} elseif ${n.c}==2 then ${n.result}=${n.left}-${n.right} elseif ${n.c}==3 then ${n.result}=${n.left}*${n.right} elseif ${n.c}==4 then ${n.result}=${n.left}/${n.right} elseif ${n.c}==5 then ${n.result}=${n.left}%${n.right} elseif ${n.c}==6 then ${n.result}=${n.left}^${n.right} elseif ${n.c}==7 then ${n.result}=${n.left}..${n.right} elseif ${n.c}==8 then ${n.result}=${n.left}==${n.right} elseif ${n.c}==9 then ${n.result}=${n.left}~=${n.right} elseif ${n.c}==10 then ${n.result}=${n.left}<${n.right} elseif ${n.c}==11 then ${n.result}=${n.left}>${n.right} elseif ${n.c}==12 then ${n.result}=${n.left}<=${n.right} elseif ${n.c}==13 then ${n.result}=${n.left}>=${n.right} elseif ${n.c}==14 then ${n.result}=math.floor(${n.left}/${n.right}) elseif ${n.c}==15 then ${n.result}=${n.bwBand}(${n.left},${n.right}) elseif ${n.c}==16 then ${n.result}=${n.bwBor}(${n.left},${n.right}) elseif ${n.c}==17 then ${n.result}=${n.bwXor}(${n.left},${n.right}) elseif ${n.c}==18 then ${n.result}=${n.bwShl}(${n.left},${n.right}) elseif ${n.c}==19 then ${n.result}=${n.bwShr}(${n.left},${n.right}) else error("Z3 fused bin") end;${n.env}.locals[${n.d}+1]=${n.env}.locals[${n.d}+1] or {v=nil};${n.env}.locals[${n.d}+1].v=${n.result} elseif ${n.route}==${routeTokens.LOAD_UPVALUE} then local ${n.frame}=${n.upvalues}[${n.a}+1];if not ${n.frame} then error(\"Z3 upvalue load\") end;${n.push}(${n.frame}.v) elseif ${n.route}==${routeTokens.STORE_UPVALUE} then local ${n.frame}=${n.upvalues}[${n.a}+1];if not ${n.frame} then error(\"Z3 upvalue store\") end;${n.frame}.v=${n.pop}() elseif ${n.route}==${routeTokens.LOAD_VAR} then ${n.push}(${n.getv}(${n.env},${n.constants}[${n.a}+1])) elseif ${n.route}==${routeTokens.STORE_VAR} then ${n.v}=${n.pop}();${n.setv}(${n.env},${n.constants}[${n.a}+1],${n.v}) elseif ${n.route}==${routeTokens.FUSED_GLOBAL_CALL} then local ${n.fn}=${n.gg}(${n.constants}[${n.a}+1]);local ${n.result}=${n.invoke}(${n.fn},{});if ${n.b}==1 then ${n.push}(${n.result}) else ${n.push}(${n.result}.v[1]) end elseif ${n.route}==${routeTokens.LOAD_GLOBAL} then ${n.push}(${n.gg}(${n.constants}[${n.a}+1])) elseif ${n.route}==${routeTokens.STORE_GLOBAL} then ${n.v}=${n.pop}();${n.sg}(${n.constants}[${n.a}+1],${n.v}) elseif ${n.route}==${routeTokens.GET_MEMBER} then ${n.obj}=${n.pop}();${n.push}(${n.obj}[${n.constants}[${n.a}+1]]) elseif ${n.route}==${routeTokens.SET_MEMBER} then ${n.v}=${n.pop}();${n.obj}=${n.pop}();${n.obj}[${n.constants}[${n.a}+1]]=${n.v} elseif ${n.route}==${routeTokens.GET_INDEX} then ${n.key}=${n.pop}();${n.obj}=${n.pop}();${n.push}(${n.obj}[${n.key}]) elseif ${n.route}==${routeTokens.SET_INDEX} then ${n.v}=${n.pop}();${n.key}=${n.pop}();${n.obj}=${n.pop}();${n.obj}[${n.key}]=${n.v} elseif ${n.route}==${routeTokens.SETLIST_MULTI} then ${n.v}=${n.pop}();${n.obj}=${n.pop}();local ${n.multiValues}=${n.isMulti}(${n.v}) and ${n.v}.v or {${n.v}};local ${n.multiCount}=${n.isMulti}(${n.v}) and ${n.v}.n or 1;for ${n.idx}=1,${n.multiCount} do ${n.obj}[${n.a}+${n.idx}-1]=${n.multiValues}[${n.idx}] end elseif ${n.route}==${routeTokens.DUP} then ${n.push}(${n.stack}[${n.sp}]) elseif ${n.route}==${routeTokens.POP} then ${n.pop}() elseif ${n.route}==${routeTokens.UNARY} then ${n.v}=${n.pop}();if ${n.a}==1 then ${n.push}(not ${n.v}) elseif ${n.a}==2 then ${n.push}(-${n.v}) elseif ${n.a}==3 then ${n.push}(#${n.v}) elseif ${n.a}==4 then ${n.push}(${n.bwNot}(${n.v})) else error(\"Z3 unary\") end elseif ${n.route}==${routeTokens.BIN} then ${n.right}=${n.pop}();${n.left}=${n.pop}();if ${n.a}==1 then ${n.push}(${n.left}+${n.right}) elseif ${n.a}==2 then ${n.push}(${n.left}-${n.right}) elseif ${n.a}==3 then ${n.push}(${n.left}*${n.right}) elseif ${n.a}==4 then ${n.push}(${n.left}/${n.right}) elseif ${n.a}==5 then ${n.push}(${n.left}%${n.right}) elseif ${n.a}==6 then ${n.push}(${n.left}^${n.right}) elseif ${n.a}==7 then ${n.push}(${n.left}..${n.right}) elseif ${n.a}==8 then ${n.push}(${n.left}==${n.right}) elseif ${n.a}==9 then ${n.push}(${n.left}~=${n.right}) elseif ${n.a}==10 then ${n.push}(${n.left}<${n.right}) elseif ${n.a}==11 then ${n.push}(${n.left}>${n.right}) elseif ${n.a}==12 then ${n.push}(${n.left}<=${n.right}) elseif ${n.a}==13 then ${n.push}(${n.left}>=${n.right}) elseif ${n.a}==14 then ${n.push}(math.floor(${n.left}/${n.right})) elseif ${n.a}==15 then ${n.push}(${n.bwBand}(${n.left},${n.right})) elseif ${n.a}==16 then ${n.push}(${n.bwBor}(${n.left},${n.right})) elseif ${n.a}==17 then ${n.push}(${n.bwXor}(${n.left},${n.right})) elseif ${n.a}==18 then ${n.push}(${n.bwShl}(${n.left},${n.right})) elseif ${n.a}==19 then ${n.push}(${n.bwShr}(${n.left},${n.right})) else error(\"Z3 binary\") end elseif ${n.route}==${routeTokens.JUMP} then ${n.pc}=${n.a} elseif ${n.route}==${routeTokens.JUMP_IF_FALSE} then ${n.v}=${n.pop}();if not ${n.truth}(${n.v}) then ${n.pc}=${n.a} end elseif ${n.route}==${routeTokens.JUMP_IF_TRUE} then ${n.v}=${n.pop}();if ${n.truth}(${n.v}) then ${n.pc}=${n.a} end elseif ${n.route}==${routeTokens.MAKE_FUNCTION} then ${n.push}(${n.makeFn}(${n.a},${n.env}.locals,${n.upvalues})) elseif ${n.route}==${routeTokens.CALL} or ${n.route}==${routeTokens.CALL_MULTI} then local ${n.args}={};for ${n.idx}=${n.a},1,-1 do ${n.args}[${n.idx}]=${n.pop}() end;local ${n.fn}=${n.pop}();${n.args}.n=${n.a};local ${n.result}=${n.invoke}(${n.fn},${n.args});if ${n.route}==${routeTokens.CALL_MULTI} then ${n.push}(${n.result}) else ${n.push}(${n.result}.v[1]) end elseif ${n.route}==${routeTokens.CALL_METHOD} or ${n.route}==${routeTokens.CALL_METHOD_MULTI} then local ${n.args}={};for ${n.idx}=${n.b},1,-1 do ${n.args}[${n.idx}]=${n.pop}() end;local ${n.obj}=${n.pop}();local ${n.fn}=${n.obj}[${n.constants}[${n.a}+1]];local ${n.callArgs}={${n.obj}};for ${n.idx}=1,#${n.args} do ${n.callArgs}[${n.idx}+1]=${n.args}[${n.idx}] end;${n.callArgs}.n=${n.b}+1;local ${n.result}=${n.invoke}(${n.fn},${n.callArgs});if ${n.route}==${routeTokens.CALL_METHOD_MULTI} then ${n.push}(${n.result}) else ${n.push}(${n.result}.v[1]) end elseif ${n.route}==${routeTokens.CALL_EXPAND} then local ${n.value}=${n.pop}();local ${n.argsList}={};for ${n.idx}=${n.c},1,-1 do ${n.argsList}[${n.idx}]=${n.pop}() end;if ${n.isMulti}(${n.value}) then for ${n.idx}=1,${n.value}.n do ${n.argsList}[${n.c}+${n.idx}]=${n.value}.v[${n.idx}] end else ${n.argsList}[${n.c}+1]=${n.value} end;local ${n.fn}=${n.pop}();${n.argsList}.n=${n.c}+(${n.isMulti}(${n.value}) and ${n.value}.n or 1);local ${n.result}=${n.invoke}(${n.fn},${n.argsList});${n.push}(${n.result}.v[1]) elseif ${n.route}==${routeTokens.CALL_METHOD_EXPAND} then local ${n.value}=${n.pop}();local ${n.argsList}={};if ${n.isMulti}(${n.value}) then for ${n.idx}=1,${n.value}.n do ${n.argsList}[${n.idx}+${n.b}]=${n.value}.v[${n.idx}] end else ${n.argsList}[${n.b}+1]=${n.value} end;for ${n.idx}=${n.b},1,-1 do ${n.argsList}[${n.idx}+1]=${n.pop}() end;local ${n.obj}=${n.pop}();${n.argsList}[1]=${n.obj};local ${n.fn}=${n.obj}[${n.constants}[${n.a}+1]];${n.argsList}.n=${n.b}+1+(${n.isMulti}(${n.value}) and ${n.value}.n or 1);local ${n.result}=${n.invoke}(${n.fn},${n.argsList});${n.push}(${n.result}.v[1]) elseif ${n.route}==${routeTokens.RETURN_VOID} then return ${n.multi}({},0) elseif ${n.route}==${routeTokens.RETURN} then ${n.v}=${n.pop}();if ${n.isMulti}(${n.v}) then return ${n.v} else return ${n.multi}({${n.v}},1) end elseif ${n.route}==${routeTokens.RETURN_MULTI} then local ${n.args}={};for ${n.idx}=${n.a},1,-1 do ${n.args}[${n.idx}]=${n.pop}() end;return ${n.multi}(${n.args},${n.a}) elseif ${n.route}==${routeTokens.RETURN_MIXED} then local ${n.value}=${n.pop}();local ${n.args}={};for ${n.idx}=${n.a},1,-1 do ${n.args}[${n.idx}]=${n.pop}() end;if ${n.isMulti}(${n.value}) then for ${n.idx}=1,${n.value}.n do ${n.args}[${n.a}+${n.idx}]=${n.value}.v[${n.idx}] end else ${n.args}[${n.a}+1]=${n.value} end;local ${n.count}=${n.a}+1;if ${n.isMulti}(${n.value}) then ${n.count}=${n.a}+${n.value}.n end;return ${n.multi}(${n.args},${n.count}) elseif ${n.route}==${routeTokens.GET_VARARG} then ${n.push}(${n.varargs}[1]) elseif ${n.route}==${routeTokens.GET_VARARG_MULTI} then ${n.push}(${n.multi}(${n.varargs},${n.varargs}.n or #${n.varargs})) elseif ${n.route}==${routeTokens.NEW_TABLE} then ${n.push}({}) elseif ${n.route}==${routeTokens.PACK_MULTI} then local ${n.args}={};for ${n.idx}=${n.a},1,-1 do ${n.args}[${n.idx}]=${n.pop}() end;${n.push}(${n.multi}(${n.args},${n.a})) elseif ${n.route}==${routeTokens.UNPACK_MULTI} then local ${n.value}=${n.pop}();local ${n.multiValues}=${n.isMulti}(${n.value}) and ${n.value}.v or {${n.value}};for ${n.idx}=1,${n.a} do ${n.push}(${n.multiValues}[${n.idx}]) end elseif ${n.route}==${routeTokens.FOR_NUM_PREP} then local ${n.step}=${n.pop}();local ${n.finish}=${n.pop}();local ${n.start}=${n.pop}();if ${n.step}==0 then error(\"Z3 numeric for step is zero\") end;local ${n.frame}={slot=${n.a},current=${n.start},finish=${n.finish},step=${n.step}};local ${n.keep}=(${n.step}>0 and ${n.start}<=${n.finish}) or (${n.step}<0 and ${n.start}>=${n.finish});if not ${n.keep} then ${n.pc}=${n.d} else ${n.loops}[#${n.loops}+1]=${n.frame};${n.env}.locals[${n.a}+1].v=${n.start} end elseif ${n.route}==${routeTokens.FOR_NUM_NEXT} then local ${n.frame}=${n.loops}[#${n.loops}];${n.frame}.current=${n.frame}.current+${n.frame}.step;local ${n.keep}=(${n.frame}.step>0 and ${n.frame}.current<=${n.frame}.finish) or (${n.frame}.step<0 and ${n.frame}.current>=${n.frame}.finish);if ${n.keep} then ${n.env}.locals[${n.frame}.slot+1].v=${n.frame}.current else ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.d} end elseif ${n.route}==${routeTokens.BREAK} then ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.a} elseif ${n.route}==${routeTokens.ITER_PREP} then local ${n.result}=${n.pop}();if type(${n.result})~=\"table\" or ${n.result}.__z~=1 or ${n.result}.n<3 then error(\"Z3 iterator setup\") end;local ${n.iter}=${n.result}.v[1];local ${n.state}=${n.result}.v[2];local ${n.control}=${n.result}.v[3];local ${n.first}=${n.invoke}(${n.iter},{${n.state},${n.control}});local ${n.layout}=${n.def}.iteratorLayouts[${n.b}+1] or {};local ${n.frame}={fn=${n.iter},state=${n.state},control=${n.first}.v[1],layout=${n.layout}};if ${n.frame}.control==nil then ${n.pc}=${n.d} else ${n.loops}[#${n.loops}+1]=${n.frame};for ${n.idx}=1,#${n.layout} do ${n.env}.locals[${n.layout}[${n.idx}]+1].v=${n.first}.v[${n.idx}] end end elseif ${n.route}==${routeTokens.ITER_NEXT} then local ${n.frame}=${n.loops}[#${n.loops}];local ${n.next}=${n.invoke}(${n.frame}.fn,{${n.frame}.state,${n.frame}.control});${n.frame}.control=${n.next}.v[1];if ${n.frame}.control==nil then ${n.loops}[#${n.loops}]=nil;${n.pc}=${n.d} else for ${n.idx}=1,#${n.frame}.layout do ${n.env}.locals[${n.frame}.layout[${n.idx}]+1].v=${n.next}.v[${n.idx}] end;${n.pc}=${n.b} end elseif ${n.route}==${routeTokens.NOP} then else error(\"Z3 opcode\") end end`,
            'end',
            `return ${n.exec}(0,nil,nil,{})`
        ];
    }
    generate(source, options = {}) {
        if (typeof source !== 'string' || !source.trim()) throw new Error('El código Lua/Luau está vacío.');
        const preset = resolvePreset(options.preset);
        const native = buildNativeProgram(source, { polymorphOptions: preset.polymorph });
        native.metadata = { ...(native.metadata || {}), strengthPreset: preset.name };
        const program = buildEmissionPlan(native, {
            backend: options.backend === undefined ? preset.backend : options.backend,
            diversify: options.diversify || preset.diversify,
            registers: options.registers || preset.registers,
            isa: options.isa || preset.isa
        });
        const raw = encodeProgram(program);
        const visual = encodeVisualPayload(raw);
        const n = this.names();
        const output = [...this.decodeLines(visual.lines, n), ...this.vmLines(program, n)].join('\n').replaceAll('\\\"', '"');
        this.lintGenerated(output);
        return output;
    }
}

module.exports = CodeGenerator;
