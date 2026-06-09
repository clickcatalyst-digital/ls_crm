// public/js/tabs/tab-po.js
// Purchase Orders tab — lifecycle view, intelligence, and all PO CRUD.
// Depends on: app.js (esc, api, formatDate, showToast, PaginatedTable)
// Shared from docs.html: _poMode (var), syncLeftDocumentViewer, startProcessing, closeReview, setTab

/* ── Constants & state ─────────────────────────────────────────── */
const PO_STATUS = {
  draft: 'Draft', confirmed: 'Confirmed',
  dispatched: 'Dispatched', cancelled: 'Cancelled'
};

let _po          = null;
let _poNewLines  = [];
let _poCompanies = [];
let _poItems     = [];
let _poUser      = null;
let _poEditable  = false;
let _poTabInited = false;

/* ── Table ─────────────────────────────────────────────────────── */
const poTable = new PaginatedTable({
  containerId: 'poPane-table',
  pageSize: 12,
  titleText: '',
  columns: [
    { label: 'PO Number', render: p => {
      const tag = p.po_source === 'system' ? ' <span class="po-source-tag">SYS</span>'
                : p.po_source === 'upload' ? ' <span class="po-source-tag">IMPORTED</span>' : '';
      return `<strong style="cursor:pointer;color:var(--primary);" onclick="openPO(${p.id})">${esc(p.po_number)}</strong>${tag}`;
    }},
    { label: 'Company',      render: p => esc(p.company_name) || '—' },
    { label: 'Contact',      render: p => esc(p.poc_name)     || '—' },
    { label: 'Status',       render: p => {
      const today = new Date().toISOString().slice(0, 10);
      const overdue = p.status === 'confirmed'
        && p.expected_dispatch_date && p.expected_dispatch_date < today;
      return overdue
        ? `<span class="po-badge" style="background:color-mix(in srgb,var(--warning) 15%,transparent);color:var(--warning);">Overdue</span>`
        : `<span class="po-badge ${p.status}">${esc(PO_STATUS[p.status] || p.status)}</span>`;
    }},
    { label: 'Order Date',    render: p => formatDate(p.order_date) || '—' },
    { label: 'Exp. Dispatch', render: p => {
      const today = new Date().toISOString().slice(0, 10);
      const overdue = p.status === 'confirmed'
        && p.expected_dispatch_date && p.expected_dispatch_date < today;
      const val = formatDate(p.expected_dispatch_date) || '—';
      return overdue ? `<span style="color:var(--warning);font-weight:700;">${val}</span>` : val;
    }},
    { label: '', render: p => `
      <button class="trash-btn" title="Delete" onclick="event.stopPropagation();_poDeleteRow(${p.id})">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="color:var(--danger)">
          <path fill-rule="evenodd" d="M16.5 4.478v.227a48.816 48.816 0 0 1 3.878.512.75.75 0 1 1-.256 1.478l-.209-.035-1.005 13.07a3 3 0 0 1-2.991 2.77H8.084a3 3 0 0 1-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 0 1-.256-1.478A48.567 48.567 0 0 1 7.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 0 1 3.369 0c1.603.051 2.815 1.387 2.815 2.951Zm-6.136-1.452a51.196 51.196 0 0 1 3.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 0 0-6 0v-.113c0-.794.609-1.428 1.364-1.452Zm-.355 5.945a.75.75 0 1 0-1.5.058l.347 9a.75.75 0 1 0 1.499-.058l-.346-9Zm5.48.058a.75.75 0 1 0-1.498-.058l-.347 9a.75.75 0 0 0 1.5.058l.345-9Z" clip-rule="evenodd"/>
        </svg>
      </button>` }
  ]
});

/* ── Intelligence ──────────────────────────────────────────────── */
function _renderPOIntel(pos) {
  const box = document.getElementById('poPane-intel');
  if (!box) return;
  const today     = new Date().toISOString().slice(0, 10);
  const draft      = pos.filter(p => p.status === 'draft').length;
  const confirmed  = pos.filter(p => p.status === 'confirmed').length;
  const dispatched = pos.filter(p => p.status === 'dispatched').length;
  const overdue    = pos.filter(p =>
    p.status === 'confirmed' && p.expected_dispatch_date && p.expected_dispatch_date < today).length;

  box.innerHTML = `
    <div class="tab-stat">
      <div class="ts-value">${draft}</div>
      <div class="ts-label">Draft</div>
    </div>
    <div class="tab-stat">
      <div class="ts-value" style="color:var(--primary)">${confirmed}</div>
      <div class="ts-label">Confirmed</div>
    </div>
    <div class="tab-stat">
      <div class="ts-value" style="color:var(--success)">${dispatched}</div>
      <div class="ts-label">Dispatched</div>
    </div>
    ${overdue ? `
    <div class="tab-stat" style="border-color:color-mix(in srgb,var(--warning) 50%,var(--border));background:color-mix(in srgb,var(--warning) 4%,var(--surface));">
      <div class="ts-value" style="color:var(--warning)">${overdue}</div>
      <div class="ts-label">Overdue</div>
      <div class="ts-sub">past dispatch date</div>
    </div>` : ''}`;
}

