// route/po.js

const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');

async function nextSysPONumber() {
  await execute("UPDATE counters SET value = value + 1 WHERE name = 'po_sys'");
  const row = await queryOne("SELECT value FROM counters WHERE name = 'po_sys'");
  return `SYS-${row.value}`;
}

// ── Fuzzy item matching ───────────────────────────────────────────────
// Extracted PO lines carry free-text descriptions, not our internal item
// codes. Match each against the items master: exact normalized hit wins;
// otherwise a token-overlap score above THRESHOLD takes the best candidate;
// otherwise the line is kept with item_code = null for manual assignment.
const MATCH_THRESHOLD = 0.6;
const STOPWORDS = new Set(['the','a','an','of','for','and','or','with','to','in','mm','pcs','set','no','x']);

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function tokenize(s) {
  return normalizeText(s).split(' ').filter(t => t.length > 1 && !STOPWORDS.has(t));
}
function tokenOverlapScore(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  // Jaccard-ish: shared over the union, so neither side dominates.
  return shared / (ta.size + tb.size - shared);
}

// Returns { item_code, matched } for a single extracted description.
function matchItem(description, items, normIndex) {
  const norm = normalizeText(description);
  if (!norm) return { item_code: null, matched: false };
  // 1. exact normalized description match
  const exact = normIndex.get(norm);
  if (exact) return { item_code: exact, matched: true };
  // 2. best token-overlap above threshold
  let best = null, bestScore = 0;
  for (const it of items) {
    const score = Math.max(
      tokenOverlapScore(description, it.description || ''),
      tokenOverlapScore(description, it.item_code || '')
    );
    if (score > bestScore) { bestScore = score; best = it; }
  }
  if (best && bestScore >= MATCH_THRESHOLD) return { item_code: best.item_code, matched: true };
  return { item_code: null, matched: false };
}

