// routes/finance.js
const express = require('express');
const router  = express.Router();
const { queryAll, queryOne } = require('../db/schema');

function parseTallyBalance(s) {
  if (!s || s === '') return 0;
  const token = String(s).split(' ')[0].replace(/,/g, '');
  return parseFloat(token) || 0;
  // Tally convention: negative = Dr balance (debtor owes you), positive = Cr (they overpaid)
}

// GET /api/finance/summary — KPI totals + sync timestamps
router.get('/summary', async (req, res) => {
  try {
    const bills = await queryAll('SELECT pending_amt, overdue_days, due_date FROM crm_tally_outstanding');
    const total    = bills.reduce((s, b) => s + (b.pending_amt || 0), 0);
    const overdue  = bills.filter(b => b.overdue_days > 0).reduce((s, b) => s + (b.pending_amt || 0), 0);
    const today    = new Date();
    const in30     = new Date(today.getTime() + 30 * 864e5).toISOString().slice(0, 10);
    const todayStr = today.toISOString().slice(0, 10);
    const dueMonth = bills
      .filter(b => b.due_date && b.due_date >= todayStr && b.due_date <= in30)
      .reduce((s, b) => s + (b.pending_amt || 0), 0);

    const masterSync  = await queryOne("SELECT value FROM counters WHERE name='tally_masters_last_sync'");
    const voucherSync = await queryOne("SELECT value FROM counters WHERE name='tally_voucher_sync_from'");

    res.json({
      total, overdue, dueMonth, openBills: bills.length,
      masterSyncEpoch:  masterSync?.value  || null,
      voucherSyncDate:  voucherSync?.value || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/outstanding
// Joins with crm_companies so the frontend can link party names to CRM client cards
router.get('/outstanding', async (req, res) => {
  try {
    const [bills, companies] = await Promise.all([
      queryAll(`SELECT * FROM crm_tally_outstanding ORDER BY overdue_days DESC, pending_amt DESC`),
      queryAll(`SELECT id, name FROM crm_companies`),
    ]);
    const cmap = {};
    for (const c of companies) cmap[(c.name || '').toLowerCase().trim()] = c.id;
    res.json(bills.map(b => ({ ...b, company_id: cmap[(b.party_name || '').toLowerCase().trim()] || null })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/debtors — Sundry Debtors ledger + tracked outstanding joined in JS
router.get('/debtors', async (req, res) => {
  try {
    const ledgers = await queryAll(
      `SELECT name, closing_balance FROM crm_tally_ledgers WHERE parent='Sundry Debtors' ORDER BY name`
    );
    const outstanding = await queryAll(
      `SELECT party_name, SUM(pending_amt) AS tracked FROM crm_tally_outstanding GROUP BY party_name`
    );
    const trackedMap = {};
    for (const r of outstanding) trackedMap[(r.party_name || '').toLowerCase().trim()] = r.tracked || 0;

    const result = ledgers
      .map(l => {
        const balance = parseTallyBalance(l.closing_balance);
        const absbal  = Math.abs(balance);
        const tracked = trackedMap[(l.name || '').toLowerCase().trim()] || 0;
        return {
          name:                l.name,
          tally_balance:       absbal,
          is_credit:           balance > 0,   // true = they overpaid / we owe them
          tracked_outstanding: tracked,
          gap:         Math.max(0, absbal - tracked),
          coverage_pct: absbal > 0 ? Math.round((tracked / absbal) * 100) : 100,
        };
      })
      .filter(d => d.tally_balance > 0)
      .sort((a, b) => b.tally_balance - a.tally_balance);

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/sales
// Note: bill_refs is included so the frontend can derive amount when voucher-level
// amount=0 (Tally DayBook does not populate <AMOUNT> for Sales vouchers at voucher level)
// GET /api/finance/sales  — optional ?from=YYYY-MM-DD&to=YYYY-MM-DD
// bill_refs included: Tally DayBook sets voucher-level amount=0 for Sales; frontend derives from bill_refs
router.get('/sales', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where  = (from && to) ? 'WHERE date >= ? AND date <= ?' : '';
    const params = (from && to) ? [from, to] : [];
    res.json(await queryAll(
      `SELECT voucher_no, date, party_name, amount, narration, bill_refs, synced_at
       FROM crm_tally_sales_vouchers ${where} ORDER BY date DESC, voucher_no DESC`,
      params
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/sales/:vno — single voucher with all JSON fields parsed
router.get('/sales/:vno', async (req, res) => {
  try {
    const v = await queryOne(
      `SELECT * FROM crm_tally_sales_vouchers WHERE voucher_no=?`, [req.params.vno]
    );
    if (!v) return res.status(404).json({ error: 'Not found' });
    for (const f of ['ledger_lines', 'bill_refs', 'inventory_lines']) {
      if (typeof v[f] === 'string') { try { v[f] = JSON.parse(v[f]); } catch { v[f] = []; } }
      if (!Array.isArray(v[f])) v[f] = [];
    }
    res.json(v);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/inventory
router.get('/inventory', async (req, res) => {
  try {
    res.json(await queryAll(
      `SELECT name, parent, base_units, closing_qty, closing_rate, hsn_code, gst_applicable, synced_at
       FROM crm_tally_stock_items ORDER BY parent, name`
    ));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/cash-bank — bank/cash accounts + advances + tax liabilities
// Returns { accounts, advances, tax } for a full financial position view
router.get('/cash-bank', async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT name, parent, closing_balance FROM crm_tally_ledgers
       WHERE parent IN ('Bank Accounts','Cash-in-Hand','Bank OD Account',
                        'Advance From Customers','Duties & Taxes')
       ORDER BY parent, name`
    );
    const map = (parent_groups, invert) => rows
      .filter(r => parent_groups.includes(r.parent))
      .map(r => {
        const bal = parseTallyBalance(r.closing_balance);
        return { name: r.name, parent: r.parent, balance: Math.abs(bal), is_overdraft: invert ? bal < 0 : bal > 0 };
      })
      .filter(r => r.balance > 0);

    res.json({
      accounts: map(['Bank Accounts','Cash-in-Hand','Bank OD Account'], false),
      advances: map(['Advance From Customers'], true),  // Cr balance = you hold advance
      tax:      map(['Duties & Taxes'], true),           // Cr balance = you owe tax
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/payables — Sundry Creditor ledger balances
// Note: aging not available until purchase vouchers are synced; closing balance only
router.get('/payables', async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT name, parent, closing_balance FROM crm_tally_ledgers
       WHERE parent IN ('Sundry Creditors', 'Sundry Creditors Import')
       ORDER BY parent, name`
    );
    res.json(rows
      .map(r => {
        const bal = parseTallyBalance(r.closing_balance);
        // Tally: positive = Cr = you owe them (normal for creditors)
        // Negative = Dr = they owe you (overpaid or credit note)
        return { name: r.name, parent: r.parent, balance: Math.abs(bal), is_dr: bal < 0 };
      })
      .filter(r => r.balance > 0)
      .sort((a, b) => b.balance - a.balance)
    );
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;