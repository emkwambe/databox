// Post-process a generated pipelinekit-demo SQL dump so it satisfies the
// PipelineKit postgres-to-duckdb blueprint contracts.
//
// The RealityDB engine cannot express sequential integer keys, unique
// emails, bounded date ranges, cross-table temporal ordering, or a
// constant column value. Rather than change the engine (owned elsewhere),
// this script rewrites the generated INSERT rows in place. It is
// deterministic: same input + same seed produces byte-identical output.
//
// Usage: node fix-pipelinekit-demo.mjs <input.sql> [output.sql]

import { readFileSync, writeFileSync } from 'fs';

const INPUT = process.argv[2];
const OUTPUT = process.argv[3] || INPUT;
const SEED = 42;
const LOADED_AT = '2026-07-27 00:00:00+00'; // Transform 6 constant
const BATCH_SIZE = 100;

if (!INPUT) {
  console.error('usage: node fix-pipelinekit-demo.mjs <input.sql> [output.sql]');
  process.exit(1);
}

// Seeded RNG (mulberry32) — determinism is the whole point of this script.
function makeRng(seed) {
  let s = seed;
  return () => {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);

const sql = readFileSync(INPUT, 'utf8');

// ── Parse ────────────────────────────────────────────────────────────
// Statements look like:
//   INSERT INTO "orders" ("order_id", ...) VALUES
//     (1, 'x', ...),
//     (2, 'y', ...);
// A table's rows are split across many statements (batches of 100).

const BLOCK_RE = /INSERT INTO "(customers|orders)" \(([^)]+)\) VALUES\n([\s\S]*?);\n/g;

function splitTuples(body) {
  const tuples = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === "'" && body[i + 1] === "'") { cur += "''"; i++; continue; }
      if (ch === "'") inStr = false;
      cur += ch; continue;
    }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') { depth++; if (depth === 1) { cur = ''; continue; } }
    if (ch === ')') { depth--; if (depth === 0) { tuples.push(cur); continue; } }
    if (depth >= 1) cur += ch;
  }
  return tuples;
}

function splitValues(tuple) {
  const vals = [];
  let v = '', inStr = false;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];
    if (inStr) {
      if (ch === "'" && tuple[i + 1] === "'") { v += "'"; i++; continue; }
      if (ch === "'") { inStr = false; continue; }
      v += ch; continue;
    }
    if (ch === "'") { inStr = true; continue; }
    if (ch === ',') { vals.push(v.trim()); v = ''; continue; }
    v += ch;
  }
  vals.push(v.trim());
  return vals;
}

