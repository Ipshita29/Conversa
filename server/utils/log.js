// Logging that never prints a secret: tokens, app secrets, codes and authorization headers are replaced before anything is written.
const SECRET = /(access_token|client_secret|appsecret_proof|authorization|bearer|token|code|secret|key)(["'\s:=]+)([^\s"',&}]+)/gi;
export const redact = (v) => String(v ?? '').replace(/Bearer\s+[^\s"',]+/gi, 'Bearer [redacted]').replace(SECRET, '$1$2[redacted]');
const line = (level, scope, msg, extra) => console[level](`[${scope}] ${redact(msg)}${extra ? ` ${redact(typeof extra === 'string' ? extra : JSON.stringify(extra))}` : ''}`);
export const log = {
  info: (scope, msg, extra) => line('log', scope, msg, extra),
  warn: (scope, msg, extra) => line('warn', scope, msg, extra),
  error: (scope, msg, extra) => line('error', scope, msg, extra),
};
