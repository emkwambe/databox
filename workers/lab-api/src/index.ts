import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { neon } from '@neondatabase/serverless';

// Types
interface Env {
  DB: D1Database;
  TEMPLATES: R2Bucket;
  KV?: KVNamespace; // optional: pack-catalog cache, absent in older deploys
  NEON_API_KEY: string;
  NEON_PROJECT_ID: string;
  LAB_API_KEY: string;
  ENVIRONMENT: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  DODO_API_KEY: string;        // Dodo Payments — test secret key
  DODO_WEBHOOK_SECRET: string; // Dodo Payments — webhook signing secret
}

interface CreateLabRequest {
  template: string;
  rows?: number;
  ttl?: string;
  name?: string;
  apiKey?: string;
  userId?: string;
  seed?: number;
}

// ── Tier Definitions ────────────────────────────────────────

const TIER_LIMITS: Record<string, { maxRows: number; maxActiveLabs: number; downloadsPerMonth: number; labsDaily: number; defaultTTL?: string }> = {
  free:       { maxRows: 5000,    maxActiveLabs: 2,  downloadsPerMonth: 0,  labsDaily: 5 },
  core:       { maxRows: 50000,   maxActiveLabs: 3,  downloadsPerMonth: 2,  labsDaily: 10 },
  compliance: { maxRows: 100000,  maxActiveLabs: 10, downloadsPerMonth: 5,  labsDaily: 20 },
  research:   { maxRows: 100000,  maxActiveLabs: 5,  downloadsPerMonth: 10, labsDaily: 5, defaultTTL: '720h' },
  enterprise: { maxRows: 1000000, maxActiveLabs: -1, downloadsPerMonth: -1, labsDaily: -1 },
};

const DATASET_PRICING: Record<string, Record<string, number>> = {
  banking:        { '5k': 0, '50k': 4900, '100k': 7900, '500k': 29900, '1000k': 49900 },
  'us-banking':   { '5k': 0, '10k': 2500, '50k': 4900, '100k': 7900, '500k': 29900, '1000k': 49900 },
  oncology:       { '5k': 0, '50k': 9900, '100k': 14900, '500k': 29900, '1000k': 49900 },
  healthcare:     { '5k': 0, '50k': 9900, '100k': 14900, '500k': 29900, '1000k': 49900 },
  'supply-chain': { '5k': 0, '50k': 4900, '100k': 7900, '500k': 29900, '1000k': 49900 },
  aml:            { '5k': 0, '50k': 9900, '100k': 14900, '500k': 29900, '1000k': 49900 },
  fintech:        { '5k': 0, '50k': 4900, '100k': 7900, '500k': 29900, '1000k': 49900 },
  telecom:        { '5k': 0, '50k': 9900, '100k': 14900, '500k': 29900, '1000k': 49900 },
  universal:      { '5k': 0, '50k': 4900, '100k': 7900, '500k': 29900, '1000k': 49900 },
  'eu-banking':    { '5k': 0, '10k': 0, '50k': 14900, '100k': 24900, '500k': 49900, '1000k': 99900 },
  'eu-healthcare': { '5k': 0, '10k': 0, '50k': 14900, '100k': 24900, '500k': 49900, '1000k': 99900 },
  'eu-telecom':    { '5k': 0, '10k': 0, '50k': 14900, '100k': 24900, '500k': 49900, '1000k': 99900 },
};

// ── Badge Definitions ───────────────────────────────────────

const BADGE_DEFINITIONS: Record<string, { name: string; description: string; tiers: { bronze: number; silver: number; gold: number; platinum: number } }> = {
  join_master:      { name: 'JOIN Master', description: 'Complete all JOIN challenges with 80%+', tiers: { bronze: 3, silver: 6, gold: 10, platinum: 15 } },
  window_pro:       { name: 'Window Functions Pro', description: 'Complete window function challenges', tiers: { bronze: 2, silver: 5, gold: 8, platinum: 12 } },
  aggregation:      { name: 'Aggregation Expert', description: 'All GROUP BY + HAVING challenges', tiers: { bronze: 3, silver: 6, gold: 10, platinum: 15 } },
  schema_navigator: { name: 'Schema Navigator', description: 'Query across 5+ tables in one session', tiers: { bronze: 1, silver: 3, gold: 5, platinum: 10 } },
  data_detective:   { name: 'Data Detective', description: 'Find the trap in challenges', tiers: { bronze: 2, silver: 5, gold: 8, platinum: 12 } },
  volume_handler:   { name: 'Volume Handler', description: 'Complete challenges on 50K+ row labs', tiers: { bronze: 1, silver: 3, gold: 5, platinum: 10 } },
  certified_pro:    { name: 'Certified Professional', description: 'Earn certifications', tiers: { bronze: 1, silver: 2, gold: 3, platinum: 3 } },
};

// ── Entitlement Helpers ─────────────────────────────────────

async function getEntitlement(db: D1Database, userId: string) {
  const ent = await db.prepare('SELECT * FROM entitlements WHERE user_id = ? AND status = ?')
    .bind(userId, 'active').first();
  if (ent) return ent;
  // Return free tier defaults
  return {
    tier: 'free',
    max_rows: 5000,
    max_active_labs: 2,
    downloads_per_month: 0,
    downloads_used_this_month: 0,
    labs_created_today: 0,
    labs_daily_limit: 5,
  };
}

async function checkLabCreationAllowed(db: D1Database, userId: string, requestedRows: number): Promise<{ allowed: boolean; reason?: string; tier: string }> {
  const ent = await getEntitlement(db, userId);
  const tier = ent.tier as string;
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.free;

  // Check row limit
  if (requestedRows > limits.maxRows) {
    return { allowed: false, reason: `Your ${tier} tier allows up to ${limits.maxRows} rows. Upgrade for more.`, tier };
  }

  // Check active lab count
  if (limits.maxActiveLabs !== -1) {
    const active = await db.prepare("SELECT COUNT(*) as c FROM labs WHERE user_id = ? AND status = 'active'")
      .bind(userId).first();
    const count = parseInt((active as any)?.c || '0');
    if (count >= limits.maxActiveLabs) {
      return { allowed: false, reason: `You have ${count} active labs (limit: ${limits.maxActiveLabs}). Delete a lab or upgrade.`, tier };
    }
  }

  // Check daily rate limit
  if (limits.labsDaily !== -1) {
    const todayStr = new Date().toISOString().split('T')[0];
    const today = await db.prepare("SELECT COUNT(*) as c FROM labs WHERE user_id = ? AND created_at LIKE ?")
      .bind(userId, todayStr + '%').first();
    const todayCount = parseInt((today as any)?.c || '0');
    if (todayCount >= limits.labsDaily) {
      return { allowed: false, reason: `Daily lab creation limit reached (${limits.labsDaily}/day). Try again tomorrow.`, tier };
    }
  }

  // Check if user has a one-time purchase for higher rows
  if (requestedRows > limits.maxRows) {
    const rowLabel = requestedRows >= 1000 ? `${requestedRows / 1000}k` : String(requestedRows);
    const purchase = await db.prepare(
      "SELECT * FROM dataset_purchases WHERE user_id = ? AND rows >= ? AND status = 'completed' AND lab_credits_remaining > 0"
    ).bind(userId, requestedRows).first();

    if (purchase) {
      // Decrement lab credit
      await db.prepare('UPDATE dataset_purchases SET lab_credits_remaining = lab_credits_remaining - 1 WHERE id = ?')
        .bind(purchase.id).run();
      return { allowed: true, tier: tier + '+purchase' };
    }
    return { allowed: false, reason: `Row count ${requestedRows} requires a higher tier or one-time purchase.`, tier };
  }

  return { allowed: true, tier };
}

// Neon API helpers
async function createNeonBranch(projectId: string, apiKey: string, branchName: string) {
  const res = await fetch(
    `https://console.neon.tech/api/v2/projects/${projectId}/branches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        branch: { name: branchName },
        endpoints: [{ type: 'read_write' }],
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Neon branch creation failed: ${res.status} ${err}`);
  }

  const data: any = await res.json();
  const branchId = data.branch.id;
  const endpointId = data.endpoints[0].id;
  const host = data.endpoints[0].host;

  // Neon returns connection_uris with the full connection string including password
  if (data.connection_uris && data.connection_uris.length > 0) {
    const connUri = data.connection_uris[0].connection_uri;
    return { branchId, endpointId, host, connectionUri: connUri };
  }

  // Fallback: get password from roles
  const roleName = data.roles?.[0]?.name || 'neondb_owner';
  const rolePassword = data.roles?.[0]?.password || '';

  // If no password from create, fetch it via the password reset endpoint
  if (!rolePassword) {
    try {
      const pwRes = await fetch(
        `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}/roles/${roleName}/reveal_password`,
        {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
        }
      );
      if (pwRes.ok) {
        const pwData: any = await pwRes.json();
        const password = pwData.password || '';
        return {
          branchId, endpointId, host,
          connectionUri: `postgresql://${roleName}:${password}@${host}/neondb?sslmode=require`,
        };
      }
    } catch {}
  }

  return {
    branchId, endpointId, host,
    connectionUri: `postgresql://${roleName}:${rolePassword}@${host}/neondb?sslmode=require`,
  };
}

async function deleteNeonBranch(projectId: string, apiKey: string, branchId: string) {
  const res = await fetch(
    `https://console.neon.tech/api/v2/projects/${projectId}/branches/${branchId}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }
  );
  return res.ok;
}

// Mask password in connection string for list responses
function maskConnection(conn: string): string {
  if (!conn) return conn;
  return conn.replace(/:([^@]+)@/, ':****@');
}

// TTL parsing
function parseTTL(ttl: string): number {
  const match = ttl.match(/^(\d+)(h|d|m)$/);
  if (!match) return 4 * 60 * 60 * 1000; // default 4h
  const [, num, unit] = match;
  const n = parseInt(num);
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  if (unit === 'm') return n * 60 * 1000;
  return 4 * 60 * 60 * 1000;
}

// Auth middleware
function authenticate(apiKey: string | undefined, env: Env): boolean {
  if (!apiKey) return false;
  return apiKey === env.LAB_API_KEY;
}

// App
const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'realitydb-lab-api' });
});

// Create lab
app.post('/v1/labs', async (c) => {
  const env = c.env;
  const body = await c.req.json<CreateLabRequest>();
  const apiKey = body.apiKey || c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');

  if (!authenticate(apiKey, env)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const template = body.template;
  const rows = body.rows || 5000;
  const ttl = body.ttl || '4h';
  const name = body.name || `lab-${Date.now().toString(36)}`;
  const userId = body.userId || 'api-user';
  const seed = body.seed ?? null;
  const id = `lab-${crypto.randomUUID().split('-')[0]}`;

  // api-user (CLI default) now subject to
  // free tier limits. Named users with
  // active entitlements get their tier.
  // Bypass removed 2026-07-21.
  const check = await checkLabCreationAllowed(env.DB, userId, rows);
  if (!check.allowed) {
    return c.json({
      error: check.reason,
      tier: check.tier,
      upgradeRequired: true,
      upgradeUrl: 'https://realitydb.dev/pricing',
      terminalMessage: 'Free tier limit reached. Upgrade at realitydb.dev/pricing or invite a colleague to earn more labs.',
    }, 403);
  }

  // Validate template + rows combo exists in R2
  const rowLabel = rows >= 1000 ? `${rows / 1000}k` : String(rows);
  const r2Key = `templates/${template}-${rowLabel}.sql`;

  const templateObj = await env.TEMPLATES.get(r2Key);
  if (!templateObj) {
    return c.json({ error: `Template not found: ${r2Key}. Available: banking-5k, banking-10k, banking-50k, banking-100k` }, 404);
  }

  try {
    // Create Neon branch
    const branch = await createNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, id);
    const connectionString = branch.connectionUri;

    // Seed the branch with template SQL
    // Use Neon's SQL over HTTP with transaction mode
    const sqlText = await templateObj.text();

    // Parse connection string to get host and auth
    const connUrl = new URL(connectionString.replace('postgresql://', 'https://'));
    const neonHost = connUrl.hostname;
    const neonUser = connUrl.username;
    const neonPass = connUrl.password;
    const neonDb = connUrl.pathname.replace('/', '');

    // Split SQL into individual statements properly
    // Each statement ends with ); or a line with just ;
    const statements: string[] = [];
    let current = '';
    for (const line of sqlText.split('\n')) {
      current += line + '\n';
      // Statement boundary: line ends with ; and next meaningful line starts with CREATE/INSERT/DROP or is empty
      if (line.trimEnd().endsWith(';') && !line.trim().startsWith('--')) {
        const trimmed = current.trim();
        if (trimmed && trimmed !== ';') {
          statements.push(trimmed);
        }
        current = '';
      }
    }
    if (current.trim()) statements.push(current.trim());

    console.log(`Parsed ${statements.length} SQL statements`);

    // Use Neon's transaction HTTP endpoint — sends all statements in one request
    const txBody = JSON.stringify({
      queries: statements.map(s => ({
        query: s.replace(/;\s*$/, ''),
        params: [],
      })),
    });

    const txRes = await fetch(`https://${neonHost}/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': connectionString,
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': 'true',
        'Neon-Pool-Opt-In': 'true',
      },
      body: txBody,
    });

    if (!txRes.ok) {
      const errText = await txRes.text();
      console.error(`Neon SQL API error (${txRes.status}):`, errText.substring(0, 300));

      // Fallback: execute statements one by one with neon driver, but limit to 45 subrequests
      console.log('Falling back to individual statement execution (max 45)...');
      const db = neon(connectionString);
      let seeded = 0;
      let errors = 0;
      for (const stmt of statements.slice(0, 45)) {
        const cleaned = stmt.replace(/;\s*$/, '');
        if (!cleaned) continue;
        try {
          await db(cleaned);
          seeded++;
        } catch (e: any) {
          errors++;
          if (errors <= 5) console.error(`Stmt ${seeded + errors}:`, e.message?.substring(0, 80));
        }
      }
      console.log(`Fallback: seeded ${seeded}, errors ${errors}`);
    } else {
      console.log('Seeded successfully via Neon SQL API');
    }

    // Calculate expiry
    const now = new Date();
    const expiresAt = new Date(now.getTime() + parseTTL(ttl));

    // Store in D1
    await env.DB.prepare(
      `INSERT INTO labs (id, user_id, name, template, rows, seed, neon_branch_id, neon_endpoint_id, connection_string, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(
      id, userId, name, template, rows, seed,
      branch.branchId, branch.endpointId,
      connectionString,
      now.toISOString(), expiresAt.toISOString()
    ).run();

    return c.json({
      id,
      name,
      template,
      rows,
      connectionString,
      expiresAt: expiresAt.toISOString(),
      ttl,
      status: 'active',
    }, 201);
  } catch (err: any) {
    return c.json({ error: `Lab creation failed: ${err.message}` }, 500);
  }
});

// List labs
app.get('/v1/labs', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const showAll = c.req.query('all') === 'true';
  const query = showAll
    ? 'SELECT * FROM labs ORDER BY created_at DESC LIMIT 50'
    : "SELECT * FROM labs WHERE status = 'active' ORDER BY created_at DESC LIMIT 50";

  const result = await env.DB.prepare(query).all();
  // Mask connection strings in list responses — full connection available via GET /v1/labs/:id
  const labs = (result.results || []).map((lab: any) => ({
    ...lab,
    connection_string: maskConnection(lab.connection_string as string),
  }));
  return c.json({ labs });
});

// Get lab
app.get('/v1/labs/:id', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const result = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!result) return c.json({ error: 'Lab not found' }, 404);
  return c.json(result);
});

// Execute SQL against a lab's database (proxy)
app.post('/v1/labs/:id/query', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!lab) return c.json({ error: 'Lab not found' }, 404);
  if (lab.status !== 'active') return c.json({ error: `Lab is ${lab.status}` }, 400);

  const { sql: query } = await c.req.json<{ sql: string }>();
  if (!query?.trim()) return c.json({ error: 'No SQL provided' }, 400);

  const start = Date.now();
  try {
    const sql = neon(lab.connection_string as string);
    const result = await sql(query);
    const duration = Date.now() - start;

    return c.json({
      columns: result.length > 0 ? Object.keys(result[0]) : [],
      rows: result,
      rowCount: result.length,
      duration,
    });
  } catch (err: any) {
    return c.json({ error: err.message, duration: Date.now() - start }, 400);
  }
});

// Extend TTL
app.patch('/v1/labs/:id/ttl', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ ttl: string }>();
  const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!lab) return c.json({ error: 'Lab not found' }, 404);

  const currentExpiry = new Date(lab.expires_at as string);
  const newExpiry = new Date(currentExpiry.getTime() + parseTTL(body.ttl));

  await env.DB.prepare('UPDATE labs SET expires_at = ? WHERE id = ?')
    .bind(newExpiry.toISOString(), c.req.param('id')).run();

  return c.json({ id: lab.id, expiresAt: newExpiry.toISOString() });
});

// Delete lab
app.delete('/v1/labs/:id', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!lab) return c.json({ error: 'Lab not found' }, 404);

  // Delete Neon branch
  await deleteNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, lab.neon_branch_id as string);

  // Update status
  await env.DB.prepare("UPDATE labs SET status = 'deleted', deleted_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), c.req.param('id')).run();

  return c.json({ deleted: true, id: lab.id });
});

// Share lab (read-only connection)
app.post('/v1/labs/:id/share', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!lab) return c.json({ error: 'Lab not found' }, 404);

  // For MVP: return the same connection string with a note about read-only
  // Full implementation would create a read-only Neon endpoint
  return c.json({
    id: lab.id,
    connectionString: lab.connection_string,
    readOnly: true,
    note: 'Share this connection string. Recipients can query but should not modify data.',
    expiresAt: new Date(lab.expires_at as string).toISOString(),
  });
});


// ============================================================
// SNAPSHOT ENDPOINTS
// ============================================================

// Save a snapshot of a lab
app.post('/v1/labs/:id/snapshot', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ name: string; description?: string }>();
  const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!lab) return c.json({ error: 'Lab not found' }, 404);

  const snapshotId = 'snap-' + crypto.randomUUID().split('-')[0];
  const r2Key = 'snapshots/' + snapshotId + '.sql';

  // Export the lab data as SQL dump via Neon
  const db = neon(lab.connection_string as string);
  let sqlDump = '';
  let tables: any[] = [];
  try {
    // Get all table names
    tables = await db('SELECT tablename FROM pg_tables WHERE schemaname = \'public\'');
    
    // For each table, get CREATE TABLE + data
    for (const t of tables) {
      const tableName = t.tablename;
      // Get rows as JSON
      const rows = await db('SELECT * FROM ' + tableName);
      if (rows.length > 0) {
        const columns = Object.keys(rows[0]);
        sqlDump += '-- Table: ' + tableName + ' (' + rows.length + ' rows)\n';
        sqlDump += 'INSERT INTO ' + tableName + ' (' + columns.join(', ') + ') VALUES\n';
        sqlDump += rows.map((r: any) => {
          const vals = columns.map(col => {
            const v = r[col];
            if (v === null) return 'NULL';
            if (typeof v === 'number') return String(v);
            if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
            return "'" + String(v).replace(/'/g, "''") + "'";
          }).join(', ');
          return '  (' + vals + ')';
        }).join(',\n') + ';\n\n';
      }
    }
  } catch (e: any) {
    console.error('Snapshot export error:', e.message);
  }

  // Count tables and rows from the dump (parsed from comments, no extra queries)
  const tableNames = tables.map((t: any) => t.tablename);
  const rowsByTable: Record<string, number> = {};
  let totalRows = 0;
  const rowPattern = /-- Table: (\w+) \((\d+) rows\)/g;
  let rmatch;
  while ((rmatch = rowPattern.exec(sqlDump)) !== null) {
    rowsByTable[rmatch[1]] = parseInt(rmatch[2]);
    totalRows += parseInt(rmatch[2]);
  }
  // Count saved queries for this lab
  const queryCount = await env.DB.prepare('SELECT COUNT(*) as c FROM saved_queries WHERE lab_id = ?').bind(lab.id as string).first();
  const savedQueriesCount = parseInt((queryCount as any)?.c || '0');

  // Store in R2
  await env.TEMPLATES.put(r2Key, sqlDump);

  const now = new Date().toISOString();

  // Store metadata in D1
  await env.DB.prepare(
    'INSERT INTO snapshots (id, lab_id, user_id, name, description, template, seed, rows, tables_count, schema_hash, r2_key, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    snapshotId, lab.id, lab.user_id, body.name, body.description || '',
    lab.template, lab.seed ?? null, totalRows, tableNames.length,
    '', r2Key, sqlDump.length, now
  ).run();

  return c.json({
    id: snapshotId,
    name: body.name,
    description: body.description || '',
    labId: lab.id,
    template: lab.template,
    seed: lab.seed ?? null,
    tableCount: tableNames.length,
    tables: tableNames,
    totalRows,
    rowsByTable,
    savedQueriesCount,
    sizeBytes: sqlDump.length,
    r2Key,
    createdAt: now,
  }, 201);
});

// List snapshots for a lab
app.get('/v1/labs/:id/snapshots', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const result = await env.DB.prepare('SELECT * FROM snapshots WHERE lab_id = ? ORDER BY created_at DESC').bind(c.req.param('id')).all();
  return c.json({ snapshots: result.results });
});

// ============================================================
// PUBLISH ENDPOINTS
// ============================================================

// Publish a snapshot to the gallery
app.post('/v1/publish', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const body = await c.req.json<{
      snapshotId: string;
      title: string;
      authors: string;
      description?: string;
      tags?: string | string[];
      license?: string;
    }>();

    // Normalize tags: the SimLabV3 client sends an array, but D1 .bind() only
    // accepts scalar values — passing an array here threw and produced a bare 500.
    const tagsValue = Array.isArray(body.tags) ? body.tags.join(',') : (body.tags ?? '');

    const snapshot = await env.DB.prepare('SELECT * FROM snapshots WHERE id = ?').bind(body.snapshotId).first();
    if (!snapshot) return c.json({ error: 'Snapshot not found' }, 404);

    const pubId = 'pub-' + crypto.randomUUID().split('-')[0];
    const slug = body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);

    // Check slug uniqueness
    const existing = await env.DB.prepare('SELECT id FROM published_labs WHERE slug = ?').bind(slug).first();
    const finalSlug = existing ? slug + '-' + pubId.split('-')[1] : slug;

    await env.DB.prepare(
      'INSERT INTO published_labs (id, snapshot_id, user_id, slug, title, authors, description, tags, license, template, seed, rows, tables_count, status, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      pubId, snapshot.id, snapshot.user_id, finalSlug,
      body.title, body.authors, body.description || '',
      tagsValue, body.license || 'CC-BY-4.0',
      snapshot.template, snapshot.seed ?? null, snapshot.rows, snapshot.tables_count,
      'active', new Date().toISOString()
    ).run();

    return c.json({
      id: pubId,
      slug: finalSlug,
      title: body.title,
      url: 'https://sandbox.realitydb.dev/#gallery/' + finalSlug,
      publishedAt: new Date().toISOString(),
    }, 201);
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: 'publish_failed', detail: err?.message || String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

// Browse the gallery
app.get('/v1/gallery', async (c) => {
  const env = c.env;
  const tag = c.req.query('tag');
  const template = c.req.query('template');
  const search = c.req.query('q');

  let query = "SELECT * FROM published_labs WHERE status = 'active'";
  const params: string[] = [];

  if (tag) { query += " AND tags LIKE ?"; params.push('%' + tag + '%'); }
  if (template) { query += " AND template = ?"; params.push(template); }
  if (search) { query += " AND (title LIKE ? OR description LIKE ?)"; params.push('%' + search + '%', '%' + search + '%'); }

  query += ' ORDER BY published_at DESC LIMIT 50';

  let stmt = env.DB.prepare(query);
  for (let i = 0; i < params.length; i++) {
    stmt = stmt.bind(...params);
  }

  // Simple approach: bind all at once
  const result = params.length > 0
    ? await env.DB.prepare(query).bind(...params).all()
    : await env.DB.prepare(query).all();

  return c.json({ labs: result.results });
});

// Browse published experiments.
// NOTE: registered before /v1/gallery/:slug below — this Hono version matches
// routes in registration order, not static-before-dynamic priority, so
// /v1/gallery/experiments would otherwise be swallowed as slug="experiments".
app.get('/v1/gallery/experiments', async (c) => {
  const env = c.env;
  // Only public, published experiments are ever listed. Unlisted experiments
  // are reachable by slug (below) but deliberately never appear here —
  // that's the whole point of "anyone with the link."
  // Kept as a back-compat alias: same query the 'experiments' discovery
  // lens now runs (see runDiscoveryQuery below), just under its original
  // route and response envelope so existing callers are unaffected.
  const results = await runDiscoveryQuery(env, 'experiments', parseDiscoveryFilters(c));
  return c.json({ experiments: results });
});

// Knowledge Discovery layer — one route per lens, all routed through the
// same shared query-building path (runDiscoveryQuery). Every lens's rows
// always carry their parent Experiment's slug/title/author — visualizations
// and SQL are derived artifacts, never standalone content.
// Distinct tag/template/author values (with counts) across a lens's
// published population — the "faceted filtering" a dropdown needs.
// Registered before /v1/discover/:lens below: both are 2-segment paths,
// and this Hono version matches routes in registration order, not
// static-before-dynamic priority, so /v1/discover/facets would otherwise
// be swallowed as lens="facets" (same bug class as /v1/gallery/:slug vs
// /v1/gallery/experiments, fixed the same way, earlier this project).
// Tags are comma-separated TEXT, so counting happens in the Worker after
// one query, not in SQL — fine at current scale, a scaling concern later.
app.get('/v1/discover/facets', async (c) => {
  const env = c.env;
  const lens = c.req.query('lens') || 'experiments';
  if (lens === 'profiles' || !DISCOVERY_LENSES.has(lens)) return c.json({ error: 'Facets not supported for this lens' }, 400);

  let rows: any[];
  if (lens === 'experiments') {
    rows = (await env.DB.prepare("SELECT tags, template, authors FROM experiments WHERE status = 'published' AND visibility = 'public'").all()).results as any[];
  } else {
    const type = lens === 'visualizations' ? 'chart' : 'sql_query';
    rows = (await env.DB.prepare(
      `SELECT ev.tags as tags, e.template as template, e.authors as authors
       FROM experiment_evidence ev JOIN experiments e ON e.id = ev.experiment_id
       WHERE ev.type = ? AND e.status = 'published' AND e.visibility = 'public'`
    ).bind(type).all()).results as any[];
  }

  const tagCounts = new Map<string, number>();
  const templateCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.tags) for (const t of String(r.tags).split(',').map((s: string) => s.trim()).filter(Boolean)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    if (r.template) templateCounts.set(r.template, (templateCounts.get(r.template) || 0) + 1);
    if (r.authors) authorCounts.set(r.authors, (authorCounts.get(r.authors) || 0) + 1);
  }
  const toSorted = (m: Map<string, number>) => Array.from(m.entries()).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);

  return c.json({ lens, tags: toSorted(tagCounts), templates: toSorted(templateCounts), authors: toSorted(authorCounts) });
});

// Personalized recommendations — derived from a signed-in user's own
// bookmark/reproduction tag-and-template affinity, the same overlap
// heuristic as /related applied to a person's aggregate interests instead
// of one Experiment's. No ML, no schema change. Falls back to the global
// trending/relevance blend for anonymous callers or users with no signal
// yet (no bookmarks/reproductions) — never errors either way. Also
// registered before /v1/discover/:lens for the same route-depth reason as
// /v1/discover/facets above.
app.get('/v1/discover/recommended', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '10', 10) || 10, 1), 50);

  const fallback = async () => {
    const results = await runDiscoveryQuery(env, 'experiments', { limit, offset: 0, sort: 'trending' } as DiscoveryFilters);
    return c.json({ personalized: false, results });
  };

  if (!userId) return fallback();

  const [bookmarked, reproduced] = await Promise.all([
    env.DB.prepare('SELECT e.id, e.tags, e.template FROM experiment_bookmarks b JOIN experiments e ON e.id = b.experiment_id WHERE b.user_id = ?').bind(userId).all(),
    env.DB.prepare('SELECT e.id, e.tags, e.template FROM experiment_reproductions r JOIN experiments e ON e.id = r.experiment_id WHERE r.user_id = ?').bind(userId).all(),
  ]);
  const interestRows = [...(bookmarked.results as any[]), ...(reproduced.results as any[])];
  if (interestRows.length === 0) return fallback();

  const tagFreq = new Map<string, number>();
  const templateFreq = new Map<string, number>();
  const excludeIds = new Set<string>();
  for (const r of interestRows) {
    excludeIds.add(r.id);
    if (r.tags) for (const t of String(r.tags).split(',').map((s: string) => s.trim()).filter(Boolean)) tagFreq.set(t, (tagFreq.get(t) || 0) + 1);
    if (r.template) templateFreq.set(r.template, (templateFreq.get(r.template) || 0) + 1);
  }
  const topTags = Array.from(tagFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  const topTemplates = Array.from(templateFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  if (topTags.length === 0 && topTemplates.length === 0) return fallback();

  const scoreTerms: string[] = [];
  const whereTerms: string[] = [];
  const scoreParams: string[] = [];
  const whereParams: string[] = [];
  for (const t of topTemplates) { scoreTerms.push('CASE WHEN e.template = ? THEN 1 ELSE 0 END'); scoreParams.push(t); whereTerms.push('e.template = ?'); whereParams.push(t); }
  for (const t of topTags) { scoreTerms.push('CASE WHEN e.tags LIKE ? THEN 1 ELSE 0 END'); scoreParams.push('%' + t + '%'); whereTerms.push('e.tags LIKE ?'); whereParams.push('%' + t + '%'); }

  const excludeIdList = Array.from(excludeIds);
  const excludeClause = excludeIdList.length ? `AND e.id NOT IN (${excludeIdList.map(() => '?').join(',')})` : '';

  const query = `SELECT e.id, e.slug, e.title, e.question, e.authors, e.tags, e.template, e.published_at,
${DISCOVERY_SIGNAL_SUBQUERIES_E},
      (${scoreTerms.join(' + ')}) as affinity_score
    FROM experiments e
    WHERE e.status = 'published' AND e.visibility = 'public' ${excludeClause}
      AND (${whereTerms.join(' OR ')})
    ORDER BY affinity_score DESC, (reproduction_count + validation_count + review_count + citation_count) DESC, published_at DESC
    LIMIT ?`;

  const params = [...scoreParams, ...excludeIdList, ...whereParams, limit];
  const result = await env.DB.prepare(query).bind(...params).all();
  return c.json({ personalized: true, results: result.results || [] });
});

app.get('/v1/discover/:lens', async (c) => {
  const lens = c.req.param('lens');
  if (!DISCOVERY_LENSES.has(lens)) return c.json({ error: 'Unknown discovery lens' }, 404);
  const results = await runDiscoveryQuery(c.env, lens as DiscoveryLens, parseDiscoveryFilters(c));
  return c.json({ lens, results });
});

// Public researcher profile — read-only, no auth required. Only published
// experiments + aggregate credibility stats are exposed here; drafts and
// bookmarks stay private to the authenticated "mine" routes
// (/v1/experiments, /v1/experiments/bookmarks/mine, etc).
app.get('/v1/profiles/:userId', async (c) => {
  const env = c.env;
  const userId = c.req.param('userId');
  const published = await env.DB.prepare(`SELECT e.id, e.slug, e.title, e.question, e.tags, e.template, e.published_at,
${CREDIBILITY_SUBQUERIES_E}
    FROM experiments e WHERE e.user_id = ? AND e.status = 'published' AND e.visibility = 'public'
    ORDER BY e.published_at DESC`).bind(userId).all();

  if (published.results.length === 0) return c.json({ error: 'Profile not found' }, 404);

  const rows = published.results as any[];
  const stats = rows.reduce((acc, e) => ({
    reproduction_count: acc.reproduction_count + (e.reproduction_count || 0),
    validation_count: acc.validation_count + (e.validation_count || 0),
    validation_confirms_count: acc.validation_confirms_count + (e.validation_confirms_count || 0),
    review_count: acc.review_count + (e.review_count || 0),
  }), { reproduction_count: 0, validation_count: 0, validation_confirms_count: 0, review_count: 0 });

  // Self-authored identity data (2D) — absent entirely for a user who
  // hasn't filled it in, rather than returning empty-string placeholders.
  const profileRow = await env.DB.prepare('SELECT bio, research_interests, expertise_tags, featured_experiment_ids FROM user_profiles WHERE user_id = ?').bind(userId).first();
  let profile: any = null;
  if (profileRow) {
    const featuredIds = ((profileRow.featured_experiment_ids as string) || '').split(',').map((s) => s.trim()).filter(Boolean);
    let featured: any[] = [];
    if (featuredIds.length > 0) {
      const placeholders = featuredIds.map(() => '?').join(',');
      const featuredRows = await env.DB.prepare(
        `SELECT id, slug, title, question FROM experiments WHERE id IN (${placeholders}) AND status = 'published' AND visibility = 'public'`
      ).bind(...featuredIds).all();
      featured = featuredRows.results || [];
    }
    profile = {
      bio: profileRow.bio || null,
      researchInterests: profileRow.research_interests || null,
      expertiseTags: profileRow.expertise_tags || null,
      featured,
    };
  }

  return c.json({ userId, published_count: rows.length, stats, experiments: rows, profile });
});

// Self-only profile edit — the actor is derived from the verified JWT and
// can only ever write their own row (no :userId param, no admin path).
// Upserts so a first-time save and a later edit use the same call.
app.patch('/v1/profile', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ bio?: string; researchInterests?: string; expertiseTags?: string; featuredExperimentIds?: string[] }>();

  // Featured experiments must actually belong to the caller and be
  // published — silently drops anything that doesn't, rather than
  // erroring, since this is a self-curated highlight list, not a claim
  // about someone else's work.
  let featuredIdsCsv: string | null = null;
  if (body.featuredExperimentIds) {
    const ids = body.featuredExperimentIds.slice(0, 5);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const owned = await env.DB.prepare(
        `SELECT id FROM experiments WHERE id IN (${placeholders}) AND user_id = ? AND status = 'published'`
      ).bind(...ids, userId).all();
      featuredIdsCsv = (owned.results as any[]).map((r) => r.id).join(',') || null;
    } else {
      featuredIdsCsv = null;
    }
  }

  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO user_profiles (user_id, bio, research_interests, expertise_tags, featured_experiment_ids, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      bio = COALESCE(excluded.bio, user_profiles.bio),
      research_interests = COALESCE(excluded.research_interests, user_profiles.research_interests),
      expertise_tags = COALESCE(excluded.expertise_tags, user_profiles.expertise_tags),
      featured_experiment_ids = CASE WHEN ? THEN excluded.featured_experiment_ids ELSE user_profiles.featured_experiment_ids END,
      updated_at = excluded.updated_at
  `).bind(
    userId, body.bio ?? null, body.researchInterests ?? null, body.expertiseTags ?? null, featuredIdsCsv, now,
    body.featuredExperimentIds ? 1 : 0
  ).run();

  return c.json({ userId, updated: true });
});

