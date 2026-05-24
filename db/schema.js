// db/schema.js
const { createClient } = require('@libsql/client');

let db = null;

async function initDB() {
  if (process.env.TURSO_URL) {
    db = createClient({
      url: process.env.TURSO_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
      intMode: 'number'
    });
    console.log('Connected to Turso (shared inventory+CRM DB)');
  } else {
    db = createClient({ url: 'file:./crm-local.db', intMode: 'number' });
    console.log('Connected to local SQLite');
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    product_type TEXT,
    category TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    website TEXT,
    industry TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER REFERENCES crm_companies(id) ON DELETE CASCADE,
    poc_name TEXT NOT NULL,
    designation TEXT,
    email TEXT,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    product_id INTEGER REFERENCES crm_products(id) ON DELETE SET NULL,
    owner TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    due_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    completed_at DATETIME,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON crm_contacts(company_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_contacts_status ON crm_contacts(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notes_contact ON crm_notes(contact_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON crm_tasks(due_date, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_contact ON crm_tasks(contact_id)`);

  return db;
}

async function queryAll(sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows;
}

async function queryOne(sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows.length ? result.rows[0] : null;
}

async function execute(sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return { changes: result.rowsAffected, lastId: result.lastInsertRowid };
}

function nowIST() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  return ist.toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = { initDB, queryAll, queryOne, execute, nowIST };