/* ── Data ──────────────────────────────────────────────────────── */
async function _loadPOs() {
  const params = new URLSearchParams();
  const s = document.getElementById('poPane-status')?.value || 'all';
  const c = document.getElementById('poPane-company')?.value || '';
  if (s !== 'all') params.set('status', s);
  if (c)           params.set('company_id', c);
  try {
    const pos = await api(`/api/po?${params}`);
    _renderPOIntel(pos);
    poTable.load(pos);
  } catch(e) {}
}

async function _poDeleteRow(id) {
  if (!confirm('Delete this Purchase Order permanently?')) return;
  try {
    await api(`/api/po/${id}`, { method: 'DELETE' });
    showToast('Deleted');
    _loadPOs();
  } catch(e) {}
}

async function _handlePOUpload(files) {
  const file = files[0];
  document.getElementById('poFileInput').value = '';
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('Only PDF files are supported', 'error'); return; }
  const fd = new FormData();
  fd.append('pdf', file);
  fd.append('hint_doc_type', 'purchase_order');
  try {
    const res  = await fetch('/api/invoices/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    startProcessing(data.invoiceId, file.name, true); // docs.html handles the overlay + poll
  } catch(e) { showToast(e.message || 'Upload failed', 'error'); }
}

/* ── Tab init ──────────────────────────────────────────────────── */
async function _initPOTab() {
  if (_poTabInited) { _loadPOs(); return; }
  _poTabInited = true;
  _poUser = await fetch('/api/auth/me').then(r => r.json()).catch(() => null);
  try {
    [_poCompanies, _poItems] = await Promise.all([
      api('/api/po/companies'), api('/api/po/items')
    ]);
    const sel = document.getElementById('poPane-company');
    if (sel) sel.innerHTML +=
      _poCompanies.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  } catch(e) {}
  _loadPOs();
}

/* ── Public namespace ──────────────────────────────────────────── */
window.POTab = { init: _initPOTab, load: _loadPOs, handleUpload: _handlePOUpload };

/* ══ Review panel helpers ══════════════════════════════════════════════════ */

function poItemOptions(sel) {
  if (!_poItems || !_poItems.length) return '<option value="">— No items synced —</option>';
  return `<option value="">— Item —</option>` +
    _poItems.map(i =>
      `<option value="${esc(i.item_code)}" ${i.item_code === sel ? 'selected' : ''}>${esc(i.item_code)}${i.description ? ' — ' + esc(i.description) : ''}</option>`
    ).join('');
}

function poCompanyOptions(sel) {
  return `<option value="">— Select company —</option>` +
    _poCompanies.map(c =>
      `<option value="${c.id}" ${c.id == sel ? 'selected' : ''}>${esc(c.name)}</option>`
    ).join('');
}

/* ── Create ────────────────────────────────────────────────────── */