// Get a single published experiment by slug. Public read — no token
// required. Pass a verified Bearer token to view experiments the caller
// has non-public access to; without one, only public/unlisted resolve.
app.get('/v1/gallery/experiments/:slug', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare("SELECT * FROM experiments WHERE slug = ?").bind(c.req.param('slug')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  await env.DB.prepare('UPDATE experiments SET view_count = view_count + 1 WHERE id = ?').bind(exp.id).run();

  const evidence = await env.DB.prepare(
    'SELECT id, type, position, title, data, created_at FROM experiment_evidence WHERE experiment_id = ? ORDER BY position ASC'
  ).bind(exp.id).all();
  const parsedEvidence = (evidence.results || []).map((e: any) => ({ ...e, data: JSON.parse(e.data) }));

  let bookmarked = false;
  if (userId) {
    const bm = await env.DB.prepare('SELECT 1 FROM experiment_bookmarks WHERE experiment_id = ? AND user_id = ?').bind(exp.id, userId).first();
    bookmarked = !!bm;
  }

  const credibility = await getCredibilitySummary(env, exp.id as string);

  // Fork lineage ("Derived From") is a distinct relationship from the
  // citation graph — resolved as a plain follow-up lookup, not a JOIN on
  // the main query, since forked_from_id is null for the common case.
  let forkedFrom: { id: string; title: string; slug: string } | null = null;
  if (exp.forked_from_id) {
    const parent = await env.DB.prepare('SELECT id, title, slug FROM experiments WHERE id = ?').bind(exp.forked_from_id).first();
    if (parent) forkedFrom = parent as any;
  }

  return c.json({ ...exp, view_count: (exp.view_count as number) + 1, viewerAccess: access, bookmarked, ...credibility, forkedFrom, evidence: parsedEvidence });
});

// Related Experiments — a landing-page-scoped heuristic (same
// template/author/tag overlap), deliberately separate from the discovery
// lens machinery (buildExperimentsDiscoveryQuery) since that only supports
// single-value tag/template filters, not "relative to experiment X"
// scoring with self-exclusion. Public read, mirrors the slug-detail route.
app.get('/v1/gallery/experiments/:slug/related', async (c) => {
  const env = c.env;
  const source = await env.DB.prepare("SELECT id, template, authors, tags FROM experiments WHERE slug = ? AND status = 'published' AND visibility = 'public'").bind(c.req.param('slug')).first();
  if (!source) return c.json({ error: 'Experiment not found' }, 404);

  const tags = ((source.tags as string) || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 5);
  const tagScoreExpr = tags.map(() => `CASE WHEN e.tags LIKE ? THEN 1 ELSE 0 END`).join(' + ');
  const tagWhereExpr = tags.map(() => `e.tags LIKE ?`).join(' OR ');
  // Citation-graph proximity — direct citation (either direction) is a
  // much stronger relatedness signal than incidental tag/template overlap,
  // so it's weighted higher (3) and also pulls a candidate into the
  // result set on its own, even with zero tag/template/author overlap.
  const citationExistsExpr = `EXISTS (SELECT 1 FROM experiment_references cr WHERE (cr.source_experiment_id = ? AND cr.target_experiment_id = e.id) OR (cr.source_experiment_id = e.id AND cr.target_experiment_id = ?))`;

  const query = `SELECT e.id, e.slug, e.title, e.question, e.authors, e.tags, e.template, e.published_at,
${CREDIBILITY_SUBQUERIES_E},
      (CASE WHEN e.template = ? THEN 1 ELSE 0 END
       + CASE WHEN e.authors = ? THEN 1 ELSE 0 END
       + CASE WHEN ${citationExistsExpr} THEN 3 ELSE 0 END
       ${tags.length ? '+ ' + tagScoreExpr : ''}) as relevance
    FROM experiments e
    WHERE e.status = 'published' AND e.visibility = 'public' AND e.id != ?
      AND (e.template = ? OR e.authors = ? OR ${citationExistsExpr}${tags.length ? ' OR ' + tagWhereExpr : ''})
    ORDER BY relevance DESC, e.published_at DESC
    LIMIT 6`;

  const tagLikeParams = tags.map((t) => '%' + t + '%');
  const params = [
    source.template, source.authors, source.id, source.id, ...tagLikeParams,
    source.id, source.template, source.authors, source.id, source.id, ...tagLikeParams,
  ];

  const result = await env.DB.prepare(query).bind(...params).all();
  return c.json({ related: result.results || [] });
});

// Fork a published experiment — provisions a fresh lab from the same
// template/seed/rows (the reproducibility manifest) and clones all
// evidence blocks into a new draft the forker can re-run and extend.
app.post('/v1/gallery/experiments/:slug/fork', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const source = await env.DB.prepare("SELECT * FROM experiments WHERE slug = ?").bind(c.req.param('slug')).first();
  if (!source) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required to fork an experiment' }, 401);

  const sourceAccess = await resolveAccess(env, source, userId);
  if (!hasAccess(sourceAccess, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  if (!source.template) return c.json({ error: 'Source experiment has no template on record — cannot reproduce' }, 400);

  const rows = (source.rows as number) || 5000;
  const rowLabel = rows >= 1000 ? `${rows / 1000}k` : String(rows);
  const r2Key = `templates/${source.template}-${rowLabel}.sql`;
  const templateObj = await env.TEMPLATES.get(r2Key);
  if (!templateObj) return c.json({ error: `Template not found for reproduction: ${r2Key}` }, 404);

  const forkLabId = 'lab-' + crypto.randomUUID().split('-')[0];
  const branch = await createNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, forkLabId);
  const sqlText = await templateObj.text();
  try {
    const sql = neon(branch.connectionUri);
    await sql(sqlText);
  } catch { /* best-effort seed, matches existing fork behavior for dataset forks */ }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  await env.DB.prepare(
    `INSERT INTO labs (id, user_id, name, template, rows, seed, neon_branch_id, neon_endpoint_id, connection_string, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(
    forkLabId, userId, 'fork-' + (source.slug as string).substring(0, 20), source.template, rows, source.seed ?? null,
    branch.branchId, branch.endpointId, branch.connectionUri, now.toISOString(), expiresAt.toISOString()
  ).run();

  const newExpId = 'exp-' + crypto.randomUUID().split('-')[0];
  await env.DB.prepare(
    `INSERT INTO experiments (id, user_id, lab_id, status, title, question, template, seed, rows, lab_version, engine_version, environment, forked_from_id, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    newExpId, userId, forkLabId, source.title, source.question, source.template, source.seed ?? null, rows,
    LAB_API_VERSION, ENGINE_VERSION, source.environment, source.id, now.toISOString()
  ).run();

  const sourceEvidence = await env.DB.prepare(
    'SELECT type, position, title, data FROM experiment_evidence WHERE experiment_id = ? ORDER BY position ASC'
  ).bind(source.id).all();
  for (const e of (sourceEvidence.results || []) as any[]) {
    await env.DB.prepare(
      'INSERT INTO experiment_evidence (id, experiment_id, type, position, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind('ev-' + crypto.randomUUID().split('-')[0], newExpId, e.type, e.position, e.title, e.data, now.toISOString()).run();
  }

  await env.DB.prepare('UPDATE experiments SET fork_count = fork_count + 1 WHERE id = ?').bind(source.id).run();
  await logExperimentEvent(env, source.id as string, 'forked', userId, { newExperimentId: newExpId });

  return c.json({
    id: newExpId,
    labId: forkLabId,
    connectionString: branch.connectionUri,
    forkedFrom: source.slug,
    expiresAt: expiresAt.toISOString(),
  }, 201);
});

// Get a single published lab
app.get('/v1/gallery/:slug', async (c) => {
  const env = c.env;
  const lab = await env.DB.prepare('SELECT * FROM published_labs WHERE slug = ?').bind(c.req.param('slug')).first();
  if (!lab) return c.json({ error: 'Published lab not found' }, 404);

  // Increment view count
  await env.DB.prepare('UPDATE published_labs SET view_count = view_count + 1 WHERE id = ?').bind(lab.id).run();

  return c.json(lab);
});

// Fork a published lab
app.post('/v1/gallery/:slug/fork', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ name?: string }>();
  const pubLab = await env.DB.prepare('SELECT * FROM published_labs WHERE slug = ?').bind(c.req.param('slug')).first();
  if (!pubLab) return c.json({ error: 'Published lab not found' }, 404);

  // Get the snapshot's R2 data
  const snapshot = await env.DB.prepare('SELECT * FROM snapshots WHERE id = ?').bind(pubLab.snapshot_id).first();
  if (!snapshot) return c.json({ error: 'Snapshot data not found' }, 404);

  // Create a new lab using the same template
  const forkName = body.name || 'fork-' + (pubLab.slug as string).substring(0, 20);
  const forkId = 'lab-' + crypto.randomUUID().split('-')[0];

  // Create Neon branch
  const branch = await createNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, forkId);

  // Fetch snapshot SQL from R2 and seed
  const sqlObj = await env.TEMPLATES.get(snapshot.r2_key as string);
  if (sqlObj) {
    const sqlText = await sqlObj.text();
    const db = neon(branch.connectionUri);
    // Also need the schema — fetch original template
    const rowLabel = (pubLab.rows as number) >= 1000 ? (pubLab.rows as number) / 1000 + 'k' : String(pubLab.rows);
    const templateObj = await env.TEMPLATES.get('templates/' + pubLab.template + '-' + rowLabel + '.sql');
    if (templateObj) {
      const templateSql = await templateObj.text();
      try { await db(templateSql); } catch {}
    }
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h default for forks

  // Store the fork as a lab
  await env.DB.prepare(
    'INSERT INTO labs (id, user_id, name, template, rows, neon_branch_id, neon_endpoint_id, connection_string, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    forkId, 'api-user', forkName, pubLab.template, pubLab.rows,
    branch.branchId, branch.endpointId, branch.connectionUri,
    'active', now.toISOString(), expiresAt.toISOString()
  ).run();

  // Record the fork
  await env.DB.prepare(
    'INSERT INTO forks (id, published_lab_id, user_id, lab_id, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind('fork-' + crypto.randomUUID().split('-')[0], pubLab.id, 'api-user', forkId, now.toISOString()).run();

  // Increment fork count
  await env.DB.prepare('UPDATE published_labs SET fork_count = fork_count + 1 WHERE id = ?').bind(pubLab.id).run();

  return c.json({
    id: forkId,
    name: forkName,
    forkedFrom: pubLab.slug,
    connectionString: branch.connectionUri,
    expiresAt: expiresAt.toISOString(),
  }, 201);
});

// Soft-unpublish a gallery post by slug (X-API-Key auth required).
// Avoids needing direct D1 access to remove/hide a published lab.
app.delete('/v1/gallery/:slug', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'unauthorized' }, 401);

  const slug = c.req.param('slug');
  const result = await env.DB.prepare(
    "UPDATE published_labs SET status = 'deleted' WHERE slug = ?"
  ).bind(slug).run();

  const changes = result.meta?.changes ?? 0;
  if (changes === 0) return c.json({ error: 'Published lab not found' }, 404);
  return c.json({ deleted: true, slug, changes });
});

// Save a query during a lab session
app.post('/v1/labs/:id/queries', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ name: string; sql: string; resultPreview?: string; executionTimeMs?: number; rowCount?: number }>();
  const queryId = 'qry-' + crypto.randomUUID().split('-')[0];

  await env.DB.prepare(
    'INSERT INTO saved_queries (id, lab_id, user_id, name, sql_text, result_preview, execution_time_ms, row_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    queryId, c.req.param('id'), 'api-user',
    body.name, body.sql, body.resultPreview || null,
    body.executionTimeMs || null, body.rowCount || null,
    new Date().toISOString()
  ).run();

  return c.json({ id: queryId, name: body.name }, 201);
});

// List saved queries for a lab
app.get('/v1/labs/:id/queries', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const result = await env.DB.prepare('SELECT * FROM saved_queries WHERE lab_id = ? ORDER BY created_at DESC').bind(c.req.param('id')).all();
  return c.json({ queries: result.results });
});

// ============================================================
// EXPERIMENT ENDPOINTS
// Experiment = the permanent record of asking a question, running
// analyses, collecting evidence, and documenting conclusions.
// Evidence is intentionally polymorphic (type + JSON data) so future
// modalities (notebook cells, benchmarks, simulations, images) need
// no schema change — just a new `type` string and documented shape.
// ============================================================

const ENGINE_VERSION = '@realitydb/engine (see packages/engine)';
const LAB_API_VERSION = 'lab-api-experiments-v1';

// ── Supabase JWT verification ───────────────────────────────────────────
// This project's Supabase instance signs access tokens with ES256 using an
// asymmetric key pair — the public verification key is served at a public
// JWKS endpoint, so no secret is required on this end to verify signatures.
// (If the Supabase project is ever migrated to legacy HS256 shared-secret
// signing, this verifier must change to HMAC verification against a
// SUPABASE_JWT_SECRET binding instead — it would silently stop matching.)
const SUPABASE_PROJECT_URL = 'https://roruzpilgspfzhvclwhb.supabase.co';
const SUPABASE_JWKS_URL = `${SUPABASE_PROJECT_URL}/auth/v1/.well-known/jwks.json`;
const SUPABASE_ISSUER = `${SUPABASE_PROJECT_URL}/auth/v1`;

let jwksCache: { keys: any[]; fetchedAt: number } | null = null;
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

async function getSupabaseJwks(): Promise<any[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) return jwksCache.keys;
  const res = await fetch(SUPABASE_JWKS_URL, { cf: { cacheTtl: 600, cacheEverything: true } } as any);
  const data: any = await res.json().catch(() => ({ keys: [] }));
  jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson(b64url: string): any {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));
}

