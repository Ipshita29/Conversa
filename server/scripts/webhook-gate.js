// A narrow door for local testing with a public tunnel (cloudflared). Conversa has no login, so the whole API must never be reachable from the
// internet. This proxy listens only on 127.0.0.1 and forwards ONLY Meta's two webhook routes to the local API; every other path is a 404.
// The webhook POST is still protected by Meta's X-Hub-Signature-256 check and the GET handshake by the verify token.
//   node scripts/webhook-gate.js            (then)   cloudflared tunnel --url http://127.0.0.1:5056
import http from 'node:http';

const PORT = Number(process.env.GATE_PORT || 5056);
const TARGET = { host: '127.0.0.1', port: Number(process.env.PORT || 5000) };
const ALLOWED = /^\/api\/webhooks\/(whatsapp|instagram)(\?[^\s]*)?$/;
const MAX = 256 * 1024;

const note = (req, status) => console.log(`${new Date().toISOString()} ${req.method} ${String(req.url).split('?')[0]} -> ${status}`); // method, path and status only: never a query, header or body

http.createServer((req, res) => {
  const ok = ALLOWED.test(req.url ?? '') && (req.method === 'GET' || req.method === 'POST');
  if (!ok) { note(req, 404); res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":{"code":"NOT_FOUND","message":"Not found."}}'); }
  let size = 0;
  const up = http.request({ ...TARGET, method: req.method, path: req.url, headers: { ...req.headers, host: `${TARGET.host}:${TARGET.port}` } }, (r) => { note(req, r.statusCode); res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  up.on('error', () => { note(req, 502); if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('data', (c) => { size += c.length; if (size > MAX) { up.destroy(); res.writeHead(413); res.end(); req.destroy(); } });
  req.pipe(up);
}).listen(PORT, '127.0.0.1', () => console.log(`Webhook gate on 127.0.0.1:${PORT} -> ${TARGET.host}:${TARGET.port} (webhook routes only)`));