function openPONew() {
  _po = null; window._poMode = true;
  _poNewLines = [{ item_code: '', qty: '', price: '' }];
  const panel = document.getElementById('reviewPanel');
  panel.classList.add('open');
  panel.classList.remove('rv-wide-layout');
  document.getElementById('rvDocNo').textContent = 'New Purchase Order';
  const st = document.getElementById('rvStatus');
  st.textContent = 'draft'; st.className = 'rv-status pending';
  document.getElementById('mobilePdfLink').style.display = 'none';
  syncLeftDocumentViewer(null);

  document.getElementById('rvBody').innerHTML = `
    <div class="rv-field">
      <label>PO Number <span class="req">*</span></label>
      <input id="po_number" placeholder="e.g. PO-2024-001">
    </div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:12px;">
      <input type="checkbox" id="po_gen" onchange="poToggleGen()"> Auto-generate (SYS-XXX)
    </label>
    <div class="rv-field">
      <label>Company <span class="req">*</span></label>
      <select id="po_company" onchange="poLoadContacts(this.value)" style="width:100%;font-family:var(--font);font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:7px 10px;">${poCompanyOptions()}</select>
    </div>
    <div class="rv-field">
      <label>Contact (optional)</label>
      <select id="po_contact" style="width:100%;font-family:var(--font);font-size:13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:7px 10px;">
        <option value="">— Select contact —</option>
      </select>
    </div>
    <div class="rv-grid">
      <div class="rv-field"><label>Order Date</label><input type="date" id="po_order_date"></div>
      <div class="rv-field"><label>Expected Dispatch</label><input type="date" id="po_exp_dispatch"></div>
    </div>
    <div class="rv-field"><label>Notes</label><input id="po_notes" placeholder="Any remarks"></div>
    <div class="rv-section-label">Line items</div>
    <div class="po-item-row head"><span>Item</span><span>Qty</span><span>Unit ₹</span><span></span></div>
    <div id="poNewLines"></div>
    <button class="rv-line-add" onclick="poAddLine()">+ Add item</button>`;

  poRenderNewLines();
  document.getElementById('rvFoot').innerHTML =
    `<button class="rv-btn-save" onclick="closeReview()">Cancel</button>
     <button class="rv-btn-approve" onclick="poCreate()">Create PO</button>`;
}

function poToggleGen() {
  const gen = document.getElementById('po_gen').checked;
  const inp = document.getElementById('po_number');
  inp.disabled = gen; if (gen) inp.value = '';
  inp.placeholder = gen ? 'Auto SYS-XXX' : 'e.g. PO-2024-001';
}

async function poLoadContacts(companyId) {
  const el = document.getElementById('po_contact');
  if (!el) return;
  el.innerHTML = '<option value="">— Select contact —</option>';
  if (!companyId) return;
  try {
    const contacts = await api(`/api/clients?company_id=${companyId}`);
    el.innerHTML += contacts.map(c => `<option value="${c.id}">${esc(c.poc_name)}</option>`).join('');
  } catch(e) {}
}

function poRenderNewLines() {
  document.getElementById('poNewLines').innerHTML = _poNewLines.map((l, i) => `
    <div class="po-item-row">
      <select onchange="_poNewLines[${i}].item_code=this.value">${poItemOptions(l.item_code)}</select>
      <input type="number" min="1" placeholder="Qty" value="${esc(l.qty)}" oninput="_poNewLines[${i}].qty=this.value">
      <input type="number" step="0.01" placeholder="₹" value="${esc(l.price)}" oninput="_poNewLines[${i}].price=this.value">
      <button class="x" onclick="poDelLine(${i})">✕</button>
    </div>`).join('');
}

function poAddLine() { _poNewLines.push({ item_code: '', qty: '', price: '' }); poRenderNewLines(); }
function poDelLine(i) { _poNewLines.splice(i, 1); poRenderNewLines(); }

async function poCreate() {
  const gen = document.getElementById('po_gen').checked;
  const company_id = document.getElementById('po_company').value;
  if (!company_id) return showToast('Select a company', 'error');
  const po_number = document.getElementById('po_number').value.trim();
  if (!gen && !po_number) return showToast('Enter a PO number or auto-generate', 'error');
  const items = _poNewLines
    .filter(l => l.item_code && parseInt(l.qty) > 0)
    .map(l => ({ item_code: l.item_code, quantity_ordered: parseInt(l.qty), unit_price: parseFloat(l.price) || null }));
  try {
    const r = await api('/api/po', { method: 'POST', body: {
      generate_number: gen,
      po_number: gen ? undefined : po_number,
      company_id: parseInt(company_id),
      contact_id: parseInt(document.getElementById('po_contact').value) || null,
      order_date: document.getElementById('po_order_date').value || null,
      expected_dispatch_date: document.getElementById('po_exp_dispatch').value || null,
      notes: document.getElementById('po_notes').value.trim() || null,
      items
    }});
    showToast(`${r.po_number} created`);
    closeReview();
    setTab('po'); // land on the PO tab to see the new record
  } catch(e) {}
}

/* ── View / Edit ───────────────────────────────────────────────── */