const tables = {};        // name -> { columns, rows }
const blockSpans = [];    // { table, start, end }
let m;
while ((m = BLOCK_RE.exec(sql)) !== null) {
  const [full, table, colList, body] = m;
  const columns = colList.split(',').map((c) => c.trim().replace(/"/g, ''));
  if (!tables[table]) tables[table] = { columns, rows: [] };
  for (const t of splitTuples(body)) {
    const vals = splitValues(t);
    const row = {};
    columns.forEach((c, i) => { row[c] = vals[i]; });
    tables[table].rows.push(row);
  }
  blockSpans.push({ table, start: m.index, end: m.index + full.length });
}

const customers = tables.customers?.rows ?? [];
const orders = tables.orders?.rows ?? [];
if (!customers.length || !orders.length) {
  console.error('No customers/orders INSERT rows found — is this the right file?');
  process.exit(1);
}

const log = [];

// ── Transform 1 — sequential integer IDs ─────────────────────────────
const custIdMap = new Map();
customers.forEach((r, i) => {
  const newId = i + 1;
  custIdMap.set(r.customer_id, newId);
  r.customer_id = String(newId);
});
let remapped = 0, unmapped = 0;
orders.forEach((r, i) => {
  r.order_id = String(i + 1);
  const mapped = custIdMap.get(r.customer_id);
  if (mapped === undefined) { unmapped++; } else { r.customer_id = String(mapped); remapped++; }
});
if (unmapped > 0) {
  console.error(`FATAL: ${unmapped} orders reference a customer_id with no match — refusing to write a file with broken FKs.`);
  process.exit(1);
}
log.push(`T1 sequential IDs: customers 1..${customers.length}, orders 1..${orders.length}, ${remapped} FKs remapped`);

// ── Transform 2 — unique emails ──────────────────────────────────────
const seenEmail = new Map(); // email -> times seen
let deduped = 0;
for (const r of customers) {
  const email = r.email;
  if (!seenEmail.has(email)) { seenEmail.set(email, 1); continue; }
  const n = seenEmail.get(email) + 1;
  seenEmail.set(email, n);
  const at = email.lastIndexOf('@');
  let candidate = `${email.slice(0, at)}_${n}${email.slice(at)}`;
  // Guard against the suffixed form itself colliding.
  let extra = n;
  while (seenEmail.has(candidate)) {
    extra++;
    candidate = `${email.slice(0, at)}_${extra}${email.slice(at)}`;
  }
  seenEmail.set(candidate, 1);
  r.email = candidate;
  deduped++;
}
log.push(`T2 unique emails: ${deduped} duplicates suffixed`);

// ── Transform 3 — date ranges ────────────────────────────────────────
const CUST_MIN = Date.parse('2023-06-01T00:00:00Z');
const CUST_MAX = Date.parse('2024-06-30T23:59:59Z');
const ORD_MIN = Date.parse('2024-01-01T00:00:00Z');
const ORD_MAX = Date.parse('2026-07-01T23:59:59Z');

const toSqlTs = (ms) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '+00');

const custDates = customers.map(() => CUST_MIN + Math.floor(rng() * (CUST_MAX - CUST_MIN)));
const ordDates = orders.map(() => ORD_MIN + Math.floor(rng() * (ORD_MAX - ORD_MIN)));
log.push(`T3 date ranges: customers ${new Date(CUST_MIN).toISOString().slice(0, 10)}..${new Date(CUST_MAX).toISOString().slice(0, 10)}, orders ${new Date(ORD_MIN).toISOString().slice(0, 10)}..${new Date(ORD_MAX).toISOString().slice(0, 10)}`);

// ── Transform 4 — monotonic order dates by order_id ──────────────────
// Rows are already in order_id order (T1 numbered them by position), so
// sorting the drawn dates and assigning positionally makes created_at
// non-decreasing as order_id increases.
ordDates.sort((a, b) => a - b);
orders.forEach((r, i) => { r.created_at = toSqlTs(ordDates[i]); });
log.push(`T4 monotonic ordering: order 1 = ${orders[0].created_at}, order ${orders.length} = ${orders[orders.length - 1].created_at}`);

// ── Transform 5 — customer created >= 30 days before first order ─────
const DAY = 24 * 60 * 60 * 1000;
const firstOrderMs = new Map();
orders.forEach((r) => {
  const t = Date.parse(r.created_at.replace(' ', 'T').replace('+00', 'Z'));
  const cid = r.customer_id;
  if (!firstOrderMs.has(cid) || t < firstOrderMs.get(cid)) firstOrderMs.set(cid, t);
});
let pulled = 0;
customers.forEach((r, i) => {
  let created = custDates[i];
  const first = firstOrderMs.get(r.customer_id);
  if (first !== undefined) {
    const deadline = first - 30 * DAY;
    if (created > deadline) {
      // Land somewhere in the 30–210 days before the first order.
      created = deadline - Math.floor(rng() * 180 * DAY);
      pulled++;
    }
  }
  r.created_at = toSqlTs(created);
});
log.push(`T5 customer-before-order: ${pulled} of ${firstOrderMs.size} ordering customers pulled earlier`);

// ── Transform 6 — constant _loaded_at ────────────────────────────────
let stamped = 0;
for (const r of [...customers, ...orders]) {
  if ('_loaded_at' in r) { r._loaded_at = LOADED_AT; stamped++; }
}
log.push(`T6 constant _loaded_at: ${stamped} rows stamped ${LOADED_AT}`);

// ── Re-emit ──────────────────────────────────────────────────────────
const INT_COLS = new Set(['customer_id', 'order_id', 'amount']);
function literal(col, value) {
  if (value === 'NULL' || value === null || value === undefined) return 'NULL';
  if (INT_COLS.has(col)) return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function renderInserts(table) {
  const { columns, rows } = tables[table];
  const colList = columns.map((c) => `"${c}"`).join(', ');
  const parts = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const tuples = batch.map((r) => `  (${columns.map((c) => literal(c, r[c])).join(', ')})`);
    parts.push(`INSERT INTO "${table}" (${colList}) VALUES\n${tuples.join(',\n')};\n`);
  }
  return parts.join('');
}

// Replace the first block of each table with all of its regenerated
// statements and drop the remaining blocks, working back to front so
// earlier offsets stay valid.
const rendered = { customers: renderInserts('customers'), orders: renderInserts('orders') };
const emitted = new Set();
let out = sql;
for (let i = blockSpans.length - 1; i >= 0; i--) {
  const span = blockSpans[i];
  const isFirstForTable = !blockSpans.slice(0, i).some((s) => s.table === span.table);
  const replacement = isFirstForTable ? rendered[span.table] : '';
  if (isFirstForTable) emitted.add(span.table);
  out = out.slice(0, span.start) + replacement + out.slice(span.end);
}

writeFileSync(OUTPUT, out, 'utf8');

console.log('pipelinekit-demo post-process');
for (const line of log) console.log('  ' + line);
console.log(`  wrote ${OUTPUT} (${customers.length} customers, ${orders.length} orders)`);
