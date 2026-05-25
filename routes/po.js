const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');

async function nextSysPONumber() {
  await execute("UPDATE counters SET value = value + 1 WHERE name = 'po_sys'");
  const row = await queryOne("SELECT value FROM counters WHERE name = 'po_sys'");
  return `SYS-${row.value}`;
}

// LIST — filterable by status, company_id
router.get('/', async (req, res) => {
  const { status, company_id } = req.query;
  let sql = `
    SELECT p.*, co.name AS company_name, c.poc_name
    FROM crm_purchase_orders p
    LEFT JOIN crm_companies co ON p.company_id = co.id
    LEFT JOIN crm_contacts c ON p.contact_id = c.id
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== 'all') { sql += ' AND p.status = ?'; params.push(status); }
  if (company_id) { sql += ' AND p.company_id = ?'; params.push(company_id); }
  sql += ' ORDER BY p.created_at DESC LIMIT 500';
  res.json(await queryAll(sql, params));
});

// Companies for outward selector (called by inventory UI)
router.get('/companies', async (req, res) => {
  res.json(await queryAll('SELECT id, name FROM crm_companies ORDER BY name'));
});

// Confirmed POs for a company (called by inventory UI when selecting customer)
router.get('/companies/:companyId/open', async (req, res) => {
  res.json(await queryAll(
    `SELECT id, po_number, expected_dispatch_date, notes
     FROM crm_purchase_orders
     WHERE company_id = ? AND status = 'confirmed'
     ORDER BY expected_dispatch_date`,
    [req.params.companyId]
  ));
});

// CREATE
router.post('/', async (req, res) => {
  const {
    company_id, contact_id, order_date,
    expected_dispatch_date, notes, items, generate_number
  } = req.body;
  if (!company_id) return res.status(400).json({ error: 'company_id required' });

  let po_number, po_source;
  if (generate_number) {
    po_number = await nextSysPONumber();
    po_source = 'system';
  } else {
    if (!req.body.po_number?.trim())
      return res.status(400).json({ error: 'po_number required' });
    po_number = req.body.po_number.trim();
    po_source = 'manual';
  }

  try {
    const r = await execute(
      `INSERT INTO crm_purchase_orders
         (po_number, po_source, company_id, contact_id, order_date,
          expected_dispatch_date, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [po_number, po_source, company_id, contact_id || null,
       order_date || null, expected_dispatch_date || null,
       notes || null, req.user.username, nowIST(), nowIST()]
    );
    const poId = Number(r.lastId);

    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item.item_code || !item.quantity_ordered) continue;
        await execute(
          `INSERT INTO crm_po_items
             (po_id, item_code, quantity_ordered, unit_price, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [poId, item.item_code, item.quantity_ordered,
           item.unit_price || null, item.notes || null]
        );
      }
    }

    res.json({ success: true, id: poId, po_number, message: `PO ${po_number} created` });
  } catch (err) {
    if (err.message?.includes('UNIQUE'))
      return res.status(409).json({ error: `PO number "${po_number}" already exists` });
    res.status(500).json({ error: err.message });
  }
});

// SINGLE — with items + outward count
router.get('/:id', async (req, res) => {
  const po = await queryOne(`
    SELECT p.*,
           co.name AS company_name, co.website,
           c.poc_name, c.phone, c.email, c.designation
    FROM crm_purchase_orders p
    LEFT JOIN crm_companies co ON p.company_id = co.id
    LEFT JOIN crm_contacts c ON p.contact_id = c.id
    WHERE p.id = ?
  `, [req.params.id]);
  if (!po) return res.status(404).json({ error: 'PO not found' });

  const items = await queryAll(`
    SELECT pi.*, i.description
    FROM crm_po_items pi
    LEFT JOIN items i ON pi.item_code = i.item_code
    WHERE pi.po_id = ?
  `, [req.params.id]);

  const outwardRow = await queryOne(
    'SELECT COUNT(*) AS n FROM outwards WHERE po_id = ?',
    [req.params.id]
  );

  res.json({ ...po, items, outward_count: outwardRow?.n || 0 });
});

// UPDATE — only allowed on draft or confirmed
router.patch('/:id', async (req, res) => {
  const po = await queryOne(
    'SELECT status FROM crm_purchase_orders WHERE id = ?',
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (['dispatched', 'cancelled'].includes(po.status))
    return res.status(400).json({ error: `Cannot edit a ${po.status} PO` });

  const { contact_id, order_date, expected_dispatch_date, notes } = req.body;
  await execute(
    `UPDATE crm_purchase_orders
     SET contact_id = ?, order_date = ?, expected_dispatch_date = ?,
         notes = ?, updated_at = ?
     WHERE id = ?`,
    [contact_id || null, order_date || null,
     expected_dispatch_date || null, notes || null, nowIST(), req.params.id]
  );
  res.json({ success: true });
});

// ADD LINE ITEM
router.post('/:id/items', async (req, res) => {
  const { item_code, quantity_ordered, unit_price, notes } = req.body;
  if (!item_code || !quantity_ordered)
    return res.status(400).json({ error: 'item_code and quantity_ordered required' });

  const po = await queryOne(
    'SELECT status FROM crm_purchase_orders WHERE id = ?',
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (['dispatched', 'cancelled'].includes(po.status))
    return res.status(400).json({ error: `Cannot modify a ${po.status} PO` });

  const r = await execute(
    `INSERT INTO crm_po_items
       (po_id, item_code, quantity_ordered, unit_price, notes)
     VALUES (?, ?, ?, ?, ?)`,
    [req.params.id, item_code, quantity_ordered, unit_price || null, notes || null]
  );
  res.json({ success: true, id: Number(r.lastId) });
});

// REMOVE LINE ITEM
router.delete('/:id/items/:itemId', async (req, res) => {
  const po = await queryOne(
    'SELECT status FROM crm_purchase_orders WHERE id = ?',
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (['dispatched', 'cancelled'].includes(po.status))
    return res.status(400).json({ error: `Cannot modify a ${po.status} PO` });

  const r = await execute(
    'DELETE FROM crm_po_items WHERE id = ? AND po_id = ?',
    [req.params.itemId, req.params.id]
  );
  if (!r.changes) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
});

// CONFIRM: draft → confirmed + dispatch reminder task
router.post('/:id/confirm', async (req, res) => {
  const po = await queryOne(`
    SELECT p.*, co.name AS company_name
    FROM crm_purchase_orders p
    LEFT JOIN crm_companies co ON p.company_id = co.id
    WHERE p.id = ?
  `, [req.params.id]);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'draft')
    return res.status(400).json({ error: 'Only draft POs can be confirmed' });

  const items = await queryAll(
    'SELECT id FROM crm_po_items WHERE po_id = ?', [req.params.id]
  );
  if (!items.length)
    return res.status(400).json({ error: 'Add at least one line item before confirming' });

  await execute(
    "UPDATE crm_purchase_orders SET status = 'confirmed', updated_at = ? WHERE id = ?",
    [nowIST(), req.params.id]
  );

  // Dispatch reminder task if expected date + contact are set
  if (po.expected_dispatch_date && po.contact_id) {
    await execute(
      `INSERT INTO crm_tasks
         (contact_id, title, due_date, assigned_to, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [po.contact_id,
       `Dispatch PO ${po.po_number} — ${po.company_name}`,
       po.expected_dispatch_date,
       po.created_by, 'system', nowIST()]
    );
  }

  res.json({ success: true, message: 'PO confirmed' });
});

