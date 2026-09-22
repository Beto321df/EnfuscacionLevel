const CodeGenerator = require('../src/generator/visualCodegen.js');
const { ALPHABET, BASE } = require('../src/zlang/codec');
const { wrapVisual } = require('../src/zlang/visualTransport');
const { buildCompatLoader } = require('../src/zlang/compatLoader');
const { resolvePreset } = require('../src/zlang/presets');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'Z3 obfuscation API' });

    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const sourceScript = typeof body.code === 'string' ? body.code : (typeof body.script === 'string' ? body.script : 'print("Z-Protector Loaded")');
        if (!sourceScript.trim()) return res.status(400).json({ success: false, error: 'El código Lua/Luau está vacío.' });
        const presetName = typeof body.preset === 'string' ? body.preset : 'maximum';
        const preset = resolvePreset(presetName);
        const compatibilityRequested = body.compat === true || body.compat === 'true';
        let generated, mode='x7-register', directBytecodeExecution=true;
        try {
            generated=new CodeGenerator().generate(sourceScript, { preset: preset.name });
        } catch (nativeError) {
            if (!compatibilityRequested) {
                return res.status(422).json({
                    success:false,
                    error:'Z3 native pipeline rejected this source. Compatibility source-preserving mode is opt-in.',
                    engine:'Z-Lang 3',
                    mode:'zlang3-native-required',
                    strengthPreset:preset.name,
                    sourceReconstruction:false,
                    directBytecodeExecution:false,
                    nativeError:nativeError instanceof Error ? nativeError.message : String(nativeError)
                });
            }
            mode='zlang3-visual-compat';
            directBytecodeExecution=false;
            generated=buildCompatLoader(sourceScript, nativeError);
        }
        const obfuscatedCode=mode==='x7-register' ? generated : wrapVisual(generated);
        if(typeof obfuscatedCode!=='string'||!obfuscatedCode.trim())throw new Error('Z no generó código protegido.');
        return res.status(200).json({success:true,engine:'Z-Lang 3',mode,format:mode==='x7-register' ? 'X7.2 hardened layered register VM' : 'Z3 visual compatibility loader',payloadAlphabet:'mixed-cjk-digit-symbol-random-alias',payloadAlphabetValue:ALPHABET,alphabetBase:BASE,visualLineWidth:19,visualSeparator:'/ ',sourceReconstruction:mode==='zlang3-visual-compat',strengthPreset:preset.name,directBytecodeExecution,singleLine:true,code:obfuscatedCode,obfuscatedCode});
    } catch(error) { const message=error instanceof Error?error.message:String(error); console.error('Z3 obfuscation failure:',error); return res.status(500).json({success:false,error:message||'Error interno de obfuscación.'}); }
};