// ── Shared PO insert core ─────────────────────────────────────────────
// Used by both the HTTP create route and the extraction import path.
// `lines` are already-resolved { item_code, quantity_ordered, unit_price, notes }.
async function insertPO({ po_number, po_source, company_id, contact_id, order_date,
                          expected_dispatch_date, notes, created_by, file_url, lines }) {
  const r = await execute(
    `INSERT INTO crm_purchase_orders
       (po_number, po_source, company_id, contact_id, order_date,
        expected_dispatch_date, notes, created_by, file_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? )`,
    [po_number, po_source, company_id, contact_id || null,
     order_date || null, expected_dispatch_date || null,
     notes || null, created_by, file_url || null, nowIST(), nowIST()]
  );
  const poId = Number(r.lastId);
  if (Array.isArray(lines)) {
    for (const line of lines) {
      if (!line.quantity_ordered) continue;
      await execute(
        `INSERT INTO crm_po_items
           (po_id, item_code, quantity_ordered, unit_price, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [poId, line.item_code || '', line.quantity_ordered,
         line.unit_price || null, line.notes || null]
      );
    }
  }
  return poId;
}

// ── Create a PO draft from an extracted document ──────────────────────
// Called by routes/invoices.js after a PO PDF is parsed. Fuzzy-matches
// extracted lines to the items master; unmatched lines keep their
// description in `notes` with item_code = null so the panel can flag them.
// Resolves party_name → company_id where an exact company name match exists;
// otherwise stashes the supplier name in the PO notes for the reviewer.
async function createPOFromExtraction(inv, createdBy, file_url = null) {
  const po_number = (inv.invoice_no && inv.invoice_no.trim())
    ? inv.invoice_no.trim()
    : await nextSysPONumber();
  const po_source = 'upload';

  // Resolve company by exact (case-insensitive) name match.
  let company_id = null, supplierNote = null;
  if (inv.party_name && inv.party_name.trim()) {
    const co = await queryOne(
      'SELECT id FROM crm_companies WHERE lower(trim(name)) = lower(trim(?))',
      [inv.party_name]
    );
    if (co) {
      company_id = co.id;
    } else {
      // Dynamic fallback: To satisfy the database NOT NULL constraint, 
      // automatically provision a clean company stub entry on the fly.
      const newCo = await execute(
        'INSERT INTO crm_companies (name) VALUES (?)',
        [inv.party_name.trim()]
      );
      company_id = Number(newCo.lastId);
      supplierNote = `New Supplier Provisioned: ${inv.party_name.trim()}`;
    }
  } else {
    // Hard fallback safety logic if the AI payload is missing a vendor name entirely
    const fallbackCo = await queryOne("SELECT id FROM crm_companies WHERE lower(name) = 'unknown supplier' LIMIT 1");
    if (fallbackCo) {
      company_id = fallbackCo.id;
    } else {
      const newCo = await execute("INSERT INTO crm_companies (name) VALUES ('Unknown Supplier')");
      company_id = Number(newCo.lastId);
    }
    supplierNote = 'Supplier identity missing from extraction payload';
  }

  // Load items master once for matching.
  const items = await queryAll(
    "SELECT item_code, description FROM items WHERE status = 'active'"
  );
  const normIndex = new Map();
  for (const it of items) {
    const k = normalizeText(it.description);
    if (k && !normIndex.has(k)) normIndex.set(k, it.item_code);
  }

  const rawLines = Array.isArray(inv.line_items) ? inv.line_items : [];
  const lines = rawLines.map(li => {
    const qty = parseInt(li.qty) || 1;
    const { item_code, matched } = matchItem(li.description, items, normIndex);
    return {
      item_code,
      quantity_ordered: qty,
      unit_price: (li.rate != null && li.rate !== '') ? parseFloat(li.rate) : null,
      // Unmatched lines preserve their source description here so the panel
      // can render them and the reviewer can assign a real item_code.
      notes: matched ? null : (li.description || '').trim() || null,
    };
  });

  const noteParts = [];
  if (supplierNote) noteParts.push(supplierNote);
  const unmatchedCount = lines.filter(l => !l.item_code).length;
  if (unmatchedCount) noteParts.push(`${unmatchedCount} line(s) need an item assigned`);

  const poId = await insertPO({
    po_number,
    po_source,
    company_id,
    contact_id: null,
    order_date: inv.invoice_date || null,
    expected_dispatch_date: inv.delivery_date || null,
    notes: noteParts.join(' · ') || null,
    created_by: createdBy,
    file_url,
    lines,
  });
  return { id: poId, po_number, company_id, unmatched: unmatchedCount };
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

// Inventory items for line item selector
router.get('/items', async (req, res) => {
  res.json(await queryAll(
    "SELECT item_code, description FROM items WHERE status = 'active' ORDER BY item_code"
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

  const lines = Array.isArray(items)
    ? items
        .filter(item => item.item_code && item.quantity_ordered)
        .map(item => ({
          item_code: item.item_code,
          quantity_ordered: item.quantity_ordered,
          unit_price: item.unit_price || null,
          notes: item.notes || null,
        }))
    : [];

  try {
    const poId = await insertPO({
      po_number, po_source, company_id,
      contact_id, order_date, expected_dispatch_date,
      notes, created_by: req.user.username, lines,
    });
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

// UPDATE LINE ITEM — assign/replace item_code (used to resolve unmatched
// lines from an uploaded PO) and adjust qty/price/notes.
router.patch('/:id/items/:itemId', async (req, res) => {
  const po = await queryOne(
    'SELECT status FROM crm_purchase_orders WHERE id = ?',
    [req.params.id]
  );
  if (!po) return res.status(404).json({ error: 'PO not found' });
  if (['dispatched', 'cancelled'].includes(po.status))
    return res.status(400).json({ error: `Cannot modify a ${po.status} PO` });

  const allowed = ['item_code', 'quantity_ordered', 'unit_price', 'notes'];
  const fields = {};
  for (const k of allowed) if (req.body[k] !== undefined) fields[k] = req.body[k];
  if (!Object.keys(fields).length)
    return res.status(400).json({ error: 'Nothing to update' });

  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), req.params.itemId, req.params.id];
  const r = await execute(
    `UPDATE crm_po_items SET ${sets} WHERE id = ? AND po_id = ?`,
    values
  );
  if (!r.changes) return res.status(404).json({ error: 'Item not found' });
  res.json({ success: true });
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

  // Robust Duplicate-Safe Delivery Task Generation
  if (po.expected_dispatch_date) {
    const dispatchTitle = `Dispatch PO ${po.po_number} — ${po.company_name || 'Unassigned Vendor'}`;
    
    // Check if an open reminder already exists for this specific dispatch action
    const existingDispatchTask = await queryOne(
      "SELECT id FROM crm_tasks WHERE title = ? AND status = 'open'",
      [dispatchTitle]
    );

    if (!existingDispatchTask) {
      await execute(
        `INSERT INTO crm_tasks
           (contact_id, title, due_date, assigned_to, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [po.contact_id || null,
         dispatchTitle,
         po.expected_dispatch_date,
         po.created_by || 'system', 'system', nowIST()]
      );
    }
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

  // Robust Duplicate-Safe Post-Dispatch Follow Up Task
  const followUpTitle = `Post-dispatch follow up — PO ${po.po_number} (${po.company_name || 'Unassigned Vendor'})`;
  
  // Verify that a follow-up ticket isn't already active in the timeline pipeline matrix
  const existingFollowUpTask = await queryOne(
    "SELECT id FROM crm_tasks WHERE title = ? AND status = 'open'",
    [followUpTitle]
  );

  if (!existingFollowUpTask) {
    const followUp = new Date(dispatch_date);
    followUp.setDate(followUp.getDate() + 3);
    await execute(
      `INSERT INTO crm_tasks
         (contact_id, title, due_date, assigned_to, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [po.contact_id || null,
       followUpTitle,
       followUp.toISOString().substring(0, 10),
       po.created_by || 'system', 'system', nowIST()]
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

// DELETE PERMANENTLY — Secure table-cascade cleanup handler
router.delete('/:id', async (req, res) => {
  // Enforce security privilege level rules across destructive deletion pipelines
  if (!['admin', 'manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Not authorized to delete purchase orders' });
  }

  try {
    const po = await queryOne('SELECT id, po_number FROM crm_purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) return res.status(404).json({ error: 'PO not found' });

    // Cascade task cleanup using the structural PO identifier string to prevent orphaned calendar items
    if (po.po_number) {
      await execute("DELETE FROM crm_tasks WHERE title LIKE ? AND status = 'open'", [`%PO ${po.po_number}%`]);
    }

    // 1. Clear lines first to satisfy foreign key constraints safely
    await execute('DELETE FROM crm_po_items WHERE po_id = ?', [req.params.id]);
    
    // 2. Clear core purchase order entry record
    await execute('DELETE FROM crm_purchase_orders WHERE id = ?', [req.params.id]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.createPOFromExtraction = createPOFromExtraction;