// The ONLY trustworthy source of actor identity in this Worker. Verifies
// the ES256 signature against Supabase's live public key, and checks
// expiry + issuer. Returns the verified `sub` (Supabase user id), or null
// on ANY failure — missing header, malformed token, wrong/unknown key,
// expired, wrong issuer, or bad signature. Callers must treat null as
// "not authenticated," never fall back to a client-supplied userId for
// authorization-sensitive actions.
async function verifySupabaseJWT(authHeader: string | undefined | null): Promise<string | null> {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  let header: any, payload: any;
  try {
    header = base64UrlDecodeJson(parts[0]);
    payload = base64UrlDecodeJson(parts[1]);
  } catch {
    return null;
  }

  if (header.alg !== 'ES256') return null;
  if (!payload.exp || Date.now() / 1000 >= payload.exp) return null;
  if (payload.iss !== SUPABASE_ISSUER) return null;
  if (!payload.sub) return null;

  const keys = await getSupabaseJwks();
  const jwk = keys.find((k: any) => k.kid === header.kid);
  if (!jwk) return null;

  try {
    const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToBytes(parts[2]);
    const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, signature, signedData);
    return valid ? payload.sub : null;
  } catch {
    return null;
  }
}

// ── Access control ──────────────────────────────────────────────────────
// visibility: private | workspace | specific_people | unlisted | public
// permission tiers (least to most): viewer < reviewer < editor; owner is
// implicit and always maximal.
//
// resolveAccess() answers "what does our data model say this userId is
// allowed to do" — the userId it's given MUST be a verifySupabaseJWT()
// result for authorization-sensitive endpoints, never a client-supplied
// body/query value. Public/anonymous reads may pass null.
type AccessLevel = 'owner' | 'editor' | 'reviewer' | 'viewer' | 'none';
const ACCESS_RANK: Record<AccessLevel, number> = { none: 0, viewer: 1, reviewer: 2, editor: 3, owner: 4 };

function hasAccess(level: AccessLevel, required: AccessLevel): boolean {
  return ACCESS_RANK[level] >= ACCESS_RANK[required];
}

async function resolveAccess(env: Env, exp: any, userId: string | null | undefined): Promise<AccessLevel> {
  if (!exp) return 'none';
  if (userId && exp.user_id === userId) return 'owner';

  let level: AccessLevel = 'none';

  // unlisted/public only grant access once published — a draft is never
  // reachable this way even if visibility was pre-set before publishing.
  if ((exp.visibility === 'public' || exp.visibility === 'unlisted') && exp.status === 'published') {
    level = 'viewer';
  }

  if (userId && exp.workspace_id) {
    const member = await env.DB.prepare(
      'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).bind(exp.workspace_id, userId).first();
    if (member) {
      const role = (member as any).role as string;
      const workspaceLevel: AccessLevel = (role === 'owner' || role === 'admin') ? 'editor' : 'viewer';
      if (ACCESS_RANK[workspaceLevel] > ACCESS_RANK[level]) level = workspaceLevel;
    }
  }

  if (userId) {
    // Defense in depth: DB-level unique indexes prevent duplicate grant
    // rows per (experiment, user), but take the max across any matches
    // rather than trusting a single .first() row order guarantee.
    const grants = await env.DB.prepare(
      'SELECT permission FROM experiment_access_grants WHERE experiment_id = ? AND user_id = ?'
    ).bind(exp.id, userId).all();
    for (const g of (grants.results || []) as any[]) {
      const grantLevel = g.permission as AccessLevel;
      if (grantLevel in ACCESS_RANK && ACCESS_RANK[grantLevel] > ACCESS_RANK[level]) level = grantLevel;
    }
  }

  return level;
}

// Stricter than hasAccess(access, 'editor') — an explicit `editor` access
// grant is content-editing rights (evidence, findings), NOT ownership.
// Visibility, access-grant management, and publishing are ownership-
// sensitive decisions and require being the owner or a workspace
// owner/admin — a plain editor grant is deliberately insufficient here.
async function isOwnerOrWorkspaceAdmin(env: Env, exp: any, userId: string | null | undefined): Promise<boolean> {
  if (!exp || !userId) return false;
  if (exp.user_id === userId) return true;
  if (!exp.workspace_id) return false;
  const member = await env.DB.prepare(
    'SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
  ).bind(exp.workspace_id, userId).first();
  return !!member && ['owner', 'admin'].includes((member as any).role);
}

// Immutable activity ledger — the durable source of truth for meaningful
// engagement (publish/fork/reproduce/reference/validate/review/bookmark/
// share). Denormalized counters (view_count, fork_count) stay as cheap
// read-optimized projections for the UI; they are NOT authoritative and
// must never be treated as an audit trail. metadata carries denormalized
// references (e.g. reproductionId, reviewId) for cheap timeline rendering
// only — the structured tables (experiment_reproductions, experiment_
// reviews, etc.) are the authoritative record, not this JSON blob.
async function logExperimentEvent(env: Env, experimentId: string, eventType: string, actorUserId: string | null, metadata: Record<string, any>): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO experiment_events (id, experiment_id, event_type, actor_user_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind('evt-' + crypto.randomUUID().split('-')[0], experimentId, eventType, actorUserId, JSON.stringify(metadata), new Date().toISOString()).run();
}

// Credibility aggregates for a single experiment's detail view — same
// shape as the correlated subqueries in the gallery list, kept as one
// combined query since detail endpoints already do `SELECT *`.
async function getCredibilitySummary(env: Env, experimentId: string) {
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = ?) as reproduction_count,
      (SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = ? AND r.matched = 1) as reproduction_matched_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = ? AND v.superseded_at IS NULL) as validation_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = ? AND v.superseded_at IS NULL AND v.verdict = 'confirms') as validation_confirms_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = ? AND v.superseded_at IS NULL AND v.verdict = 'disputes') as validation_disputes_count,
      (SELECT COUNT(*) FROM experiment_reviews rv WHERE rv.experiment_id = ?) as review_count,
      (SELECT COUNT(*) FROM experiment_reviews rv WHERE rv.experiment_id = ? AND rv.status = 'open') as review_open_count
  `).bind(experimentId, experimentId, experimentId, experimentId, experimentId, experimentId, experimentId).first();
  return row;
}

async function nextEvidencePosition(db: D1Database, experimentId: string): Promise<number> {
  const row = await db.prepare(
    'SELECT COALESCE(MAX(position), -1) as maxPos FROM experiment_evidence WHERE experiment_id = ?'
  ).bind(experimentId).first();
  return ((row as any)?.maxPos ?? -1) + 1;
}

// ─────────────────────────────────────────────────────────────────────────
// Knowledge Discovery layer — one shared query-building path for every
// discovery lens (experiments/visualizations/sql/profiles), instead of a
// bespoke hand-rolled SELECT per lens. Every lens's primary rows always
// carry their parent Experiment's identity (slug/title/author) so a
// visualization or SQL card can never be rendered without a way back to
// its canonical Experiment.
// ─────────────────────────────────────────────────────────────────────────

type DiscoveryLens = 'experiments' | 'visualizations' | 'sql' | 'profiles';
const DISCOVERY_LENSES: Set<string> = new Set(['experiments', 'visualizations', 'sql', 'profiles']);

interface DiscoveryFilters {
  q?: string;
  tag?: string;
  template?: string;
  chartType?: string;
  sort?: string;
  limit: number;
  offset: number;
}

function parseDiscoveryFilters(c: any): DiscoveryFilters {
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '50', 10) || 50, 1), 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  return {
    q: c.req.query('q') || undefined,
    tag: c.req.query('tag') || undefined,
    template: c.req.query('template') || undefined,
    chartType: c.req.query('chartType') || undefined,
    sort: c.req.query('sort') || undefined,
    limit,
    offset,
  };
}

// Credibility aggregates keyed off an `e.id` correlated experiments alias —
// reused by every lens whose rows resolve back to a parent experiment, so
// "most reproduced/validated/reviewed" sorting means the same thing (and is
// computed the same way) everywhere.
const CREDIBILITY_SUBQUERIES_E = `
      (SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = e.id) as reproduction_count,
      (SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = e.id AND r.matched = 1) as reproduction_matched_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL) as validation_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL AND v.verdict = 'confirms') as validation_confirms_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL AND v.verdict = 'disputes') as validation_disputes_count,
      (SELECT COUNT(*) FROM experiment_reviews rv WHERE rv.experiment_id = e.id) as review_count,
      (SELECT COUNT(*) FROM experiment_reviews rv WHERE rv.experiment_id = e.id AND rv.status = 'open') as review_open_count`;

// Citation graph signal (2B's experiment_references, finally used for
// ranking) and a rolling-window engagement signal for "trending" — both
// keyed off the same `e.id` correlation as the credibility subqueries
// above, so every lens gets them identically.
const CITATION_SUBQUERY_E = `
      (SELECT COUNT(*) FROM experiment_references ref WHERE ref.target_experiment_id = e.id) as citation_count`;
const TRENDING_SUBQUERY_E = `
      (SELECT COUNT(*) FROM experiment_events ev2 WHERE ev2.experiment_id = e.id AND ev2.created_at >= datetime('now', '-14 days')) as recent_engagement_count`;
const DISCOVERY_SIGNAL_SUBQUERIES_E = `${CREDIBILITY_SUBQUERIES_E},\n${CITATION_SUBQUERY_E},\n${TRENDING_SUBQUERY_E}`;

// Builds the FTS5 join/select fragment for a lens's query. Only joins the
// FTS virtual table (and only calls bm25(), which SQLite requires be
// evaluated against an actual MATCH constraint) when a `q` is present —
// unconditionally joining would either break bm25() or force a full scan
// for every browse-with-no-search request.
function ftsJoinAndSelect(filters: DiscoveryFilters, ftsTable: string, idCol: string): { join: string; selectCol: string; whereClause: string; param: string | null } {
  if (!filters.q) return { join: '', selectCol: '0 as text_relevance', whereClause: '', param: null };
  return {
    join: `JOIN ${ftsTable} ON ${ftsTable}.id = ${idCol}`,
    selectCol: `bm25(${ftsTable}) as text_relevance`,
    whereClause: ` AND ${ftsTable} MATCH ?`,
    param: filters.q,
  };
}

// Weighted-sum ranking, expressed as an ORDER BY expression over the named
// signal columns every lens's query now selects (text_relevance,
// reproduction_count, validation_count, review_count, citation_count,
// recent_engagement_count, published_at). Each `sort` value is a strict
// generalization of what existed before — single-signal sorts (recent,
// most_reproduced, most_validated, most_reviewed) are unchanged; the new
// values (most_cited, trending, relevance) are additive. `relevance` is
// the implicit default when `q` is present and no explicit sort was
// requested — previously an unset sort always meant "recent" regardless
// of whether a search term was given, which ranked search results
// arbitrarily rather than by match quality.
function discoveryRankExpression(sort: string | undefined, hasQuery: boolean): string {
  switch (sort) {
    case 'most_reproduced': return 'reproduction_count DESC, published_at DESC';
    case 'most_validated': return 'validation_count DESC, published_at DESC';
    case 'most_reviewed': return 'review_count DESC, published_at DESC';
    case 'most_cited': return 'citation_count DESC, published_at DESC';
    case 'trending': return 'recent_engagement_count DESC, published_at DESC';
    case 'relevance':
      return hasQuery
        ? 'text_relevance ASC, (reproduction_count + validation_count + review_count + citation_count) DESC, published_at DESC'
        : '(reproduction_count + validation_count + review_count + citation_count) DESC, published_at DESC';
    case 'recent': return 'published_at DESC';
    default:
      return hasQuery ? discoveryRankExpression('relevance', true) : 'published_at DESC';
  }
}

// Appends tag/template/chartType filters shared across lenses (`q` is
// handled separately via ftsJoinAndSelect above, since it needs to affect
// both the FROM clause and the SELECT list, not just WHERE). `tagCol`/
// `templateCol`/`chartTypeCol` are omitted for lenses where they don't
// apply (e.g. profiles has no tags; chartType only applies to visualizations).
function applyDiscoveryFilters(
  query: string,
  params: (string | number)[],
  filters: DiscoveryFilters,
  opts: { tagCol?: string; templateCol?: string; chartTypeCol?: string }
): string {
  if (filters.tag && opts.tagCol) { query += ` AND ${opts.tagCol} LIKE ?`; params.push('%' + filters.tag + '%'); }
  if (filters.template && opts.templateCol) { query += ` AND ${opts.templateCol} = ?`; params.push(filters.template); }
  if (filters.chartType && opts.chartTypeCol) { query += ` AND ${opts.chartTypeCol} = ?`; params.push(filters.chartType); }
  return query;
}

function buildExperimentsDiscoveryQuery(filters: DiscoveryFilters): { query: string; params: (string | number)[] } {
  const fts = ftsJoinAndSelect(filters, 'experiments_fts', 'e.id');
  let query = `SELECT e.id, e.slug, e.title, e.question, e.authors, e.tags, e.template, e.seed, e.rows, e.view_count, e.fork_count, e.published_at,
      ${fts.selectCol},
${DISCOVERY_SIGNAL_SUBQUERIES_E}
    FROM experiments e ${fts.join}
    WHERE e.status = 'published' AND e.visibility = 'public'${fts.whereClause}`;
  const params: (string | number)[] = [];
  if (fts.param) params.push(fts.param);
  query = applyDiscoveryFilters(query, params, filters, { tagCol: 'e.tags', templateCol: 'e.template' });
  query += ` ORDER BY ${discoveryRankExpression(filters.sort, !!filters.q)} LIMIT ? OFFSET ?`;
  params.push(filters.limit, filters.offset);
  return { query, params };
}

function buildVisualizationsDiscoveryQuery(filters: DiscoveryFilters): { query: string; params: (string | number)[] } {
  const fts = ftsJoinAndSelect(filters, 'evidence_fts', 'ev.id');
  let query = `SELECT ev.id, ev.title, ev.description, ev.tags, ev.data, ev.created_at,
      e.id as experiment_id, e.slug as experiment_slug, e.title as experiment_title, e.authors as experiment_authors, e.template, e.published_at,
      ${fts.selectCol},
${DISCOVERY_SIGNAL_SUBQUERIES_E}
    FROM experiment_evidence ev ${fts.join}
    JOIN experiments e ON e.id = ev.experiment_id
    WHERE ev.type = 'chart' AND e.status = 'published' AND e.visibility = 'public'${fts.whereClause}`;
  const params: (string | number)[] = [];
  if (fts.param) params.push(fts.param);
  query = applyDiscoveryFilters(query, params, filters, { tagCol: 'ev.tags', templateCol: 'e.template', chartTypeCol: "json_extract(ev.data, '$.chartType')" });
  query += ` ORDER BY ${discoveryRankExpression(filters.sort, !!filters.q)} LIMIT ? OFFSET ?`;
  params.push(filters.limit, filters.offset);
  return { query, params };
}

function buildSqlDiscoveryQuery(filters: DiscoveryFilters): { query: string; params: (string | number)[] } {
  const fts = ftsJoinAndSelect(filters, 'evidence_fts', 'ev.id');
  let query = `SELECT ev.id, ev.title, ev.description, ev.tags, ev.data, ev.created_at,
      e.id as experiment_id, e.slug as experiment_slug, e.title as experiment_title, e.authors as experiment_authors, e.template, e.published_at,
      ${fts.selectCol},
${DISCOVERY_SIGNAL_SUBQUERIES_E}
    FROM experiment_evidence ev ${fts.join}
    JOIN experiments e ON e.id = ev.experiment_id
    WHERE ev.type = 'sql_query' AND e.status = 'published' AND e.visibility = 'public'${fts.whereClause}`;
  const params: (string | number)[] = [];
  if (fts.param) params.push(fts.param);
  query = applyDiscoveryFilters(query, params, filters, { tagCol: 'ev.tags', templateCol: 'e.template' });
  query += ` ORDER BY ${discoveryRankExpression(filters.sort, !!filters.q)} LIMIT ? OFFSET ?`;
  params.push(filters.limit, filters.offset);
  return { query, params };
}

// Folded into the same filter/rank path as the other three lenses —
// previously had its own bespoke inline sort mapping (and silently
// ignored q/tag entirely). q/tag still don't apply here (no bio/tag field
// exists on a profile yet — see 2D), but sort now means the same thing it
// means everywhere else, using SUM()s of the same signal names instead of
// per-row correlated subqueries.
function buildProfilesDiscoveryQuery(filters: DiscoveryFilters): { query: string; params: (string | number)[] } {
  const query = `SELECT e.user_id,
      COUNT(*) as published_count,
      MAX(e.published_at) as published_at,
      SUM((SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = e.id)) as reproduction_count,
      SUM((SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL)) as validation_count,
      SUM((SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL AND v.verdict = 'confirms')) as validation_confirms_count,
      SUM((SELECT COUNT(*) FROM experiment_reviews rv WHERE rv.experiment_id = e.id)) as review_count,
      SUM((SELECT COUNT(*) FROM experiment_references ref WHERE ref.target_experiment_id = e.id)) as citation_count,
      SUM((SELECT COUNT(*) FROM experiment_events ev2 WHERE ev2.experiment_id = e.id AND ev2.created_at >= datetime('now', '-14 days'))) as recent_engagement_count
    FROM experiments e
    WHERE e.status = 'published' AND e.visibility = 'public'
    GROUP BY e.user_id
    ORDER BY ${discoveryRankExpression(filters.sort, false)}
    LIMIT ? OFFSET ?`;
  return { query, params: [filters.limit, filters.offset] };
}

// Chart evidence stores its axis config but not the underlying rows —
// those live in the paired result_table block referenced by
// data.sourceEvidenceId. Resolved here as a single batched follow-up
// query (not one query per chart) so the visualization lens can report a
// row count without an N+1 fetch.
async function resolveVisualizationRowCounts(db: D1Database, rows: any[]): Promise<any[]> {
  const sourceIds = rows
    .map((r) => { try { return JSON.parse(r.data).sourceEvidenceId; } catch { return null; } })
    .filter((id): id is string => !!id);
  if (sourceIds.length === 0) return rows.map((r) => ({ ...r, row_count: null }));

  const placeholders = sourceIds.map(() => '?').join(',');
  const resultTables = await db.prepare(
    `SELECT id, data FROM experiment_evidence WHERE id IN (${placeholders}) AND type = 'result_table'`
  ).bind(...sourceIds).all();
  const rowCountById = new Map<string, number>();
  for (const rt of resultTables.results as any[]) {
    try { rowCountById.set(rt.id, JSON.parse(rt.data).rowCount ?? null); } catch { /* ignore malformed row */ }
  }
  return rows.map((r) => {
    let sourceId: string | null = null;
    try { sourceId = JSON.parse(r.data).sourceEvidenceId ?? null; } catch { /* ignore */ }
    return { ...r, row_count: sourceId ? (rowCountById.get(sourceId) ?? null) : null };
  });
}

async function runDiscoveryQuery(env: Env, lens: DiscoveryLens, filters: DiscoveryFilters): Promise<any[]> {
  const builder = lens === 'experiments' ? buildExperimentsDiscoveryQuery
    : lens === 'visualizations' ? buildVisualizationsDiscoveryQuery
    : lens === 'sql' ? buildSqlDiscoveryQuery
    : buildProfilesDiscoveryQuery;
  const { query, params } = builder(filters);
  const result = await env.DB.prepare(query).bind(...params).all();
  if (lens === 'visualizations') return resolveVisualizationRowCounts(env.DB, result.results as any[]);
  return result.results as any[];
}

// Create a draft experiment. If labId is given, the reproducibility
// manifest (template/seed/rows) is captured from that lab automatically.
app.post('/v1/experiments', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required to create an experiment' }, 401);

  const body = await c.req.json<{
    title: string; question?: string; labId?: string;
    template?: string; seed?: number; rows?: number;
    workspaceId?: string;
  }>();
  if (!body.title) return c.json({ error: 'title is required' }, 400);

  let template = body.template ?? null;
  let seed = body.seed ?? null;
  let rows = body.rows ?? null;

  if (body.labId) {
    const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(body.labId).first();
    if (lab) {
      template = template ?? (lab.template as string);
      seed = seed ?? (lab.seed as number | null);
      rows = rows ?? (lab.rows as number);
    }
  }

  let workspaceId: string | null = null;
  if (body.workspaceId) {
    const member = await env.DB.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).bind(body.workspaceId, userId).first();
    if (!member) return c.json({ error: 'You are not a member of that workspace' }, 403);
    workspaceId = body.workspaceId;
  }

  const id = 'exp-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO experiments (id, user_id, lab_id, status, title, question, template, seed, rows, lab_version, engine_version, environment, workspace_id, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, userId, body.labId || null, body.title, body.question || null,
    template, seed, rows, LAB_API_VERSION, ENGINE_VERSION,
    JSON.stringify({ createdVia: 'api', platform: 'realitydb-simlab' }), workspaceId, now
  ).run();

  return c.json({ id, title: body.title, status: 'draft', visibility: 'private', template, seed, rows, workspaceId, createdAt: now }, 201);
});

// Get a single experiment with its ordered evidence blocks. Gated by
// resolveAccess — pass a verified Bearer token to view anything beyond
// public/unlisted published experiments.
app.get('/v1/experiments/:id', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const evidence = await env.DB.prepare(
    'SELECT id, type, position, title, data, created_at FROM experiment_evidence WHERE experiment_id = ? ORDER BY position ASC'
  ).bind(exp.id).all();

  const parsedEvidence = (evidence.results || []).map((e: any) => ({ ...e, data: JSON.parse(e.data) }));

  let bookmarked = false;
  if (userId) {
    const bm = await env.DB.prepare('SELECT 1 FROM experiment_bookmarks WHERE experiment_id = ? AND user_id = ?').bind(exp.id, userId).first();
    bookmarked = !!bm;
  }

  const credibility = await getCredibilitySummary(env, exp.id as string);

  return c.json({ ...exp, viewerAccess: access, bookmarked, ...credibility, evidence: parsedEvidence });
});

// List the signed-in user's own experiments (drafts + published) — the
// backbone of the Profile page. Includes credibility aggregates so
// Published cards can show the same badges as the public Gallery.
app.get('/v1/experiments', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const result = await env.DB.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = e.id) as reproduction_count,
      (SELECT COUNT(*) FROM experiment_reproductions r WHERE r.experiment_id = e.id AND r.matched = 1) as reproduction_matched_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL) as validation_count,
      (SELECT COUNT(*) FROM experiment_validations v WHERE v.experiment_id = e.id AND v.superseded_at IS NULL AND v.verdict = 'confirms') as validation_confirms_count,
      (SELECT COUNT(*) FROM experiment_reviews rv WHERE rv.experiment_id = e.id) as review_count
    FROM experiments e WHERE e.user_id = ? ORDER BY e.created_at DESC
  `).bind(userId).all();
  return c.json({ experiments: result.results });
});

// ── Profile aggregates: what a user has DONE across all experiments ────
// (as opposed to /v1/experiments, which is what they OWN). These three
// plus /v1/experiments/bookmarks/mine (defined earlier) are the backbone
// of the Professional Profile page — designed to extend cleanly to a
// public researcher/org profile later without a route redesign, since
// they're already scoped per-user rather than per-workspace.

app.get('/v1/experiments/reproductions/mine', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const result = await env.DB.prepare(`
    SELECT r.id, r.matched, r.notes, r.created_at, e.id as experiment_id, e.slug, e.title, e.status
    FROM experiment_reproductions r JOIN experiments e ON e.id = r.experiment_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC
  `).bind(userId).all();
  return c.json({ reproductions: result.results });
});

app.get('/v1/experiments/reviews/mine', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const result = await env.DB.prepare(`
    SELECT rv.id, rv.review_type, rv.content, rv.status, rv.evidence_id, rv.created_at, e.id as experiment_id, e.slug, e.title
    FROM experiment_reviews rv JOIN experiments e ON e.id = rv.experiment_id
    WHERE rv.reviewer_user_id = ? ORDER BY rv.created_at DESC
  `).bind(userId).all();
  return c.json({ reviews: result.results });
});

app.get('/v1/experiments/validations/mine', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const result = await env.DB.prepare(`
    SELECT v.id, v.verdict, v.note, v.created_at, e.id as experiment_id, e.slug, e.title
    FROM experiment_validations v JOIN experiments e ON e.id = v.experiment_id
    WHERE v.validator_user_id = ? AND v.superseded_at IS NULL ORDER BY v.created_at DESC
  `).bind(userId).all();
  return c.json({ validations: result.results });
});