// DISPATCH: confirmed → dispatched + follow-up task
router.post('/:id/dispatch', async (req, res) => {
  const { dispatch_date } = req.body;
  if (!dispatch_date)
    return res.status(400).json({ error: 'dispatch_date required' });

  const po = await queryOne(`
    SELECT p.*, co.name AS company_name
    FROM crm_purchase_orders p
    LEFT JOIN crm_companies co ON p.company_id = co.id
    WHERE p.id = ?
  `, [req.params.id]);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status !== 'confirmed')
    return res.status(400).json({ error: 'Only confirmed POs can be dispatched' });

  await execute(
    `UPDATE crm_purchase_orders
     SET status = 'dispatched', dispatch_date = ?, updated_at = ?
     WHERE id = ?`,
    [dispatch_date, nowIST(), req.params.id]
  );

  // Follow-up task 3 days after dispatch
  if (po.contact_id) {
    const followUp = new Date(dispatch_date);
    followUp.setDate(followUp.getDate() + 3);
    await execute(
      `INSERT INTO crm_tasks
         (contact_id, title, due_date, assigned_to, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [po.contact_id,
       `Post-dispatch follow up — PO ${po.po_number} (${po.company_name})`,
       followUp.toISOString().substring(0, 10),
       po.created_by, 'system', nowIST()]
    );
  }

  res.json({ success: true, message: `PO ${po.po_number} dispatched` });
});

// CANCEL — admins/managers only, not if already dispatched
router.post('/:id/cancel', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user?.role))
    return res.status(403).json({ error: 'Not authorized' });

  const po = await queryOne(
    'SELECT status FROM crm_purchase_orders WHERE id = ?',
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (po.status === 'dispatched')
    return res.status(400).json({ error: 'Cannot cancel a dispatched PO' });

  await execute(
    "UPDATE crm_purchase_orders SET status = 'cancelled', updated_at = ? WHERE id = ?",
    [nowIST(), req.params.id]
  );
  res.json({ success: true, message: 'PO cancelled' });
});

module.exports = router;