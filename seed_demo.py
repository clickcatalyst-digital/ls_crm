#!/usr/bin/env python3
"""
seed_demo.py  —  Turso seeder for LS CRM / Talk2Tally
Inserts demo data directly into an existing Turso database.
Schema (DDL) must already be applied before running this.

Requirements:
    pip install bcrypt requests

Usage:
    python seed_demo.py
"""

import json, sys
from datetime import datetime, timedelta

try:
    import bcrypt as _bcrypt
except ImportError:
    sys.exit("Missing dependency — run:  pip install bcrypt requests")

try:
    import requests as _http
except ImportError:
    sys.exit("Missing dependency — run:  pip install bcrypt requests")


# ─────────────────────────────────────────────────────────────
#  TURSO CONNECTION
# ─────────────────────────────────────────────────────────────
TURSO_URL   = "https://demo-rock77.aws-ap-south-1.turso.io"
TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODA1MTAyMTYsImlkIjoiMDE5ZThlYTktMDQwMS03MjVjLWFmZTEtZjcwYzExNWNiNzMzIiwicmlkIjoiOGNmMjQ2ZTktYWJjMi00Nzg0LTk4MzktZDY1NThlMDIyNWY0In0.LAuSHRzAyjt-8bnJFlOXUGUT9acfGt11IMBwaaslyLdRqRCkLiO2zhpOY1SJTXrY-yH596vAG9z-kGk__RUBBg"


# ─────────────────────────────────────────────────────────────
#  DATE HELPERS  (everything relative to: 3 Jun 2026)
# ─────────────────────────────────────────────────────────────
_BASE = datetime(2026, 6, 3)

def ts(days_ago=0):
    return (_BASE - timedelta(days=days_ago)).strftime("%Y-%m-%d %H:%M:%S")

def dt(days_ago=0):
    return (_BASE - timedelta(days=days_ago)).strftime("%Y-%m-%d")

def fwd(days=0):
    return (_BASE + timedelta(days=days)).strftime("%Y-%m-%d")

def hp(pw):
    return _bcrypt.hashpw(pw.encode(), _bcrypt.gensalt(10)).decode()

def jj(v):
    return json.dumps(v)

def dr(n): return -float(n)
def cr(n): return float(n)


# ─────────────────────────────────────────────────────────────
#  TURSO HTTP CLIENT
# ─────────────────────────────────────────────────────────────
class TursoClient:
    """Thin wrapper around the Turso libsql HTTP pipeline API."""

    def __init__(self, url, token):
        self._url = f"{url.rstrip('/')}/v2/pipeline"
        self._headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def _arg(v):
        if v is None:
            return {"type": "null"}
        if isinstance(v, bool):
            return {"type": "integer", "value": str(int(v))}
        if isinstance(v, int):
            return {"type": "integer", "value": str(v)}
        if isinstance(v, float):
            return {"type": "float", "value": v}
        return {"type": "text", "value": str(v)}

    def _pipeline(self, stmts):
        payload = {"requests": stmts + [{"type": "close"}]}
        resp = _http.post(self._url, headers=self._headers, json=payload, timeout=30)
        if not resp.ok:
            raise RuntimeError(f"Turso HTTP {resp.status_code}: {resp.text}")
        for i, r in enumerate(resp.json().get("results", [])):
            if r.get("type") == "error":
                raise RuntimeError(f"Statement {i}: {r.get('error', {}).get('message', 'unknown error')}")

    def execute(self, sql, args=()):
        self._pipeline([{
            "type": "execute",
            "stmt": {"sql": sql, "args": [self._arg(v) for v in args]},
        }])

    def executemany(self, sql, rows, chunk=100):
        rows = list(rows)
        for i in range(0, len(rows), chunk):
            stmts = [
                {"type": "execute", "stmt": {"sql": sql, "args": [self._arg(v) for v in row]}}
                for row in rows[i:i + chunk]
            ]
            self._pipeline(stmts)

    def ping(self):
        self._pipeline([{"type": "execute", "stmt": {"sql": "SELECT 1", "args": []}}])

