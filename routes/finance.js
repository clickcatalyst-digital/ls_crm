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

// PUT /api/finance/sales/:vno/reminder — Commit a payment reminder date tracker and sync it to global tasks
router.put('/sales/:vno/reminder', async (req, res) => {
  try {
    const { reminder_date } = req.body;
    const vno = req.params.vno;
    
    // Explicitly pull missing schema execution models for isolated security boundaries
    const { execute, nowIST } = require('../db/schema');

    // 1. Fetch voucher metadata details to populate a high-context task title string
    const v = await queryOne('SELECT party_name FROM crm_tally_sales_vouchers WHERE voucher_no = ?', [vno]);
    if (!v) return res.status(404).json({ error: 'Sales voucher entry missing' });

    const partyName = v.party_name || 'Unknown Customer';
    const taskTitle = `💳 Payment Reminder: Voucher ${vno} (${partyName})`;

    // 2. Commit tracking parameters to core sales voucher row index
    await execute(
      'UPDATE crm_tally_sales_vouchers SET payment_reminder_date = ? WHERE voucher_no = ?',
      [reminder_date || null, vno]
    );

    // 3. Sync lifecycle state directly with crm_tasks ledger systems
    if (!reminder_date) {
      // If date is completely cleared, wipe any associated open reminder tasks to prevent clutter
      await execute("DELETE FROM crm_tasks WHERE title = ? AND status = 'open'", [taskTitle]);
    } else {
      // Look ahead to check if an open reminder task is already active
      const existingTask = await queryOne("SELECT id FROM crm_tasks WHERE title = ? AND status = 'open'", [taskTitle]);
      
      if (existingTask) {
        // Adjust the due date of the current active reminder task
        await execute("UPDATE crm_tasks SET due_date = ? WHERE id = ?", [reminder_date, existingTask.id]);
      } else {
        // Insert a brand new, color-codeable system task reminder
        await execute(
          `INSERT INTO crm_tasks (contact_id, title, due_date, assigned_to, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [null, taskTitle, reminder_date, req.user?.username || 'system', 'system', nowIST()]
        );
      }
    }

    res.json({ success: true, message: 'Payment reminder date and task updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// GET /api/finance/pnl-snapshot — P&L account ledger balances (resets each FY in Indian accounting)
// Answers: Are we profitable? What's our revenue vs cost this year?
router.get('/pnl-snapshot', async (req, res) => {
  try {
    const rows = await queryAll(
      `SELECT name, parent, closing_balance FROM crm_tally_ledgers
       WHERE parent IN ('Sales Accounts','Purchase Accounts','Indirect Expenses',
                        'Direct Expenses','Direct Incomes','Indirect Incomes')
       ORDER BY parent, name`
    );
    const bucket = (parents) => rows
      .filter(r => parents.includes(r.parent))
      .map(r => ({ name: r.name, parent: r.parent, balance: Math.abs(parseTallyBalance(r.closing_balance)) }))
      .filter(r => r.balance > 0);

    const sales    = bucket(['Sales Accounts', 'Direct Incomes', 'Indirect Incomes']);
    const purchase = bucket(['Purchase Accounts']);
    const opex     = bucket(['Indirect Expenses', 'Direct Expenses']);

    const totalSales    = sales.reduce((s, r) => s + r.balance, 0);
    const totalPurchase = purchase.reduce((s, r) => s + r.balance, 0);
    const totalOpEx     = opex.reduce((s, r) => s + r.balance, 0);
    const grossProfit   = totalSales - totalPurchase;

    res.json({ sales, purchase, opex, totalSales, totalPurchase, totalOpEx, grossProfit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/transactions — bank receipts + payments with date/type filter
// Answers: Has a customer paid? What went out this month? Net cash flow?
router.get('/transactions', async (req, res) => {
  try {
    const { from, to, type } = req.query;
    const conditions = [];
    const params = [];
    if (from && to) { conditions.push('date >= ? AND date <= ?'); params.push(from, to); }
    if (type && type !== 'all') { conditions.push('voucher_type = ?'); params.push(type); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await queryAll(
      `SELECT voucher_no, voucher_type, date, party_name, amount, narration
       FROM crm_tally_bank_txns ${where} ORDER BY date DESC, voucher_no DESC`,
      params
    );
    const totalIn  = rows.filter(r => r.voucher_type === 'Receipt').reduce((s, r) => s + Math.abs(r.amount || 0), 0);
    const totalOut = rows.filter(r => r.voucher_type === 'Payment').reduce((s, r) => s + Math.abs(r.amount || 0), 0);
    res.json({ rows, totalIn, totalOut, netFlow: totalIn - totalOut });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/finance/purchase-register — purchase vouchers with date filter
// Answers: What did we buy, from whom, and at what cost this period?
router.get('/purchase-register', async (req, res) => {
  try {
    const { from, to } = req.query;
    const where  = (from && to) ? 'WHERE date >= ? AND date <= ?' : '';
    const params = (from && to) ? [from, to] : [];
    const rows = await queryAll(
      `SELECT voucher_no, date, party_name, amount, narration, inventory_lines, ledger_lines, bill_refs
       FROM crm_tally_purchase_vouchers ${where} ORDER BY date DESC`,
      params
    );
    res.json(rows.map(r => {
      for (const f of ['inventory_lines', 'ledger_lines', 'bill_refs']) {
        if (typeof r[f] === 'string') { try { r[f] = JSON.parse(r[f]); } catch { r[f] = []; } }
        if (!Array.isArray(r[f])) r[f] = [];
      }
      // Derive total from inventory lines if voucher-level amount=0
      if (!r.amount || r.amount === 0) {
        r.amount = r.inventory_lines.reduce((s, l) => s + Math.abs(l.amount || 0), 0);
      } else {
        r.amount = Math.abs(r.amount);
      }
      return r;
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;