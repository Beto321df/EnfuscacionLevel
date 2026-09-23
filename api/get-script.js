const CodeGenerator = require('../src/generator/visualCodegen.js');
const { wrapVisual } = require('../src/zlang/visualTransport');

module.exports = async function handler(req, res) {
    const { id } = req.query;
    const accept = (req.headers['accept'] || '').toLowerCase();
    const ua = (req.headers['user-agent'] || '').toLowerCase();
    const isSecHeader = !!req.headers['sec-ch-ua'];

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    const isBrowser = isSecHeader || accept.includes('text/html');
    const isBot = ua.includes('discord') || ua.includes('python') ||
                  ua.includes('axios') || ua.includes('node') ||
                  ua.includes('curl') || ua.includes('wget') ||
                  ua.includes('go-http-client') || ua.includes('java') ||
                  ua.includes('bot') || ua.includes('crawler');

    if (isBrowser || isBot) {
        return res.status(403).send('-- Z Protector: acceso denegado.');
    }

    if (!id) {
        return res.status(400).send('-- Z Protector: ID no proporcionado.');
    }

    try {
        const cleanId = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
        if (!cleanId) return res.status(400).send('-- Z Protector: ID inválido.');

        const DB_URL = 'https://loaderz1-default-rtdb.firebaseio.com';
        const SECRET = process.env.FIREBASE_SECRET;
        const fbRes = await fetch(`${DB_URL}/scripts/${cleanId}.json?auth=${SECRET}`);
        const data = await fbRes.json();

        if (!fbRes.ok || !data || data.error) {
            return res.status(404).send('-- Z Protector: script no encontrado.');
        }

        const stored = typeof data === 'string' ? data : data.code;
        if (typeof stored !== 'string' || !stored.trim()) {
            return res.status(404).send('-- Z Protector: script vacío o inválido.');
        }

        // NeverDD treat an existing Z3 loader as source code. This recognizes the
        // legacy formats plus the new mixed visual transport and edit marker.
        const isCompactX7Loader =
            stored.startsWith('return(function(') &&
            stored.includes('return v.v[1]') &&
            /}\):[A-Za-z]\(\.\.\.\)$/.test(stored);

        const isZ3Loader =
            isCompactX7Loader ||
            stored.includes('--Z3M:') ||
            stored.includes('return(function(P)local T=') ||
            stored.includes('return(function(t,...)') ||
            stored.includes('return setmetatable({p=') ||
            stored.includes('return ({p=') ||
            (stored.includes('Z3 visual payload corto') && stored.includes('Z3 visual checksum')) ||
            (stored.includes('Z3 opcode') && stored.includes('__z')) ||
            stored.includes('Z3-stable') ||
            (stored.includes('return({L={') && stored.includes('E=function') && stored.includes('R=function')) ||
            (stored.includes('Z3 visual header') && stored.includes('Z3 visual checksum'));

        const isX71 = stored.startsWith('return ({p=');
        const isX7 = stored.startsWith('return setmetatable({p=');
        const code = (isX7 || isX71) ? stored : (isZ3Loader ? (stored.startsWith('return(') ? stored : wrapVisual(stored)) : new CodeGenerator().generate(stored));

        if (typeof code !== 'string' || !code.trim()) {
            return res.status(500).send('-- Z Protector: el motor no generó código protegido.');
        }

        return res.status(200).send(code);
    } catch (err) {
        return res.status(500).send('-- Z Protector: error interno del servidor.');
    }
}
