// routes/settings.js
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute } = require('../db/schema');

const APPROVER_ROLES = ['admin', 'manager'];
function requireApprover(req, res, next) {
  if (!APPROVER_ROLES.includes(req.user?.role)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  next();
}

// --- Products ---
router.get('/products', async (req, res) => {
  res.json(await queryAll('SELECT * FROM crm_products ORDER BY status, name'));
});

router.post('/products', requireApprover, async (req, res) => {
  const { name, product_type, category } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const r = await execute(
      'INSERT INTO crm_products (name, product_type, category) VALUES (?, ?, ?)',
      [name.trim(), product_type?.trim() || null, category?.trim() || null]
    );
    res.json({ success: true, id: Number(r.lastId), message: `Product "${name}" added` });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Product already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/products/:id', requireApprover, async (req, res) => {
  const { name, product_type, category, status } = req.body;
  const r = await execute(
    'UPDATE crm_products SET name = ?, product_type = ?, category = ?, status = ? WHERE id = ?',
    [name?.trim(), product_type?.trim() || null, category?.trim() || null, status || 'active', req.params.id]
  );
  if (!r.changes) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true, message: 'Product updated' });
});

router.post('/products/:id/archive', requireApprover, async (req, res) => {
  const r = await execute("UPDATE crm_products SET status = 'archived' WHERE id = ?", [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true, message: 'Product archived' });
});

// --- Categories (distinct values pulled from products; no separate table needed) ---
router.get('/categories', async (req, res) => {
  const rows = await queryAll("SELECT DISTINCT category FROM crm_products WHERE category IS NOT NULL AND category != '' ORDER BY category");
  res.json(rows.map(r => r.category));
});

// --- Users (shared table — affects inventory logins too) ---
const bcrypt = require('bcrypt');

router.get('/users', requireApprover, async (req, res) => {
  res.json(await queryAll('SELECT id, username, role, created_at FROM users ORDER BY username'));
});

router.post('/users', requireApprover, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'username and password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await execute('INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
      [username.trim(), hash, role || 'user']);
    res.json({ success: true, message: `User "${username}" added` });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', requireApprover, async (req, res) => {
  const { role, password } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    await execute('UPDATE users SET role = ?, password = ? WHERE id = ?', [role, hash, req.params.id]);
  } else {
    await execute('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  }
  res.json({ success: true, message: 'User updated' });
});

router.delete('/users/:id', requireApprover, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You can't delete yourself" });
  const r = await execute('DELETE FROM users WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true, message: 'User deleted' });
});

module.exports = router;