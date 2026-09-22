const http = require('http');
const fs = require('fs');
const path = require('path');

const login = require('./api/login');
const obfuscate = require('./api/obfuscate');
const scripts = require('./api/scripts');
const getScript = require('./api/get-script');

const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const WEB_ROOT = path.join(__dirname, 'Servidor');
const INDEX = path.join(WEB_ROOT, 'index.html');
const WEB_ASSETS = Object.freeze({
  '/Servidor/style.css': { file: path.join(WEB_ROOT, 'style.css'), type: 'text/css; charset=utf-8' },
  '/Servidor/app.js': { file: path.join(WEB_ROOT, 'app.js'), type: 'application/javascript; charset=utf-8' }
});
const PACKAGE = require('./package.json');
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST,PUT,PATCH,DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store');
  res.end(String(body ?? ''));
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error('Request body exceeds the 8 MB limit.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

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

function wrapHandlerResponse(res) {
  return {
    status(code) {
      res.statusCode = Number(code) || 200;
      return this;
    },
    setHeader(name, value) {
      res.setHeader(name, value);
      return this;
    },
    getHeader(name) {
      return res.getHeader(name);
    },
    removeHeader(name) {
      res.removeHeader(name);
      return this;
    },
    json(value) {
      if (res.writableEnded) return this;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(value));
      return this;
    },
    send(value) {
      if (res.writableEnded) return this;
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.setHeader('Cache-Control', 'no-store');
      res.end(value == null ? '' : String(value));
      return this;
    },
    end(value) {
      if (!res.writableEnded) res.end(value);
      return this;
    }
  };
}

async function callApi(handler, req, res, url) {
  req.query = Object.fromEntries(url.searchParams.entries());

  if (req.method === 'GET' || req.method === 'HEAD') {
    req.body = {};
  } else {
    req.body = await readJsonBody(req);
  }

  await handler(req, wrapHandlerResponse(res));

  if (!res.writableEnded) {
    sendJson(res, 500, {
      ok: false,
      msg: 'API handler finished without sending a response.',
      route: url.pathname
    });
  }
}

async function serveIndex(req, res) {
  try {
    const stat = await fs.promises.stat(INDEX);
    if (!stat.isFile()) throw new Error('index.html is not a file');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (req.method === 'HEAD') return res.end();

    fs.createReadStream(INDEX)
      .on('error', error => {
        console.error('index.html read error:', error);
        if (!res.writableEnded) sendText(res, 500, 'Internal Server Error');
      })
      .pipe(res);
  } catch (error) {
    console.error('index.html serve error:', error);
    sendText(res, 500, 'index.html could not be served.');
  }
}

async function dispatch(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'nyvex',
      runtime: 'node',
      version: PACKAGE.version,
      port: PORT
    });
  }

  if (pathname === '/api') {
    return sendJson(res, 200, {
      ok: true,
      service: 'nyvex',
      routes: ['/api/login', '/api/obfuscate', '/api/scripts', '/api/get-script']
    });
  }

  if (pathname === '/') {
    return serveIndex(req, res);
  }

  const asset = WEB_ASSETS[pathname];
  if (asset) {
    try {
      const data = await fs.promises.readFile(asset.file);
      res.statusCode = 200;
      res.setHeader('Content-Type', asset.type);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end(data);
    } catch (error) {
      console.error('web asset serve error:', pathname, error);
      return sendText(res, 404, 'Web asset not found.');
    }
  }

  if (pathname === '/favicon.png') {
    try {
      const faviconPath = path.join(__dirname, 'favicon.png');
      const data = await fs.promises.readFile(faviconPath);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      return res.end(data);
    } catch (error) {
      console.error('favicon serve error:', error);
      return sendText(res, 404, 'Favicon not found.');
    }
  }

  const handlers = {
    '/api/login': login,
    '/api/obfuscate': obfuscate,
    '/api/scripts': scripts,
    '/api/get-script': getScript
  };

  const handler = handlers[pathname];
  if (!handler) {
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { ok: false, msg: 'API route not found.', route: pathname });
    }
    return sendText(res, 404, 'Not Found');
  }

  try {
    return await callApi(handler, req, res, url);
  } catch (error) {
    console.error('API request failure:', pathname, error);
    if (!res.writableEnded) {
      const status = Number(error && error.statusCode) || 500;
      return sendJson(res, status, {
        ok: false,
        msg: status === 400 || status === 413
          ? String(error.message || 'Invalid request.')
          : 'Internal server error.',
        route: pathname
      });
    }
  }
}

const server = http.createServer((req, res) => {
  dispatch(req, res).catch(error => {
    console.error('Unhandled request error:', error);
    if (!res.writableEnded) {
      sendJson(res, 500, { ok: false, msg: 'Internal server error.' });
    }
  });
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

server.listen(PORT, HOST, () => {
  console.log('Nyvex listening on ' + HOST + ':' + PORT);
});
