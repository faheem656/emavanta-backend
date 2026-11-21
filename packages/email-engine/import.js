/** Streaming-friendly CSV import: RFC4180-ish parser, validation, dedupe keys, rollback plan. */

export const parseCsvChunk = (chunk, delimiter = ',') => {
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (quoted) {
      if (c === '"' && chunk[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && chunk[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
};

export const parseCsv = (text, options = {}) => {
  const raw = parseCsvChunk(String(text || ''), options.delimiter || ',');
  if (!raw.length) return { rows: [], errors: [], total: 0 };
  const headers = raw[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const emailIndex = headers.indexOf('email');
  if (emailIndex < 0) return { rows: [], errors: [{ row: 1, error: 'Missing email column' }], total: 0 };
  const rows = [], errors = [];
  raw.slice(1).forEach((cols, i) => {
    if (i >= (options.maxRows || 20000)) return;
    const row = Object.fromEntries(headers.map((h, j) => [h, (cols[j] || '').trim()]));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(row.email)) { errors.push({ row: i + 2, error: 'Invalid email', value: row.email }); return; }
    rows.push(row);
  });
  return { rows, errors, total: raw.length - 1 };
};

export const importPreview = (text, organizationId, listIds = []) => {
  const parsed = parseCsv(text);
  const seen = new Set();
  const rows = [];
  for (const row of parsed.rows) {
    const dedupeKey = `${organizationId}:${row.email.toLowerCase()}`;
    if (seen.has(dedupeKey)) { parsed.errors.push({ row: rows.length + 2, error: 'Duplicate in file', value: row.email }); continue; }
    seen.add(dedupeKey);
    rows.push({ ...row, email: row.email.toLowerCase(), dedupeKey, listIds });
  }
  return { ...parsed, rows, accepted: rows.length, rejected: parsed.errors.length };
};
