module.exports = async function handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            ok: false,
            msg: 'Método no permitido'
        });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const user = typeof body.user === 'string' ? body.user : '';
    const pass = typeof body.pass === 'string' ? body.pass : '';
    const pin = typeof body.pin === 'string' ? body.pin : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';

    if (!user || !pass || !pin) {
        return res.status(400).json({
            ok: false,
            msg: 'Todos los campos son obligatorios.'
        });
    }

    const cleanUser = user.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanUser || cleanUser !== user) {
        return res.status(400).json({
            ok: false,
            msg: 'Usuario inválido.'
        });
    }

    const DB_URL = 'https://loaderz1-default-rtdb.firebaseio.com';
    const SECRET = process.env.FIREBASE_SECRET;

    if (!SECRET) {
        console.error('FIREBASE_SECRET is not configured.');
        return res.status(500).json({
            ok: false,
            msg: 'El servidor no tiene configurado FIREBASE_SECRET.'
        });
    }

    const userRefUrl =
        DB_URL +
        '/users/' +
        encodeURIComponent(cleanUser) +
        '/auth.json?auth=' +
        encodeURIComponent(SECRET);

    try {
        if (mode === 'signup') {
            if (deviceId) {
                const devUrl =
                    DB_URL +
                    '/devices/' +
                    encodeURIComponent(deviceId) +
                    '/accounts.json?auth=' +
                    encodeURIComponent(SECRET);

                const devRes = await fetch(devUrl);

                if (!devRes.ok) {
                    console.error('Firebase device lookup failed:', devRes.status);
                    return res.status(502).json({
                        ok: false,
                        msg: 'Firebase rechazó la consulta del dispositivo.'
                    });
                }

                const devAccs = (await devRes.json()) || {};
                if (Object.keys(devAccs).length >= 2 && !devAccs[cleanUser]) {
                    return res.status(400).json({
                        ok: false,
                        msg: 'Límite alcanzado: Máximo 2 cuentas por dispositivo.'
                    });
                }
            }

            const checkRes = await fetch(userRefUrl);

            if (!checkRes.ok) {
                console.error('Firebase signup lookup failed:', checkRes.status);
                return res.status(502).json({
                    ok: false,
                    msg: 'Firebase rechazó la consulta del usuario.'
                });
            }

            const existingData = await checkRes.json();

            if (existingData && existingData.pass) {
                return res.status(400).json({
                    ok: false,
                    msg: 'El usuario ya existe.'
                });
            }

            const saveRes = await fetch(userRefUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pass,
                    pin,
                    createdAt: Date.now()
                })
            });

            if (!saveRes.ok) {
                console.error('Firebase signup write failed:', saveRes.status);
                return res.status(502).json({
                    ok: false,
                    msg: 'Firebase rechazó el registro.'
                });
            }

            if (deviceId) {
                const deviceAccountUrl =
                    DB_URL +
                    '/devices/' +
                    encodeURIComponent(deviceId) +
                    '/accounts/' +
                    encodeURIComponent(cleanUser) +
                    '.json?auth=' +
                    encodeURIComponent(SECRET);

                const deviceWrite = await fetch(deviceAccountUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: 'true'
                });

                if (!deviceWrite.ok) {
                    console.error('Firebase device write failed:', deviceWrite.status);
                }
            }

            return res.status(200).json({
                ok: true,
                msg: 'Cuenta registrada correctamente.'
            });
        }

        if (mode === 'signin') {
            const checkRes = await fetch(userRefUrl);

            if (!checkRes.ok) {
                console.error('Firebase login lookup failed:', checkRes.status);
                return res.status(502).json({
                    ok: false,
                    msg: 'Firebase no pudo consultar la cuenta.'
                });
            }

            const userData = await checkRes.json();

            if (!userData || !userData.pass) {
                return res.status(404).json({
                    ok: false,
                    msg: 'Usuario no encontrado.'
                });
            }

            if (String(userData.pass).trim() !== pass.trim()) {
                return res.status(401).json({
                    ok: false,
                    msg: 'Contraseña incorrecta.'
                });
            }

            if (String(userData.pin).trim() !== pin.trim()) {
                return res.status(401).json({
                    ok: false,
                    msg: 'PIN incorrecto.'
                });
            }

            return res.status(200).json({
                ok: true,
                msg: 'Login exitoso.'
            });
        }

        return res.status(400).json({
            ok: false,
            msg: 'Modo inválido.'
        });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({
            ok: false,
            msg: 'Error de servidor.'
        });
    }
};