// Update an experiment's narrative fields. Requires editor access,
// derived from the verified Supabase JWT subject — never a client-
// supplied userId.
app.patch('/v1/experiments/:id', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'editor')) return c.json({ error: 'Insufficient permission' }, 403);

  const body = await c.req.json<{
    title?: string; question?: string; findings?: string; tags?: string; authors?: string; license?: string;
    keyFindings?: string; limitations?: string; futureWork?: string;
  }>();
  await env.DB.prepare(
    `UPDATE experiments SET
       title = COALESCE(?, title), question = COALESCE(?, question),
       findings = COALESCE(?, findings), tags = COALESCE(?, tags),
       authors = COALESCE(?, authors), license = COALESCE(?, license),
       key_findings = COALESCE(?, key_findings), limitations = COALESCE(?, limitations), future_work = COALESCE(?, future_work),
       updated_at = ?
     WHERE id = ?`
  ).bind(
    body.title ?? null, body.question ?? null, body.findings ?? null,
    body.tags ?? null, body.authors ?? null, body.license ?? null,
    body.keyFindings ?? null, body.limitations ?? null, body.futureWork ?? null,
    new Date().toISOString(), exp.id
  ).run();

  return c.json({ id: exp.id, updated: true });
});

// Add an evidence block to an experiment. For type 'sql_query' with
// execute:true, the SQL actually runs against the experiment's lab and
// the real result set is cached as a companion 'result_table' block —
// this is what lets a published Experiment render forever, even after
// the originating lab (and its Neon branch) has expired.
app.post('/v1/experiments/:id/evidence', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'editor')) return c.json({ error: 'Insufficient permission' }, 403);

  const body = await c.req.json<{
    type: 'sql_query' | 'result_table' | 'chart' | 'markdown';
    title?: string;
    sql?: string;
    execute?: boolean;
    data?: any;
  }>();

  if (!body.type) return c.json({ error: 'type is required' }, 400);
  const now = new Date().toISOString();
  const created: any[] = [];

  if (body.type === 'sql_query') {
    if (!body.sql?.trim()) return c.json({ error: 'sql is required for type sql_query' }, 400);

    let executionTimeMs: number | null = null;
    let resultBlock: any = null;

    if (body.execute) {
      if (!exp.lab_id) return c.json({ error: 'Experiment has no lab_id — cannot execute SQL' }, 400);
      const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(exp.lab_id).first();
      if (!lab) return c.json({ error: 'Originating lab not found (may have expired)' }, 404);

      const start = Date.now();
      try {
        const sql = neon(lab.connection_string as string);
        const rowsResult = await sql(body.sql);
        executionTimeMs = Date.now() - start;

        const capped = rowsResult.slice(0, 500);
        resultBlock = {
          columns: capped.length > 0 ? Object.keys(capped[0]) : [],
          rows: capped,
          rowCount: rowsResult.length,
          truncated: rowsResult.length > 500,
        };
      } catch (err: any) {
        return c.json({ error: `Query execution failed: ${err.message}` }, 400);
      }
    }

    const sqlEvidenceId = 'ev-' + crypto.randomUUID().split('-')[0];
    const sqlPosition = await nextEvidencePosition(env.DB, exp.id as string);
    const sqlData = { sql: body.sql, executionTimeMs };
    await env.DB.prepare(
      'INSERT INTO experiment_evidence (id, experiment_id, type, position, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(sqlEvidenceId, exp.id, 'sql_query', sqlPosition, body.title || null, JSON.stringify(sqlData), now).run();
    created.push({ id: sqlEvidenceId, type: 'sql_query', position: sqlPosition, title: body.title || null, data: sqlData });

    if (resultBlock) {
      const resultEvidenceId = 'ev-' + crypto.randomUUID().split('-')[0];
      const resultPosition = await nextEvidencePosition(env.DB, exp.id as string);
      const resultData = { ...resultBlock, sourceEvidenceId: sqlEvidenceId };
      await env.DB.prepare(
        'INSERT INTO experiment_evidence (id, experiment_id, type, position, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(resultEvidenceId, exp.id, 'result_table', resultPosition, null, JSON.stringify(resultData), now).run();
      created.push({ id: resultEvidenceId, type: 'result_table', position: resultPosition, title: null, data: resultData });
    }
  } else {
    // markdown / chart / future evidence types — data is caller-provided and opaque to this endpoint.
    if (!body.data) return c.json({ error: 'data is required for this evidence type' }, 400);
    const evidenceId = 'ev-' + crypto.randomUUID().split('-')[0];
    const position = await nextEvidencePosition(env.DB, exp.id as string);
    await env.DB.prepare(
      'INSERT INTO experiment_evidence (id, experiment_id, type, position, title, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(evidenceId, exp.id, body.type, position, body.title || null, JSON.stringify(body.data), now).run();
    created.push({ id: evidenceId, type: body.type, position, title: body.title || null, data: body.data });
  }

  await env.DB.prepare('UPDATE experiments SET updated_at = ? WHERE id = ?').bind(now, exp.id).run();
  return c.json({ evidence: created }, 201);
});

// Edit an existing evidence block's title/description/tags — needed because
// chart evidence today only gets an auto-generated title at creation time
// (e.g. "bar chart: revenue by month"). Same editor-or-above tier as
// evidence creation, not the stricter owner/admin tier used for
// visibility/publish — an editor is trusted to curate evidence metadata.
app.patch('/v1/experiments/:id/evidence/:evidenceId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const evidence = await env.DB.prepare('SELECT * FROM experiment_evidence WHERE id = ? AND experiment_id = ?')
    .bind(c.req.param('evidenceId'), exp.id).first();
  if (!evidence) return c.json({ error: 'Evidence not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'editor')) return c.json({ error: 'Insufficient permission' }, 403);

  const body = await c.req.json<{ title?: string; description?: string; tags?: string }>();
  const updates: string[] = [];
  const params: (string | null)[] = [];
  if (body.title !== undefined) { updates.push('title = ?'); params.push(body.title || null); }
  if (body.description !== undefined) { updates.push('description = ?'); params.push(body.description || null); }
  if (body.tags !== undefined) { updates.push('tags = ?'); params.push(body.tags || null); }
  if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);

  params.push(evidence.id as string);
  await env.DB.prepare(`UPDATE experiment_evidence SET ${updates.join(', ')} WHERE id = ?`).bind(...params).run();

  const updated = await env.DB.prepare('SELECT * FROM experiment_evidence WHERE id = ?').bind(evidence.id).first();
  return c.json({ evidence: updated });
});

const VISIBILITY_VALUES = new Set(['private', 'workspace', 'specific_people', 'unlisted', 'public']);

// Publish an experiment — requires findings + at least one evidence block.
// Publishing is ownership-sensitive (it changes discoverability and
// interacts with visibility), so it requires owner or workspace owner/
// admin — a plain editor grant is not enough. BACKWARD COMPAT: userId
// optional, falls back to owner (see PATCH note above).
// Accepts an optional target `visibility`; if omitted, defaults to
// 'unlisted' (safe middle ground — shareable via link, not broadcast in
// the public gallery listing) unless a non-default visibility was already
// set pre-publish via PATCH /visibility, in which case that is kept.
app.post('/v1/experiments/:id/publish', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  if (!(await isOwnerOrWorkspaceAdmin(env, exp, userId))) return c.json({ error: 'Insufficient permission — owner or workspace admin required' }, 403);

  const body = await c.req.json<{ visibility?: string }>().catch(() => ({} as any));

  if (!exp.findings) return c.json({ error: 'Findings are required before publishing' }, 400);

  const evidenceCount = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM experiment_evidence WHERE experiment_id = ?'
  ).bind(exp.id).first();
  if (((evidenceCount as any)?.c || 0) === 0) return c.json({ error: 'At least one evidence block is required before publishing' }, 400);

  let visibility = (exp.visibility as string) || 'private';
  if (body.visibility) {
    if (!VISIBILITY_VALUES.has(body.visibility)) return c.json({ error: `Invalid visibility: ${body.visibility}` }, 400);
    visibility = body.visibility;
  } else if (visibility === 'private') {
    visibility = 'unlisted';
  }

  const slugBase = (exp.title as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
  const existing = await env.DB.prepare('SELECT id FROM experiments WHERE slug = ?').bind(slugBase).first();
  const slug = existing ? slugBase + '-' + (exp.id as string).split('-')[1] : slugBase;

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE experiments SET status = 'published', slug = ?, visibility = ?, published_at = ? WHERE id = ?`
  ).bind(slug, visibility, now, exp.id).run();

  await logExperimentEvent(env, exp.id as string, 'published', userId, { visibility });

  return c.json({ id: exp.id, slug, visibility, url: 'https://sandbox.realitydb.dev/#gallery/' + slug, publishedAt: now });
});

// ============================================================
// EXPERIMENT ACCESS & VISIBILITY
// ============================================================

// Set/update visibility (and optionally attach a workspace). Ownership-
// sensitive — requires owner or workspace owner/admin, not a plain editor
// grant. Enforces server-side: public/unlisted require status =
// 'published'; drafts may only be private, workspace, or specific_people.
app.patch('/v1/experiments/:id/visibility', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ visibility: string; workspaceId?: string }>();
  if (!body.visibility || !VISIBILITY_VALUES.has(body.visibility)) return c.json({ error: 'Valid visibility is required' }, 400);

  if (!(await isOwnerOrWorkspaceAdmin(env, exp, userId))) return c.json({ error: 'Insufficient permission — owner or workspace admin required' }, 403);

  if ((body.visibility === 'public' || body.visibility === 'unlisted') && exp.status !== 'published') {
    return c.json({ error: 'Publish this experiment before setting public or unlisted visibility' }, 400);
  }

  let workspaceId = exp.workspace_id as string | null;
  if (body.visibility === 'workspace') {
    workspaceId = body.workspaceId || workspaceId;
    if (!workspaceId) return c.json({ error: 'workspaceId is required to set workspace visibility' }, 400);
    const member = await env.DB.prepare(
      'SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
    ).bind(workspaceId, userId).first();
    if (!member) return c.json({ error: 'You are not a member of that workspace' }, 403);
  }

  await env.DB.prepare(
    'UPDATE experiments SET visibility = ?, workspace_id = ?, updated_at = ? WHERE id = ?'
  ).bind(body.visibility, workspaceId, new Date().toISOString(), exp.id).run();

  return c.json({ id: exp.id, visibility: body.visibility, workspaceId });
});

// "Who has access" — workspace membership (if any) + explicit grants.
// Requires reviewer access (collaborator identities are more sensitive
// than the experiment content itself).
app.get('/v1/experiments/:id/access', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'reviewer')) return c.json({ error: 'Insufficient permission' }, 403);

  let workspace: any = null;
  let workspaceMembers: any[] = [];
  if (exp.workspace_id) {
    workspace = await env.DB.prepare('SELECT id, name, slug FROM workspaces WHERE id = ?').bind(exp.workspace_id).first();
    const members = await env.DB.prepare('SELECT user_id, role, joined_at FROM workspace_members WHERE workspace_id = ?').bind(exp.workspace_id).all();
    workspaceMembers = members.results || [];
  }

  const grants = await env.DB.prepare(
    'SELECT id, user_id, invite_email, permission, invited_by, invited_at, accepted_at FROM experiment_access_grants WHERE experiment_id = ? ORDER BY invited_at DESC'
  ).bind(exp.id).all();

  return c.json({ visibility: exp.visibility, workspace, workspaceMembers, accessGrants: grants.results || [] });
});

// Grant explicit access to a user or an email invite. Ownership-sensitive
// — requires owner or workspace owner/admin, not a plain editor grant.
app.post('/v1/experiments/:id/access', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  if (!(await isOwnerOrWorkspaceAdmin(env, exp, userId))) return c.json({ error: 'Insufficient permission — owner or workspace admin required' }, 403);

  const body = await c.req.json<{ granteeUserId?: string; inviteEmail?: string; permission: string }>();
  if (!['viewer', 'reviewer', 'editor'].includes(body.permission)) return c.json({ error: 'permission must be viewer, reviewer, or editor' }, 400);
  const hasGrantee = !!body.granteeUserId;
  const hasEmail = !!body.inviteEmail;
  if (hasGrantee === hasEmail) return c.json({ error: 'Provide exactly one of granteeUserId or inviteEmail' }, 400);

  // Re-granting an existing collaborator updates their permission in place
  // rather than stacking a second row — resolveAccess() only ever reads
  // one row per (experiment, user), so a stale duplicate would silently
  // under- or over-grant depending on row order. Enforced at the DB level
  // too via partial unique indexes on (experiment_id, user_id) and
  // (experiment_id, invite_email).
  const now = new Date().toISOString();
  const existing = body.granteeUserId
    ? await env.DB.prepare('SELECT id FROM experiment_access_grants WHERE experiment_id = ? AND user_id = ?').bind(exp.id, body.granteeUserId).first()
    : await env.DB.prepare('SELECT id FROM experiment_access_grants WHERE experiment_id = ? AND invite_email = ?').bind(exp.id, body.inviteEmail).first();

  let id: string;
  if (existing) {
    id = (existing as any).id;
    await env.DB.prepare('UPDATE experiment_access_grants SET permission = ?, invited_by = ?, invited_at = ? WHERE id = ?')
      .bind(body.permission, userId, now, id).run();
  } else {
    id = 'grant-' + crypto.randomUUID().split('-')[0];
    await env.DB.prepare(
      `INSERT INTO experiment_access_grants (id, experiment_id, user_id, invite_email, permission, invited_by, invited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, exp.id, body.granteeUserId || null, body.inviteEmail || null, body.permission, userId, now).run();
  }

  return c.json({ id, experimentId: exp.id, userId: body.granteeUserId || null, inviteEmail: body.inviteEmail || null, permission: body.permission, invitedAt: now }, existing ? 200 : 201);
});

// Revoke an access grant. Ownership-sensitive — owner or workspace
// owner/admin only.
app.delete('/v1/experiments/:id/access/:grantId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  if (!(await isOwnerOrWorkspaceAdmin(env, exp, userId))) return c.json({ error: 'Insufficient permission — owner or workspace admin required' }, 403);

  const result = await env.DB.prepare('DELETE FROM experiment_access_grants WHERE id = ? AND experiment_id = ?').bind(c.req.param('grantId'), exp.id).run();
  const changes = result.meta?.changes ?? 0;
  if (changes === 0) return c.json({ error: 'Access grant not found' }, 404);
  return c.json({ deleted: true });
});

// ============================================================
// ENGAGEMENT: BOOKMARK
// ============================================================

// Idempotent — bookmarking twice is a no-op, no duplicate event. Requires
// viewer access (must be able to see the experiment to bookmark it).
app.post('/v1/experiments/:id/bookmark', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const result = await env.DB.prepare(
    'INSERT OR IGNORE INTO experiment_bookmarks (experiment_id, user_id, created_at) VALUES (?, ?, ?)'
  ).bind(exp.id, userId, new Date().toISOString()).run();

  if ((result.meta?.changes ?? 0) > 0) {
    await logExperimentEvent(env, exp.id as string, 'bookmarked', userId, {});
  }

  return c.json({ bookmarked: true });
});

// Idempotent removal. Deliberately does not emit an event — the ledger
// records meaningful engagement, not its reversal.
app.delete('/v1/experiments/:id/bookmark', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  await env.DB.prepare('DELETE FROM experiment_bookmarks WHERE experiment_id = ? AND user_id = ?').bind(c.req.param('id'), userId).run();
  return c.json({ bookmarked: false });
});

// List the signed-in user's bookmarked experiments.
app.get('/v1/experiments/bookmarks/mine', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const result = await env.DB.prepare(
    `SELECT e.id, e.slug, e.title, e.question, e.status, e.visibility, b.created_at as bookmarked_at
     FROM experiment_bookmarks b JOIN experiments e ON e.id = b.experiment_id
     WHERE b.user_id = ? ORDER BY b.created_at DESC`
  ).bind(userId).all();

  return c.json({ bookmarks: result.results });
});

// ============================================================
// ENGAGEMENT: REPRODUCE
// ============================================================

// A substantive, queryable claim — "I re-ran this and got a matching (or
// non-matching) result" — not just an event. Requires viewer access.
app.post('/v1/experiments/:id/reproductions', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ matched: boolean; notes?: string; newExperimentId?: string }>();
  if (typeof body.matched !== 'boolean') return c.json({ error: 'matched (boolean) is required' }, 400);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const id = 'repro-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO experiment_reproductions (id, experiment_id, user_id, matched, notes, new_experiment_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, exp.id, userId, body.matched ? 1 : 0, body.notes || null, body.newExperimentId || null, now).run();

  await logExperimentEvent(env, exp.id as string, 'reproduced', userId, { reproductionId: id, matched: body.matched });

  return c.json({ id, experimentId: exp.id, matched: body.matched, notes: body.notes || null, createdAt: now }, 201);
});

app.get('/v1/experiments/:id/reproductions', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const result = await env.DB.prepare(
    'SELECT * FROM experiment_reproductions WHERE experiment_id = ? ORDER BY created_at DESC'
  ).bind(exp.id).all();
  return c.json({ reproductions: result.results });
});

// ============================================================
// ENGAGEMENT: PEER REVIEW (structured, evidence-anchored)
// ============================================================

// Reviews target either a specific evidence block or the experiment
// generally (evidenceId omitted). Requires reviewer access — one tier
// above plain viewing, matching "reviewer" as a real permission concept.
app.post('/v1/experiments/:id/reviews', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ evidenceId?: string; reviewType: string; content: string }>();
  if (!body.content?.trim()) return c.json({ error: 'content is required' }, 400);
  if (!['suggestion', 'question', 'concern', 'endorsement'].includes(body.reviewType)) {
    return c.json({ error: 'reviewType must be suggestion, question, concern, or endorsement' }, 400);
  }
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'reviewer')) return c.json({ error: 'Insufficient permission — reviewer access required' }, 403);

  if (body.evidenceId) {
    const ev = await env.DB.prepare('SELECT 1 FROM experiment_evidence WHERE id = ? AND experiment_id = ?').bind(body.evidenceId, exp.id).first();
    if (!ev) return c.json({ error: 'evidenceId does not belong to this experiment' }, 400);
  }

  const id = 'rev-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO experiment_reviews (id, experiment_id, evidence_id, reviewer_user_id, review_type, content, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`
  ).bind(id, exp.id, body.evidenceId || null, userId, body.reviewType, body.content.trim(), now).run();

  await logExperimentEvent(env, exp.id as string, 'reviewed', userId, { reviewId: id, evidenceId: body.evidenceId || null });

  return c.json({ id, experimentId: exp.id, evidenceId: body.evidenceId || null, reviewType: body.reviewType, content: body.content.trim(), status: 'open', createdAt: now }, 201);
});

app.get('/v1/experiments/:id/reviews', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const result = await env.DB.prepare(
    'SELECT * FROM experiment_reviews WHERE experiment_id = ? ORDER BY created_at ASC'
  ).bind(exp.id).all();
  return c.json({ reviews: result.results });
});

// Resolve a review (mark addressed/dismissed). Only the experiment
// owner/editor may do this — a review's author does NOT get to mark
// their own review addressed/dismissed (that would let someone silence
// their own critique). Authors instead edit or withdraw their review via
// the two endpoints below.
app.patch('/v1/experiments/:id/reviews/:reviewId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const review = await env.DB.prepare('SELECT * FROM experiment_reviews WHERE id = ? AND experiment_id = ?').bind(c.req.param('reviewId'), exp.id).first();
  if (!review) return c.json({ error: 'Review not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ status: string }>();
  if (!['addressed', 'dismissed'].includes(body.status)) return c.json({ error: 'status must be addressed or dismissed' }, 400);

  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'editor')) return c.json({ error: 'Insufficient permission — experiment editor or owner required' }, 403);

  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE experiment_reviews SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?'
  ).bind(body.status, now, userId, review.id).run();

  return c.json({ id: review.id, status: body.status, resolvedAt: now, resolvedBy: userId });
});

