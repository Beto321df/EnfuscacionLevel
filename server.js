const http = require('http');
const fs = require('fs');
const path = require('path');

const obfuscate = require('./api/obfuscate');
const scripts = require('./api/scripts');
const getScript = require('./api/get-script');

const PORT = Number(process.env.PORT || 10000);
const HOST = '0.0.0.0';
const INDEX = path.join(__dirname, 'index.html');
const DB_URL = 'https://loaderz1-default-rtdb.firebaseio.com';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,DELETE,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON request body.');
    error.statusCode = 400;
    throw error;
  }
}

async function nativeLogin(req, res) {
  if (req.method !== 'POST') {
    return json(res, 405, { ok: false, msg: 'Método no permitido' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return json(res, error.statusCode || 400, { ok: false, msg: error.message });
  }

  const { mode, user, pass, pin, deviceId } = body || {};

  if (!user || !pass || !pin) {
    return json(res, 400, { ok: false, msg: 'Todos los campos son obligatorios.' });
  }

  const cleanUser = String(user).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleanUser) {
    return json(res, 400, { ok: false, msg: 'Usuario inválido.' });
  }

  const secret = process.env.FIREBASE_SECRET;
  if (!secret) {
    console.error('FIREBASE_SECRET is not configured.');
    return json(res, 500, { ok: false, msg: 'El servidor no tiene configurado FIREBASE_SECRET.' });
  }

  const userUrl = DB_URL + '/users/' + encodeURIComponent(cleanUser) + '/auth.json?auth=' + encodeURIComponent(secret);

  try {
    if (mode === 'signup') {
      if (deviceId) {
        const devUrl = DB_URL + '/devices/' + encodeURIComponent(String(deviceId)) + '/accounts.json?auth=' + encodeURIComponent(secret);
        const devRes = await fetch(devUrl);
        if (!devRes.ok) {
          return json(res, 502, { ok: false, msg: 'Firebase rechazó la consulta del dispositivo.' });
        }
        const devAccs = (await devRes.json()) || {};
        if (Object.keys(devAccs).length >= 2 && !devAccs[cleanUser]) {
          return json(res, 400, { ok: false, msg: 'Límite alcanzado: Máximo 2 cuentas por dispositivo.' });
        }
      }

      const checkRes = await fetch(userUrl);
      if (!checkRes.ok) {
        return json(res, 502, { ok: false, msg: 'Firebase rechazó la consulta del usuario.' });
      }

      const existing = await checkRes.json();
      if (existing && existing.pass) {
        return json(res, 400, { ok: false, msg: 'El usuario ya existe.' });
      }

      const saveRes = await fetch(userUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pass: String(pass),
          pin: String(pin),
          createdAt: Date.now()
        })
      });

      if (!saveRes.ok) {
        console.error('Firebase signup failed:', saveRes.status, await saveRes.text().catch(() => ''));
        return json(res, 502, { ok: false, msg: 'Firebase rechazó el registro.' });
      }

      if (deviceId) {
        const deviceAccountUrl =
          DB_URL + '/devices/' + encodeURIComponent(String(deviceId)) +
          '/accounts/' + encodeURIComponent(cleanUser) +
          '.json?auth=' + encodeURIComponent(secret);

        await fetch(deviceAccountUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: 'true'
        });
      }

      return json(res, 200, { ok: true, msg: 'Cuenta registrada correctamente.' });
    }

    if (mode === 'signin') {
      const checkRes = await fetch(userUrl);

      if (!checkRes.ok) {
        console.error('Firebase login lookup failed:', checkRes.status);
        return json(res, 502, { ok: false, msg: 'Firebase no pudo consultar la cuenta.' });
      }

      const userData = await checkRes.json();

      if (!userData || !userData.pass) {
        return json(res, 404, { ok: false, msg: 'Usuario no encontrado.' });
      }

      if (String(userData.pass).trim() !== String(pass).trim()) {
        return json(res, 401, { ok: false, msg: 'Contraseña incorrecta.' });
      }

      if (String(userData.pin).trim() !== String(pin).trim()) {
        return json(res, 401, { ok: false, msg: 'PIN incorrecto.' });
      }

      return json(res, 200, { ok: true, msg: 'Login exitoso.' });
    }

    return json(res, 400, { ok: false, msg: 'Modo inválido.' });
  } catch (error) {
    console.error('Login error:', error);
    return json(res, 500, { ok: false, msg: 'Error de servidor.' });
  }
}

function wrapHandlerResponse(res) {
  return {
    status(code) {
      res.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
    },
    json(value) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(value));
    },
    send(value) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end(value == null ? '' : String(value));
    },
    end(value) {
      res.end(value);
    }
  };
}

async function callModule(handler, req, res, url) {
  req.query = Object.fromEntries(url.searchParams.entries());

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.body = await readJsonBody(req);
  } else {
    req.body = {};
  }

  await handler(req, wrapHandlerResponse(res));

  if (!res.writableEnded) {
    json(res, 500, { ok: false, msg: 'API terminó sin enviar una respuesta.' });
  }
}

async function dispatch(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'nyvex',
      runtime: 'node',
      port: PORT
    });
  }

  if (url.pathname === '/') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return fs.createReadStream(INDEX).pipe(res);
  }

  if (url.pathname === '/api/login') {
    return nativeLogin(req, res);
  }

  const handlers = {
    '/api/obfuscate': obfuscate,
    '/api/scripts': scripts,
    '/api/get-script': getScript
  };

  const handler = handlers[url.pathname];
  if (!handler) {
    return json(res, 404, { ok: false, msg: 'Ruta no encontrada.' });
  }

  try {
    return await callModule(handler, req, res, url);
  } catch (error) {
    console.error('API request failure:', error);
    if (!res.writableEnded) {
      return json(res, error.statusCode || 500, {
        ok: false,
        msg: error.statusCode === 400 ? error.message : 'Error interno del servidor.'
      });
    }
  }
}

const server = http.createServer((req, res) => {
  dispatch(req, res).catch(error => {
    console.error('Unhandled request error:', error);
    if (!res.writableEnded) {
      json(res, 500, { ok: false, msg: 'Error interno del servidor.' });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log('Nyvex listening on ' + HOST + ':' + PORT);
});
