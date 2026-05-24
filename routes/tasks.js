// routes/tasks.js
const express = require('express');
const router = express.Router();
const { queryAll, execute, nowIST } = require('../db/schema');

// Today's + overdue open tasks, with contact/company context
router.get('/today', async (req, res) => {
  const today = nowIST().substring(0, 10); // YYYY-MM-DD
  res.json(await queryAll(`
    SELECT t.*, c.poc_name, co.name AS company_name
    FROM crm_tasks t
    LEFT JOIN crm_contacts c ON t.contact_id = c.id
    LEFT JOIN crm_companies co ON c.company_id = co.id
    WHERE t.status = 'open' AND t.due_date <= ?
    ORDER BY t.due_date
  `, [today]));
});

router.post('/', async (req, res) => {
  const { contact_id, title, due_date } = req.body;
  if (!title || !due_date) return res.status(400).json({ error: 'title and due_date required' });
  await execute('INSERT INTO crm_tasks (contact_id, title, due_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
    [contact_id || null, title.trim(), due_date, req.user.username, nowIST()]);
  res.json({ success: true, message: 'Task created' });
});

router.post('/:id/done', async (req, res) => {
  const r = await execute("UPDATE crm_tasks SET status = 'done', completed_at = ? WHERE id = ?", [nowIST(), req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true, message: 'Task completed' });
});

module.exports = router;