async function openPO(id) {
  window._poMode = true;
  const panel = document.getElementById('reviewPanel');
  panel.classList.add('open');
  panel.classList.remove('rv-wide-layout');
  document.getElementById('rvBody').innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Loading…</div>';
  document.getElementById('rvFoot').innerHTML = '';
  try {
    if (!_poItems || !_poItems.length) {
      try { _poItems = await api('/api/po/items'); } catch(e) { _poItems = []; }
    }
    const po = await api(`/api/po/${id}`);
    _po = po; _poEditable = ['draft', 'confirmed'].includes(po.status);

    const mobLink = document.getElementById('mobilePdfLink');
    if (po.file_url) {
      mobLink.href = po.file_url; mobLink.style.display = 'inline-block';
      syncLeftDocumentViewer(po.file_url);
    } else {
      mobLink.href = '#'; mobLink.style.display = 'none';
      syncLeftDocumentViewer(null);
    }

    document.getElementById('rvDocNo').innerHTML =
      esc(po.po_number) + (po.po_source === 'system' ? ' <span class="po-source-tag">SYS</span>' : '');
    const st = document.getElementById('rvStatus'); st.textContent = po.status;
    st.className = 'rv-status ' + (
      po.status === 'draft'      ? 'pending'  :
      po.status === 'confirmed'  ? 'pushed'   :
      po.status === 'dispatched' ? 'approved' : 'rejected');

    const dis = _poEditable ? '' : 'disabled';
    document.getElementById('rvBody').innerHTML = `
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:14px;">${esc(po.company_name || '')}${po.poc_name ? ' · ' + esc(po.poc_name) : ''}</div>
      <div class="rv-grid">
        <div class="rv-field"><label>Order Date</label><input type="date" id="po_order_date" value="${po.order_date || ''}" ${dis}></div>
        <div class="rv-field"><label>Expected Dispatch</label><input type="date" id="po_exp_dispatch" value="${po.expected_dispatch_date || ''}" ${dis}></div>
      </div>
      ${po.dispatch_date ? `<div class="rv-field"><label>Dispatched On</label><input value="${formatDate(po.dispatch_date)}" disabled></div>` : ''}
      <div class="rv-field"><label>Notes</label><input id="po_notes" value="${esc(po.notes || '')}" ${dis}></div>
      ${po.items.some(i => !i.item_code) ? `
        <div class="po-existing-item" style="border-color:var(--warning);margin-bottom:8px;">
          <div>
            <div class="code" style="color:var(--warning);">${po.items.filter(i => !i.item_code).length} line(s) need an item</div>
            <div class="desc">Imported lines without a matched item — assign one below.</div>
          </div>
        </div>` : ''}
      <div class="rv-section-label">Line items (${po.items.length})</div>
      <div id="poExistingItems">
        ${po.items.length ? po.items.map(i => poItemRow(po.id, i)).join('') : '<div style="color:var(--text-muted);font-size:12px;">No items yet</div>'}
      </div>
      ${_poEditable ? `
        <div class="po-item-row" style="margin-top:8px;">
          <select id="po_add_item">${poItemOptions('')}</select>
          <input type="number" id="po_add_qty" min="1" placeholder="Qty">
          <input type="number" id="po_add_price" step="0.01" placeholder="₹">
          <button class="x" style="color:var(--primary);font-size:18px;" onclick="poAddItem(${po.id})">+</button>
        </div>` : ''}
      <div class="po-existing-item" style="margin-top:14px;">
        <div class="desc">Outward dispatches linked</div>
        <span style="font-size:18px;font-weight:800;">${po.outward_count}</span>
      </div>`;

    const foot    = document.getElementById('rvFoot');
    const canCancel = _poUser && ['admin', 'manager'].includes(_poUser.role)
      && po.status !== 'dispatched' && po.status !== 'cancelled';
    let btns = '';
    if (po.status === 'draft') {
      btns = `<button class="rv-btn-save" onclick="poSave(${po.id})">Save</button>
              <button class="rv-btn-confirm" onclick="poConfirm(${po.id})">Confirm PO</button>`;
    } else if (po.status === 'confirmed') {
      btns = `<button class="rv-btn-save" onclick="poSave(${po.id})">Save</button>
              <button class="rv-btn-dispatch" onclick="poDispatch(${po.id})">Mark Dispatched</button>`;
    } else {
      btns = `<button class="rv-btn-save" onclick="closeReview()">Close (${esc(po.status)})</button>`;
    }
    if (canCancel) btns = `<button class="rv-btn-reject" onclick="poCancel(${po.id})">Cancel</button>` + btns;
    foot.innerHTML = btns;
  } catch(e) {
    document.getElementById('rvBody').innerHTML = '<div style="color:var(--danger)">Failed to load.</div>';
  }
}