// Edit the content of your own review. Author-only, and only while the
// review is still 'open' — once an owner/editor has resolved it, the
// record of what was said should stop changing.
app.patch('/v1/experiments/:id/reviews/:reviewId/content', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const review = await env.DB.prepare('SELECT * FROM experiment_reviews WHERE id = ? AND experiment_id = ?').bind(c.req.param('reviewId'), c.req.param('id')).first();
  if (!review) return c.json({ error: 'Review not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId || review.reviewer_user_id !== userId) return c.json({ error: 'Only the review author may edit it' }, 403);

  const body = await c.req.json<{ content: string }>();
  if (review.status !== 'open') return c.json({ error: 'Only open reviews can be edited' }, 400);
  if (!body.content?.trim()) return c.json({ error: 'content is required' }, 400);

  await env.DB.prepare('UPDATE experiment_reviews SET content = ? WHERE id = ?').bind(body.content.trim(), review.id).run();
  return c.json({ id: review.id, content: body.content.trim() });
});

// Withdraw your own review. Author-only. This removes the structured
// review record; the 'reviewed' event stays in the immutable ledger
// regardless — the ledger records that engagement happened, not the
// current state of the review content.
app.delete('/v1/experiments/:id/reviews/:reviewId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const review = await env.DB.prepare('SELECT * FROM experiment_reviews WHERE id = ? AND experiment_id = ?').bind(c.req.param('reviewId'), c.req.param('id')).first();
  if (!review) return c.json({ error: 'Review not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId || review.reviewer_user_id !== userId) return c.json({ error: 'Only the review author may withdraw it' }, 403);

  await env.DB.prepare('DELETE FROM experiment_reviews WHERE id = ?').bind(review.id).run();
  return c.json({ withdrawn: true });
});

// ============================================================
// ENGAGEMENT: VALIDATE
// ============================================================

// A peer's judgment call on whether the evidence holds up. Enforces "one
// current validation per user/experiment" via a partial unique index on
// (experiment_id, validator_user_id) WHERE superseded_at IS NULL — a
// re-validation supersedes the prior row rather than erasing history.
// Requires reviewer access (a judgment call is a stronger claim than
// viewing).
app.post('/v1/experiments/:id/validations', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ verdict: string; note?: string }>();
  if (!['confirms', 'disputes', 'needs_more_info'].includes(body.verdict)) {
    return c.json({ error: 'verdict must be confirms, disputes, or needs_more_info' }, 400);
  }
  if (userId === exp.user_id) return c.json({ error: 'Owners cannot validate their own experiment' }, 400);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'reviewer')) return c.json({ error: 'Insufficient permission — reviewer access required' }, 403);

  const now = new Date().toISOString();
  await env.DB.prepare(
    'UPDATE experiment_validations SET superseded_at = ? WHERE experiment_id = ? AND validator_user_id = ? AND superseded_at IS NULL'
  ).bind(now, exp.id, userId).run();

  const id = 'val-' + crypto.randomUUID().split('-')[0];
  await env.DB.prepare(
    `INSERT INTO experiment_validations (id, experiment_id, validator_user_id, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, exp.id, userId, body.verdict, body.note || null, now).run();

  await logExperimentEvent(env, exp.id as string, 'validated', userId, { validationId: id, verdict: body.verdict });

  return c.json({ id, experimentId: exp.id, verdict: body.verdict, note: body.note || null, createdAt: now }, 201);
});

app.get('/v1/experiments/:id/validations', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const result = await env.DB.prepare(
    'SELECT * FROM experiment_validations WHERE experiment_id = ? AND superseded_at IS NULL ORDER BY created_at DESC'
  ).bind(exp.id).all();
  return c.json({ validations: result.results });
});

// ============================================================
// ENGAGEMENT: REFERENCE (citation graph — backend only this pass;
// authoring UX/UI is deferred)
// ============================================================

// Creating a citation is an edit to the SOURCE experiment ("this
// experiment builds upon X") — it requires editor-or-above on the source
// (:id), the same tier as any other content edit. No permission on the
// target is required or checked beyond "it exists and is visible to the
// caller" — acknowledging someone else's public work doesn't need their
// approval. (Corrected 2026-07-12: this previously required reviewer
// access on the TARGET, which had the relationship backwards.)
app.post('/v1/experiments/:id/references', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const source = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!source) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const sourceAccess = await resolveAccess(env, source, userId);
  if (!hasAccess(sourceAccess, 'editor')) return c.json({ error: 'Insufficient permission — editor access required on the source experiment' }, 403);

  const body = await c.req.json<{ targetExperimentId?: string; note?: string }>();
  if (!body.targetExperimentId) return c.json({ error: 'targetExperimentId is required' }, 400);
  if (body.targetExperimentId === source.id) return c.json({ error: 'An experiment cannot reference itself' }, 400);

  const target = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(body.targetExperimentId).first();
  if (!target) return c.json({ error: 'targetExperimentId not found' }, 404);
  const targetAccess = await resolveAccess(env, target, userId);
  if (!hasAccess(targetAccess, 'viewer')) return c.json({ error: 'targetExperimentId not found' }, 404);

  const dup = await env.DB.prepare('SELECT id FROM experiment_references WHERE source_experiment_id = ? AND target_experiment_id = ?').bind(source.id, target.id).first();
  if (dup) return c.json({ error: 'This citation already exists' }, 409);

  const id = 'ref-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO experiment_references (id, source_experiment_id, target_experiment_id, note, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, source.id, target.id, body.note || null, userId, now).run();

  await logExperimentEvent(env, target.id as string, 'referenced', userId, { referenceId: id, sourceExperimentId: source.id });

  return c.json({ id, sourceExperimentId: source.id, targetExperimentId: target.id, note: body.note || null, createdAt: now }, 201);
});

// Remove a citation — same authorization as creating one: editor-or-above
// on the reference's source experiment.
app.delete('/v1/experiments/:id/references/:referenceId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const ref = await env.DB.prepare('SELECT * FROM experiment_references WHERE id = ? AND source_experiment_id = ?')
    .bind(c.req.param('referenceId'), c.req.param('id')).first();
  if (!ref) return c.json({ error: 'Reference not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const source = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(ref.source_experiment_id).first();
  if (!source) return c.json({ error: 'Experiment not found' }, 404);
  const sourceAccess = await resolveAccess(env, source, userId);
  if (!hasAccess(sourceAccess, 'editor')) return c.json({ error: 'Insufficient permission — editor access required on the source experiment' }, 403);

  await env.DB.prepare('DELETE FROM experiment_references WHERE id = ?').bind(ref.id).run();
  return c.json({ deleted: true });
});

app.get('/v1/experiments/:id/references', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  // Joined to the *other* experiment's title/slug in each row — citedBy
  // rows join on source_experiment_id (the citing experiment), cites rows
  // join on target_experiment_id (the cited experiment) — so the UI can
  // render "Referenced by: <title>" without an extra fetch per row.
  const citedBy = await env.DB.prepare(`
    SELECT r.id, r.note, r.created_at, r.source_experiment_id, s.title as other_title, s.slug as other_slug
    FROM experiment_references r LEFT JOIN experiments s ON s.id = r.source_experiment_id
    WHERE r.target_experiment_id = ? ORDER BY r.created_at DESC
  `).bind(exp.id).all();
  const cites = await env.DB.prepare(`
    SELECT r.id, r.note, r.created_at, r.target_experiment_id, t.title as other_title, t.slug as other_slug
    FROM experiment_references r JOIN experiments t ON t.id = r.target_experiment_id
    WHERE r.source_experiment_id = ? ORDER BY r.created_at DESC
  `).bind(exp.id).all();

  return c.json({ citedBy: citedBy.results || [], cites: cites.results || [] });
});

// ============================================================
// ENGAGEMENT: SHARE (event only — no structured table needed)
// ============================================================

app.post('/v1/experiments/:id/share', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const body = await c.req.json<{ method?: string }>().catch(() => ({} as any));
  await logExperimentEvent(env, exp.id as string, 'shared', userId, { method: body.method || 'link' });
  return c.json({ shared: true });
});

// ============================================================
// EVENT LEDGER (read-only)
// ============================================================

// The experiment's full activity timeline. Requires viewer access.
app.get('/v1/experiments/:id/events', async (c) => {
  const env = c.env;
  const exp = await env.DB.prepare('SELECT * FROM experiments WHERE id = ?').bind(c.req.param('id')).first();
  if (!exp) return c.json({ error: 'Experiment not found' }, 404);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  const access = await resolveAccess(env, exp, userId);
  if (!hasAccess(access, 'viewer')) return c.json({ error: 'Experiment not found' }, 404);

  const result = await env.DB.prepare(
    'SELECT id, event_type, actor_user_id, metadata, created_at FROM experiment_events WHERE experiment_id = ? ORDER BY created_at DESC LIMIT 100'
  ).bind(exp.id).all();
  const parsed = (result.results || []).map((e: any) => ({ ...e, metadata: JSON.parse(e.metadata || '{}') }));
  return c.json({ events: parsed });
});

// ============================================================
// WORKSPACES (minimal foundation — team management UI deferred)
// ============================================================

app.post('/v1/workspaces', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ name: string }>();
  if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);

  const id = 'ws-' + crypto.randomUUID().split('-')[0];
  const slugBase = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
  const existing = await env.DB.prepare('SELECT id FROM workspaces WHERE slug = ?').bind(slugBase).first();
  const slug = existing ? slugBase + '-' + id.split('-')[1] : slugBase;
  const now = new Date().toISOString();

  await env.DB.prepare('INSERT INTO workspaces (id, name, slug, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, body.name.trim(), slug, userId, now).run();
  await env.DB.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, 'owner', now).run();

  return c.json({ id, name: body.name.trim(), slug, ownerUserId: userId, createdAt: now }, 201);
});

app.get('/v1/workspaces/mine', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const result = await env.DB.prepare(
    `SELECT w.id, w.name, w.slug, w.owner_user_id, m.role, w.created_at
     FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = ? ORDER BY w.created_at DESC`
  ).bind(userId).all();

  return c.json({ workspaces: result.results });
});

app.get('/v1/workspaces/:id/members', async (c) => {
  const env = c.env;
  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const isMember = await env.DB.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(c.req.param('id'), userId).first();
  if (!isMember) return c.json({ error: 'Workspace not found' }, 404);

  const result = await env.DB.prepare('SELECT user_id, role, joined_at FROM workspace_members WHERE workspace_id = ?').bind(c.req.param('id')).all();
  return c.json({ members: result.results });
});

// Requires the requester to be workspace owner/admin.
app.post('/v1/workspaces/:id/members', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = await verifySupabaseJWT(c.req.header('Authorization'));
  if (!userId) return c.json({ error: 'Sign in required' }, 401);

  const body = await c.req.json<{ memberUserId: string; role?: string }>();
  if (!body.memberUserId) return c.json({ error: 'memberUserId is required' }, 400);
  const role = body.role || 'member';
  if (!['owner', 'admin', 'member'].includes(role)) return c.json({ error: 'role must be owner, admin, or member' }, 400);

  const requester = await env.DB.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').bind(c.req.param('id'), userId).first();
  if (!requester || !['owner', 'admin'].includes((requester as any).role)) return c.json({ error: 'Insufficient permission' }, 403);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`
  ).bind(c.req.param('id'), body.memberUserId, role, now).run();

  return c.json({ workspaceId: c.req.param('id'), userId: body.memberUserId, role }, 201);
});

// ============================================================
// ADMIN / DEPLOYMENT CHECKS
// ============================================================
//
// MIGRATION RULE — read before adding any column to `experiments` (or any
// other table `resolveAccess`/visibility logic depends on):
//
//   Any ALTER TABLE that adds a column with a DEFAULT affecting access-
//   control semantics (visibility, workspace_id, permission tiers, etc.)
//   MUST NOT leave already-published rows in a state that is more
//   restrictive than their pre-migration behavior. Either:
//     (a) choose a default that preserves existing access, or
//     (b) ship an explicit, narrowly-scoped backfill UPDATE (targeting
//         specific rows/IDs, never a blanket predicate) alongside the
//         migration, run and verified before the code that enforces the
//         new column goes live.
//
//   This happened once already: `visibility TEXT DEFAULT 'private'` was
//   added while 3 experiments were already published (and had been fully
//   public); the default silently demoted all 3. Run the check below
//   after every schema change that touches access control, and treat any
//   non-empty result as a release blocker.

// Flags published experiments sitting at the raw column default with no
// explicit visibility decision ever made — the exact signature of a
// migration-induced demotion (the publish endpoint itself never leaves
// visibility at bare 'private'; it defaults new publishes to 'unlisted'
// at minimum). A non-empty result here after a deploy means: stop and
// investigate before doing anything else.
app.get('/v1/admin/checks/visibility-integrity', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const suspect = await env.DB.prepare(
    "SELECT id, slug, title, user_id, status, visibility, published_at FROM experiments WHERE status = 'published' AND visibility = 'private' ORDER BY published_at ASC"
  ).all();

  const inconsistentWorkspace = await env.DB.prepare(
    "SELECT id, slug, title, visibility, workspace_id FROM experiments WHERE visibility = 'workspace' AND workspace_id IS NULL"
  ).all();

  return c.json({
    ok: (suspect.results?.length ?? 0) === 0 && (inconsistentWorkspace.results?.length ?? 0) === 0,
    likelyDemotedOnMigration: suspect.results || [],
    workspaceVisibilityMissingWorkspaceId: inconsistentWorkspace.results || [],
  });
});

// ============================================================
// EXPORT ENDPOINTS
// ============================================================

// Export lab as Jupyter notebook — with live schema introspection and pandas
app.get('/v1/labs/:id/export', async (c) => {
  const env = c.env;
  const format = c.req.query('format');
  if (format !== 'notebook') {
    return c.json({ error: 'Unsupported format. Use ?format=notebook' }, 400);
  }

  const lab = await env.DB.prepare('SELECT * FROM labs WHERE id = ?').bind(c.req.param('id')).first();
  if (!lab) return c.json({ error: 'Lab not found' }, 404);

  // Fetch live schema from the database
  let schemaMarkdown = 'Schema information unavailable (database may be suspended).';
  try {
    const sql = neon(lab.connection_string as string);
    const tables = await sql(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const schemaLines: string[] = [];
    for (const t of tables as any[]) {
      const cols = await sql(
        `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [t.table_name]
      );

      schemaLines.push(`### ${t.table_name}`);
      schemaLines.push('| Column | Type | Nullable |');
      schemaLines.push('|--------|------|----------|');
      for (const col of cols as any[]) {
        schemaLines.push(`| ${col.column_name} | ${col.data_type} | ${col.is_nullable} |`);
      }
      schemaLines.push('');
    }
    schemaMarkdown = schemaLines.join('\n');
  } catch {
    // If DB is unreachable, use placeholder
  }

  // Fetch saved queries
  const queriesResult = await env.DB.prepare(
    'SELECT name, sql_text FROM saved_queries WHERE lab_id = ? ORDER BY created_at ASC'
  ).bind(lab.id).all();
  const savedQueries = queriesResult.results || [];

  // Cell builders
  const mdCell = (lines: string[]) => ({
    cell_type: 'markdown',
    metadata: {},
    source: lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)),
  });
  const codeCell = (lines: string[]) => ({
    cell_type: 'code',
    execution_count: null,
    metadata: {},
    outputs: [],
    source: lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)),
  });

  const cells: any[] = [];

  // Title cell
  cells.push(mdCell([
    `# RealityDB Lab: ${lab.name || lab.template}`,
    '',
    `- **Template:** ${lab.template}`,
    `- **Rows:** ${(lab.rows as number).toLocaleString()}`,
    `- **Created:** ${lab.created_at}`,
    `- **Expires:** ${lab.expires_at}`,
    `- **Lab ID:** \`${lab.id}\``,
  ]));

  // Schema cell
  cells.push(mdCell([
    '## Database Schema',
    '',
    schemaMarkdown,
  ]));

  // Setup cell
  cells.push(codeCell([
    '# Install dependencies (run once)',
    '!pip install psycopg2-binary pandas sqlalchemy -q',
  ]));

  // Connection cell (mask password — user fills in from `realitydb lab connect`)
  const maskedConn = maskConnection(lab.connection_string as string);
  cells.push(codeCell([
    'import pandas as pd',
    'from sqlalchemy import create_engine',
    '',
    '# Replace **** with your actual password from `realitydb lab connect`',
    `DATABASE_URL = "${maskedConn}"`,
    '',
    'engine = create_engine(DATABASE_URL)',
    '',
    '# Quick test',
    "tables = pd.read_sql(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'\", engine)",
    'print(f"Connected! {len(tables)} tables available")',
    'tables',
  ]));

  // Saved query cells or default exploration
  if (savedQueries.length > 0) {
    cells.push(mdCell(['## Saved Queries', '']));
    for (const q of savedQueries as any[]) {
      cells.push(mdCell([`### ${q.name}`]));
      cells.push(codeCell([
        `# ${q.name}`,
        `df = pd.read_sql("""`,
        q.sql_text,
        `""", engine)`,
        'df.head(20)',
      ]));
    }
  } else {
    cells.push(mdCell(['## Explore the Data', '']));
    cells.push(codeCell([
      '# List all tables with row counts',
      "query = \"\"\"",
      "SELECT schemaname, tablename,",
      "       (xpath('/row/cnt/text()', xml_count))[1]::text::int AS row_count",
      "FROM (",
      "  SELECT schemaname, tablename,",
      "         query_to_xml('SELECT count(*) AS cnt FROM ' || schemaname || '.' || tablename, false, true, '') AS xml_count",
      "  FROM pg_tables WHERE schemaname = 'public'",
      ") t ORDER BY row_count DESC",
      "\"\"\"",
      'pd.read_sql(query, engine)',
    ]));
  }

  // Reproducibility + citation cell
  cells.push(mdCell([
    '## Reproducibility',
    '',
    'This dataset was generated by RealityDB with deterministic seeding.',
    'Regenerate identical data with:',
    '',
    '```bash',
    `realitydb lab create ${lab.template} --rows ${lab.rows} --seed 42`,
    '```',
    '',
    '## Citation',
    '',
    '```bibtex',
    '@software{realitydb,',
    '  title = {RealityDB: Synthetic Data Generation Platform},',
    '  author = {Mpingo Systems},',
    '  url = {https://realitydb.dev},',
    `  year = {${new Date().getFullYear()}}`,
    '}',
    '```',
  ]));

  const notebook = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.0' },
      realitydb: { lab_id: lab.id, template: lab.template, rows: lab.rows },
    },
    cells,
  };

  const filename = `realitydb-${lab.template}-${lab.rows}.ipynb`;
  return new Response(JSON.stringify(notebook, null, 2), {
    headers: {
      'Content-Type': 'application/x-ipynb+json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// ============================================================
// CI ENDPOINT
// ============================================================

// Minimal CI endpoint: create a short-lived lab for CI pipelines
app.post('/v1/labs/ci', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{ template?: string; rows?: number }>().catch(() => ({}));
  const template = (body as any).template || 'banking';
  const rows = (body as any).rows || 5000;
  const id = `ci-${crypto.randomUUID().split('-')[0]}`;
  const name = `ci-${Date.now().toString(36)}`;

  // Validate template exists in R2
  const rowLabel = rows >= 1000 ? `${rows / 1000}k` : String(rows);
  const r2Key = `templates/${template}-${rowLabel}.sql`;
  const templateObj = await env.TEMPLATES.get(r2Key);
  if (!templateObj) {
    return c.json({ error: `Template not found: ${r2Key}` }, 404);
  }

  try {
    const branch = await createNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, id);
    const connectionString = branch.connectionUri;

    // Seed via Neon SQL API
    const sqlText = await templateObj.text();
    const connUrl = new URL(connectionString.replace('postgresql://', 'https://'));
    const neonHost = connUrl.hostname;

    const statements: string[] = [];
    let current = '';
    for (const line of sqlText.split('\n')) {
      current += line + '\n';
      if (line.trimEnd().endsWith(';') && !line.trim().startsWith('--')) {
        const trimmed = current.trim();
        if (trimmed && trimmed !== ';') statements.push(trimmed);
        current = '';
      }
    }
    if (current.trim()) statements.push(current.trim());

    const txRes = await fetch(`https://${neonHost}/sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Neon-Connection-String': connectionString,
        'Neon-Raw-Text-Output': 'true',
        'Neon-Array-Mode': 'true',
        'Neon-Pool-Opt-In': 'true',
      },
      body: JSON.stringify({
        queries: statements.map(s => ({ query: s.replace(/;\s*$/, ''), params: [] })),
      }),
    });

    if (!txRes.ok) {
      // Fallback to individual statements
      const db = neon(connectionString);
      for (const stmt of statements.slice(0, 45)) {
        try { await db(stmt.replace(/;\s*$/, '')); } catch {}
      }
    }

    // 2h TTL for CI
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    await env.DB.prepare(
      `INSERT INTO labs (id, user_id, name, template, rows, neon_branch_id, neon_endpoint_id, connection_string, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, 'ci', name, template, rows, branch.branchId, branch.endpointId, connectionString, now.toISOString(), expiresAt.toISOString()).run();

    // Return minimal JSON for CI consumption
    return c.json({
      id,
      connectionString,
      host: connUrl.hostname,
      database: 'neondb',
      expiresAt: expiresAt.toISOString(),
    }, 201);
  } catch (err: any) {
    return c.json({ error: `CI lab creation failed: ${err.message}` }, 500);
  }
});

// ============================================================
// CERTIFICATE VERIFICATION (PUBLIC — no auth required)
// ============================================================

// Verify a certificate by cert_id
app.get('/v1/certs/:certId/verify', async (c) => {
  const env = c.env;
  const certId = c.req.param('certId');

  const cert = await env.DB.prepare('SELECT * FROM certificates WHERE cert_id = ?').bind(certId).first();
  if (!cert) {
    return c.json({ valid: false, error: 'Certificate not found' }, 404);
  }

  // Increment verified_count
  await env.DB.prepare('UPDATE certificates SET verified_count = verified_count + 1 WHERE cert_id = ?')
    .bind(certId).run();

  return c.json({
    valid: true,
    certId: cert.cert_id,
    level: cert.level,
    score: cert.score,
    grade: cert.grade,
    displayName: cert.display_name,
    challengeCount: cert.challenge_count,
    timeTakenSeconds: cert.time_taken_seconds,
    templateUsed: cert.template_used,
    issuedAt: cert.issued_at,
    verifiedCount: (cert.verified_count as number) + 1,
  });
});

// Sync a certificate from the frontend (called after exam completion)
app.post('/v1/certs', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    certId: string;
    userId: string;
    attemptId?: string;
    level: string;
    score: number;
    grade: string;
    displayName?: string;
    challengeCount?: number;
    timeTakenSeconds?: number;
    templateUsed?: string;
    issuedAt: string;
  }>();

  const id = 'cert-' + crypto.randomUUID().split('-')[0];

  await env.DB.prepare(
    `INSERT INTO certificates (id, cert_id, user_id, attempt_id, level, score, grade, display_name, challenge_count, time_taken_seconds, template_used, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cert_id) DO UPDATE SET score = excluded.score, grade = excluded.grade`
  ).bind(
    id, body.certId, body.userId, body.attemptId || null,
    body.level, body.score, body.grade, body.displayName || null,
    body.challengeCount || null, body.timeTakenSeconds || null,
    body.templateUsed || null, body.issuedAt
  ).run();

  return c.json({ synced: true, certId: body.certId }, 201);
});

// List all certificates for a user
app.get('/v1/certs', async (c) => {
  const env = c.env;
  const userId = c.req.query('userId');
  if (!userId) return c.json({ error: 'userId query parameter required' }, 400);

  const result = await env.DB.prepare(
    'SELECT cert_id, level, score, grade, display_name, issued_at FROM certificates WHERE user_id = ? ORDER BY issued_at DESC'
  ).bind(userId).all();

  return c.json({ certificates: result.results });
});

// ============================================================
// ENTITLEMENT ENDPOINTS
// ============================================================

// Get user's current entitlement/tier
app.get('/v1/entitlements/:userId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const ent = await getEntitlement(env.DB, c.req.param('userId'));
  return c.json(ent);
});

// Set/update user entitlement (called by Stripe webhook or admin)
app.put('/v1/entitlements/:userId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const userId = c.req.param('userId');
  const body = await c.req.json<{
    tier: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
    periodEnd?: string;
  }>();

  const limits = TIER_LIMITS[body.tier];
  if (!limits) return c.json({ error: `Unknown tier: ${body.tier}` }, 400);

  const now = new Date().toISOString();
  const id = 'ent-' + crypto.randomUUID().split('-')[0];

  await env.DB.prepare(
    `INSERT INTO entitlements (id, user_id, tier, max_rows, max_active_labs, downloads_per_month, labs_daily_limit, stripe_customer_id, stripe_subscription_id, current_period_end, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET tier = excluded.tier, max_rows = excluded.max_rows, max_active_labs = excluded.max_active_labs, downloads_per_month = excluded.downloads_per_month, labs_daily_limit = excluded.labs_daily_limit, stripe_customer_id = excluded.stripe_customer_id, stripe_subscription_id = excluded.stripe_subscription_id, current_period_end = excluded.current_period_end, status = 'active', updated_at = excluded.updated_at`
  ).bind(
    id, userId, body.tier, limits.maxRows, limits.maxActiveLabs, limits.downloadsPerMonth, limits.labsDaily,
    body.stripeCustomerId || null, body.stripeSubscriptionId || null,
    body.periodEnd || null, now, now
  ).run();

  return c.json({ userId, tier: body.tier, limits });
});

// ============================================================
// BADGE ENDPOINTS
// ============================================================

// List badge definitions
app.get('/v1/badges', (c) => {
  return c.json({ badges: BADGE_DEFINITIONS });
});

// Get badges for a user
app.get('/v1/badges/:userId', async (c) => {
  const env = c.env;
  const result = await env.DB.prepare(
    'SELECT * FROM badges WHERE user_id = ? ORDER BY earned_at DESC'
  ).bind(c.req.param('userId')).all();

  return c.json({ badges: result.results });
});

// Award a badge (called by frontend after achievement)
app.post('/v1/badges', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const body = await c.req.json<{
    userId: string;
    badgeType: string;
    badgeTier: string;
    score?: number;
    challengesCompleted?: number;
  }>();

  if (!BADGE_DEFINITIONS[body.badgeType]) {
    return c.json({ error: `Unknown badge type: ${body.badgeType}` }, 400);
  }

  const id = 'badge-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO badges (id, user_id, badge_type, badge_tier, score, challenges_completed, earned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, badge_type) DO UPDATE SET badge_tier = excluded.badge_tier, score = excluded.score, challenges_completed = excluded.challenges_completed, earned_at = excluded.earned_at`
  ).bind(id, body.userId, body.badgeType, body.badgeTier, body.score || null, body.challengesCompleted || null, now).run();

  return c.json({
    id,
    badge: BADGE_DEFINITIONS[body.badgeType],
    tier: body.badgeTier,
    earnedAt: now,
  }, 201);
});

// ============================================================
// STORE ENDPOINTS
// ============================================================

// List available datasets with pricing
app.get('/v1/store', (c) => {
  const datasets = Object.entries(DATASET_PRICING).map(([template, prices]) => ({
    template,
    variants: Object.entries(prices).map(([size, priceCents]) => ({
      size,
      rows: parseInt(size) * 1000,
      priceCents,
      free: priceCents === 0,
    })),
  }));
  return c.json({ datasets, tiers: TIER_LIMITS });
});

// Get details for a specific dataset template
app.get('/v1/store/:template', async (c) => {
  const env = c.env;
  const template = c.req.param('template');
  const pricing = DATASET_PRICING[template];
  if (!pricing) return c.json({ error: 'Template not found' }, 404);

  // Try to get a 5-row preview from the 5k template
  const r2Key = `templates/${template}-5k.sql`;
  const templateObj = await env.TEMPLATES.get(r2Key);

  let preview: string[] = [];
  if (templateObj) {
    const sql = await templateObj.text();
    // Extract first INSERT block to show sample data
    const insertMatch = sql.match(/INSERT INTO (\w+) .+?VALUES\n([\s\S]*?);/);
    if (insertMatch) {
      const rows = insertMatch[2].split('\n').filter(l => l.trim().startsWith('(')).slice(0, 5);
      preview = rows.map(r => r.trim());
    }
  }

  return c.json({
    template,
    variants: Object.entries(pricing).map(([size, priceCents]) => ({
      size,
      rows: parseInt(size) * 1000,
      priceCents,
      free: priceCents === 0,
    })),
    preview,
  });
});

// Initiate a purchase (stub — will be wired to Stripe)
app.post('/v1/store/:template/buy', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const template = c.req.param('template');
  const body = await c.req.json<{ userId: string; rows: number }>();
  const rowLabel = body.rows >= 1000 ? `${body.rows / 1000}k` : String(body.rows);
  const pricing = DATASET_PRICING[template];
  if (!pricing || pricing[rowLabel] === undefined) {
    return c.json({ error: 'Invalid template/size combination' }, 400);
  }

  const priceCents = pricing[rowLabel];
  if (priceCents === 0) {
    return c.json({ error: 'Free tier — no purchase needed. Create a lab directly.' }, 400);
  }

  const id = 'pur-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO dataset_purchases (id, user_id, template, rows, price_cents, status, lab_credits_remaining, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 3, ?)`
  ).bind(id, body.userId, template, body.rows, priceCents, now).run();

  // In production: create Stripe checkout session and return URL
  // For now: return purchase ID for manual completion
  return c.json({
    purchaseId: id,
    template,
    rows: body.rows,
    priceCents,
    priceFormatted: `$${(priceCents / 100).toFixed(2)}`,
    status: 'pending',
    note: 'Stripe integration pending. Use PUT /v1/store/complete/:purchaseId to simulate completion.',
  }, 201);
});

