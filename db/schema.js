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
    assigned_to TEXT,
    completed_at DATETIME,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT NOT NULL UNIQUE,
    po_source TEXT NOT NULL DEFAULT 'manual',
    company_id INTEGER NOT NULL REFERENCES crm_companies(id) ON DELETE RESTRICT,
    contact_id INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    order_date DATE,
    expected_dispatch_date DATE,
    dispatch_date DATE,
    notes TEXT,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS crm_po_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        po_id INTEGER NOT NULL REFERENCES crm_purchase_orders(id) ON DELETE CASCADE,
        item_code TEXT NOT NULL,
        quantity_ordered INTEGER NOT NULL DEFAULT 1,
        unit_price REAL,
        notes TEXT
    )`);

    await db.execute(`CREATE TABLE IF NOT EXISTS crm_invoices (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    uploaded_by      TEXT,
    original_filename TEXT,
    doc_type         TEXT DEFAULT 'freight_invoice',
    invoice_no       TEXT,
    invoice_date     TEXT,
    party_name       TEXT,
    party_gstin      TEXT,
    buyer_gstin      TEXT,
    place_of_supply  TEXT,
    mawb_no          TEXT,
    flight_no        TEXT,
    commodity        TEXT,
    origin_airport   TEXT,
    dest_airport     TEXT,
    gross_weight     REAL,
    supplier_ref     TEXT,
    taxable_value    REAL,
    cgst             REAL,
    sgst             REAL,
    igst             REAL,
    total_tax        REAL,
    net_amount       REAL,
    line_items       TEXT DEFAULT '[]',
    tally_xml        TEXT,
    status           TEXT DEFAULT 'pending',
    review_notes     TEXT,
    task_id          INTEGER,
    approved_at      DATETIME,
    pushed_at        DATETIME
  )`);

  try { await db.execute(`ALTER TABLE crm_tasks ADD COLUMN invoice_id INTEGER REFERENCES crm_invoices(id) ON DELETE SET NULL`); } catch (e) {}

  // Talk2Tally: async extraction + delete + push-error tracking
  try { await db.execute(`ALTER TABLE crm_invoices ADD COLUMN deleted_at DATETIME`); } catch (e) {}
  try { await db.execute(`ALTER TABLE crm_invoices ADD COLUMN push_error TEXT`); } catch (e) {}
  try { await db.execute(`ALTER TABLE crm_invoices ADD COLUMN extract_error TEXT`); } catch (e) {}

  // Read-intelligence: snapshot of real Tally ledgers, synced up by the local agent.
  // CRM reads this to validate ledger names before approval. Empty until the agent populates it.
  await db.execute(`CREATE TABLE IF NOT EXISTS crm_tally_ledgers (
    name        TEXT PRIMARY KEY,
    parent      TEXT,
    closing_balance TEXT,
    synced_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Snapshot of Tally stock items, synced up by the local agent.
  // Mirrors crm_tally_ledgers — same pattern, different master.
  await db.execute(`CREATE TABLE IF NOT EXISTS crm_tally_stock_items (
    name        TEXT PRIMARY KEY,
    parent      TEXT,
    base_units  TEXT,
    closing_qty TEXT,
    closing_rate TEXT,
    synced_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON crm_invoices(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_invoices_date ON crm_invoices(invoice_date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_invoice ON crm_tasks(invoice_id)`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_tally_sales_vouchers (
    voucher_no    TEXT PRIMARY KEY,
    date          TEXT,
    party_name    TEXT,
    amount        REAL,
    narration     TEXT,
    ledger_lines  TEXT DEFAULT '[]',
    bill_refs     TEXT DEFAULT '[]',
    synced_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_tally_bank_txns (
    voucher_no    TEXT PRIMARY KEY,
    voucher_type  TEXT,
    date          TEXT,
    party_name    TEXT,
    amount        REAL,
    narration     TEXT,
    bill_refs     TEXT DEFAULT '[]',
    synced_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS crm_tally_outstanding (
    party_name    TEXT NOT NULL,
    bill_ref      TEXT NOT NULL,
    voucher_no    TEXT,
    bill_date     TEXT,
    original_amt  REAL,
    settled_amt   REAL DEFAULT 0,
    pending_amt   REAL,
    credit_days   INTEGER DEFAULT 0,
    due_date      TEXT,
    overdue_days  INTEGER DEFAULT 0,
    synced_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (party_name, bill_ref)
  )`);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sales_vch_party ON crm_tally_sales_vouchers(party_name)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_sales_vch_date  ON crm_tally_sales_vouchers(date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bank_txns_type  ON crm_tally_bank_txns(voucher_type)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_bank_txns_date  ON crm_tally_bank_txns(date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_outstanding_party   ON crm_tally_outstanding(party_name)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_outstanding_due     ON crm_tally_outstanding(due_date)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_outstanding_overdue ON crm_tally_outstanding(overdue_days)`);

  // Migrations — safe to re-run, errors mean column already exists
  try {
      await db.execute(`ALTER TABLE outwards ADD COLUMN po_id INTEGER REFERENCES crm_purchase_orders(id) ON DELETE SET NULL`);
  } catch (e) {}
  try {
      await db.execute(`ALTER TABLE outwards ADD COLUMN company_id INTEGER REFERENCES crm_companies(id) ON DELETE SET NULL`);
  } catch (e) {}

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_po_company ON crm_purchase_orders(company_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_po_status ON crm_purchase_orders(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_po_items_po ON crm_po_items(po_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_outwards_po ON outwards(po_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_outwards_company ON outwards(company_id)`);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_contacts_company ON crm_contacts(company_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_contacts_status ON crm_contacts(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_notes_contact ON crm_notes(contact_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_due ON crm_tasks(due_date, status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_contact ON crm_tasks(contact_id)`);

  await db.execute(`CREATE INDEX IF NOT EXISTS idx_ledgers_parent ON crm_tally_ledgers(parent)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_stock_parent ON crm_tally_stock_items(parent)`);


  // Ensure counters table exists (shared with inventory, safe to re-declare)
    await db.execute(`CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1000
    )`);

    // Seed po_sys counter if not already there
    const poCounter = await queryOne("SELECT value FROM counters WHERE name = 'po_sys'");
    if (!poCounter) {
    await db.execute("INSERT INTO counters (name, value) VALUES ('po_sys', 1000)");
    }

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