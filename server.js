const http = require('http');
const fs = require('fs');
const path = require('path');

const login = require('./api/login');
const obfuscate = require('./api/obfuscate');
const scripts = require('./api/scripts');
const getScript = require('./api/get-script');

const PORT = Number(process.env.PORT || 3000);
const INDEX = path.join(__dirname, 'index.html');

function sendHealth(res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, service: 'nyvex', runtime: 'node' }));
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST,DELETE,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function wrapResponse(res) {
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
      res.end(value == null ? '' : String(value));
    }
  };
}

async function body(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  if ((req.headers['content-type'] || '').includes('application/json')) return JSON.parse(text);
  return {};
}

async function run(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return fs.createReadStream(INDEX).pipe(res);
  }

  const routes = {
    '/api/login': login,
    '/api/obfuscate': obfuscate,
    '/api/scripts': scripts,
    '/api/get-script': getScript
  };

  const handler = routes[url.pathname];
  if (url.pathname === '/health') {
    return sendHealth(res);
  }

  if (!handler) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ ok: false, msg: 'Ruta no encontrada.' }));
  }

  try {
    req.query = Object.fromEntries(url.searchParams.entries());
    req.body = await body(req);
    await handler(req, wrapResponse(res));
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify({ ok: false, msg: 'API terminó sin enviar una respuesta.' }));
    }
    return;
  } catch (error) {
    console.error(error);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ ok: false, msg: 'Error interno del servidor.' }));
    }
  }
}

http.createServer((req, res) => run(req, res)).listen(PORT, '0.0.0.0', () => {
  console.log('Nyvex listening on port ' + PORT);
});
