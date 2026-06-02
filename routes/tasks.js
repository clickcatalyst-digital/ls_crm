// routes/tasks.js
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');

// Today's + overdue open tasks, with contact/company context
router.get('/today', async (req, res) => {
  const today = nowIST().substring(0, 10);
  const scope = req.query.scope || 'mine'; // 'mine' | 'all'
  const isApprover = ['admin', 'manager'].includes(req.user?.role);

  // Staff can never see 'all' — force 'mine' regardless of query
  const effectiveScope = isApprover ? scope : 'mine';

  let sql = `
    SELECT t.*, c.poc_name, co.name AS company_name
    FROM crm_tasks t
    LEFT JOIN crm_contacts c ON t.contact_id = c.id
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE t.status = 'open' AND t.due_date <= ?`;
  const params = [today];

  if (effectiveScope === 'mine') {
    sql += ' AND t.assigned_to = ?';
    params.push(req.user.username);
  }
  sql += ' ORDER BY t.due_date';
  res.json(await queryAll(sql, params));
});

router.post('/', async (req, res) => {
  const { contact_id, title, due_date, assigned_to } = req.body;
  if (!title || !due_date) return res.status(400).json({ error: 'title and due_date required' });
  await execute('INSERT INTO crm_tasks (contact_id, title, due_date, assigned_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [contact_id || null, title.trim(), due_date, assigned_to || req.user.username, req.user.username, nowIST()]);
  res.json({ success: true, message: 'Task created' });
});

router.post('/:id/done', async (req, res) => {
  const r = await execute("UPDATE crm_tasks SET status = 'done', completed_at = ? WHERE id = ?", [nowIST(), req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true, message: 'Task completed' });
});

// Tasks within a date range (for the calendar), grouped client-side
router.get('/range', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });
  res.json(await queryAll(`
    SELECT t.id, t.title, t.due_date, t.status, t.assigned_to,
           c.poc_name, co.name AS company_name
    FROM crm_tasks t
    LEFT JOIN crm_contacts c ON t.contact_id = c.id
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE t.status = 'open' AND t.due_date >= ? AND t.due_date <= ?
    ORDER BY t.due_date
  `, [from, to]));
});

// Reassign a task (approvers only)
router.post('/:id/assign', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user?.role)) return res.status(403).json({ error: 'Not authorized' });
  const { assigned_to } = req.body; // username or null to unassign
  const r = await execute('UPDATE crm_tasks SET assigned_to = ? WHERE id = ?', [assigned_to || null, req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true, message: assigned_to ? `Assigned to ${assigned_to}` : 'Unassigned' });
});

// Users that tasks can be assigned to (excludes admins)
router.get('/assignable', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user?.role)) return res.status(403).json({ error: 'Not authorized' });
  res.json(await queryAll("SELECT username, role FROM users WHERE role != 'admin' ORDER BY username"));
});

// Reopen a completed task (undo)
router.post('/:id/reopen', async (req, res) => {
  const r = await execute("UPDATE crm_tasks SET status = 'open', completed_at = NULL WHERE id = ?", [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true, message: 'Task reopened' });
});

// All tasks (for the Tasks page) — filterable by status + assignee, scope-aware for staff
router.get('/all', async (req, res) => {
  const { status, assignee } = req.query;
  const isApprover = ['admin', 'manager'].includes(req.user?.role);

  let sql = `
    SELECT t.*, c.poc_name, co.name AS company_name
    FROM crm_tasks t
    LEFT JOIN crm_contacts c ON t.contact_id = c.id
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE 1=1`;
  const params = [];

  // Staff only ever see their own tasks
  if (!isApprover) { sql += ' AND t.assigned_to = ?'; params.push(req.user.username); }
  else if (assignee) { sql += ' AND t.assigned_to = ?'; params.push(assignee); }

  if (status && status !== 'all') { sql += ' AND t.status = ?'; params.push(status); }

  sql += ' ORDER BY (t.status = "done"), t.due_date DESC LIMIT 500';
  res.json(await queryAll(sql, params));
});

// Completion stats — per assignee, grouped by week or month (approvers only)
router.get('/stats', async (req, res) => {
  if (!['admin', 'manager'].includes(req.user?.role)) return res.status(403).json({ error: 'Not authorized' });
  const period = req.query.period === 'month' ? 'month' : 'week';
  const fmt = period === 'month' ? '%Y-%m' : '%Y-W%W';
  const rows = await queryAll(`
    SELECT assigned_to,
           strftime('${fmt}', completed_at) AS bucket,
           COUNT(*) AS n
    FROM crm_tasks
    WHERE status = 'done' AND completed_at IS NOT NULL
    GROUP BY assigned_to, bucket
    ORDER BY bucket
  `);
  res.json(rows);
});

// Single task detail — with contact, company, and last note
router.get('/:id', async (req, res) => {
  const task = await queryOne(`
    SELECT t.*,
           c.poc_name, c.designation, c.email, c.phone,
           c.status AS contact_status, c.id AS crm_contact_id,
           co.name AS company_name
    FROM crm_tasks t
    LEFT JOIN crm_contacts c ON t.contact_id = c.id
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE t.id = ?
  `, [req.params.id]);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const note = task.contact_id ? await queryOne(
    `SELECT body, created_by, created_at FROM crm_notes
     WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1`,
    [task.contact_id]
  ) : null;

  res.json({ ...task, last_note: note || null });
});

// Update task title and/or due_date
router.patch('/:id', async (req, res) => {
  const { title, due_date } = req.body;
  const sets = [], params = [];
  if (title)    { sets.push('title = ?');    params.push(title.trim()); }
  if (due_date) { sets.push('due_date = ?'); params.push(due_date); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const r = await execute(`UPDATE crm_tasks SET ${sets.join(', ')} WHERE id = ?`, params);
  if (!r.changes) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

// DELETE PERMANENTLY — Permanent task-purging router hook
router.delete('/:id', async (req, res) => {
  try {
    const r = await execute('DELETE FROM crm_tasks WHERE id = ?', [req.params.id]);
    if (!r.changes) return res.status(404).json({ error: 'Task already deleted or not found' });
    res.json({ success: true, message: 'Task permanently removed from ledger tracking metrics' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;