// public/js/tabs/tab-invoices.js
// Invoices tab — purchase_invoice, freight_invoice, bill_of_entry.
// Depends on: app.js (esc, api, formatDate, PaginatedTable)
// Shared from docs.html: openReview()

const INV_TYPES = ['purchase_invoice', 'freight_invoice'];

const INV_TYPE_LABEL = {
  purchase_invoice: 'Purchase',
  freight_invoice:  'Freight',
  bill_of_entry:    'Bill of Entry'
};

let _invFilter       = 'all';
let _invTypeFilter   = 'all';
let _invSearchQuery  = '';
let _invTabInited    = false;
let _invAllRows      = [];

/* ── Table Configuration ───────────────────────────────────────── */
const invTable = new PaginatedTable({
  containerId: 'invPane-table',
  pageSize: 12,
  titleText: '',
  columns: [
    { label: 'Document', render: d =>
        `<strong style="cursor:pointer;color:var(--primary);font-size:12.5px;" onclick="openReview(${d.id})">${esc(d.invoice_no || d.original_filename || 'Untitled')}</strong>` },
    
    // Vendor layout structured to support high readability scannability hierarchies
    { label: 'Party / Vendor', render: d => `
        <div style="font-weight:700; color:var(--text); font-size:13px;">${esc(d.party_name || '—')}</div>
        <div style="display:flex; gap:6px; margin-top:2px; align-items:center;">
          <span style="background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:1px 5px; font-size:9px; font-weight:700; color:var(--text-muted); text-transform:uppercase;">${esc(INV_TYPE_LABEL[d.doc_type] || d.doc_type)}</span>
          ${d.party_gstin ? `<span style="font-size:9.5px; font-family:monospace; color:var(--text-muted);">${d.party_gstin}</span>` : ''}
        </div>
    `},

    // Document Insights column mapping logic based on document classification
    { label: 'Document Insights', render: d => {
        const netAmt = parseFloat(d.net_amount) || 0;
        const formattedAmount = `<strong style="font-size:14px; color:var(--text); font-weight:800;">₹${netAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</strong>`;

        // Purchase Invoice context
        if (d.doc_type === 'purchase_invoice') {
          let lines = [];
          try { lines = typeof d.line_items === 'string' ? JSON.parse(d.line_items) : (d.line_items || []); } catch(e) {}
          const totalQty = lines.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
          
          if (totalQty > 0) {
            const costPerComponent = (netAmt / totalQty).toFixed(2);
            return `
              <div>${formattedAmount}</div>
              <div style="font-size:10px; color:var(--text-muted); font-weight:500; margin-top:1px;">
                Purchase Value · <span style="font-weight:600; color:var(--text);">${totalQty.toLocaleString('en-IN')} pcs</span> (₹${costPerComponent}/component)
              </div>`;
          }
          return `<div>${formattedAmount}</div><div style="font-size:10px; color:var(--text-muted); margin-top:1px;">Purchase Value</div>`;
        }

        // Freight/Logistics Invoice context
        if (d.doc_type === 'freight_invoice') {
          const weight = parseFloat(d.gross_weight) || 0;
          if (weight > 0) {
            const costPerKg = (netAmt / weight).toFixed(2);
            return `
              <div>${formattedAmount}</div>
              <div style="font-size:10px; color:var(--text-muted); font-weight:500; margin-top:1px;">
                Logistics Charges · <span style="font-weight:600; color:var(--text);">${weight} kg shipment</span> (₹${costPerKg}/kg)
              </div>`;
          }
          return `<div>${formattedAmount}</div><div style="font-size:10px; color:var(--text-muted); margin-top:1px;">Logistics Charges</div>`;
        }

        // Bill of Entry / Customs documentation context
        const defaultLabel = d.doc_type === 'bill_of_entry' ? 'Customs Duty' : 'Net Document Value';
        return `<div>${formattedAmount}</div><div style="font-size:10px; color:var(--text-muted); margin-top:1px;">${defaultLabel}</div>`;
    }},

    // Clean, balanced shipment info action trigger pill
    { label: 'Shipment Tracking', render: d => {
        const refMawb = d.mawb_no || '';
        if (!refMawb) return '<span style="color:var(--text-muted); font-size:11px;">Inland / Local Delivery</span>';

        const logDoc = _invAllRows.find(r => r.doc_type === 'freight_invoice' && r.mawb_no === refMawb);
        const flight = d.flight_no || (logDoc ? logDoc.flight_no : '—');
        const origin = d.origin_airport || (logDoc ? logDoc.origin_airport : '—');
        const dest = d.dest_airport || (logDoc ? logDoc.dest_airport : '—');
        const weight = d.gross_weight || (logDoc ? logDoc.gross_weight : '—');

        return `
          <span class="shipment-trigger-pill"
                style="cursor:pointer; display:inline-flex; align-items:center; gap:4px; padding:4px 8px; border:1px solid var(--border); border-radius:4px; font-size:11px; color:var(--text-muted); font-weight:600; background:var(--surface); transition:all 0.1s;"
                onclick="alert('📊 Shipment Manifest Summary:\\n\\nMAWB: ${esc(refMawb)}\\nFlight: ${esc(flight)}\\nGross Weight: ${weight} KG\\nRoute Nodes: ${esc(origin)} ➔ ${esc(dest)}')"
                onmouseover="this.style.borderColor='var(--primary)'; this.style.color='var(--primary)';"
                onmouseout="this.style.borderColor='var(--border)'; this.style.color='var(--text-muted)';"
                title="Click to view full manifest data summary details">
            ✈️ Attached Shipment
          </span>`;
    }},

    { label: 'Stage', render: d => {
        let badgeStyle = 'background:var(--border); color:var(--text-muted);';
        if (d.status === 'pending') badgeStyle = 'background:color-mix(in srgb, var(--warning) 12%, var(--bg)); color:#d97706; border:1px solid color-mix(in srgb, var(--warning) 30%, transparent);';
        if (d.status === 'approved') badgeStyle = 'background:color-mix(in srgb, var(--success) 12%, var(--bg)); color:var(--success); border:1px solid color-mix(in srgb, var(--success) 30%, transparent);';
        if (d.status === 'pushed') badgeStyle = 'background:var(--primary); color:#fff;';
        if (d.status === 'in_tally') badgeStyle = 'background:var(--success); color:#fff;';
        if (d.status === 'rejected') badgeStyle = 'background:color-mix(in srgb, var(--danger) 12%, var(--bg)); color:var(--danger); border:1px solid color-mix(in srgb, var(--danger) 30%, transparent);';
        const stageLabel = d.status === 'in_tally' ? 'In Tally' : d.status;
        return `<span style="font-size:10px; font-weight:800; text-transform:uppercase; letter-spacing:0.5px; padding:4px 8px; border-radius:6px; display:inline-block; ${badgeStyle}">${esc(stageLabel)}</span>`;
    }},
    
    { label: 'Added', render: d => `<span style="color:var(--text-muted); font-size:11px; font-weight:500;">${formatDate(d.created_at)}</span>` }
  ]
});

