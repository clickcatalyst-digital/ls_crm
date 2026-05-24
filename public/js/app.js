// public/js/app.js
// ========== API HELPER ==========
async function api(url, options = {}) {
  try {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

// ========== TOAST NOTIFICATIONS ==========
function showToast(message, type = 'success') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.background = type === 'error' ? '#dc2626' : '#1a1a18';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// ========== DATE FORMATTING ==========
function formatDate(dateStr) {
  if (!dateStr) return '—';
  // SQLite returns naive string — treat as IST directly
  const d = new Date(dateStr.replace(' ', 'T') + '+05:30');
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr.replace(' ', 'T') + '+05:30');
  return d.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    hour12: true
  });
}

// ========== STATUS BADGE ==========
function statusBadge(status) {
  const map = { 'In Stock': 'badge-success', 'Outwarded': 'badge-danger', 'Partial': 'badge-warning', 'Deleted': 'badge-danger' };
  return `<span class="badge ${map[status] || 'badge-warning'}">${status}</span>`;
}

// ========== NUMBER FORMATTING ==========
function formatQty(n) {
  return (n || 0).toLocaleString('en-IN');
}

// ========== NAVBAR ACTIVE STATE ==========
document.addEventListener('DOMContentLoaded', () => {
  const path = window.location.pathname;
  document.querySelectorAll('.nav-links a').forEach(a => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
});

// ========== DARK MODE ==========
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  // Desktop toggle icon
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.innerHTML = theme === 'dark'
      ? '<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75 9.75 9.75 0 0 1 8.25 6 9.72 9.72 0 0 1 9 2.252 9.75 9.75 0 0 0 3 12a9.75 9.75 0 0 0 9.75 9.75c2.385 0 4.575-.86 6.252-2.248Z"/>'
      : '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/>';
  }
  // Cog menu icon + label
  const cogIcon = document.getElementById('cogThemeIcon');
  const cogLabel = document.getElementById('cogThemeLabel');
  if (cogIcon) {
    cogIcon.innerHTML = theme === 'dark'
      ? '<path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75 9.75 9.75 0 0 1 8.25 6 9.72 9.72 0 0 1 9 2.252 9.75 9.75 0 0 0 3 12a9.75 9.75 0 0 0 9.75 9.75c2.385 0 4.575-.86 6.252-2.248Z"/>'
      : '<path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/>';
  }
  if (cogLabel) {
    cogLabel.textContent = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
  }
}

// Apply saved theme on every page load
(function() {
  const saved = localStorage.getItem('theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
  document.addEventListener('DOMContentLoaded', () => updateThemeIcon(saved));
})();

// ========== COG MENU ==========
function toggleCogMenu() {
  const dropdown = document.getElementById('cogDropdown');
  if (dropdown) dropdown.classList.toggle('open');
}

// Close cog when tapping outside
document.addEventListener('click', (e) => {
  const menu = document.getElementById('cogMenu');
  if (menu && !menu.contains(e.target)) {
    const dropdown = document.getElementById('cogDropdown');
    if (dropdown) dropdown.classList.remove('open');
  }
});

// ========== REUSABLE PAGINATED TABLE ==========
class PaginatedTable {
  constructor({ containerId, titleText, columns, pageSize = 10 }) {
    this.containerId = containerId;
    this.titleText = titleText;
    this.columns = columns;
    this.pageSize = pageSize;
    this.currentPage = 1;
    this.data = [];
    this._inject();
  }

  _inject() {
    const container = document.getElementById(this.containerId);
    if (!container) return;
    const sizes = [5, 10, 20, 50, 100];
    container.innerHTML = `
      <div class="table-controls">
        <div class="card-title">${this.titleText}</div>
        <select class="page-size-select" id="${this.containerId}-size">
          ${sizes.map(s => `<option value="${s}" ${s === this.pageSize ? 'selected' : ''}>${s} / page</option>`).join('')}
        </select>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>${this.columns.map(c => `<th>${c.label}</th>`).join('')}</tr>
          </thead>
          <tbody id="${this.containerId}-tbody">
            <tr><td colspan="${this.columns.length}" style="text-align:center;color:var(--text-muted)">Loading...</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pagination-row">
        <span class="page-info" id="${this.containerId}-info"></span>
        <div class="pagination-btns" id="${this.containerId}-btns"></div>
      </div>
    `;
    document.getElementById(`${this.containerId}-size`).addEventListener('change', (e) => {
      this.pageSize = parseInt(e.target.value);
      this.currentPage = 1;
      this._render();
    });
  }

  load(data) {
    this.data = data;
    this.currentPage = 1;
    this._render();
  }

  _render() {
    const total = this.data.length;
    const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
    this.currentPage = Math.min(this.currentPage, totalPages);
    const start = (this.currentPage - 1) * this.pageSize;
    const slice = this.data.slice(start, start + this.pageSize);
    const tbody = document.getElementById(`${this.containerId}-tbody`);

    if (!total) {
      tbody.innerHTML = `<tr><td colspan="${this.columns.length}" style="text-align:center;color:var(--text-muted)">No data</td></tr>`;
    } else {
      tbody.innerHTML = slice.map(row =>
        `<tr>${this.columns.map(c => `<td>${c.render(row)}</td>`).join('')}</tr>`
      ).join('');
    }

    const from = total ? start + 1 : 0;
    const to = Math.min(start + this.pageSize, total);
    document.getElementById(`${this.containerId}-info`).textContent =
      total ? `${from}–${to} of ${total}` : '0 results';

    const btnsEl = document.getElementById(`${this.containerId}-btns`);
    let btns = `<button ${this.currentPage === 1 ? 'disabled' : ''} data-page="${this.currentPage - 1}">←</button>`;
    for (const p of this._pageRange(this.currentPage, totalPages)) {
      btns += p === '…'
        ? `<button disabled>…</button>`
        : `<button class="${p === this.currentPage ? 'active-page' : ''}" data-page="${p}">${p}</button>`;
    }
    btns += `<button ${this.currentPage === totalPages ? 'disabled' : ''} data-page="${this.currentPage + 1}">→</button>`;
    btnsEl.innerHTML = btns;

    btnsEl.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentPage = parseInt(btn.dataset.page);
        this._render();
      });
    });

    // Hide pagination row if all data fits on one page
    btnsEl.closest('.pagination-row').style.display = totalPages <= 1 ? 'none' : 'flex';

    // Hide/show dropdown based on data size
    const sizeEl = document.getElementById(`${this.containerId}-size`);
    sizeEl.style.display = total <= 10 ? 'none' : '';
    sizeEl.querySelectorAll('option').forEach(opt => {
      opt.disabled = parseInt(opt.value) >= total && parseInt(opt.value) !== this.pageSize;
    });
  }

  _pageRange(current, total) {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    if (current <= 4) return [1, 2, 3, 4, 5, '…', total];
    if (current >= total - 3) return [1, '…', total-4, total-3, total-2, total-1, total];
    return [1, '…', current - 1, current, current + 1, '…', total];
  }
}
