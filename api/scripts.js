const CodeGenerator = require('../src/generator/visualCodegen');
const { wrapVisual } = require('../src/zlang/visualTransport');

function isZ3Loader(code) {
    return typeof code === 'string' && (
        code.includes('--Z3M:') ||
        code.includes('return(function(P)local T=') ||
        code.includes('return(function(t,...)') ||
        code.includes('return setmetatable({p=') ||
        code.includes('return ({p=') ||
        (code.includes('Z3 visual payload corto') && code.includes('Z3 visual checksum')) ||
        code.includes('return(function(p,a,b)') ||
        (code.includes('local T=') && code.includes('Z3 visual frame') && code.includes('Z3 visual loader compile failed')) ||
        (code.includes('Z visual glyph') && code.includes('Z visual pair')) ||
        (code.includes('Z3 opcode') && code.includes('__z')) ||
        code.includes('Z3-stable') ||
        (code.includes('return({L={') && code.includes('E=function') && code.includes('R=function')) ||
        (code.includes('Z3 visual header') && code.includes('Z3 visual checksum'))
    );
}

module.exports = async function handler(req, res) {
    const DB_URL = 'https://loaderz1-default-rtdb.firebaseio.com';
    const SECRET = process.env.FIREBASE_SECRET;

    if (req.method === 'GET') {
        const { user } = req.query;
        if (!user) return res.status(400).json({ msg: 'Usuario no proporcionado' });
        try {
            const cleanUser = user.replace(/[^a-zA-Z0-9_-]/g, '');
            const userScriptsRes = await fetch(`${DB_URL}/users/${cleanUser}/user_scripts.json?auth=${SECRET}`);
            const userScriptsMap = await userScriptsRes.json() || {};
            const ids = Object.keys(userScriptsMap);
            const scripts = {};

            // Always return the protected record to the dashboard/editor.
            // Source copies are kept server-side but are never substituted for
            // the protected loader in the client response.
            await Promise.all(ids.map(async id => {
                const sRes = await fetch(`${DB_URL}/scripts/${id}.json?auth=${SECRET}`);
                if (!sRes.ok) return;
                const sData = await sRes.json();
                if (!sData) return;
                scripts[id] = {
                    owner: sData.owner || cleanUser,
                    code: typeof sData.code === 'string' ? sData.code : '',
                    createdAt: sData.createdAt || null
                };
            }));

            return res.status(200).json({ scripts });
        } catch (err) {
            return res.status(500).json({ msg: 'Error al leer scripts de Firebase' });
        }
    }

    if (req.method === 'POST') {
        const { user, id, code, source: providedSource, isUpdate } = req.body;
        if (!user || !id || !code) return res.status(400).json({ msg: 'Usuario, ID y código son obligatorios.' });

        const cleanUser = user.replace(/[^a-zA-Z0-9_-]/g, '');
        const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '');

        try {
            const scriptRefUrl = `${DB_URL}/scripts/${cleanId}.json?auth=${SECRET}`;
            let existingData = null;
            const checkRes = await fetch(scriptRefUrl);
            existingData = await checkRes.json();

            if (!isUpdate && existingData && existingData.code) {
                return res.status(400).json({ msg: `El script "${cleanId}" ya existe.` });
            }
            if (isUpdate && cleanUser !== 'admin123' && existingData && existingData.owner && existingData.owner !== cleanUser) {
                return res.status(403).json({ msg: 'No tienes permiso para modificar este script.' });
            }

            // code is the protected result produced by /api/obfuscate.
            // Re-generate only when a raw source string is actually supplied.
            let generatedCode;
            try {
                generatedCode = isZ3Loader(code) ? code : new CodeGenerator().generate(code);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error('X7 script generation failure:', error);
                return res.status(422).json({ ok: false, msg: `No se pudo proteger el script: ${message}`, stage: 'x7-generation' });
            }
            const protectedCode = generatedCode.replace(/\r?\n/g, ' ').trim();
            if (protectedCode.length > 1024 * 1024) {
                return res.status(413).json({ ok: false, msg: `La salida protegida supera el límite de 1 MB (${protectedCode.length} caracteres).`, stage: 'x72-size' });
            }
            const isProtected = protectedCode.startsWith('return setmetatable({p=') || protectedCode.startsWith('return ({p=');
            if (!isProtected) {
                return res.status(500).json({ ok: false, msg: 'El motor X7 generó una salida protegida inválida.', stage: 'x7-output' });
            }
            const createdAt = Date.now();
            const scriptPayload = { owner: cleanUser, code: protectedCode, createdAt };
            if (typeof providedSource === 'string' && providedSource.trim()) {
                scriptPayload.source = providedSource;
            }

            const scriptWrite = await fetch(scriptRefUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(scriptPayload)
            });
            if (!scriptWrite.ok) {
                const firebaseMessage = await scriptWrite.text().catch(() => '');
                console.error('Firebase script write failure:', scriptWrite.status, firebaseMessage);
                return res.status(502).json({ ok: false, msg: 'Firebase rechazó el guardado del script.', stage: 'firebase-script', status: scriptWrite.status });
            }

            // Keep lightweight ownership metadata only. This prevents the
            // dashboard from accidentally replacing the protected `code` with
            // the raw source while editing.
            const metaWrite = await fetch(`${DB_URL}/users/${cleanUser}/user_scripts/${cleanId}.json?auth=${SECRET}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ owner: cleanUser, createdAt })
            });
            if (!metaWrite.ok) {
                const firebaseMessage = await metaWrite.text().catch(() => '');
                console.error('Firebase metadata write failure:', metaWrite.status, firebaseMessage);
                await fetch(scriptRefUrl, { method: 'DELETE' }).catch(() => {});
                return res.status(502).json({ ok: false, msg: 'Firebase rechazó los metadatos del script; el guardado fue revertido.', stage: 'firebase-metadata', status: metaWrite.status });
            }

            return res.status(200).json({ ok: true, msg: 'Script guardado correctamente.' });
        } catch (err) {
            return res.status(500).json({ msg: 'Error al guardar el script.' });
        }
    }

    if (req.method === 'DELETE') {
        const { user, id } = req.body;
        if (!user || !id) return res.status(400).json({ msg: 'Usuario e ID son requeridos.' });
        const cleanUser = user.replace(/[^a-zA-Z0-9_-]/g, '');
        const cleanId = id.replace(/[^a-zA-Z0-9_-]/g, '');
        try {
            const scriptRefUrl = `${DB_URL}/scripts/${cleanId}.json?auth=${SECRET}`;
            const checkRes = await fetch(scriptRefUrl);
            const existingData = await checkRes.json();
            if (!existingData) return res.status(404).json({ msg: 'El script no existe.' });
            if (cleanUser !== 'admin123' && existingData.owner !== cleanUser) return res.status(403).json({ msg: 'No tienes permisos para eliminar este script.' });
            await Promise.all([
                fetch(scriptRefUrl, { method: 'DELETE' }),
                fetch(`${DB_URL}/users/${existingData.owner || cleanUser}/user_scripts/${cleanId}.json?auth=${SECRET}`, { method: 'DELETE' })
            ]);
            return res.status(200).json({ ok: true, msg: 'Script eliminado.' });
        } catch (err) {
            return res.status(500).json({ msg: 'Error al eliminar el script.' });
        }
    }
}