# idempotent: true clean-slate reset (wipe everything and re-seed from scratch
def reset(db):
    tables = [
        "crm_tally_stock_items", "crm_tally_purchase_outstanding",
        "crm_tally_purchase_vouchers", "crm_tally_sales_vouchers",
        "crm_tally_bank_txns", "crm_tally_outstanding", "crm_tally_ledgers",
        "crm_invoices", "crm_po_items", "crm_purchase_orders",
        "crm_tasks", "crm_notes", "crm_contacts", "crm_companies",
        "crm_products", "counters", "users",
    ]
    for t in tables:
        db.execute(f"DELETE FROM {t}")
        db.execute(f"DELETE FROM sqlite_sequence WHERE name='{t}'")
    print("  All tables cleared ✓\n")

# ─────────────────────────────────────────────────────────────
#  SEED DATA
# ─────────────────────────────────────────────────────────────
def seed(db):
    _S = ts(3)

    LS      = "24AALLS1234A1Z5"
    G_MEHTA = "24AABCM9876K1ZX"
    G_BIO   = "27AABCB5678L1ZT"
    G_APEX  = "27AABCA4321M1ZP"
    G_AGRO  = "24AABCG1111N1ZV"

    # ── 1. USERS ─────────────────────────────────────────────
    print("  [1/17] Users (hashing passwords — ~3 s) ...")
    db.executemany(
        "INSERT OR IGNORE INTO users (username, password, role, created_at) VALUES (?,?,?,?)", [
        ("admin", hp("admin234"), "admin",   ts(120)),
        ("rahul", hp("demo234"),  "manager", ts(90)),
        ("priya", hp("demo234"),  "user",    ts(60)),
    ])

    # ── 2. COUNTERS ──────────────────────────────────────────
    print("  [2/17] Counters ...")
    db.executemany("INSERT OR REPLACE INTO counters (name, value) VALUES (?,?)", [
        ("po_sys",                  1004),
        ("tally_masters_last_sync", 1748649600),
        ("tally_voucher_sync_from", 1743465600),
    ])

    # ── 3. PRODUCTS ──────────────────────────────────────────
    print("  [3/17] Products ...")
    db.executemany(
        "INSERT OR IGNORE INTO crm_products (name, product_type, category, status, created_at) VALUES (?,?,?,?,?)", [
        ("Air Freight - Import",   "Recurring", "Air Freight",   "active", ts(180)),
        ("Air Freight - Export",   "Recurring", "Air Freight",   "active", ts(180)),
        ("Customs Clearance",      "One-time",  "Customs",       "active", ts(180)),
        ("Documentation & Filing", "One-time",  "Documentation", "active", ts(90)),
    ])

    # ── 4. COMPANIES ─────────────────────────────────────────
    print("  [4/17] Companies ...")
    db.executemany(
        "INSERT OR IGNORE INTO crm_companies (name, website, industry, created_at, updated_at) VALUES (?,?,?,?,?)", [
        ("Mehta Exports Pvt Ltd",  "www.mehtaexports.com",  "Textile & Garments",  ts(150), ts(15)),
        ("BioTech Pharma Ltd",     "www.biotechpharma.in",  "Pharma & Healthcare", ts(140), ts(10)),
        ("Sunrise Electronics",    "www.sunriseelec.com",   "Electronics",         ts(130), ts(5)),
        ("Global Agro Foods Ltd",  "www.globalagro.in",     "Food & Agriculture",  ts(120), ts(3)),
        ("Apex Auto Components",   "www.apexauto.co.in",    "Auto Parts",          ts(110), ts(1)),
    ])

    # ── 5. CONTACTS ──────────────────────────────────────────
    print("  [5/17] Contacts ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_contacts
        (company_id, poc_name, designation, email, phone, status, product_id, owner, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)""", [
        (1, "Rajesh Mehta",  "Director",         "rajesh@mehtaexports.com",  "+91-9876543201", "customer",  2, "rahul", ts(150), ts(15)),
        (2, "Kavita Shah",   "Import Manager",   "kavita@biotechpharma.in",  "+91-9876543202", "customer",  3, "priya", ts(140), ts(10)),
        (3, "Vikram Patel",  "Purchase Head",    "vikram@sunriseelec.com",   "+91-9876543203", "qualified", 1, "rahul", ts(60),  ts(5)),
        (4, "Anita Desai",   "Operations Head",  "anita@globalagro.in",      "+91-9876543204", "qualified", 2, "priya", ts(45),  ts(3)),
        (5, "Suresh Kumar",  "GM - Procurement", "suresh@apexauto.co.in",    "+91-9876543205", "customer",  3, "rahul", ts(110), ts(1)),
        (2, "Neha Joshi",    "Accounts Manager", "neha@biotechpharma.in",    "+91-9876543206", "customer",  4, "priya", ts(100), ts(8)),
        (3, "Arjun Nair",    "IT Head",          "arjun@sunriseelec.com",    "+91-9876543207", "contacted", 1, "rahul", ts(30),  ts(2)),
    ])

    # ── 6. NOTES ─────────────────────────────────────────────
    print("  [6/17] Notes ...")
    db.executemany(
        "INSERT OR IGNORE INTO crm_notes (contact_id, body, created_by, created_at) VALUES (?,?,?,?)", [
        (1, "Confirmed FY2026 annual plan — 3 export consignments/month AMD→DXB. "
            "Happy with our TAT. Discussed 5% volume discount for Q3 onward.", "rahul", ts(15)),
        (1, "Rajesh requested a dedicated airfreight tracking login for his team. "
            "Raised feature request internally.", "rahul", ts(8)),
        (2, "Raised concern about 2-day clearance delay on last BOM→AMD pharma shipment. "
            "Committed resolution in 24 hrs. Escalated to our ops team.", "priya", ts(10)),
        (2, "Clearance delay resolved — custom duty query cleared. Kavita satisfied. "
            "Relationship back on track.", "priya", ts(9)),
        (3, "Vikram interested in our AMD import consolidation lane (electronics from Shenzhen). "
            "Shared rate card and sample AWB. Decision expected this week.", "rahul", ts(5)),
        (4, "Anita confirmed Global Agro is ready to sign annual service agreement. "
            "Waiting for MD signature only. Strong win incoming.", "priya", ts(3)),
        (5, "Regular customer. Suresh asked about GST 2A reconciliation support for FY25-26. "
            "Referred to Neha's documentation team.", "rahul", ts(1)),
        (6, "All April invoices reconciled with Tally — zero discrepancies this month.", "priya", ts(2)),
        (7, "Discovery call done. Arjun's team handles 4-5 China imports/quarter — electronics. "
            "Good potential. Schedule formal proposal call next week.", "rahul", ts(2)),
    ])

    # ── 7. TASKS ─────────────────────────────────────────────
    print("  [7/17] Tasks ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tasks
        (contact_id, title, due_date, status, assigned_to, completed_at, created_by, created_at, invoice_id)
        VALUES (?,?,?,?,?,?,?,?,?)""", [
        (1, "Collect overdue payment — LS/2025-26/001 (₹1,25,000 outstanding)",
         dt(5),  "open", "rahul", None,   "rahul", ts(30), 1),
        (2, "Send BOM→AMD clearance status update to Kavita Shah",
         dt(0),  "open", "priya", None,   "priya", ts(10), None),
        (4, "Share service agreement draft with Anita Desai — Global Agro",
         fwd(1), "open", "priya", None,   "priya", ts(5),  None),
        (3, "Follow up with Vikram Patel on rate proposal — Sunrise Electronics",
         fwd(3), "open", "rahul", None,   "rahul", ts(5),  None),
        (5, "Review and approve Apex Auto customs invoice — LS/2025-26/003",
         dt(7),  "done", "rahul", ts(7),  "rahul", ts(15), 3),
        (2, "Complete Kavita Shah onboarding and share Tally sync walkthrough",
         dt(60), "done", "priya", ts(60), "priya", ts(90), None),
    ])

    # ── 8. PURCHASE ORDERS ───────────────────────────────────
    print("  [8/17] Purchase Orders ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_purchase_orders
        (po_number, po_source, company_id, contact_id, status, order_date,
         expected_dispatch_date, dispatch_date, notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", [
        ("PO-1001", "manual", 1, 1, "dispatched",
         dt(140), dt(130), dt(125),
         "AMD→DXB textile export — Jan 2026 batch. Mehta Exports.",
         "rahul", ts(140), ts(125)),
        ("PO-1002", "email",  2, 2, "dispatched",
         dt(115), dt(105), dt(100),
         "BOM→AMD pharma import clearance — Feb 2026.",
         "priya", ts(115), ts(100)),
        ("PO-1003", "manual", 5, 5, "confirmed",
         dt(60),  dt(45),  None,
         "AMD→LHR auto parts import — Mar 2026. Awaiting dispatch.",
         "rahul", ts(60),  ts(45)),
        ("PO-1004", "manual", 4, 4, "pending",
         dt(15),  dt(5),   None,
         "AMD→SIN agro food export — first order from Global Agro.",
         "priya", ts(15),  ts(5)),
    ])

    # ── 9. PO ITEMS ──────────────────────────────────────────
    print("  [9/17] PO Items ...")
    db.executemany(
        "INSERT OR IGNORE INTO crm_po_items (po_id, item_code, quantity_ordered, unit_price, notes) VALUES (?,?,?,?,?)", [
        (1, "AFE-AMD-DXB", 1,  95000.00, "AMD to DXB, 285 kg, Textile Garments"),
        (1, "DOC-EXPORT",  1,   5000.00, "Export documentation & AWB charges"),
        (2, "CC-PHARMA",   1,  42000.00, "Customs clearance — pharma import, BOM port"),
        (2, "DOC-IMPORT",  1,   5000.00, "Import documentation & filing"),
        (3, "AFI-AMD-LHR", 1,  52000.00, "AMD to LHR, 192 kg, Auto Components"),
        (3, "CC-GENERAL",  1,   8000.00, "Customs clearance — general import"),
        (4, "AFE-AMD-SIN", 1,  32000.00, "AMD to SIN, 210 kg, Processed Food"),
        (4, "DOC-EXPORT",  1,   5000.00, "Export documentation & phytosanitary cert"),
    ])

    # ── 10. INVOICES ─────────────────────────────────────────
    print("  [10/17] Invoices ...")
    _INV = """
        INSERT OR IGNORE INTO crm_invoices (
            created_at, uploaded_by, original_filename, doc_type,
            invoice_no, invoice_date, party_name, party_gstin, buyer_gstin,
            place_of_supply, mawb_no, flight_no, commodity,
            origin_airport, dest_airport, gross_weight, supplier_ref,
            taxable_value, cgst, sgst, igst, total_tax, net_amount,
            line_items, status, review_notes, task_id, approved_at, pushed_at,
            purchase_ledger, bank_ledger, delivery_date
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""

    db.executemany(_INV, [
        # id=1  Mehta Exports AMD→DXB — PUSHED
        (ts(125), "rahul", "Mehta_Exports_INV_Jan2026.pdf", "freight_invoice",
         "LS/2025-26/001", dt(125), "Mehta Exports Pvt Ltd", G_MEHTA, LS,
         "International", "098-12345601", "AI-961", "Textile Garments",
         "AMD", "DXB", 285.5, "SHR-2601",
         105932.0, 0.0, 0.0, 19068.0, 19068.0, 125000.0,
         jj([{"description": "Air Freight Charges AMD-DXB", "qty": 1, "unit": "Consignment", "rate": 95000, "amount": 95000},
             {"description": "Fuel Surcharge",              "qty": 1, "unit": "Consignment", "rate": 8200,  "amount": 8200},
             {"description": "Terminal Handling (AMD)",     "qty": 1, "unit": "Consignment", "rate": 2732,  "amount": 2732}]),
         "pushed", None, 1, ts(123), ts(120),
         "Mehta Exports Pvt Ltd", "HDFC Current Account", dt(120)),

        # id=2  BioTech Pharma BOM→AMD — PUSHED
        (ts(100), "priya", "BioTech_INV_Feb2026.pdf", "freight_invoice",
         "LS/2025-26/002", dt(100), "BioTech Pharma Ltd", G_BIO, LS,
         "Gujarat", "176-98765432", "EK-524", "Pharmaceutical Products",
         "BOM", "AMD", 142.0, "SHR-2602",
         72458.0, 0.0, 0.0, 13042.0, 13042.0, 85500.0,
         jj([{"description": "Air Freight Charges BOM-AMD", "qty": 1, "unit": "Consignment", "rate": 62000, "amount": 62000},
             {"description": "Customs Clearance Charges",   "qty": 1, "unit": "Consignment", "rate": 8000,  "amount": 8000},
             {"description": "Documentation Charges",       "qty": 1, "unit": "Consignment", "rate": 2458,  "amount": 2458}]),
         "pushed", None, None, ts(98), ts(95),
         "BioTech Pharma Ltd", "HDFC Current Account", dt(95)),

        # id=3  Apex Auto AMD→LHR — APPROVED
        (ts(58), "rahul", "Apex_Auto_INV_Mar2026.pdf", "freight_invoice",
         "LS/2025-26/003", dt(58), "Apex Auto Components", G_APEX, LS,
         "International", "526-45678901", "6E-1501", "Auto Components & Spare Parts",
         "AMD", "LHR", 192.3, "SHR-2603",
         52881.0, 0.0, 0.0, 9519.0, 9519.0, 62400.0,
         jj([{"description": "Air Freight Charges AMD-LHR", "qty": 1, "unit": "Consignment", "rate": 48000, "amount": 48000},
             {"description": "Customs Clearance",           "qty": 1, "unit": "Consignment", "rate": 4881,  "amount": 4881}]),
         "approved", "Weight and MAWB verified. Ledger names confirmed. Ready for Tally push.",
         5, ts(50), None,
         "Apex Auto Components", "HDFC Current Account", dt(50)),

        # id=4  BioTech Pharma DEL→AMD — UNDER REVIEW
        (ts(43), "priya", "BioTech_DEL_Import_Apr2026.pdf", "freight_invoice",
         "LS/2025-26/004", dt(43), "BioTech Pharma Ltd", G_BIO, LS,
         "Gujarat", "098-33221144", "AI-657", "Active Pharmaceutical Ingredients",
         "DEL", "AMD", 88.0, "SHR-2604",
         35593.0, 0.0, 0.0, 6407.0, 6407.0, 42000.0,
         jj([{"description": "Air Freight Charges DEL-AMD", "qty": 1, "unit": "Consignment", "rate": 32000, "amount": 32000},
             {"description": "Customs Clearance",           "qty": 1, "unit": "Consignment", "rate": 3593,  "amount": 3593}]),
         "under_review",
         "Extracted GSTIN 27AABCB5678L1ZT — verify against party master before approving.",
         None, None, None,
         "BioTech Pharma Ltd", "HDFC Current Account", None),

        # id=5  Global Agro AMD→SIN — PENDING (just uploaded, not yet extracted)
        (ts(15), "priya", "GlobalAgro_Shipment_May2026.pdf", "freight_invoice",
         None, None, "Global Agro Foods Ltd", G_AGRO, LS,
         None, None, None, None, None, None, None, None,
         None, None, None, None, None, None,
         "[]", "pending", None, None, None, None,
         None, None, None),
    ])

    # id=6  HDFC Bank Statement — different column set
    db.execute("""
        INSERT OR IGNORE INTO crm_invoices (
            created_at, uploaded_by, original_filename, doc_type,
            party_name, status, review_notes, approved_at,
            bank_ledger, account_no, statement_from, statement_to,
            opening_balance, closing_balance, total_debit, total_credit
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        ts(5), "rahul", "HDFC_Statement_May2026.pdf", "bank_statement",
        "HDFC Bank Ltd", "approved", "May 2026 bank statement — all entries reconciled.",
        ts(4),
        "HDFC Current Account", "XXXX4521",
        "2026-05-01", "2026-05-31",
        285000.0, 345000.0, 420000.0, 480000.0,
    ))

    # ── 11. TALLY LEDGERS ────────────────────────────────────
    print("  [11/17] Tally Ledgers ...")
    db.executemany(
        "INSERT OR IGNORE INTO crm_tally_ledgers (name, parent, closing_balance, synced_at) VALUES (?,?,?,?)", [
        ("Mehta Exports Pvt Ltd",   "Sundry Debtors",          dr(125000), _S),
        ("BioTech Pharma Ltd",      "Sundry Debtors",          dr(127500), _S),
        ("Apex Auto Components",    "Sundry Debtors",          dr(62400),  _S),
        ("Global Agro Foods Ltd",   "Sundry Debtors",          dr(38250),  _S),
        ("Air India Cargo Ltd",     "Sundry Creditors",        cr(45000),  _S),
        ("IndiGo Cargo Pvt Ltd",    "Sundry Creditors",        cr(22000),  _S),
        ("Emirates SkyCargo",       "Sundry Creditors Import", cr(78500),  _S),
        ("HDFC Current Account",    "Bank Accounts",           dr(345000), _S),
        ("ICICI Current Account",   "Bank Accounts",           dr(120000), _S),
        ("Petty Cash",              "Cash-in-Hand",            dr(12500),  _S),
        ("Freight Income",          "Sales Accounts",          cr(895000), _S),
        ("Customs & CHA Income",    "Sales Accounts",          cr(325000), _S),
        ("Airline & Cargo Charges", "Purchase Accounts",       dr(485000), _S),
        ("Port & Handling Charges", "Direct Expenses",         dr(95000),  _S),
        ("Office & Admin Expenses", "Indirect Expenses",       dr(45000),  _S),
        ("GST Payable",             "Duties & Taxes",          cr(92340),  _S),
        ("IGST Input Credit",       "Duties & Taxes",          dr(68250),  _S),
        ("Advance from Customers",  "Advance From Customers",  cr(25000),  _S),
    ])

    # ── 12. TALLY OUTSTANDING (receivables) ──────────────────
    print("  [12/17] Tally Outstanding ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tally_outstanding
        (party_name, bill_ref, voucher_no, bill_date, original_amt, settled_amt,
         pending_amt, credit_days, due_date, overdue_days, synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", [
        ("Mehta Exports Pvt Ltd",
         "LS/2025-26/001", "VCH-S-001", dt(125), 125000,     0, 125000, 30, dt(95), 95, _S),
        ("BioTech Pharma Ltd",
         "LS/2025-26/002", "VCH-S-002", dt(100),  85500,     0,  85500, 30, dt(70), 70, _S),
        ("Apex Auto Components",
         "LS/2025-26/003", "VCH-S-003", dt(58),   62400, 17400,  45000, 30, dt(28), 28, _S),
        ("BioTech Pharma Ltd",
         "LS/2025-26/004", "VCH-S-004", dt(43),   42000,     0,  42000, 45, fwd(2), 0,  _S),
        ("Global Agro Foods Ltd",
         "LS/2025-26/005", "VCH-S-005", dt(15),   38250,     0,  38250, 30, fwd(15), 0, _S),
    ])

    # ── 13. TALLY BANK TRANSACTIONS ──────────────────────────
    print("  [13/17] Tally Bank Transactions ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tally_bank_txns
        (voucher_no, voucher_type, date, party_name, amount, narration, bill_refs, synced_at)
        VALUES (?,?,?,?,?,?,?,?)""", [
        ("VCH-R-001", "Receipt", dt(140), "Mehta Exports Pvt Ltd",   180000,
         "Payment against LS/2024-25/045 — Q4 FY25 settlement",
         jj([{"bill_ref": "LS/2024-25/045", "amount": 180000}]), _S),
        ("VCH-P-001", "Payment", dt(130), "Air India Cargo Ltd",      95000,
         "Airline charges AMD-DXB — Mehta Exports Jan 2026 batch",
         jj([]), _S),
        ("VCH-R-002", "Receipt", dt(95),  "BioTech Pharma Ltd",       65000,
         "Partial advance payment against LS/2025-26/002",
         jj([]), _S),
        ("VCH-P-002", "Payment", dt(85),  "Emirates SkyCargo",        78500,
         "Cargo charges BOM-AMD Feb 2026 — BioTech Pharma import",
         jj([]), _S),
        ("VCH-R-003", "Receipt", dt(60),  "Apex Auto Components",     45000,
         "Advance payment against PO-1003 (auto parts import)",
         jj([]), _S),
        ("VCH-P-003", "Payment", dt(55),  "IndiGo Cargo Pvt Ltd",     22000,
         "Domestic cargo charges AMD sector — Mar 2026",
         jj([]), _S),
        ("VCH-R-004", "Receipt", dt(30),  "Sunrise Electronics",      10000,
         "Inquiry advance — import consolidation service",
         jj([]), _S),
        ("VCH-P-004", "Payment", dt(20),  "Airports Authority India", 18500,
         "Port & terminal handling charges AMD — May 2026",
         jj([]), _S),
        ("VCH-R-005", "Receipt", dt(10),  "Apex Auto Components",     17400,
         "Partial payment against LS/2025-26/003 (balance ₹45,000 still pending)",
         jj([{"bill_ref": "LS/2025-26/003", "amount": 17400}]), _S),
        ("VCH-P-005", "Payment", dt(5),   "Petty Cash",                3500,
         "Miscellaneous office & stationery expenses",
         jj([]), _S),
    ])

    # ── 14. TALLY SALES VOUCHERS ─────────────────────────────
    print("  [14/17] Tally Sales Vouchers ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tally_sales_vouchers
        (voucher_no, date, party_name, amount, narration, ledger_lines, bill_refs, inventory_lines, synced_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", [
        ("VCH-S-001", dt(125), "Mehta Exports Pvt Ltd",  125000,
         "Air freight AMD-DXB — Textile garments — INV LS/2025-26/001",
         jj([{"ledger": "Mehta Exports Pvt Ltd",  "amount":  125000},
             {"ledger": "Freight Income",          "amount": -105932},
             {"ledger": "IGST Output",             "amount":  -19068}]),
         jj([{"bill_ref": "LS/2025-26/001", "amount": 125000}]),
         jj([]), _S),

        ("VCH-S-002", dt(100), "BioTech Pharma Ltd",      85500,
         "Pharma import clearance BOM-AMD — INV LS/2025-26/002",
         jj([{"ledger": "BioTech Pharma Ltd",   "amount":   85500},
             {"ledger": "Customs & CHA Income", "amount":  -72458},
             {"ledger": "IGST Output",          "amount":  -13042}]),
         jj([{"bill_ref": "LS/2025-26/002", "amount": 85500}]),
         jj([]), _S),

        ("VCH-S-003", dt(58),  "Apex Auto Components",    62400,
         "Air freight AMD-LHR + customs clearance — INV LS/2025-26/003",
         jj([{"ledger": "Apex Auto Components", "amount":   62400},
             {"ledger": "Freight Income",        "amount":  -52881},
             {"ledger": "IGST Output",           "amount":   -9519}]),
         jj([{"bill_ref": "LS/2025-26/003", "amount": 62400}]),
         jj([]), _S),

        ("VCH-S-004", dt(43),  "BioTech Pharma Ltd",      42000,
         "DEL-AMD import clearance — API consignment — INV LS/2025-26/004",
         jj([{"ledger": "BioTech Pharma Ltd",   "amount":   42000},
             {"ledger": "Customs & CHA Income", "amount":  -35593},
             {"ledger": "IGST Output",          "amount":   -6407}]),
         jj([{"bill_ref": "LS/2025-26/004", "amount": 42000}]),
         jj([]), _S),

        ("VCH-S-005", dt(15),  "Global Agro Foods Ltd",   38250,
         "AMD-SIN agro food export — INV LS/2025-26/005",
         jj([{"ledger": "Global Agro Foods Ltd", "amount":   38250},
             {"ledger": "Freight Income",         "amount":  -32415},
             {"ledger": "IGST Output",            "amount":   -5835}]),
         jj([{"bill_ref": "LS/2025-26/005", "amount": 38250}]),
         jj([]), _S),
    ])

    # ── 15. TALLY PURCHASE VOUCHERS ──────────────────────────
    print("  [15/17] Tally Purchase Vouchers ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tally_purchase_vouchers
        (voucher_no, date, party_name, amount, narration, ledger_lines, bill_refs, inventory_lines, synced_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", [
        ("VCH-P-V01", dt(130), "Air India Cargo Ltd",  95000,
         "Airline charges AMD-DXB Jan 2026 — Mehta Exports consignment",
         jj([{"ledger": "Airline & Cargo Charges", "amount":  95000},
             {"ledger": "Air India Cargo Ltd",      "amount": -95000}]),
         jj([{"bill_ref": "AIC/2026/001", "amount": 95000}]),
         jj([]), _S),

        ("VCH-P-V02", dt(85),  "Emirates SkyCargo",    78500,
         "Cargo charges BOM-AMD Feb 2026 — BioTech Pharma import",
         jj([{"ledger": "Airline & Cargo Charges", "amount":  78500},
             {"ledger": "Emirates SkyCargo",        "amount": -78500}]),
         jj([{"bill_ref": "EK/2026/084", "amount": 78500}]),
         jj([]), _S),

        ("VCH-P-V03", dt(55),  "IndiGo Cargo Pvt Ltd", 22000,
         "Domestic cargo charges AMD sector Mar 2026",
         jj([{"ledger": "Airline & Cargo Charges", "amount":  22000},
             {"ledger": "IndiGo Cargo Pvt Ltd",    "amount": -22000}]),
         jj([{"bill_ref": "6E/2026/302", "amount": 22000}]),
         jj([]), _S),
    ])

    # ── 16. TALLY PURCHASE OUTSTANDING ───────────────────────
    print("  [16/17] Tally Purchase Outstanding ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tally_purchase_outstanding
        (party_name, bill_ref, voucher_no, bill_date, original_amt, settled_amt,
         pending_amt, credit_days, due_date, overdue_days, synced_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)""", [
        ("Air India Cargo Ltd",  "AIC/2026/001", "VCH-P-V01", dt(130), 95000, 95000,     0, 30, dt(100), 0,  _S),
        ("Emirates SkyCargo",    "EK/2026/084",  "VCH-P-V02", dt(85),  78500,     0, 78500, 45, fwd(12), 0,  _S),
        ("IndiGo Cargo Pvt Ltd", "6E/2026/302",  "VCH-P-V03", dt(55),  22000, 22000,     0, 30, dt(25),  0,  _S),
    ])

    # ── 17. TALLY STOCK ITEMS ────────────────────────────────
    print("  [17/17] Tally Stock Items ...")
    db.executemany("""
        INSERT OR IGNORE INTO crm_tally_stock_items
        (name, parent, base_units, closing_qty, closing_rate, synced_at, hsn_code, gst_applicable)
        VALUES (?,?,?,?,?,?,?,?)""", [
        ("Air Waybill Forms", "Stationery & Forms", "Nos", "180", "5.00",   _S, "4820", "Applicable"),
        ("Stamp Paper (100)", "Stationery & Forms", "Nos", "42",  "120.00", _S, "4901", "Applicable"),
        ("Packing Material",  "Packaging Goods",    "Nos", "95",  "15.00",  _S, "4819", "Applicable"),
    ])


# ─────────────────────────────────────────────────────────────
#  MAIN
# ─────────────────────────────────────────────────────────────
def main():
    print(f"\nConnecting to Turso ...")
    db = TursoClient(TURSO_URL, TURSO_TOKEN)
    try:
        db.ping()
        print("  Connection OK ✓\n")
    except Exception as e:
        sys.exit(f"  Connection FAILED: {e}")

    print("wipe and re-seed from scratch")
    reset(db)
    print("Seeding demo data:")
    seed(db)

    print(f"\n{'─'*52}")
    print(f"  Turso   : {TURSO_URL}")
    print(f"  Seeded  : 17 tables with data, 5 left empty")
    print(f"{'─'*52}")
    print("\n  Demo logins:")
    print("    admin  /  admin234   (admin)")
    print("    rahul  /  demo234    (manager)")
    print("    priya  /  demo234    (staff)")
    print()


if __name__ == "__main__":
    main()