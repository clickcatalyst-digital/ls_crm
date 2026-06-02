// server.js

require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const path = require('path');
const os = require('os');
const morgan = require('morgan');
const { initDB, queryOne } = require('./db/schema');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'fallback-secret';

app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

function requireLogin(req, res, next) {
  // Allow secure incoming webhooks from Telegram to bypass browser authentication checkpoints
  if (req.path === '/api/invoices/telegram-webhook') return next();

  const token = req.headers['authorization']?.replace('Bearer ', '')
    || req.cookies?.token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch (e) {}
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

(async () => {
  await initDB();

  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const user = await queryOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ success: true, username: user.username, role: user.role, token });
  });

  app.get('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.redirect('/login');
  });

  // All routes below require login
  app.use(requireLogin);

  // Pages
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views', 'dashboard.html')));
  app.get('/clients', (req, res) => res.sendFile(path.join(__dirname, 'views', 'clients.html')));
  app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'views', 'settings.html')));
  app.get('/docs', (req, res) => res.sendFile(path.join(__dirname, 'views', 'docs.html')));
  app.get('/finance', (req, res) => res.sendFile(path.join(__dirname, 'views', 'finance.html')));

  // API
  app.use('/api/products', require('./routes/products'));
  app.use('/api/clients', require('./routes/clients'));
  app.use('/api/tasks', require('./routes/tasks'));
  app.use('/api/invoices', require('./routes/invoices'));
  app.use('/api/finance', require('./routes/finance'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/po', require('./routes/po'));

  app.get('/api/auth/me', (req, res) => {
    res.json({ username: req.user.username, role: req.user.role });
  });

  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nLS CRM running at:`);
    console.log(`   Local:   http://localhost:${PORT}`);
    ips.forEach(ip => console.log(`   Network: http://${ip}:${PORT}`));
    console.log('');
  });
})();

// Keep-alive ping (free tier only)
if (process.env.RENDER_SERVICE_URL) {
  setInterval(() => {
    fetch(process.env.RENDER_SERVICE_URL).catch(() => {});
  }, 14 * 60 * 1000);
}