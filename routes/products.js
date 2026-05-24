// routes/products.js
const express = require('express');
const router = express.Router();
const { queryAll, queryOne, execute } = require('../db/schema');

router.get('/', async (req, res) => {
  res.json(await queryAll("SELECT * FROM crm_products WHERE status != 'archived' ORDER BY name"));
});

router.post('/', async (req, res) => {
  const { name, product_type, category } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    const r = await execute(
      'INSERT INTO crm_products (name, product_type, category) VALUES (?, ?, ?)',
      [name.trim(), product_type || null, category || null]
    );
    res.json({ success: true, id: Number(r.lastId), message: `Product "${name}" added` });
  } catch (err) {
    if (err.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Product already exists' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;