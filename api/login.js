export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, msg: 'Método no permitido' });
    }

    const { mode, user, pass, pin, deviceId } = req.body;

    if (!user || !pass || !pin) {
        return res.status(400).json({ ok: false, msg: 'Todos los campos son obligatorios.' });
    }

    const cleanUser = user.replace(/[^a-zA-Z0-9_-]/g, "");
    const DB_URL = "https://loaderz1-default-rtdb.firebaseio.com";
    const SECRET = process.env.FIREBASE_SECRET;

    try {
        const userRefUrl = `${DB_URL}/users/${cleanUser}/auth.json?auth=${SECRET}`;

        if (mode === 'signup') {
            if (deviceId) {
                const devUrl = `${DB_URL}/devices/${deviceId}/accounts.json?auth=${SECRET}`;
                const devRes = await fetch(devUrl);
                const devAccs = await devRes.json() || {};
                const accCount = Object.keys(devAccs).length;

                if (accCount >= 2 && !devAccs[cleanUser]) {
                    return res.status(400).json({ ok: false, msg: 'Límite alcanzado: Máximo 2 cuentas por dispositivo.' });
                }
            }

            const checkRes = await fetch(userRefUrl);
            const existingData = await checkRes.json();

            if (existingData && existingData.pass) {
                return res.status(400).json({ ok: false, msg: 'El usuario ya existe.' });
            }

            const saveRes = await fetch(userRefUrl, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pass: String(pass), pin: String(pin), createdAt: Date.now() })
            });

            if (saveRes.ok) {
                if (deviceId) {
                    await fetch(`${DB_URL}/devices/${deviceId}/accounts/${cleanUser}.json?auth=${SECRET}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(true)
                    });
                }
                return res.status(200).json({ ok: true, msg: 'Cuenta registrada correctamente.' });
            } else {
                return res.status(500).json({ ok: false, msg: 'Error al registrar usuario.' });
            }

        } else if (mode === 'signin') {
            const checkRes = await fetch(userRefUrl);
            const userData = await checkRes.json();

            if (!userData || !userData.pass) {
                return res.status(404).json({ ok: false, msg: 'Usuario no encontrado.' });
            }

            if (String(userData.pass).trim() !== String(pass).trim()) {
                return res.status(401).json({ ok: false, msg: 'Contraseña incorrecta.' });
            }

            if (String(userData.pin).trim() !== String(pin).trim()) {
                return res.status(401).json({ ok: false, msg: 'PIN incorrecto.' });
            }

            return res.status(200).json({ ok: true, msg: 'Login exitoso.' });
        } else {
            return res.status(400).json({ ok: false, msg: 'Modo inválido.' });
        }
    } catch (error) {
        return res.status(500).json({ ok: false, msg: 'Error de servidor.' });
    }
}
