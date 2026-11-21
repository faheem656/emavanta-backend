/**
 * Zero-dependency .env loader.
 *
 * Why this exists: the API used to read `process.env` only, so a `.env` file was
 * silently ignored — you could paste a MongoDB Atlas URI into `.env` and the app
 * would keep running on the in-memory store without telling you. This loads the
 * backend configuration at boot; the frontend has its own configuration.
 *
 * Search order (first value wins, real environment variables always win):
 *   backend/.env.local, backend/.env; process environment wins
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

let done = false;
let loaded = { files: [], keys: [] };

const parse = text => {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip matching quotes, keep everything else verbatim (passwords may contain #).
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash > -1) value = value.slice(0, hash).trim();
    }
    value = value.replace(/\\n/g, '\n');
    if (key) out[key] = value;
  }
  return out;
};

export const parseEnv = text => parse(text);

export function loadEnv({ force = false } = {}) {
  if (done && !force) return loaded;
  done = true;
  const candidates = [
    path.join(REPO_ROOT, '.env.local'),
    path.join(REPO_ROOT, '.env')
  ];
  const envExample = path.join(REPO_ROOT, '.env.example');
  const files = [];
  const keys = [];
  const sources = Object.fromEntries(Object.keys(process.env).map(key => [key, 'process environment']));
  for (const file of candidates) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const parsed = parse(text);
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) { process.env[key] = value; keys.push(key); sources[key] = path.relative(REPO_ROOT, file); }
    }
    files.push(path.relative(REPO_ROOT, file));
  }
  loaded = { files, keys, sources, example: fs.existsSync(envExample) ? '.env.example' : null };
  return loaded;
}

// Do not print connection strings: malformed credentials may defeat partial redaction.
export const maskUri = uri => uri ? '•••• (connection string hidden)' : null;

// Common copy/paste errors should fail closed, not be silently rewritten.
export function mongoUriConfigurationIssue(value) {
  const raw = String(value || '').trim();
  if (/^MONGODB_URI\s*=/i.test(raw) || /:\/\/MONGODB_URI\s*=/i.test(raw))
    return 'MONGODB_URI was pasted inside its own value. In backend/.env use MONGODB_URI=mongodb+srv://USER:PASSWORD@HOST/DATABASE only once.';
  if (/^mongodb(?:\+srv)?:\/\/.*mongodb(?:\+srv)?:\/\//i.test(raw))
    return 'The connection string contains a repeated mongodb:// or mongodb+srv:// prefix. Copy the Atlas URI once.';
  return null;
}

/** Extract safe, non-secret diagnostics. A malformed host is never echoed. */
export const describeMongoUri = uri => {
  if (!uri) return { configured: false };
  const raw = String(uri).trim();
  const srv = raw.startsWith('mongodb+srv://');
  const scheme = srv ? 'mongodb+srv' : raw.startsWith('mongodb://') ? 'mongodb' : 'unknown';
  let host = null, database = null;
  if (scheme !== 'unknown' && !mongoUriConfigurationIssue(raw)) {
    try {
      const afterScheme = raw.replace(/^mongodb(\+srv)?:\/\//, '');
      const authorityAndPath = afterScheme.split('?')[0];
      const authority = authorityAndPath.split('/')[0];
      const candidate = authority.slice(authority.lastIndexOf('@') + 1);
      const safeHosts = /^(?:[a-z0-9.-]+(?::[0-9]{1,5})?|\[[a-f0-9:]+\](?::[0-9]{1,5})?)(?:,(?:[a-z0-9.-]+(?::[0-9]{1,5})?|\[[a-f0-9:]+\](?::[0-9]{1,5})?))*$/i;
      if (safeHosts.test(candidate) && candidate.length <= 255 && !authorityAndPath.slice(authority.length).includes('@')) host = candidate;
      const dbPart = authorityAndPath.split('/')[1];
      if (dbPart && /^[a-z0-9_.-]+$/i.test(dbPart)) database = dbPart;
    } catch { /* malformed values remain hidden */ }
  }
  return { configured: true, scheme, host, database, srv, masked: maskUri(raw) };
};
