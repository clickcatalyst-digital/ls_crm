// routes/tasks.js
const express = require('express');
const router = express.Router();
const { queryAll, execute, nowIST } = require('../db/schema');

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

module.exports = router;