function poItemRow(poId, i) {
  const qtyPrice = `× ${i.quantity_ordered}${i.unit_price ? ' · ₹' + i.unit_price : ''}`;
  const removeBtn = _poEditable
    ? `<button class="x" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:4px;display:inline-flex;align-items:center;" onclick="poRemoveItem(${poId},${i.id})">✕</button>`
    : '';
  if (i.item_code) {
    return `
      <div class="po-existing-item" style="flex-direction:column;gap:8px;padding:12px;align-items:stretch;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="min-width:0;">
            <div class="code" style="color:var(--primary);font-size:12px;">${esc(i.item_code)}</div>
            <div class="desc" style="margin-top:4px;line-height:1.4;word-break:break-word;">${esc(i.description || '—')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
            <span style="font-size:12px;font-weight:700;white-space:nowrap;">${qtyPrice}</span>
            ${removeBtn}
          </div>
        </div>
      </div>`;
  }
  const picker = _poEditable
    ? `<select onchange="poAssignItem(${poId},${i.id},this.value)" style="font-family:var(--font);font-size:12px;background:var(--surface);border:1px solid var(--warning);border-radius:var(--radius);color:var(--text);padding:7px 28px 7px 10px;width:100%;box-sizing:border-box;">${poItemOptions('')}</select>`
    : '';
  return `
    <div class="po-existing-item" style="border-color:var(--warning);flex-direction:column;gap:10px;padding:12px;align-items:stretch;background:color-mix(in srgb,var(--warning) 3%,var(--surface));margin-bottom:8px;">
      <div style="min-width:0;">
        <div class="code" style="color:var(--warning);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;">Needs Item Assignment</div>
        <div class="desc" style="margin-top:4px;line-height:1.4;word-break:break-word;font-weight:500;">${esc(i.notes || i.description || '—')}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border-top:1px dashed color-mix(in srgb,var(--warning) 20%,var(--border));padding-top:8px;">
        <div style="position:relative;width:100%;">${picker}</div>
        <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <span style="font-size:12px;font-weight:700;white-space:nowrap;">${qtyPrice}</span>
          ${removeBtn}
        </div>
      </div>
    </div>`;
}

async function poAssignItem(poId, itemId, itemCode) {
  if (!itemCode) return;
  try {
    await api(`/api/po/${poId}/items/${itemId}`, { method: 'PATCH', body: { item_code: itemCode } });
    showToast('Item assigned'); openPO(poId);
  } catch(e) {}
}

async function poSave(id) {
  try {
    await api(`/api/po/${id}`, { method: 'PATCH', body: {
      order_date: document.getElementById('po_order_date').value || null,
      expected_dispatch_date: document.getElementById('po_exp_dispatch').value || null,
      notes: document.getElementById('po_notes').value.trim() || null
    }});
    showToast('Saved'); openPO(id); _loadPOs();
  } catch(e) {}
}

async function poAddItem(id) {
  const item_code = document.getElementById('po_add_item').value;
  const qty       = parseInt(document.getElementById('po_add_qty').value);
  if (!item_code || !qty) return showToast('Select item and quantity', 'error');
  try {
    await api(`/api/po/${id}/items`, { method: 'POST', body: {
      item_code, quantity_ordered: qty,
      unit_price: parseFloat(document.getElementById('po_add_price').value) || null
    }});
    showToast('Item added'); openPO(id);
  } catch(e) {}
}

async function poRemoveItem(id, itemId) {
  try { await api(`/api/po/${id}/items/${itemId}`, { method: 'DELETE' }); showToast('Item removed'); openPO(id); } catch(e) {}
}

async function poConfirm(id) {
  try { await api(`/api/po/${id}/confirm`, { method: 'POST' }); showToast('PO confirmed'); openPO(id); _loadPOs(); } catch(e) {}
}

async function poDispatch(id) {
  const date = document.getElementById('po_exp_dispatch').value;
  if (!date) return showToast('Set a dispatch date first', 'error');
  try { await api(`/api/po/${id}/dispatch`, { method: 'POST', body: { dispatch_date: date } }); showToast('PO dispatched'); closeReview(); _loadPOs(); } catch(e) {}
}

async function poCancel(id) {
  if (!confirm('Cancel this PO? This cannot be undone.')) return;
  try { await api(`/api/po/${id}/cancel`, { method: 'POST' }); showToast('PO cancelled'); closeReview(); _loadPOs(); } catch(e) {}
}