// Complete a purchase (simulate Stripe webhook for now)
app.put('/v1/store/complete/:purchaseId', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);

  const purchaseId = c.req.param('purchaseId');
  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE dataset_purchases SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(now, purchaseId).run();

  const purchase = await env.DB.prepare('SELECT * FROM dataset_purchases WHERE id = ?').bind(purchaseId).first();
  if (!purchase) return c.json({ error: 'Purchase not found' }, 404);

  return c.json({ completed: true, purchase });
});

// Download dataset SQL file from R2
app.get('/v1/store/:template/download', async (c) => {
  const env = c.env;
  const template = c.req.param('template');
  const size = c.req.query('size') || '5k';
  const format = c.req.query('format') || 'sql';

  if (format !== 'sql') {
    return c.json({ error: 'Only format=sql is supported' }, 400);
  }

  const pricing = DATASET_PRICING[template];
  if (!pricing) return c.json({ error: `Unknown template: ${template}` }, 404);

  const priceCents = pricing[size];
  if (priceCents === undefined) {
    return c.json({ error: `Size ${size} not available for ${template}. Available: ${Object.keys(pricing).join(', ')}` }, 400);
  }

  // Free tier (5k): no auth required
  // Paid sizes: require auth + check download entitlement or purchase
  if (priceCents > 0) {
    const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
    if (!authenticate(apiKey, env)) {
      return c.json({ error: 'Authentication required for paid dataset downloads' }, 401);
    }

    // Check if user has an active subscription with downloads remaining
    // or a completed purchase for this template/size
    const userId = 'api-user'; // TODO: extract from JWT or API key mapping
    const ent = await getEntitlement(env.DB, userId);

    if (ent.downloads_per_month === 0 && (ent.tier === 'free')) {
      // Check one-time purchases
      const rows = parseInt(size) * 1000;
      const purchase = await env.DB.prepare(
        "SELECT * FROM dataset_purchases WHERE user_id = ? AND template = ? AND rows >= ? AND status = 'completed'"
      ).bind(userId, template, rows).first();

      if (!purchase) {
        return c.json({
          error: 'Download requires a subscription (Core+) or one-time purchase',
          tier: ent.tier,
          buyUrl: `/v1/store/${template}/buy`,
        }, 403);
      }
    }

    // Decrement download counter for subscription users
    if ((ent.downloads_per_month as number) > 0) {
      const used = (ent.downloads_used_this_month as number) || 0;
      if (used >= (ent.downloads_per_month as number) && (ent.downloads_per_month as number) !== -1) {
        return c.json({ error: 'Monthly download limit reached', used, limit: ent.downloads_per_month }, 429);
      }
      await env.DB.prepare('UPDATE entitlements SET downloads_used_this_month = downloads_used_this_month + 1 WHERE user_id = ?')
        .bind(userId).run();
    }
  }

  // Fetch from R2
  const r2Key = `templates/${template}-${size}.sql`;
  const object = await env.TEMPLATES.get(r2Key);

  if (!object) {
    return c.json({ error: `Dataset file not found: ${r2Key}. This size may not have been generated yet.` }, 404);
  }

  const filename = `realitydb-${template}-${size}.sql`;
  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/sql',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(object.size),
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

// Check which sizes are available for a template in R2
app.get('/v1/store/:template/sizes', async (c) => {
  const env = c.env;
  const template = c.req.param('template');

  const pricing = DATASET_PRICING[template];
  if (!pricing) return c.json({ error: `Unknown template: ${template}` }, 404);

  const allSizes = Object.keys(pricing);
  const available: string[] = [];

  for (const size of allSizes) {
    const r2Key = `templates/${template}-${size}.sql`;
    const head = await env.TEMPLATES.head(r2Key);
    if (head) {
      available.push(size);
    }
  }

  return c.json({
    template,
    sizes: available,
    allSizes,
    formats: ['sql'],
    pricing: Object.fromEntries(
      allSizes.map(s => [s, { priceCents: pricing[s], available: available.includes(s) }])
    ),
  });
});

// ============================================================
// STRIPE PAYMENT ENDPOINTS
// ============================================================

// Stripe API helper — all Stripe calls go through fetch (no SDK needed)
async function stripeAPI(secretKey: string, endpoint: string, params: Record<string, string>): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  return res.json();
}

async function stripeGET(secretKey: string, endpoint: string): Promise<any> {
  const res = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    headers: { 'Authorization': `Bearer ${secretKey}` },
  });
  return res.json();
}

// ============================================================
// DODO PAYMENTS — primary payment processor (Stripe kept as fallback above)
// ============================================================

// Dodo API helper — JSON body, Bearer auth (mirrors stripeAPI but JSON not form-encoded)
async function dodoAPI(
  secretKey: string,
  endpoint: string,
  body?: Record<string, any>
): Promise<any> {
  const baseUrl = 'https://live.dodopayments.com';
  const res = await fetch(`${baseUrl}/${endpoint}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // Dodo occasionally returns non-JSON (404 HTML, empty body). Parse defensively
  // so callers get structured data instead of an uncaught throw → 500.
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _dodo_status: res.status, _dodo_raw: text.slice(0, 500) };
  }
}

// Business ID: bus_0Ncmo4Hc4s7QRoViHC7Fj
// Product ID map — canonical source of truth for allowed Dodo products
const DODO_PRODUCTS: Record<string, string> = {
  // Subscriptions
  data_monthly:           'pdt_0Nirf6Mx6bpCNmvw95xUp',  // $19/mo
  data_annual:            'pdt_0Nirf6QAWnvSfWIQ7vuHw',  // $190/yr
  professional_monthly:   'pdt_0NirfGsVdeTfxs1dDREhp',  // $49/mo
  professional_annual:    'pdt_0NirfGvvtkR7JFAS2XPyF',  // $490/yr
  enterprise_eu_monthly:  'pdt_0NirfeJV05qMdKB2WSu2g',  // €499/mo
  enterprise_eu_annual:   'pdt_0NirfeOfJwXzZupRtDrua',  // €4,990/yr
  team_monthly:           'pdt_0NiwqEQox4EwJqXvnhSph',  // $99/mo
  team_annual:            'pdt_0NiwqERFLzbPmSaBTiEbT',  // $990/yr
  // Credits (one-time)
  credits_starter:        'pdt_0NirfeTLQMc7V6kgvfjMB',  // $9  — 5 runs, 50K rows
  credits_standard:       'pdt_0Nirfs73dKQndnUGJgPh7',  // $29 — 20 runs, 100K rows
  credits_research:       'pdt_0Nirfs8ke53HBG9iWKDvq',  // $79 — 30 days, 500K rows
  credits_eu_compliance:  'pdt_0Nirfs9a1QlZ5AIDEBM7T',  // €299 — 10 EU runs + comply
  // Dataset one-time purchases
  dataset_50k:            'pdt_0NiwqELSVr8obmFb7RAEO',  // $49
  dataset_100k:           'pdt_0NiwqEPggv7srrLKeOkLj',  // $79
  dataset_500k:           'pdt_0NiwqEQ5ceoWGiP9vWivF',  // $299
  dataset_1m:             'pdt_0NiwqEQT1zHgxVTA6Nf5B',  // $499
  dataset_50k_test:       'pdt_0NiwzkIObz6WkzYXnLgsD',  // Dodo test-mode product used for the first live webhook verification
};

// Reverse lookup: product_id → product key
function dodoProductKey(productId: string): string | undefined {
  return Object.keys(DODO_PRODUCTS).find((k) => DODO_PRODUCTS[k] === productId);
}

// Subscription product → tier + explicit entitlement limits (per sprint spec).
// NOTE: tiers 'data' / 'professional' / 'enterprise_eu' are NOT in TIER_LIMITS,
// so limits are specified explicitly here rather than looked up.
interface DodoTierLimits {
  tier: string;
  maxRows: number;
  maxActiveLabs: number;
  downloadsPerMonth: number;
  labsDaily: number;
}
const DODO_SUBSCRIPTION_TIERS: Record<string, DodoTierLimits> = {
  data_monthly:          { tier: 'data',          maxRows: 500000,    maxActiveLabs: 3,   downloadsPerMonth: 50,  labsDaily: 3 },
  data_annual:           { tier: 'data',          maxRows: 500000,    maxActiveLabs: 3,   downloadsPerMonth: 50,  labsDaily: 3 },
  professional_monthly:  { tier: 'professional',  maxRows: 2000000,   maxActiveLabs: 5,   downloadsPerMonth: 200, labsDaily: 10 },
  professional_annual:   { tier: 'professional',  maxRows: 2000000,   maxActiveLabs: 5,   downloadsPerMonth: 200, labsDaily: 10 },
  team_monthly:          { tier: 'team',          maxRows: 2000000,   maxActiveLabs: 30,  downloadsPerMonth: 300, labsDaily: 20 },
  team_annual:           { tier: 'team',          maxRows: 2000000,   maxActiveLabs: 30,  downloadsPerMonth: 300, labsDaily: 20 },
  enterprise_eu_monthly: { tier: 'enterprise_eu', maxRows: 999999999, maxActiveLabs: 999, downloadsPerMonth: 999, labsDaily: 999 },
  enterprise_eu_annual:  { tier: 'enterprise_eu', maxRows: 999999999, maxActiveLabs: 999, downloadsPerMonth: 999, labsDaily: 999 },
};

// One-time credit product → grant (per sprint spec).
interface DodoCreditGrant {
  runs?: number;
  euRuns?: number;
  researchDays?: number;
  maxRowsPerRun: number;
  euComplyEnabled?: boolean;
}
const DODO_CREDIT_PRODUCTS: Record<string, DodoCreditGrant> = {
  credits_starter:       { runs: 5,  maxRowsPerRun: 50000 },
  credits_standard:      { runs: 20, maxRowsPerRun: 100000 },
  credits_research:      { researchDays: 30, maxRowsPerRun: 500000 },
  credits_eu_compliance: { euRuns: 10, maxRowsPerRun: 100000, euComplyEnabled: true },
};

// Subscription price mapping — these get created on first deploy via /v1/stripe/setup
const SUBSCRIPTION_TIERS: Record<string, { name: string; monthlyPriceCents: number; features: string }> = {
  core: { name: 'RealityDB Core', monthlyPriceCents: 4900, features: '50K rows, 3 active labs, SQL downloads' },
  compliance: { name: 'RealityDB Compliance', monthlyPriceCents: 19900, features: '100K rows, 10 active labs, domain specialist' },
  research: { name: 'RealityDB Research', monthlyPriceCents: 2492, features: '100K rows, 5 labs, 30-day TTL, Jupyter export, citations' },
};

// One-time setup: create Stripe products and prices (idempotent)
app.post('/v1/stripe/setup', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return c.json({ error: 'Unauthorized' }, 401);
  if (!env.STRIPE_SECRET_KEY) return c.json({ error: 'STRIPE_SECRET_KEY not configured' }, 500);

  const results: Record<string, any> = {};

  // Create subscription products + prices
  for (const [tier, config] of Object.entries(SUBSCRIPTION_TIERS)) {
    const product = await stripeAPI(env.STRIPE_SECRET_KEY, 'products', {
      name: config.name,
      description: config.features,
      'metadata[tier]': tier,
    });

    const price = await stripeAPI(env.STRIPE_SECRET_KEY, 'prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: String(config.monthlyPriceCents),
      'recurring[interval]': 'month',
      'metadata[tier]': tier,
    });

    results[tier] = { productId: product.id, priceId: price.id, amount: config.monthlyPriceCents };
  }

  // Create one-time purchase products for each template/size combo
  for (const [template, prices] of Object.entries(DATASET_PRICING)) {
    for (const [size, priceCents] of Object.entries(prices)) {
      if (priceCents === 0) continue; // Skip free tier
      const product = await stripeAPI(env.STRIPE_SECRET_KEY, 'products', {
        name: `RealityDB ${template} Dataset — ${size} rows`,
        description: `One-time purchase: ${template} template, ${size} rows. Includes SQL download + 3 lab credits.`,
        'metadata[template]': template,
        'metadata[size]': size,
      });

      const price = await stripeAPI(env.STRIPE_SECRET_KEY, 'prices', {
        product: product.id,
        currency: 'usd',
        unit_amount: String(priceCents),
        'metadata[template]': template,
        'metadata[size]': size,
      });

      results[`${template}-${size}`] = { productId: product.id, priceId: price.id, amount: priceCents };
    }
  }

  // Create certification exam products
  const certPrices: Record<string, number> = { foundations: 2900, analyst: 4900, advanced: 7900, specialist: 9900 };
  for (const [level, priceCents] of Object.entries(certPrices)) {
    const product = await stripeAPI(env.STRIPE_SECRET_KEY, 'products', {
      name: `RealityDB SQL Certification — ${level.charAt(0).toUpperCase() + level.slice(1)}`,
      description: `Timed SQL certification exam with verifiable credential`,
      'metadata[type]': 'certification',
      'metadata[level]': level,
    });

    const price = await stripeAPI(env.STRIPE_SECRET_KEY, 'prices', {
      product: product.id,
      currency: 'usd',
      unit_amount: String(priceCents),
      'metadata[type]': 'certification',
      'metadata[level]': level,
    });

    results[`cert-${level}`] = { productId: product.id, priceId: price.id, amount: priceCents };
  }

  return c.json({ created: results });
});

// Create a Stripe Checkout Session (subscription or one-time)
app.post('/v1/stripe/checkout', async (c) => {
  const env = c.env;
  if (!env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 500);

  const body = await c.req.json<{
    priceId: string;
    userId: string;
    email?: string;
    returnUrl: string;
    mode?: 'subscription' | 'payment';
  }>();

  if (!body.priceId || !body.userId || !body.returnUrl) {
    return c.json({ error: 'priceId, userId, and returnUrl are required' }, 400);
  }

  const mode = body.mode || 'subscription';

  // Check if user already has a Stripe customer ID
  const ent = await env.DB.prepare('SELECT stripe_customer_id FROM entitlements WHERE user_id = ?')
    .bind(body.userId).first();
  let customerId = (ent as any)?.stripe_customer_id;

  // Create customer if needed
  if (!customerId) {
    const customer = await stripeAPI(env.STRIPE_SECRET_KEY, 'customers', {
      'metadata[userId]': body.userId,
      ...(body.email ? { email: body.email } : {}),
    });
    customerId = customer.id;
  }

  // Create checkout session
  const params: Record<string, string> = {
    customer: customerId,
    mode,
    'line_items[0][price]': body.priceId,
    'line_items[0][quantity]': '1',
    success_url: `${body.returnUrl}?session_id={CHECKOUT_SESSION_ID}&status=success`,
    cancel_url: `${body.returnUrl}?status=cancelled`,
    'metadata[userId]': body.userId,
  };

  if (mode === 'subscription') {
    params['subscription_data[metadata][userId]'] = body.userId;
  } else {
    params['payment_intent_data[metadata][userId]'] = body.userId;
  }

  const session = await stripeAPI(env.STRIPE_SECRET_KEY, 'checkout/sessions', params);

  if (session.error) {
    return c.json({ error: session.error.message }, 400);
  }

  return c.json({ url: session.url, sessionId: session.id });
});

// Create a Stripe Customer Portal session (manage subscription)
app.post('/v1/stripe/portal', async (c) => {
  const env = c.env;
  if (!env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 500);

  const body = await c.req.json<{ customerId: string; returnUrl: string }>();

  const session = await stripeAPI(env.STRIPE_SECRET_KEY, 'billing_portal/sessions', {
    customer: body.customerId,
    return_url: body.returnUrl,
  });

  if (session.error) {
    return c.json({ error: session.error.message }, 400);
  }

  return c.json({ url: session.url });
});

// Stripe Webhook handler — processes payment events
app.post('/v1/stripe/webhook', async (c) => {
  const env = c.env;
  if (!env.STRIPE_SECRET_KEY) return c.json({ error: 'Stripe not configured' }, 500);

  const body = await c.req.text();
  const sig = c.req.header('stripe-signature');

  // Verify webhook signature
  if (env.STRIPE_WEBHOOK_SECRET && sig) {
    const verified = await verifyStripeSignature(body, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!verified) {
      return c.json({ error: 'Invalid signature' }, 400);
    }
  }

  const event = JSON.parse(body);
  console.log(`Stripe webhook: ${event.type}`);

  const now = new Date().toISOString();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      if (!userId) break;

      if (session.mode === 'subscription') {
        // Fetch subscription to get price metadata
        const sub = await stripeGET(env.STRIPE_SECRET_KEY, `subscriptions/${session.subscription}`);
        const tier = sub.items?.data?.[0]?.price?.metadata?.tier || 'core';
        const limits = TIER_LIMITS[tier] || TIER_LIMITS.core;

        // Upsert entitlement
        const entId = 'ent-' + crypto.randomUUID().split('-')[0];
        await env.DB.prepare(
          `INSERT INTO entitlements (id, user_id, tier, max_rows, max_active_labs, downloads_per_month, labs_daily_limit, stripe_customer_id, stripe_subscription_id, status, current_period_end, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier, max_rows=excluded.max_rows, max_active_labs=excluded.max_active_labs, downloads_per_month=excluded.downloads_per_month, labs_daily_limit=excluded.labs_daily_limit, stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id, status='active', current_period_end=excluded.current_period_end, updated_at=excluded.updated_at`
        ).bind(
          entId, userId, tier, limits.maxRows, limits.maxActiveLabs, limits.downloadsPerMonth, limits.labsDaily,
          session.customer, session.subscription,
          sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          now, now
        ).run();

        console.log(`Subscription activated: ${userId} → ${tier}`);
      } else if (session.mode === 'payment') {
        // One-time purchase — check line items for template/size
        const lineItems = await stripeGET(env.STRIPE_SECRET_KEY, `checkout/sessions/${session.id}/line_items`);
        const item = lineItems.data?.[0];
        const price = item?.price;
        const template = price?.metadata?.template;
        const size = price?.metadata?.size;
        const certLevel = price?.metadata?.level;

        if (template && size) {
          // Dataset purchase
          const rows = parseInt(size) * 1000;
          const purId = 'pur-' + crypto.randomUUID().split('-')[0];
          await env.DB.prepare(
            `INSERT INTO dataset_purchases (id, user_id, template, rows, price_cents, stripe_payment_id, status, lab_credits_remaining, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, 'completed', 3, ?, ?)`
          ).bind(purId, userId, template, rows, price?.unit_amount || 0, session.payment_intent, now, now).run();

          console.log(`Dataset purchased: ${userId} → ${template}-${size}`);
        } else if (certLevel) {
          // Certification exam purchase — could store entitlement to take exam
          console.log(`Cert exam purchased: ${userId} → ${certLevel}`);
        }
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      const tier = sub.items?.data?.[0]?.price?.metadata?.tier || 'core';
      const status = sub.status === 'active' ? 'active' : (sub.status === 'past_due' ? 'past_due' : 'cancelled');

      await env.DB.prepare(
        `UPDATE entitlements SET status = ?, current_period_end = ?, updated_at = ? WHERE user_id = ?`
      ).bind(
        status,
        sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
        now, userId
      ).run();

      console.log(`Subscription updated: ${userId} → ${status}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const userId = sub.metadata?.userId;
      if (!userId) break;

      // Downgrade to free
      const limits = TIER_LIMITS.free;
      await env.DB.prepare(
        `UPDATE entitlements SET tier = 'free', status = 'cancelled', max_rows = ?, max_active_labs = ?, downloads_per_month = ?, labs_daily_limit = ?, updated_at = ? WHERE user_id = ?`
      ).bind(limits.maxRows, limits.maxActiveLabs, limits.downloadsPerMonth, limits.labsDaily, now, userId).run();

      console.log(`Subscription cancelled: ${userId} → free`);
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (subId) {
        await env.DB.prepare(
          `UPDATE entitlements SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`
        ).bind(now, subId).run();
      }
      break;
    }
  }

  return c.json({ received: true });
});

// Verify Stripe webhook signature using Web Crypto API
async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  try {
    const parts = header.split(',').reduce((acc: Record<string, string>, part) => {
      const [k, v] = part.split('=');
      acc[k.trim()] = v;
      return acc;
    }, {});

    const timestamp = parts['t'];
    const signature = parts['v1'];
    if (!timestamp || !signature) return false;

    // Reject if timestamp is too old (5 min tolerance)
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) return false;

    const signedPayload = `${timestamp}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(signedPayload));
    const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

    return computed === signature;
  } catch {
    return false;
  }
}

// ============================================================
// DODO PAYMENTS ENDPOINTS
// ============================================================

// Create a Dodo hosted checkout session
app.post('/v1/checkout', async (c) => {
  const env = c.env;
  if (!env.DODO_API_KEY) return c.json({ error: 'Dodo Payments not configured' }, 500);

  const body = await c.req.json<{
    product_id: string;
    user_email: string;
    success_url: string;
    cancel_url: string;
    template?: string;
    rows?: number;
    productKey?: string;
  }>().catch(() => null);

  if (!body || !body.product_id || !body.user_email || !body.success_url || !body.cancel_url) {
    return c.json({ error: 'product_id, user_email, success_url, and cancel_url are required' }, 400);
  }

  // Validate product_id is one we recognize
  if (!dodoProductKey(body.product_id)) {
    return c.json({ error: `Unknown product_id: ${body.product_id}` }, 400);
  }

  // Dodo checkout API: POST /checkouts with a `customer` object and `return_url`.
  // (The sprint spec's `/checkout/sessions` + top-level `customer_email`/`success_url`
  //  do not match Dodo's current API — corrected here per docs.dodopayments.com.
  //  Client-facing request/response contract is kept exactly as the sprint defined.)
  // NOTE: a live test purchase confirmed Dodo's payment.succeeded webhook always
  // carries an empty metadata object regardless of what's sent at checkout creation —
  // so metadata cannot be used to recover template/rows. Instead, the download_tokens
  // row is pre-created here (status='pending') keyed by session_id, and the webhook
  // just flips it to 'paid' once payment succeeds.
  const session = await dodoAPI(env.DODO_API_KEY, 'checkouts', {
    product_cart: [{ product_id: body.product_id, quantity: 1 }],
    customer: { email: body.user_email },
    return_url: body.success_url,
    cancel_url: body.cancel_url,
    metadata: {
      user_email: body.user_email,
      product_id: body.product_id,
      ...(body.template ? { template: body.template } : {}),
      ...(body.rows != null ? { rows: String(body.rows) } : {}),
      ...(body.productKey ? { product_key: body.productKey } : {}),
    },
  });

  const checkoutUrl = session?.checkout_url || session?.payment_link || session?.url;
  const sessionId = session?.session_id || session?.id;

  if (!checkoutUrl) {
    // Surface Dodo's error so it can be debugged rather than returning a false success
    return c.json({ error: 'Dodo checkout session failed', details: session }, 400);
  }

  // Pre-create the download token for dataset purchases (session_id is the lookup key —
  // metadata doesn't survive to the webhook, see note above).
  if (body.template && body.rows != null) {
    const token = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO download_tokens (token, template, rows, format, customer_email, product_id, session_id, expires_at, downloaded, status)
       VALUES (?, ?, ?, 'sql', ?, ?, ?, datetime('now', '+7 days'), 0, 'pending')`
    ).bind(token, body.template, body.rows, body.user_email, body.product_id, sessionId).run();
  }

  return c.json({ checkout_url: checkoutUrl, session_id: sessionId });
});

// Look up a download token by the checkout session_id returned from POST /v1/checkout.
// The row is pre-created (status='pending') at checkout time and flipped to 'paid'
// by the webhook, so this can report 'pending' briefly right after redirect —
// the caller should retry a few times before giving up.
app.get('/v1/download-by-session/:sessionId', async (c) => {
  const env = c.env;
  const row = await env.DB.prepare(
    'SELECT token, status FROM download_tokens WHERE session_id = ? ORDER BY created_at DESC LIMIT 1'
  ).bind(c.req.param('sessionId')).first();

  if (!row) return c.json({ status: 'not_found' }, 404);
  if (row.status !== 'paid') return c.json({ status: 'pending' }, 404);
  return c.json({ token: row.token, downloadUrl: `/v1/download/${row.token}` });
});

