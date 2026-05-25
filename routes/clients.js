// routes/clients.js
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');

const PIPELINE_STAGES = ['new', 'contacted', 'qualified', 'customer', 'lost'];

// LIST — contacts joined to company + product, with search/filter
router.get('/', async (req, res) => {
  const { q, status, product_id } = req.query;
  let sql = `
    SELECT c.*, co.name AS company_name, co.website, co.industry, p.name AS product_name
    FROM crm_contacts c
    LEFT JOIN crm_companies co ON c.company_id = co.id
    LEFT JOIN crm_products p ON c.product_id = p.id
    WHERE 1=1
  `;
  const params = [];
  if (q) { sql += ' AND (c.poc_name LIKE ? OR co.name LIKE ? OR c.email LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  if (product_id) { sql += ' AND c.product_id = ?'; params.push(product_id); }
  if (req.query.company_id) { sql += ' AND c.company_id = ?'; params.push(req.query.company_id); }
  sql += ' ORDER BY c.updated_at DESC LIMIT 500';
  res.json(await queryAll(sql, params));
});

// SINGLE — contact + its notes thread + its tasks
router.get('/:id', async (req, res) => {
  const contact = await queryOne(`
    SELECT c.*, co.name AS company_name, co.website, co.industry, p.name AS product_name
    FROM crm_contacts c
    LEFT JOIN crm_companies co ON c.company_id = co.id
    LEFT JOIN crm_products p ON c.product_id = p.id
    WHERE c.id = ?`, [req.params.id]);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  const notes = await queryAll('SELECT * FROM crm_notes WHERE contact_id = ? ORDER BY created_at DESC', [req.params.id]);
  const tasks = await queryAll("SELECT * FROM crm_tasks WHERE contact_id = ? AND status = 'open' ORDER BY due_date", [req.params.id]);
  res.json({ ...contact, notes, tasks });
});

// CREATE — finds-or-creates company, then contact, optional first note + next-touchpoint task
router.post('/', async (req, res) => {
  const { poc_name, company_name, designation, email, phone, status, product_id, website, industry, note, next_touchpoint, next_touchpoint_title, next_touchpoint_assignee } = req.body;
  if (!poc_name) return res.status(400).json({ error: 'poc_name is required' });

  try {
    let companyId = null;
    if (company_name?.trim()) {
      const existing = await queryOne('SELECT id FROM crm_companies WHERE name = ?', [company_name.trim()]);
      if (existing) {
        companyId = existing.id;
      } else {
        const r = await execute('INSERT INTO crm_companies (name, website, industry) VALUES (?, ?, ?)',
          [company_name.trim(), website || null, industry || null]);
        companyId = Number(r.lastId);
      }
    }

    const r = await execute(
      `INSERT INTO crm_contacts (company_id, poc_name, designation, email, phone, status, product_id, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, poc_name.trim(), designation || null, email || null, phone || null,
       status || 'new', product_id || null, req.user.username, nowIST(), nowIST()]
    );
    const contactId = Number(r.lastId);

    if (note?.trim()) {
      await execute('INSERT INTO crm_notes (contact_id, body, created_by, created_at) VALUES (?, ?, ?, ?)',
        [contactId, note.trim(), req.user.username, nowIST()]);
    }
    if (next_touchpoint) {
      await execute('INSERT INTO crm_tasks (contact_id, title, due_date, assigned_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [contactId, next_touchpoint_title || 'Follow up', next_touchpoint, next_touchpoint_assignee || req.user.username, req.user.username, nowIST()]);
    }

    res.json({ success: true, id: contactId, message: `${poc_name} added` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// UPDATE contact fields
router.put('/:id', async (req, res) => {
  const { poc_name, designation, email, phone, status, product_id } = req.body;
  const result = await execute(
    `UPDATE crm_contacts SET poc_name = ?, designation = ?, email = ?, phone = ?, status = ?, product_id = ?, updated_at = ?
     WHERE id = ?`,
    [poc_name?.trim(), designation || null, email || null, phone || null, status, product_id || null, nowIST(), req.params.id]
  );
  if (!result.changes) return res.status(404).json({ error: 'Contact not found' });
  res.json({ success: true, message: 'Contact updated' });
});

// ADD a note (timestamped) — also bumps contact's updated_at
router.post('/:id/notes', async (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'note body required' });
  await execute('INSERT INTO crm_notes (contact_id, body, created_by, created_at) VALUES (?, ?, ?, ?)',
    [req.params.id, body.trim(), req.user.username, nowIST()]);
  await execute('UPDATE crm_contacts SET updated_at = ? WHERE id = ?', [nowIST(), req.params.id]);
  res.json({ success: true, message: 'Note added' });
});

// METRICS for dashboard
router.get('/meta/metrics', async (req, res) => {
  const total = await queryOne('SELECT COUNT(*) AS n FROM crm_contacts');
  const byStatus = await queryAll('SELECT status, COUNT(*) AS n FROM crm_contacts GROUP BY status');
  const counts = {};
  byStatus.forEach(r => counts[r.status] = r.n);
  const customers = counts.customer || 0;
  const denom = (total.n || 0) - (counts.lost || 0);
  res.json({
    total: total.n || 0,
    qualified: counts.qualified || 0,
    customers,
    conversion: denom > 0 ? Math.round((customers / (total.n || 1)) * 100) : 0,
    byStatus: counts
  });
});

module.exports = router;