/* ── Symmetric Intelligence KPI Strip ──────────────────────────── */
function _renderInvIntel(rows) {
  const box = document.getElementById('invPane-intel');
  if (!box) return;

  const fmt = v => '₹' + Math.round(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  const pending  = rows.filter(d => d.status === 'pending');
  const approved = rows.filter(d => d.status === 'approved');
  const errors   = rows.filter(d => ['extract_failed', 'push_failed'].includes(d.status)).length;

  const pendingVal  = pending.reduce((s, d)  => s + (parseFloat(d.net_amount) || 0), 0);

  // Compute live strategic pipeline tax credits
  const pipeline = rows.filter(d => ['pending', 'approved'].includes(d.status));
  const cgst = pipeline.reduce((s, d) => s + (parseFloat(d.cgst) || 0), 0);
  const sgst = pipeline.reduce((s, d) => s + (parseFloat(d.sgst) || 0), 0);
  const igst = pipeline.reduce((s, d) => s + (parseFloat(d.igst) || 0), 0);
  const totalITC = cgst + sgst + igst;

  box.style.display = 'grid';
  box.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';
  box.style.gap = '12px';
  box.style.width = '100%';
  box.style.marginBottom = '16px';

  box.innerHTML = `
    <div class="tab-stat" style="margin:0; min-height:85px;">
      <div class="ts-value" style="color:var(--warning)">${pending.length}</div>
      <div class="ts-label">Pending Approval</div>
      <div class="ts-sub" style="font-weight:700; margin-top:2px;">${fmt(pendingVal)}</div>
    </div>
    
    <div class="tab-stat" style="margin:0; min-height:85px; background:linear-gradient(to bottom right, color-mix(in srgb, var(--success) 4%, var(--surface)), var(--surface));">
      <div class="ts-value" style="color:var(--success)">${fmt(totalITC)}</div>
      <div class="ts-label" style="color:var(--text); font-weight:700;">GST Recoverable</div>
      <div class="ts-sub" style="margin-top:2px; color:var(--text-muted);">Input Credit Available</div>
    </div>

    ${errors ? `
    <div class="tab-stat" style="margin:0; min-height:85px; border-color:color-mix(in srgb,var(--danger) 40%,var(--border));">
      <div class="ts-value" style="color:var(--danger)">${errors}</div>
      <div class="ts-label">Need Attention</div>
      <div class="ts-sub" style="margin-top:2px; color:var(--text-muted)">Stalled pipelines</div>
    </div>` : ''}

    <div class="tab-stat" style="margin:0; min-height:85px; min-width:240px;">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;">GST Input Credit Ledger (Pipeline)</div>
      <div style="display:flex; gap:16px; align-items:center;">
        ${cgst > 0 ? `<div>
          <div style="font-size:14px; font-weight:800;">${fmt(cgst)}</div>
          <div style="font-size:8px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin-top:2px;">CGST</div>
        </div>` : ''}
        ${cgst > 0 && sgst > 0 ? `<div style="border-left:1px solid var(--border); height:16px;"></div>` : ''}
        ${sgst > 0 ? `<div>
          <div style="font-size:14px; font-weight:800;">${fmt(sgst)}</div>
          <div style="font-size:8px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin-top:2px;">SGST</div>
        </div>` : ''}
        ${(cgst > 0 || sgst > 0) && igst > 0 ? `<div style="border-left:1px solid var(--border); height:16px;"></div>` : ''}
        ${igst > 0 ? `<div>
          <div style="font-size:14px; font-weight:800; color:var(--primary);">${fmt(igst)}</div>
          <div style="font-size:8px; font-weight:700; text-transform:uppercase; color:var(--text-muted); margin-top:4px;">IGST</div>
        </div>` : ''}
        ${totalITC === 0 ? `<div style="font-size:12px; font-weight:600; color:var(--text-muted);">No credits in pipeline</div>` : ''}
      </div>
    </div>`;
}

/* ── PO-style Create / Upload / Search / Filters toolbar ───────── */
function _injectInvoiceToolbar() {
  const tableContainer = document.getElementById('invPane-table');
  if (!tableContainer || document.getElementById('invCustomToolbar')) return;

  // Hide the old status-pill toolbar that lives in docs.html
  document.querySelector('#pane-invoices .tab-toolbar')?.style.setProperty('display', 'none');

  const wrapper = document.createElement('div');
  wrapper.id = 'invCustomToolbar';
  wrapper.style.cssText = 'margin-bottom:12px;';
  wrapper.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">

      <!-- Create (with invoice-type menu) -->
      <div id="invCreateWrap" style="position:relative;flex-shrink:0;">
        <button onclick="InvoicesTab.toggleCreateMenu(event)"
          style="font-size:12px;font-weight:700;padding:7px 13px;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:var(--radius);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;">
          + Create
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
        </button>
        <div id="invCreateMenu" style="display:none;position:absolute;top:100%;left:0;margin-top:4px;z-index:200;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:0 8px 28px rgba(0,0,0,0.18);min-width:190px;overflow:hidden;">
          <button onclick="InvoicesTab.create('purchase_invoice')" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-family:var(--font);font-size:12.5px;font-weight:600;padding:9px 14px;cursor:pointer;" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background='none'">Purchase Invoice</button>
          <button onclick="InvoicesTab.create('freight_invoice')" style="display:block;width:100%;text-align:left;background:none;border:none;color:var(--text);font-family:var(--font);font-size:12.5px;font-weight:600;padding:9px 14px;cursor:pointer;border-top:1px solid var(--border);" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background='none'">Freight Invoice</button>
        </div>
      </div>

      <!-- Upload (AI auto-classifies) -->
      <label style="flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:7px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);cursor:pointer;white-space:nowrap;">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/>
        </svg>
        Upload
        <input type="file" id="invFileInput" accept="application/pdf" style="display:none"
               onchange="InvoicesTab.handleUpload(this.files)">
      </label>

      <!-- Search -->
      <div style="flex:1;position:relative;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-muted);display:flex;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/>
          </svg>
        </span>
        <input id="invSearchInput" placeholder="Search number, vendor, commodity…"
               style="width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:7px 10px 7px 34px;font-size:12px;font-family:var(--font);"
               oninput="InvoicesTab.handleSearch(this.value)">
      </div>

      <!-- Filters -->
      <button id="invFilterBtn" onclick="InvoicesTab.toggleFilters()"
        style="flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:7px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);cursor:pointer;white-space:nowrap;transition:background 0.15s,border-color 0.15s;">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z"/>
        </svg>
        Filters
        <span id="invFilterCount" style="display:none;background:var(--primary);color:#fff;font-size:9px;font-weight:800;padding:1px 5px;border-radius:10px;min-width:14px;text-align:center;"></span>
      </button>
    </div>

    <!-- Filter panel (Doc Category + Stage) -->
    <div id="invFilterPanel" style="display:none;margin-top:8px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);">
      <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;">
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;">Doc Category</div>
          <select id="invTypeFilterSelect"
            onchange="InvoicesTab.handleTypeFilter(this.value)"
            style="font-family:var(--font);font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:6px 10px;min-width:180px;">
            <option value="all">All Classifications</option>
            <option value="purchase_invoice">Purchase Invoices</option>
            <option value="freight_invoice">Freight Log Invoices</option>
          </select>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;">Stage</div>
          <div class="doc-filters" id="invStageFilters" style="margin:0;">
            <button class="doc-filter active" data-status="all"      onclick="InvoicesTab.setFilter('all')">All</button>
            <button class="doc-filter"        data-status="pending"  onclick="InvoicesTab.setFilter('pending')">Pending</button>
            <button class="doc-filter"        data-status="approved" onclick="InvoicesTab.setFilter('approved')">Approved</button>
            <button class="doc-filter"        data-status="pushed"   onclick="InvoicesTab.setFilter('pushed')">Pushed</button>
            <button class="doc-filter"        data-status="rejected" onclick="InvoicesTab.setFilter('rejected')">Rejected</button>
          </div>
        </div>
      </div>
    </div>`;

  tableContainer.parentNode.insertBefore(wrapper, tableContainer);
}

/* ── Pipeline Processing Layer ─────────────────────────────────── */
async function _loadInvoices() {
  try {
    const all   = await api('/api/invoices');
    _invAllRows = all.filter(d => INV_TYPES.includes(d.doc_type));
    _renderInvIntel(_invAllRows);
    _injectInvoiceToolbar();
    _applyInvFilter();
  } catch(e) {
    console.error('InvoicesTab loading pipeline encountered an error:', e);
  }
}

function _applyInvFilter() {
  let rows = _invAllRows;

  if (_invFilter !== 'all') {
    rows = rows.filter(d => d.status === _invFilter);
  }

  if (_invTypeFilter !== 'all') {
    rows = rows.filter(d => d.doc_type === _invTypeFilter);
  }

  if (_invSearchQuery) {
    const q = _invSearchQuery.toLowerCase();
    rows = rows.filter(d => 
      (d.invoice_no && d.invoice_no.toLowerCase().includes(q)) ||
      (d.party_name && d.party_name.toLowerCase().includes(q)) ||
      (d.commodity  && d.commodity.toLowerCase().includes(q))  ||
      (d.mawb_no    && d.mawb_no.toLowerCase().includes(q))
    );
  }

  invTable.load(rows);
}

function _setInvFilter(status) {
  _invFilter = status;
  document.querySelectorAll('#invStageFilters .doc-filter')
    .forEach(b => b.classList.toggle('active', b.dataset.status === status));
  _updateInvFilterCount();
  _applyInvFilter();
}

/* ── Toolbar helpers (Create menu / Filters / Upload) ──────────── */
function _toggleInvFilters() {
  const panel = document.getElementById('invFilterPanel');
  const btn   = document.getElementById('invFilterBtn');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (btn) btn.style.background = open ? 'var(--bg)' : 'color-mix(in srgb,var(--primary) 10%,var(--bg))';
}

function _updateInvFilterCount() {
  const el = document.getElementById('invFilterCount');
  if (!el) return;
  const n = (_invFilter !== 'all' ? 1 : 0) + (_invTypeFilter !== 'all' ? 1 : 0);
  el.textContent = n;
  el.style.display = n > 0 ? 'inline' : 'none';
}

function _toggleInvCreateMenu(ev) {
  if (ev) ev.stopPropagation();
  const m = document.getElementById('invCreateMenu');
  if (!m) return;
  m.style.display = m.style.display === 'none' ? 'block' : 'none';
}

function _invCreate(type) {
  const m = document.getElementById('invCreateMenu');
  if (m) m.style.display = 'none';
  if (typeof openManual === 'function') openManual(type);   // global, defined in docs.html
  else showToast('Create unavailable', 'error');
}

async function _handleInvUpload(files) {
  const file = files[0];
  const fi = document.getElementById('invFileInput');
  if (fi) fi.value = '';
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('Only PDF files are supported', 'error'); return; }
  const fd = new FormData();
  fd.append('pdf', file);                 // no hint → AI auto-classifies the invoice type
  try {
    const res  = await fetch('/api/invoices/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    startProcessing(data.invoiceId, file.name, false);      // global, defined in docs.html
  } catch (e) {
    console.error('[Invoice Upload] failed:', e);
    showToast(e.message || 'Upload failed', 'error');
  }
}

// Close the Create menu on any outside click
document.addEventListener('click', e => {
  const m = document.getElementById('invCreateMenu');
  if (m && m.style.display !== 'none' && !e.target.closest('#invCreateWrap')) {
    m.style.display = 'none';
  }
});

/* ── Init Entry Node ───────────────────────────────────────────── */
async function _initInvTab() {
  if (_invTabInited) { await _loadInvoices(); return; }
  _invTabInited = true;
  await _loadInvoices();
}

/* ── Public Namespace Interface Exposure ───────────────────────── */
window.InvoicesTab = {
  init:             _initInvTab,
  load:             _loadInvoices,
  setFilter:        _setInvFilter,
  toggleFilters:    _toggleInvFilters,
  toggleCreateMenu: _toggleInvCreateMenu,
  create:           _invCreate,
  handleUpload:     _handleInvUpload,

  handleSearch(val) {
    _invSearchQuery = val.trim();
    _applyInvFilter();
  },

  handleTypeFilter(val) {
    _invTypeFilter = val;
    _updateInvFilterCount();
    _applyInvFilter();
  }
};