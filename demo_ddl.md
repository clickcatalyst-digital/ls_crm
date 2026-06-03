# demo.sqlite — DDL for Turso

Copy the entire block below and run it in Turso. Tables are ordered by foreign-key dependency; indexes follow at the end.

---

```sql
-- ─────────────────────────────────────────────
-- TABLES
-- ─────────────────────────────────────────────

-- No FK dependencies
CREATE TABLE IF NOT EXISTS counters (
    name  TEXT    PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT    NOT NULL UNIQUE,
    password   TEXT    NOT NULL,
    role       TEXT    NOT NULL DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code   TEXT NOT NULL UNIQUE,
    description TEXT,
    default_spq INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS boxes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    box_number  TEXT NOT NULL UNIQUE,
    item_code   TEXT,
    reel_count  INTEGER DEFAULT 0,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reel_number TEXT NOT NULL UNIQUE,
    item_code   TEXT,
    box_number  TEXT,
    quantity    INTEGER DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'in_stock',
    inward_date DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes       TEXT
);

CREATE TABLE IF NOT EXISTS requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    type          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    created_by    TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_by   TEXT,
    reviewed_at   DATETIME,
    reject_reason TEXT,
    payload       TEXT
);

-- CRM: no FK dependencies
CREATE TABLE IF NOT EXISTS crm_companies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    website    TEXT,
    industry   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    product_type TEXT,
    category     TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tally sync tables: no FK dependencies
CREATE TABLE IF NOT EXISTS crm_tally_ledgers (
    name            TEXT PRIMARY KEY,
    parent          TEXT,
    closing_balance TEXT,
    synced_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_tally_stock_items (
    name           TEXT PRIMARY KEY,
    parent         TEXT,
    base_units     TEXT,
    closing_qty    TEXT,
    closing_rate   TEXT,
    synced_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    hsn_code       TEXT,
    gst_applicable TEXT
);

CREATE TABLE IF NOT EXISTS crm_tally_bank_txns (
    voucher_no   TEXT PRIMARY KEY,
    voucher_type TEXT,
    date         TEXT,
    party_name   TEXT,
    amount       REAL,
    narration    TEXT,
    bill_refs    TEXT DEFAULT '[]',
    synced_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS crm_tally_sales_vouchers (
    voucher_no      TEXT PRIMARY KEY,
    date            TEXT,
    party_name      TEXT,
    amount          REAL,
    narration       TEXT,
    ledger_lines    TEXT DEFAULT '[]',
    bill_refs       TEXT DEFAULT '[]',
    synced_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    inventory_lines TEXT DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS crm_tally_purchase_vouchers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_no      TEXT,
    date            TEXT,
    party_name      TEXT,
    amount          REAL,
    narration       TEXT,
    ledger_lines    TEXT DEFAULT '[]',
    bill_refs       TEXT DEFAULT '[]',
    inventory_lines TEXT DEFAULT '[]',
    synced_at       TEXT
);

CREATE TABLE IF NOT EXISTS crm_tally_outstanding (
    party_name   TEXT    NOT NULL,
    bill_ref     TEXT    NOT NULL,
    voucher_no   TEXT,
    bill_date    TEXT,
    original_amt REAL,
    settled_amt  REAL    DEFAULT 0,
    pending_amt  REAL,
    credit_days  INTEGER DEFAULT 0,
    due_date     TEXT,
    overdue_days INTEGER DEFAULT 0,
    synced_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (party_name, bill_ref)
);

CREATE TABLE IF NOT EXISTS crm_tally_purchase_outstanding (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    party_name   TEXT,
    bill_ref     TEXT,
    voucher_no   TEXT,
    bill_date    TEXT,
    original_amt REAL,
    settled_amt  REAL    DEFAULT 0,
    pending_amt  REAL,
    credit_days  INTEGER DEFAULT 0,
    due_date     TEXT,
    overdue_days INTEGER DEFAULT 0,
    synced_at    TEXT
);

-- Depends on: crm_companies, crm_products
CREATE TABLE IF NOT EXISTS crm_contacts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id  INTEGER REFERENCES crm_companies(id) ON DELETE CASCADE,
    poc_name    TEXT NOT NULL,
    designation TEXT,
    email       TEXT,
    phone       TEXT,
    status      TEXT NOT NULL DEFAULT 'new',
    product_id  INTEGER REFERENCES crm_products(id) ON DELETE SET NULL,
    owner       TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Depends on: crm_companies, crm_contacts
CREATE TABLE IF NOT EXISTS crm_purchase_orders (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number              TEXT NOT NULL UNIQUE,
    po_source              TEXT NOT NULL DEFAULT 'manual',
    company_id             INTEGER NOT NULL REFERENCES crm_companies(id) ON DELETE RESTRICT,
    contact_id             INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
    status                 TEXT NOT NULL DEFAULT 'draft',
    order_date             DATE,
    expected_dispatch_date DATE,
    dispatch_date          DATE,
    notes                  TEXT,
    created_by             TEXT,
    created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at             DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Depends on: crm_contacts
CREATE TABLE IF NOT EXISTS crm_notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
    body       TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Depends on: crm_contacts
CREATE TABLE IF NOT EXISTS crm_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id   INTEGER REFERENCES crm_contacts(id) ON DELETE CASCADE,
    title        TEXT NOT NULL,
    due_date     DATE NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open',
    assigned_to  TEXT,
    completed_at DATETIME,
    created_by   TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    invoice_id   INTEGER
);

-- Depends on: crm_purchase_orders
CREATE TABLE IF NOT EXISTS crm_po_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id            INTEGER NOT NULL REFERENCES crm_purchase_orders(id) ON DELETE CASCADE,
    item_code        TEXT    NOT NULL,
    quantity_ordered INTEGER NOT NULL DEFAULT 1,
    unit_price       REAL,
    notes            TEXT
);

-- Invoices (standalone; task_id is a soft ref, no FK constraint in source)
CREATE TABLE IF NOT EXISTS crm_invoices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    uploaded_by       TEXT,
    original_filename TEXT,
    doc_type          TEXT DEFAULT 'freight_invoice',
    invoice_no        TEXT,
    invoice_date      TEXT,
    party_name        TEXT,
    party_gstin       TEXT,
    buyer_gstin       TEXT,
    place_of_supply   TEXT,
    mawb_no           TEXT,
    flight_no         TEXT,
    commodity         TEXT,
    origin_airport    TEXT,
    dest_airport      TEXT,
    gross_weight      REAL,
    supplier_ref      TEXT,
    taxable_value     REAL,
    cgst              REAL,
    sgst              REAL,
    igst              REAL,
    total_tax         REAL,
    net_amount        REAL,
    line_items        TEXT DEFAULT '[]',
    tally_xml         TEXT,
    status            TEXT DEFAULT 'pending',
    review_notes      TEXT,
    task_id           INTEGER,
    approved_at       DATETIME,
    pushed_at         DATETIME,
    deleted_at        DATETIME,
    push_error        TEXT,
    extract_error     TEXT,
    purchase_ledger   TEXT,
    bank_ledger       TEXT,
    delivery_date     TEXT,
    account_no        TEXT,
    statement_from    TEXT,
    statement_to      TEXT,
    opening_balance   REAL,
    closing_balance   REAL,
    total_debit       REAL,
    total_credit      REAL
);

-- Depends on: crm_purchase_orders, crm_companies
CREATE TABLE IF NOT EXISTS outwards (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    reel_number      TEXT,
    customer_name    TEXT,
    invoice_number   TEXT,
    quantity_shipped INTEGER,
    outward_type     TEXT,
    outward_date     DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes            TEXT,
    po_id            INTEGER,
    company_id       INTEGER
);


-- ─────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_bank_txns_date        ON crm_tally_bank_txns(date);
CREATE INDEX IF NOT EXISTS idx_bank_txns_type        ON crm_tally_bank_txns(voucher_type);
CREATE INDEX IF NOT EXISTS idx_contacts_company      ON crm_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status       ON crm_contacts(status);
CREATE INDEX IF NOT EXISTS idx_invoices_date         ON crm_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_invoices_status       ON crm_invoices(status);
CREATE INDEX IF NOT EXISTS idx_ledgers_parent        ON crm_tally_ledgers(parent);
CREATE INDEX IF NOT EXISTS idx_notes_contact         ON crm_notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_outstanding_due       ON crm_tally_outstanding(due_date);
CREATE INDEX IF NOT EXISTS idx_outstanding_overdue   ON crm_tally_outstanding(overdue_days);
CREATE INDEX IF NOT EXISTS idx_outstanding_party     ON crm_tally_outstanding(party_name);
CREATE INDEX IF NOT EXISTS idx_outwards_company      ON outwards(company_id);
CREATE INDEX IF NOT EXISTS idx_outwards_po           ON outwards(po_id);
CREATE INDEX IF NOT EXISTS idx_po_company            ON crm_purchase_orders(company_id);
CREATE INDEX IF NOT EXISTS idx_po_items_po           ON crm_po_items(po_id);
CREATE INDEX IF NOT EXISTS idx_po_status             ON crm_purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_sales_vch_date        ON crm_tally_sales_vouchers(date);
CREATE INDEX IF NOT EXISTS idx_sales_vch_party       ON crm_tally_sales_vouchers(party_name);
CREATE INDEX IF NOT EXISTS idx_stock_parent          ON crm_tally_stock_items(parent);
CREATE INDEX IF NOT EXISTS idx_tasks_contact         ON crm_tasks(contact_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due             ON crm_tasks(due_date, status);
CREATE INDEX IF NOT EXISTS idx_tasks_invoice         ON crm_tasks(invoice_id);
```