// Serve a purchased dataset file by download token (one-time use).
app.get('/v1/download/:token', async (c) => {
  const env = c.env;
  const token = c.req.param('token');

  const row = await env.DB.prepare(
    `SELECT * FROM download_tokens WHERE token = ? AND status = 'paid' AND downloaded = 0 AND expires_at > datetime('now')`
  ).bind(token).first();

  if (!row) return c.json({ error: 'invalid_or_expired_token' }, 404);

  const rows = row.rows as number;
  const rowLabel = rows >= 1000 ? `${rows / 1000}k` : String(rows);
  const r2Key = `templates/${row.template}-${rowLabel}.sql`;
  const file = await env.TEMPLATES.get(r2Key);

  if (!file) {
    return c.json({
      status: 'generating',
      message: 'Your dataset is being generated. Check back in 60 seconds.',
      poll_url: `/v1/download/${token}/status`,
    }, 202);
  }

  await env.DB.prepare(
    `UPDATE download_tokens SET downloaded = 1, downloaded_at = datetime('now') WHERE token = ?`
  ).bind(token).run();

  return new Response(file.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="realitydb-${row.template}-${rowLabel}.sql"`,
    },
  });
});

// Dodo webhook handler — verify signature, ack immediately (200), then process async
app.post('/v1/webhooks/dodo', async (c) => {
  const env = c.env;
  const rawBody = await c.req.text();

  const valid = await verifyDodoSignature(
    rawBody,
    {
      id: c.req.header('webhook-id'),
      timestamp: c.req.header('webhook-timestamp'),
      signature: c.req.header('webhook-signature'),
    },
    env.DODO_WEBHOOK_SECRET
  );

  if (!valid) return c.json({ error: 'Invalid signature' }, 401);

  // Ack immediately (before processing) to prevent Dodo retries; process in the background.
  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ received: true });
  }
  c.executionCtx.waitUntil(processDodoEvent(env, event));
  return c.json({ received: true });
});

// Verify a Dodo webhook using the Standard Webhooks scheme (HMAC-SHA256).
// Signed content = `${webhook-id}.${webhook-timestamp}.${payload}`.
async function verifyDodoSignature(
  payload: string,
  headers: { id?: string; timestamp?: string; signature?: string },
  secret: string
): Promise<boolean> {
  try {
    const { id, timestamp, signature } = headers;
    if (!id || !timestamp || !signature || !secret) return false;

    // Replay protection: reject timestamps older than 5 minutes
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (!Number.isFinite(age) || age > 300) return false;

    const signedContent = `${id}.${timestamp}.${payload}`;
    const enc = new TextEncoder();

    // Standard Webhooks secrets are `whsec_<base64>`; the HMAC key is the decoded portion.
    let keyBytes: Uint8Array;
    if (secret.startsWith('whsec_')) {
      keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), (ch) => ch.charCodeAt(0));
    } else {
      keyBytes = enc.encode(secret);
    }

    const computed = await hmacBase64(keyBytes, enc.encode(signedContent));

    // Header is a space-separated list of `v1,<base64sig>` entries
    const provided = signature.split(' ').map((s) => (s.includes(',') ? s.split(',')[1] : s));
    if (provided.some((sig) => timingSafeEqual(sig, computed))) return true;

    // Fallback: some setups HMAC the raw (undecoded) secret bytes
    if (secret.startsWith('whsec_')) {
      const rawComputed = await hmacBase64(enc.encode(secret), enc.encode(signedContent));
      if (provided.some((sig) => timingSafeEqual(sig, rawComputed))) return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function hmacBase64(keyBytes: Uint8Array, msg: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, msg);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Upsert an entitlement row (mirrors the Stripe webhook upsert; no Stripe IDs).
async function upsertDodoEntitlement(
  env: Env,
  userId: string,
  limits: DodoTierLimits,
  status: string,
  periodEnd: string | null,
  now: string
): Promise<void> {
  const entId = 'ent-' + crypto.randomUUID().split('-')[0];
  await env.DB.prepare(
    `INSERT INTO entitlements (id, user_id, tier, max_rows, max_active_labs, downloads_per_month, labs_daily_limit, status, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier, max_rows=excluded.max_rows, max_active_labs=excluded.max_active_labs, downloads_per_month=excluded.downloads_per_month, labs_daily_limit=excluded.labs_daily_limit, status=excluded.status, current_period_end=excluded.current_period_end, updated_at=excluded.updated_at`
  ).bind(
    entId, userId, limits.tier, limits.maxRows, limits.maxActiveLabs, limits.downloadsPerMonth, limits.labsDaily,
    status, periodEnd, now, now
  ).run();
}

// Guards subscription-status handlers against out-of-order webhook delivery —
// only write if the incoming event is not older than what's already stored.
// A missing timestamp on either side fails open (treated as newer) since we
// have no basis to reject the write; this only closes the gap when both a
// stored and incoming timestamp are actually available to compare.
function isNewerThan(
  incomingTimestamp: string | null,
  storedTimestamp: string | null
): boolean {
  if (!incomingTimestamp) return true;
  if (!storedTimestamp) return true;
  return new Date(incomingTimestamp) >
         new Date(storedTimestamp);
}

// Process a verified Dodo webhook event.
// NOTE: the entitlements schema has no runs / max_rows_per_run / research_expires_at /
// eu_runs / eu_comply_enabled columns, so one-time credit grants are recorded in the
// existing dataset_purchases table (lab_credits_remaining) as the closest existing store.
// Adding those columns is a separate schema migration (out of scope for this one-file sprint).
async function processDodoEvent(env: Env, event: any): Promise<void> {
  const type: string = event?.type;
  const data: any = event?.data || {};
  const now = new Date().toISOString();

  const productId: string | undefined = data.product_id || data.product_cart?.[0]?.product_id;
  const email: string | undefined = data.customer?.email || data.metadata?.user_email;
  const productKey = productId ? dodoProductKey(productId) : undefined;
  const eventTimestamp: string =
    data.created_at ||
    data.timestamp ||
    data.current_period_end ||
    now;

  try {
    switch (type) {
      case 'payment.succeeded': {
        // Dataset one-time purchases — the download_tokens row was pre-created
        // (status='pending') at checkout time in /v1/checkout, keyed by session_id.
        // Dodo's payment.succeeded payload carries an empty metadata object, so
        // session_id is the only reliable correlation key here — this just flips
        // the pre-created row to 'paid'.
        if (productKey?.startsWith('dataset_')) {
          // Best-effort session correlation: field name for the originating checkout
          // session isn't confirmed against a live Dodo payment.succeeded payload,
          // so multiple candidate keys are checked.
          const sessionId: string | undefined =
            data.checkout_session_id || data.session_id || data.checkout_id ||
            data.checkout?.session_id || data.subscription_id || undefined;

          if (sessionId) {
            const result = await env.DB.prepare(
              `UPDATE download_tokens SET status = 'paid' WHERE session_id = ? AND status = 'pending'`
            ).bind(sessionId).run();
            if ((result.meta?.changes ?? 0) > 0) {
              console.log(`Dodo dataset purchase paid: session ${sessionId}`);
            } else {
              console.error(`Dodo dataset purchase: no pending download_tokens row for session ${sessionId}`);
            }
          } else {
            console.error(`Dodo dataset purchase: no session_id in webhook payload (product ${productId})`);
          }
          break;
        }

        // One-time credit purchases (subscription first-payments arrive via subscription.active)
        if (!email || !productKey) break;
        const credit = DODO_CREDIT_PRODUCTS[productKey];
        if (!credit) break;

        const paymentId: string | null = data.payment_id || data.id || null;

        // Idempotency check — Dodo (like most webhook providers) may redeliver
        // payment.succeeded for the same payment. Without this, a replay grants
        // credits twice for one purchase.
        if (paymentId) {
          const existing = await env.DB.prepare(
            `SELECT id FROM dataset_purchases WHERE stripe_payment_id = ? AND status = 'completed'`
          ).bind(paymentId).first();

          if (existing) {
            console.log(`Dodo webhook: duplicate delivery for payment ${paymentId} — skipping (already granted)`);
            break;
          }
        }

        const creditsRemaining = credit.runs ?? credit.euRuns ?? (credit.researchDays ? -1 : 0);
        const purId = 'pur-' + crypto.randomUUID().split('-')[0];
        await env.DB.prepare(
          `INSERT INTO dataset_purchases (id, user_id, template, rows, price_cents, stripe_payment_id, status, lab_credits_remaining, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`
        ).bind(
          purId, email, productKey, credit.maxRowsPerRun, 0,
          paymentId, creditsRemaining, now, now
        ).run();

        console.log(`Dodo credits: ${email} → ${productKey} (credits=${creditsRemaining}, maxRowsPerRun=${credit.maxRowsPerRun}, euComply=${!!credit.euComplyEnabled})`);
        break;
      }

      case 'subscription.active': {
        if (!email || !productKey) break;
        const limits = DODO_SUBSCRIPTION_TIERS[productKey];
        if (!limits) break;
        const periodEnd: string | null = data.current_period_end || data.next_billing_date || null;
        await upsertDodoEntitlement(env, email, limits, 'active', periodEnd, now);
        console.log(`Dodo subscription active: ${email} → ${limits.tier}`);
        break;
      }

      case 'subscription.cancelled': {
        if (!email) break;
        // Keep access until current_period_end; only flip status.
        const current = await env.DB.prepare(
          'SELECT updated_at FROM entitlements WHERE user_id = ?'
        ).bind(email).first();
        if (!isNewerThan(eventTimestamp, current?.updated_at as string)) {
          console.log(`Dodo: stale cancelled event for ${email} — skipping`);
          break;
        }
        await env.DB.prepare(
          `UPDATE entitlements SET status = 'cancelled',
           updated_at = ? WHERE user_id = ?`
        ).bind(now, email).run();
        console.log(`Dodo subscription cancelled: ${email}`);
        break;
      }

      case 'subscription.renewed': {
        if (!email) break;
        const periodEnd: string | null =
          data.current_period_end ||
          data.next_billing_date || null;
        const current = await env.DB.prepare(
          'SELECT updated_at, current_period_end FROM entitlements WHERE user_id = ?'
        ).bind(email).first();
        if (!isNewerThan(eventTimestamp, current?.updated_at as string)) {
          console.log(`Dodo: stale renewed event for ${email} — skipping`);
          break;
        }
        await env.DB.prepare(
          `UPDATE entitlements SET current_period_end = ?,
           status = 'active', updated_at = ? WHERE user_id = ?`
        ).bind(periodEnd, now, email).run();
        console.log(`Dodo subscription renewed: ${email}`);
        break;
      }

      case 'subscription.on_hold': {
        if (!email) break;
        // Block generation — treat as community tier by marking on_hold.
        const current = await env.DB.prepare(
          'SELECT updated_at FROM entitlements WHERE user_id = ?'
        ).bind(email).first();
        if (!isNewerThan(eventTimestamp, current?.updated_at as string)) {
          console.log(`Dodo: stale on_hold event for ${email} — skipping`);
          break;
        }
        await env.DB.prepare(
          `UPDATE entitlements SET status = 'on_hold',
           updated_at = ? WHERE user_id = ?`
        ).bind(now, email).run();
        console.log(`Dodo subscription on_hold: ${email}`);
        break;
      }

      default:
        console.log(`Dodo webhook: unhandled event type ${type}`);
    }
  } catch (err: any) {
    console.error(`Dodo event processing error (${type}):`, err?.message);
  }
}

// CRON: cleanup expired labs
async function cleanupExpiredLabs(env: Env) {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    "SELECT * FROM labs WHERE status = 'active' AND expires_at < ?"
  ).bind(now).all();

  let cleaned = 0;
  for (const lab of (expired.results || [])) {
    try {
      await deleteNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, lab.neon_branch_id as string);
      await env.DB.prepare("UPDATE labs SET status = 'expired', deleted_at = ? WHERE id = ?")
        .bind(now, lab.id).run();
      cleaned++;
    } catch (err) {
      console.error(`Failed to cleanup lab ${lab.id}:`, err);
    }
  }

  return { cleaned, total: expired.results?.length || 0 };
}

// Reap expired agent-claimed databases: delete the Neon branch and mark
// the claim RELEASED. Same hourly cron as cleanupExpiredLabs. Idempotent
// — a RELEASED row is never revisited.
async function releaseExpiredAgentDatabases(env: Env) {
  const now = new Date().toISOString();
  const expired = await env.DB.prepare(
    "SELECT id, neon_branch_id FROM agent_databases WHERE status = 'READY' AND expires_at < ?"
  ).bind(now).all();

  let released = 0;
  for (const db of (expired.results || [])) {
    try {
      if (db.neon_branch_id) {
        await deleteNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, db.neon_branch_id as string);
      }
      await env.DB.prepare("UPDATE agent_databases SET status = 'RELEASED', released_at = ? WHERE id = ?")
        .bind(now, db.id).run();
      released++;
    } catch (err) {
      console.error(`Failed to release agent database ${db.id}:`, err);
    }
  }
  return { released, total: expired.results?.length || 0 };
}

// ============================================================
// CLAIMABLE DATABASE AGENT API  (Day 1)
// Agent-native façade over the existing SimLab provisioning
// pipeline (createNeonBranch + R2 template seed). Identity is an
// agent API key (SHA-256 hashed at rest); responses use
// self-describing field names per the design doc.
//   POST   /v1/agent/keys        (admin: mint an agent key)
//   POST   /v1/agent/databases   (claim a seeded database)
//   GET    /v1/agent/databases/:id (poll status / fetch handle)
// ============================================================

// Per-tier ceilings. maxRows/maxTtlSeconds/monthlyClaimLimit are baked
// onto a key when it is minted; concurrentLimit and rateLimitPerMinute
// are derived from the key's tier at request time (so they apply to
// keys minted before Day 2 without a migration). -1 = unlimited.
// Mirrors the pricing table in CLAIMABLE-DATABASE-AGENT-API-DESIGN.md.
const AGENT_TIER_LIMITS: Record<string, { maxRows: number; maxTtlSeconds: number; claimsPerPeriod: number; concurrentLimit: number; rateLimitPerMinute: number }> = {
  free:       { claimsPerPeriod: 10,      maxRows: 5000,    maxTtlSeconds: 3600,    concurrentLimit: 1,  rateLimitPerMinute: 10 },   // 1 hour
  starter:    { claimsPerPeriod: 100,     maxRows: 50000,   maxTtlSeconds: 86400,   concurrentLimit: 3,  rateLimitPerMinute: 60 },   // 24 hours
  pro:        { claimsPerPeriod: 500,     maxRows: 500000,  maxTtlSeconds: 604800,  concurrentLimit: 10, rateLimitPerMinute: 300 },  // 7 days
  enterprise: { claimsPerPeriod: 1000000, maxRows: 1000000, maxTtlSeconds: 2592000, concurrentLimit: 25, rateLimitPerMinute: -1 },   // 30 days · unlimited claims/rate
  agent:      { claimsPerPeriod: 1000000, maxRows: 100000,  maxTtlSeconds: 86400,   concurrentLimit: -1, rateLimitPerMinute: -1 },   // metered / unlimited
  // Back-compat aliases for keys minted under the pre-rename tier names.
  developer:  { claimsPerPeriod: 100,     maxRows: 50000,   maxTtlSeconds: 86400,   concurrentLimit: 3,  rateLimitPerMinute: 60 },   // = starter
  team:       { claimsPerPeriod: 500,     maxRows: 500000,  maxTtlSeconds: 604800,  concurrentLimit: 10, rateLimitPerMinute: 300 },  // = pro
};

// Resolve the live tier limits for a key row, falling back to free.
function agentTierLimits(tier: string) {
  return AGENT_TIER_LIMITS[tier] || AGENT_TIER_LIMITS.free;
}

// Templates the agent API will provision. Row counts are validated
// against R2 at request time (a template-rows combo only works if the
// pre-generated SQL exists in the bucket); this list drives the
// self-correcting error message and the future list_templates tool.
// 'banking' and 'aml' were removed on 2026-07-27: neither has any pack in
// R2, so every claim against them failed the bucket check with
// template_rows_unavailable. Re-add once their SQL is uploaded.
const AGENT_TEMPLATES = ['us-banking', 'oncology', 'healthcare', 'supply-chain', 'fintech', 'telecom', 'universal', 'eu-banking', 'eu-healthcare', 'eu-telecom', 'pipelinekit-demo'];

// Human-facing display metadata for the pack catalog (GET /v1/agent/packs).
// The provisionable row bounds are NOT taken from here — they are derived
// at request time from DATASET_PRICING (the existing source of truth for
// which template+rows combos exist). This map only supplies the label,
// blurb, table count, and compliance tags a catalog needs.
const AGENT_PACK_METADATA: Record<string, { name: string; description: string; tables: number; compliance: string[] }> = {
// Table counts are the number of tables a claim actually lands in the
// public schema — the pack's own tables plus the _realitydb_meta
// watermark table the generator appends. They therefore match the
// `tables` field a claim returns (which counts pg_tables). Counted on
// 2026-07-27 from apps/cli/dist/packs/*.json (+1 watermark); re-count
// after regenerating a pack rather than editing these by hand.
  banking:        { name: 'Banking',            description: 'Retail banking: customers, accounts, transactions, cards, loans.',        tables: 16, compliance: ['SOC2', 'PCI-DSS'] },
  'us-banking':   { name: 'US Banking',         description: 'US retail banking with ACH, wires, and Reg-compliant account types.',     tables: 11, compliance: ['SOC2', 'PCI-DSS'] },
  oncology:       { name: 'Oncology',           description: 'Cancer care: patients, diagnoses, treatments, labs, clinical trials.',    tables: 21, compliance: ['HIPAA'] },
  healthcare:     { name: 'Healthcare',         description: 'General healthcare: encounters, providers, claims, prescriptions.',       tables: 15, compliance: ['HIPAA'] },
  'supply-chain': { name: 'Supply Chain',       description: 'Suppliers, warehouses, shipments, inventory, purchase orders.',           tables: 24, compliance: ['SOC2'] },
  aml:            { name: 'AML / Fraud',        description: 'Anti-money-laundering: entities, transfers, alerts, SAR cases.',          tables: 18, compliance: ['SOC2', 'BSA-AML'] },
  fintech:        { name: 'Fintech',            description: 'Neobank / wallet: users, ledgers, payments, KYC records.',                tables: 10, compliance: ['SOC2', 'PCI-DSS'] },
  telecom:        { name: 'Telecom',            description: 'Subscribers, plans, CDRs, billing, network usage.',                       tables: 22, compliance: ['SOC2'] },
  universal:      { name: 'Universal',          description: 'Domain-agnostic relational sampler for generic SQL testing.',             tables: 7, compliance: [] },
  'eu-banking':   { name: 'EU Banking',         description: 'SEPA / PSD2 retail banking with GDPR-shaped personal data.',              tables: 13, compliance: ['GDPR', 'PSD2'] },
  'eu-healthcare':{ name: 'EU Healthcare',      description: 'EU healthcare records with GDPR special-category handling.',              tables: 15, compliance: ['GDPR'] },
  'eu-telecom':   { name: 'EU Telecom',         description: 'EU telecom with GDPR consent and retention modelling.',                   tables: 13, compliance: ['GDPR'] },
  'pipelinekit-demo': { name: 'PipelineKit Demo', description: 'Orders + customers schema for the PipelineKit postgres-to-duckdb blueprint. Integer sequential PKs, valid status enum, 100% referential integrity, dbt-compatible.', tables: 3, compliance: ['SOC2'] },
};

// Fallback only — used when the R2 probe *fails* (network error, bucket
// unreachable), never when it succeeds and simply finds nothing. Ground
// truth is the bucket itself; see probePackAvailableSizes below. Values
// verified object-by-object on 2026-07-27. Run
// POST /v1/agent/packs/refresh after uploading new packs to R2 to drop
// the cache immediately rather than waiting out the 5-minute TTL.
const FALLBACK_SIZES: Record<string, number[]> = {
  'us-banking':    [5000, 10000, 50000],
  'oncology':      [5000, 50000, 100000, 500000, 1000000],
  'healthcare':    [5000, 50000, 100000, 500000, 1000000],
  'supply-chain':  [5000, 50000, 100000, 500000, 1000000],
  'fintech':       [5000, 50000, 100000, 500000, 1000000],
  'telecom':       [5000, 50000, 100000, 500000, 1000000],
  'universal':     [5000, 50000, 100000, 500000, 1000000],
  'eu-banking':    [5000, 10000, 50000, 100000, 500000],
  'eu-healthcare': [5000, 10000, 50000, 100000, 500000],
  'eu-telecom':    [5000, 10000, 50000, 100000, 500000],
};

// Row counts the claim endpoint might be asked for. Each is probed
// against R2 by object key; anything not in the bucket is not offered.
const CANDIDATE_SIZES = [1000, 5000, 10000, 50000, 100000, 500000, 1000000];

// Row-count label used in R2 object keys — must stay identical to the
// label POST /v1/agent/databases builds, or the catalog will advertise
// a size the claim endpoint then fails to find.
function rowsToSizeLabel(rows: number): string {
  return rows >= 1000 ? `${rows / 1000}k` : String(rows);
}

// Probe R2 for the sizes a template actually has. Returns null (not [])
// when the bucket itself is unreachable, so callers can tell "this pack
// has no sizes" apart from "we could not find out" — the first is a real
// answer, the second is when the fallback table applies.
async function probePackAvailableSizes(env: Env, templateId: string): Promise<number[] | null> {
  try {
    const results = await Promise.all(
      CANDIDATE_SIZES.map(async (size) => {
        const key = `templates/${templateId}-${rowsToSizeLabel(size)}.sql`;
        const obj = await env.TEMPLATES.head(key);
        return obj ? size : null;
      })
    );
    return results.filter((s): s is number => s !== null);
  } catch {
    return null; // bucket unreachable — caller falls back
  }
}

const PACK_SIZES_CACHE_TTL = 300; // 5 minutes
const PACK_SIZES_CACHE_PREFIX = 'pack-sizes:';

// Cached wrapper around the probe. KV is optional: without the binding
// this still works, it just probes R2 on every request.
async function getCachedPackSizes(env: Env, templateId: string): Promise<number[]> {
  const cacheKey = `${PACK_SIZES_CACHE_PREFIX}${templateId}`;

  if (env.KV) {
    try {
      const cached = await env.KV.get(cacheKey);
      if (cached) return JSON.parse(cached) as number[];
    } catch { /* cache miss or KV error — probe instead */ }
  }

  const sizes = await probePackAvailableSizes(env, templateId);

  // Probe failed outright: serve the last-known-good table rather than
  // silently reporting the catalog as empty.
  if (sizes === null) return FALLBACK_SIZES[templateId] || [];

  // A successful probe is authoritative even when it finds nothing —
  // an empty result means the pack genuinely has no SQL in the bucket,
  // and offering FALLBACK_SIZES here is what caused the original bug.
  if (env.KV) {
    try {
      await env.KV.put(cacheKey, JSON.stringify(sizes), { expirationTtl: PACK_SIZES_CACHE_TTL });
    } catch { /* cache write failure is non-fatal */ }
  }

  return sizes;
}

// Build the pack catalog from live R2 availability. It iterates
// AGENT_TEMPLATES, not AGENT_PACK_METADATA, so the catalog can only ever
// list packs the claim endpoint will actually accept. Display fields come
// from AGENT_PACK_METADATA; row counts come from the bucket.
async function buildAgentPackCatalog(env: Env) {
  const entries = await Promise.all(
    AGENT_TEMPLATES.map(async (id) => ({ id, sizes: await getCachedPackSizes(env, id) }))
  );

  const packs = [];
  for (const { id, sizes } of entries) {
    if (sizes.length === 0) continue; // nothing in R2 — not offerable
    const rowCounts = [...sizes].sort((a, b) => a - b);
    const meta = AGENT_PACK_METADATA[id] || { name: id, description: `${id} synthetic dataset.`, tables: 0, compliance: [] };
    packs.push({
      id,
      name: meta.name,
      description: meta.description,
      tables: meta.tables,
      available_rows: rowCounts,
      max_rows: rowCounts[rowCounts.length - 1],
      min_rows: rowCounts[0],
      default_rows: rowCounts.includes(5000) ? 5000 : rowCounts[0],
      compliance: meta.compliance,
      docs_url: `https://realitydb.dev/docs/packs/${id}`,
    });
  }
  return packs;
}

// Structured agent-endpoint error. Every agent error carries a stable
// snake_case code, a human message, and a docs_url; upgrade_url and any
// extra fields are merged in when relevant.
function agentError(c: any, status: any, code: string, message: string, extra?: Record<string, unknown>) {
  return c.json({
    error: code,
    message,
    docs_url: `https://realitydb.dev/docs/agent/errors#${code}`,
    ...(extra || {}),
  }, status);
}

// Sliding-window rate limiter (Day 2). Fixed 60s buckets in
// agent_rate_limits; the current + previous bucket are read and the
// previous is weighted by how much of the current minute has elapsed —
// a standard sliding-window-counter approximation. Returns whether the
// request is allowed and the tier limit. Unlimited tiers short-circuit.
async function checkRateLimit(env: Env, keyId: string, tier: string): Promise<{ allowed: boolean; limit: number; count: number }> {
  const limit = agentTierLimits(tier).rateLimitPerMinute;
  if (limit < 0) return { allowed: true, limit: -1, count: 0 };

  const nowSec = Math.floor(Date.now() / 1000);
  const curWin = nowSec - (nowSec % 60);
  const prevWin = curWin - 60;

  const rows = await env.DB.prepare(
    'SELECT window_start, request_count FROM agent_rate_limits WHERE key_id = ? AND window_start IN (?, ?)'
  ).bind(keyId, curWin, prevWin).all();

  let cur = 0, prev = 0;
  for (const r of (rows.results || []) as any[]) {
    if (r.window_start === curWin) cur = r.request_count as number;
    else if (r.window_start === prevWin) prev = r.request_count as number;
  }

  const elapsed = nowSec - curWin;            // 0..59 into the current bucket
  const weight = (60 - elapsed) / 60;
  const estimated = prev * weight + cur;

  if (estimated >= limit) {
    return { allowed: false, limit, count: Math.floor(estimated) };
  }

  // Count this request against the current bucket and prune old buckets.
  await env.DB.prepare(
    `INSERT INTO agent_rate_limits (key_id, window_start, request_count) VALUES (?, ?, 1)
     ON CONFLICT(key_id, window_start) DO UPDATE SET request_count = request_count + 1`
  ).bind(keyId, curWin).run();
  await env.DB.prepare('DELETE FROM agent_rate_limits WHERE key_id = ? AND window_start < ?').bind(keyId, prevWin).run();

  return { allowed: true, limit, count: cur + 1 };
}

// Count a key's currently-live databases (READY and not yet expired).
async function countActiveAgentDatabases(env: Env, keyId: string): Promise<number> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM agent_databases WHERE api_key_id = ? AND status = 'READY' AND expires_at > ?"
  ).bind(keyId, now).first();
  return parseInt((r as any)?.c || '0', 10);
}

// The 429 body for a tripped rate limit — shared by all agent endpoints.
function rateLimitError(c: any, tier: string, limit: number) {
  return agentError(c, 429, 'rate_limit_exceeded',
    `Rate limit exceeded: ${limit} requests/minute on the ${tier} tier. Slow down or upgrade your plan.`,
    { limit, tier, upgrade_url: 'https://realitydb.dev/pricing' });
}

// SHA-256 hex — agent keys are stored hashed, never in plaintext.
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Neon pooled host = endpoint host with "-pooler" inserted before the
// first dot (ep-x-123.us-east-2.aws.neon.tech -> ep-x-123-pooler...).
// Returns the same string unchanged if it can't be parsed.
function derivePooledConnection(direct: string): string {
  try {
    const u = new URL(direct.replace('postgresql://', 'https://'));
    if (u.hostname.includes('-pooler.')) return direct;
    const pooledHost = u.hostname.replace('.', '-pooler.');
    return direct.replace(u.hostname, pooledHost);
  } catch {
    return direct;
  }
}

// Seed a freshly-created Neon branch from a pre-generated template SQL
// string. Extracted from the proven /v1/labs path: one POST to Neon's
// /sql transaction endpoint (avoids the 50-subrequest limit), with a
// bounded per-statement fallback. Returns whether seeding succeeded.
async function seedNeonBranchFromSql(connectionString: string, sqlText: string): Promise<{ ok: boolean; statements: number }> {
  const connUrl = new URL(connectionString.replace('postgresql://', 'https://'));
  const neonHost = connUrl.hostname;

  const statements: string[] = [];
  let current = '';
  for (const line of sqlText.split('\n')) {
    current += line + '\n';
    if (line.trimEnd().endsWith(';') && !line.trim().startsWith('--')) {
      const trimmed = current.trim();
      if (trimmed && trimmed !== ';') statements.push(trimmed);
      current = '';
    }
  }
  if (current.trim()) statements.push(current.trim());

  const txBody = JSON.stringify({
    queries: statements.map((s) => ({ query: s.replace(/;\s*$/, ''), params: [] })),
  });

  const txRes = await fetch(`https://${neonHost}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': connectionString,
      'Neon-Raw-Text-Output': 'true',
      'Neon-Array-Mode': 'true',
      'Neon-Pool-Opt-In': 'true',
    },
    body: txBody,
  });

  if (txRes.ok) return { ok: true, statements: statements.length };

  // Fallback: individual execution, capped under the subrequest limit.
  const errText = await txRes.text();
  console.error(`Agent seed: Neon SQL API error (${txRes.status}):`, errText.substring(0, 200));
  const db = neon(connectionString);
  let seeded = 0;
  for (const stmt of statements.slice(0, 45)) {
    const cleaned = stmt.replace(/;\s*$/, '');
    if (!cleaned) continue;
    try { await db(cleaned); seeded++; } catch { /* best-effort */ }
  }
  return { ok: seeded > 0, statements: seeded };
}

// Look up an agent key by hashing the presented raw key. Handles the
// monthly quota window: if period_start is older than 30 days, the
// counter is reset before the caller checks quota. Returns the row or
// null (unknown / revoked).
async function authenticateAgentKey(env: Env, rawKey: string | undefined): Promise<any | null> {
  if (!rawKey || !rawKey.startsWith('rdb_agent_')) return null;
  const hash = await sha256Hex(rawKey);
  const key = await env.DB.prepare("SELECT * FROM agent_api_keys WHERE key_hash = ? AND status = 'active'").bind(hash).first();
  if (!key) return null;

  const now = new Date();
  const periodStart = key.period_start ? new Date(key.period_start as string) : null;
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  if (!periodStart || now.getTime() - periodStart.getTime() > THIRTY_DAYS) {
    await env.DB.prepare('UPDATE agent_api_keys SET claims_used_this_period = 0, period_start = ? WHERE id = ?')
      .bind(now.toISOString(), key.id).run();
    key.claims_used_this_period = 0;
    key.period_start = now.toISOString();
  }
  return key;
}

// Admin: mint a new agent API key. Protected by the master LAB_API_KEY
// (the same key that guards /v1/labs). Returns the raw key exactly once
// — it is not recoverable afterward, only its hash is stored.
app.post('/v1/agent/keys', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) return agentError(c, 401, 'unauthorized', 'Minting agent keys requires the master API key.');

  const body = await c.req.json<{ owner_id?: string; name?: string; tier?: string }>().catch(() => ({} as any));
  const tier = (body.tier && AGENT_TIER_LIMITS[body.tier]) ? body.tier : 'free';
  const limits = AGENT_TIER_LIMITS[tier];
  const ownerId = body.owner_id || 'agent-user';

  const rawKey = 'rdb_agent_' + crypto.randomUUID().replace(/-/g, '');
  const keyHash = await sha256Hex(rawKey);
  const keyPrefix = rawKey.substring(0, 18);
  const id = 'akey-' + crypto.randomUUID().split('-')[0];
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO agent_api_keys (id, key_hash, key_prefix, name, owner_id, tier, monthly_claim_limit, claims_used_this_period, max_rows, max_ttl_seconds, status, period_start, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?)`
  ).bind(id, keyHash, keyPrefix, body.name || null, ownerId, tier, limits.claimsPerPeriod, limits.maxRows, limits.maxTtlSeconds, now, now).run();

  return c.json({
    id,
    api_key: rawKey,
    key_prefix: keyPrefix,
    tier,
    owner_id: ownerId,
    monthly_claim_limit: limits.claimsPerPeriod,
    max_rows: limits.maxRows,
    max_ttl_seconds: limits.maxTtlSeconds,
    warning: 'Store this key now — it will not be shown again.',
    created_at: now,
  }, 201);
});

// Claim a database: provision a Neon branch and seed it from the R2
// template, returning a ready-to-use connection string. Wired directly
// to the existing SimLab provisioning pipeline (createNeonBranch +
// seedNeonBranchFromSql). Agent-friendly: self-describing fields,
// structured self-correcting errors, idempotency-key dedupe.
app.post('/v1/agent/databases', async (c) => {
  const env = c.env;
  const rawKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  const key = await authenticateAgentKey(env, rawKey);
  if (!key) {
    return agentError(c, 401, 'invalid_api_key', 'Missing or invalid agent API key. Pass it as "Authorization: Bearer rdb_agent_..." or the X-API-Key header.');
  }

  // Rate limit (per key, per tier).
  const rl = await checkRateLimit(env, key.id as string, key.tier as string);
  if (!rl.allowed) return rateLimitError(c, key.tier as string, rl.limit);

  const body = await c.req.json<{ template?: string; rows?: number; ttl_seconds?: number; seed?: number; idempotency_key?: string }>().catch(() => ({} as any));

  // Validate template.
  const template = body.template;
  if (!template || !AGENT_TEMPLATES.includes(template)) {
    return agentError(c, 400, 'template_not_found',
      `Template ${template ? `'${template}'` : '(missing)'} not found. Valid templates: ${AGENT_TEMPLATES.join(', ')}.`,
      { valid_templates: AGENT_TEMPLATES });
  }

  // Validate rows against the key's ceiling.
  const rows = body.rows || 5000;
  if (rows > (key.max_rows as number)) {
    return agentError(c, 403, 'rows_exceed_tier_limit',
      `Requested ${rows} rows exceeds your ${key.tier} tier limit of ${key.max_rows}. Lower the row count or upgrade the key.`,
      { max_rows: key.max_rows, tier: key.tier, upgrade_url: 'https://realitydb.dev/pricing' });
  }

  // Validate TTL against the key's ceiling (default = ceiling).
  const maxTtl = key.max_ttl_seconds as number;
  let ttlSeconds = body.ttl_seconds ?? maxTtl;
  if (ttlSeconds < 60) ttlSeconds = 60;
  if (ttlSeconds > maxTtl) {
    return agentError(c, 403, 'ttl_exceeds_tier_limit',
      `Requested ttl_seconds ${ttlSeconds} exceeds your ${key.tier} tier limit of ${maxTtl}s. Lower ttl_seconds or upgrade the key.`,
      { max_ttl_seconds: maxTtl, tier: key.tier, upgrade_url: 'https://realitydb.dev/pricing' });
  }

  // Idempotency: a retried request with the same key returns the same
  // claim instead of provisioning a second branch.
  const idem = body.idempotency_key || null;
  if (idem) {
    const existing = await env.DB.prepare('SELECT * FROM agent_databases WHERE api_key_id = ? AND idempotency_key = ?')
      .bind(key.id, idem).first();
    if (existing) return c.json(agentClaimResponse(existing), 200);
  }

  // Quota check (period already reset in authenticateAgentKey if stale).
  if ((key.claims_used_this_period as number) >= (key.monthly_claim_limit as number)) {
    return agentError(c, 429, 'quota_exceeded',
      `Monthly claim limit reached (${key.monthly_claim_limit} on the ${key.tier} tier). Upgrade or wait for the next period.`,
      { monthly_claim_limit: key.monthly_claim_limit, claims_used_this_period: key.claims_used_this_period, tier: key.tier, upgrade_url: 'https://realitydb.dev/pricing' });
  }

  // Concurrent-database limit: count this key's live (READY, unexpired)
  // databases before provisioning another.
  const concurrentLimit = agentTierLimits(key.tier as string).concurrentLimit;
  if (concurrentLimit >= 0) {
    const active = await countActiveAgentDatabases(env, key.id as string);
    if (active >= concurrentLimit) {
      return agentError(c, 429, 'concurrent_limit_exceeded',
        'Release an active database or upgrade your plan',
        { active, limit: concurrentLimit, upgrade_url: 'https://realitydb.dev/pricing' });
    }
  }

  // Validate the template+rows combo exists in R2 before doing any work.
  const rowLabel = rows >= 1000 ? `${rows / 1000}k` : String(rows);
  const r2Key = `templates/${template}-${rowLabel}.sql`;
  const templateObj = await env.TEMPLATES.get(r2Key);
  if (!templateObj) {
    return agentError(c, 404, 'template_rows_unavailable',
      `No pre-generated dataset for '${template}' at ${rows} rows (${r2Key}). Try a supported row count such as 5000, 10000, 50000, or 100000.`,
      { template, requested_rows: rows });
  }

  const id = 'adb-' + crypto.randomUUID().split('-')[0];
  const seed = body.seed ?? null;
  const nowIso = new Date().toISOString();

  // Record the PENDING claim (also reserves the idempotency key).
  try {
    await env.DB.prepare(
      `INSERT INTO agent_databases (id, api_key_id, owner_id, template, rows, seed, status, idempotency_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
    ).bind(id, key.id, key.owner_id, template, rows, seed, idem, nowIso, nowIso).run();
  } catch (e: any) {
    // Unique idempotency collision from a concurrent retry — return the winner.
    if (idem) {
      const winner = await env.DB.prepare('SELECT * FROM agent_databases WHERE api_key_id = ? AND idempotency_key = ?')
        .bind(key.id, idem).first();
      if (winner) return c.json(agentClaimResponse(winner), 200);
    }
    return agentError(c, 500, 'claim_insert_failed', e?.message || String(e));
  }

  let branch: { branchId: string; endpointId: string; host: string; connectionUri: string } | null = null;
  try {
    branch = await createNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, id);
    const sqlText = await templateObj.text();
    await seedNeonBranchFromSql(branch.connectionUri, sqlText);

    // Count seeded tables (single request; best-effort).
    let tablesCount: number | null = null;
    try {
      const db = neon(branch.connectionUri);
      const r = await db("SELECT COUNT(*)::int AS c FROM pg_tables WHERE schemaname = 'public'");
      tablesCount = (r[0] as any)?.c ?? null;
    } catch { /* non-fatal */ }

    const readyAt = new Date();
    const expiresAt = new Date(readyAt.getTime() + ttlSeconds * 1000);

    await env.DB.prepare(
      `UPDATE agent_databases SET status = 'READY', neon_branch_id = ?, neon_endpoint_id = ?, connection_string = ?, tables_count = ?, rows_seeded = ?, ready_at = ?, expires_at = ? WHERE id = ?`
    ).bind(branch.branchId, branch.endpointId, branch.connectionUri, tablesCount, rows, readyAt.toISOString(), expiresAt.toISOString(), id).run();

    // Meter the successful claim against the key's quota.
    await env.DB.prepare('UPDATE agent_api_keys SET claims_used_this_period = claims_used_this_period + 1, last_used_at = ? WHERE id = ?')
      .bind(readyAt.toISOString(), key.id).run();

    const row = await env.DB.prepare('SELECT * FROM agent_databases WHERE id = ?').bind(id).first();
    return c.json(agentClaimResponse(row), 201);
  } catch (err: any) {
    // Roll back: tear down the branch if it was created, mark FAILED.
    if (branch?.branchId) {
      try { await deleteNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, branch.branchId); } catch { /* ignore */ }
    }
    await env.DB.prepare("UPDATE agent_databases SET status = 'FAILED', error_message = ? WHERE id = ?")
      .bind(String(err?.message || err).substring(0, 500), id).run();
    return agentError(c, 500, 'provisioning_failed',
      `Failed to provision the database: ${err?.message || err}. The claim was not counted against your quota; retry with the same idempotency_key.`,
      { claim_id: id, status: 'FAILED' });
  }
});

// Poll a claim's status / fetch its connection handle.
app.get('/v1/agent/databases/:id', async (c) => {
  const env = c.env;
  const rawKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  const key = await authenticateAgentKey(env, rawKey);
  if (!key) return agentError(c, 401, 'invalid_api_key', 'Missing or invalid agent API key.');

  const rl = await checkRateLimit(env, key.id as string, key.tier as string);
  if (!rl.allowed) return rateLimitError(c, key.tier as string, rl.limit);

  const row = await env.DB.prepare('SELECT * FROM agent_databases WHERE id = ?').bind(c.req.param('id')).first();
  if (!row || row.api_key_id !== key.id) {
    return agentError(c, 404, 'database_not_found', `No claimed database with id '${c.req.param('id')}' for this key.`);
  }
  return c.json(agentClaimResponse(row));
});

// ISO timestamp when the current monthly quota window resets (30 days
// after the period started).
function agentPeriodResetAt(periodStart: string | null | undefined): string {
  const start = periodStart ? new Date(periodStart) : new Date();
  return new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

// ENDPOINT 1 — list this key's live databases, with quota summary.
app.get('/v1/agent/databases', async (c) => {
  const env = c.env;
  const rawKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  const key = await authenticateAgentKey(env, rawKey);
  if (!key) return agentError(c, 401, 'invalid_api_key', 'Missing or invalid agent API key.');

  const rl = await checkRateLimit(env, key.id as string, key.tier as string);
  if (!rl.allowed) return rateLimitError(c, key.tier as string, rl.limit);

  const nowMs = Date.now();
  const result = await env.DB.prepare(
    "SELECT * FROM agent_databases WHERE api_key_id = ? AND status != 'RELEASED' ORDER BY created_at DESC LIMIT 200"
  ).bind(key.id).all();

  const statusMap: Record<string, string> = { READY: 'active', PENDING: 'pending', FAILED: 'failed' };
  const databases = ((result.results || []) as any[])
    .filter((r) => !(r.status === 'READY' && r.expires_at && new Date(r.expires_at).getTime() <= nowMs)) // drop expired-but-unreaped
    .map((r) => {
      const expMs = r.expires_at ? new Date(r.expires_at).getTime() : 0;
      return {
        database_id: r.id,
        status: statusMap[r.status as string] || (r.status as string).toLowerCase(),
        pack: r.template,
        rows: r.rows_seeded ?? r.rows ?? 0,
        claimed_at: r.created_at,
        expires_at: r.expires_at,
        ttl_remaining_seconds: r.status === 'READY' ? Math.max(0, Math.floor((expMs - nowMs) / 1000)) : 0,
      };
    });

  return c.json({
    databases,
    total: databases.length,
    quota: {
      used: key.claims_used_this_period,
      limit: key.monthly_claim_limit,
      reset_at: agentPeriodResetAt(key.period_start as string),
    },
  });
});

// ENDPOINT 2 — release a database early. Must belong to the key. Deletes
// the Neon branch (best-effort) and marks RELEASED. Quota is NOT refunded.
app.delete('/v1/agent/databases/:id', async (c) => {
  const env = c.env;
  const rawKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  const key = await authenticateAgentKey(env, rawKey);
  if (!key) return agentError(c, 401, 'invalid_api_key', 'Missing or invalid agent API key.');

  const rl = await checkRateLimit(env, key.id as string, key.tier as string);
  if (!rl.allowed) return rateLimitError(c, key.tier as string, rl.limit);

  const id = c.req.param('id');
  const row = await env.DB.prepare('SELECT * FROM agent_databases WHERE id = ?').bind(id).first();
  if (!row || row.api_key_id !== key.id) {
    return agentError(c, 404, 'database_not_found', `No claimed database with id '${id}' for this key.`);
  }

  // Idempotent: already released -> report the existing release.
  if (row.status === 'RELEASED') {
    return c.json({ database_id: id, status: 'released', released_at: row.released_at });
  }

  // Tear down the Neon branch (best-effort — a failed delete must not
  // block marking the claim released).
  if (row.neon_branch_id) {
    try { await deleteNeonBranch(env.NEON_PROJECT_ID, env.NEON_API_KEY, row.neon_branch_id as string); } catch { /* ignore */ }
  }

  const releasedAt = new Date().toISOString();
  await env.DB.prepare("UPDATE agent_databases SET status = 'RELEASED', released_at = ? WHERE id = ?")
    .bind(releasedAt, id).run();

  // NOTE: quota (claims_used_this_period) is intentionally NOT decremented.
  return c.json({ database_id: id, status: 'released', released_at: releasedAt });
});

// ENDPOINT 3 — list available domain packs. Built from DATASET_PRICING
// (the existing provisionable-combos config), not a hardcoded array.
app.get('/v1/agent/packs', async (c) => {
  const env = c.env;
  const rawKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  const key = await authenticateAgentKey(env, rawKey);
  if (!key) return agentError(c, 401, 'invalid_api_key', 'Missing or invalid agent API key.');

  const rl = await checkRateLimit(env, key.id as string, key.tier as string);
  if (!rl.allowed) return rateLimitError(c, key.tier as string, rl.limit);

  const packs = await buildAgentPackCatalog(env);
  return c.json({ packs, total: packs.length });
});

// Admin: drop the cached pack-availability entries and return a freshly
// probed catalog. Call this straight after uploading a pack to R2 instead
// of waiting out the 5-minute TTL. Guarded by the master LAB_API_KEY.
app.post('/v1/agent/packs/refresh', async (c) => {
  const env = c.env;
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  if (!authenticate(apiKey, env)) {
    return agentError(c, 401, 'unauthorized', 'Refreshing the pack catalog requires the master API key.');
  }

  let cleared = 0;
  if (env.KV) {
    try {
      // KV list is paginated; drain it so a large cache is fully cleared.
      let cursor: string | undefined;
      do {
        const page = await env.KV.list({ prefix: PACK_SIZES_CACHE_PREFIX, cursor });
        await Promise.all(page.keys.map((k) => env.KV!.delete(k.name)));
        cleared += page.keys.length;
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    } catch (e: any) {
      return agentError(c, 500, 'cache_clear_failed', e?.message || String(e));
    }
  }

  const packs = await buildAgentPackCatalog(env);
  return c.json({ packs, total: packs.length, refreshed: true, cache_entries_cleared: cleared, cache_enabled: Boolean(env.KV) });
});

// ENDPOINT 4 — current quota / plan details for this key.
app.get('/v1/agent/quota', async (c) => {
  const env = c.env;
  const rawKey = c.req.header('Authorization')?.replace('Bearer ', '') || c.req.header('X-API-Key');
  const key = await authenticateAgentKey(env, rawKey);
  if (!key) return agentError(c, 401, 'invalid_api_key', 'Missing or invalid agent API key.');

  const rl = await checkRateLimit(env, key.id as string, key.tier as string);
  if (!rl.allowed) return rateLimitError(c, key.tier as string, rl.limit);

  const limits = agentTierLimits(key.tier as string);
  const concurrentActive = await countActiveAgentDatabases(env, key.id as string);

  return c.json({
    plan: key.tier,
    databases_this_period: key.claims_used_this_period,
    databases_limit: key.monthly_claim_limit,
    concurrent_active: concurrentActive,
    concurrent_limit: limits.concurrentLimit,
    max_rows_per_claim: key.max_rows,
    max_ttl_seconds: key.max_ttl_seconds,
    period_reset_at: agentPeriodResetAt(key.period_start as string),
  });
});

// Shape a claim row into the agent-friendly response envelope. Field
// names are self-describing per the design doc; connection strings are
// only ever returned to the key that owns the claim.
function agentClaimResponse(row: any) {
  const expiresAt = row.expires_at ? new Date(row.expires_at as string) : null;
  const ttlRemaining = expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : 0;
  const direct = (row.status === 'READY' && row.connection_string) ? (row.connection_string as string) : null;
  return {
    claim_id: row.id,
    status: row.status,
    template: row.template,
    rows_seeded: row.rows_seeded ?? row.rows ?? null,
    tables: row.tables_count ?? null,
    connection_string_pooled: direct ? derivePooledConnection(direct) : null,
    connection_string_direct: direct,
    expires_at_iso8601: row.expires_at ?? null,
    ttl_seconds_remaining: ttlRemaining,
    claim_url: `https://realitydb.dev/claim/${row.id}`,
    compliance_doc_url: `https://realitydb.dev/compliance/${row.template}`,
    error: row.status === 'FAILED' ? (row.error_message ?? 'provisioning_failed') : undefined,
  };
}

// Export
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cleanupExpiredLabs(env));
    ctx.waitUntil(releaseExpiredAgentDatabases(env));
  },
};
