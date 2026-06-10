// public/js/tabs/tab-po.js
// Purchase Orders tab — lifecycle, intelligence, CRUD.
// Depends on: app.js (esc, api, formatDate, showToast, PaginatedTable)
// Shared from docs.html: syncLeftDocumentViewer, startProcessing, closeReview, setTab, openReview

/* ── State ─────────────────────────────────────────────────────── */
const PO_STATUS = {
  draft: 'Draft', confirmed: 'Confirmed',
  dispatched: 'Dispatched', cancelled: 'Cancelled'
};

let _po              = null;
let _poNewLines      = [];
let _poCompanies     = [];
let _poItems         = [];
let _poUser          = null;
let _poEditable      = false;
let _poTabInited     = false;
let _poAllRows       = [];
let _poFilter        = 'all';
let _poSearch        = '';
let _poCompanyFilter = '';

let _cdItems = [];
let _openCd  = null;

/* ── Date helpers ──────────────────────────────────────────────── */
// Own formatter — avoids Invalid Date from app.js on raw "YYYY-MM-DD" strings
function _fmtDate(d) {
  if (!d) return '—';
  try {
    const p = String(d).split('-');
    if (p.length === 3) {
      const m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return `${parseInt(p[2])} ${m[parseInt(p[1])-1]} ${p[0]}`;
    }
    return String(d);
  } catch(e) { return String(d || '—'); }
}

function _timelineChip(p) {
  const today = new Date();
  if (p.status === 'dispatched' && p.dispatch_date && p.order_date) {
    const cycle = Math.round((new Date(p.dispatch_date) - new Date(p.order_date)) / 86400000);
    return `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${cycle}d cycle</div>`;
  }
  if (p.status === 'confirmed' && p.expected_dispatch_date) {
    const diff = Math.round((new Date(p.expected_dispatch_date) - today) / 86400000);
    if (diff < 0)  return `<div style="font-size:10px;font-weight:700;color:var(--danger);margin-top:2px;">${Math.abs(diff)}d late</div>`;
    if (diff === 0) return `<div style="font-size:10px;font-weight:700;color:var(--danger);margin-top:2px;">due today</div>`;
    if (diff <= 3) return `<div style="font-size:10px;font-weight:700;color:var(--danger);margin-top:2px;">${diff}d left</div>`;
    if (diff <= 7) return `<div style="font-size:10px;font-weight:700;color:var(--warning);margin-top:2px;">${diff}d left</div>`;
    return `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${diff}d left</div>`;
  }
  return '';
}

/* ── Custom Dropdown ───────────────────────────────────────────── */
async function cdEnsureItems() {
  if (_cdItems.length) return;
  try { _cdItems = await api('/api/po/items'); _poItems = _cdItems; } catch(e) {}
}

function cdToggle(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  if (_openCd && _openCd !== id) cdClose(_openCd);
  const panel = wrap.querySelector('.cd-panel');
  if (panel.style.display !== 'none') { cdClose(id); return; }
  panel.innerHTML = `
    <input class="cd-search" placeholder="Search items…" autocomplete="off"
           oninput="cdFilter('${id}', this.value)">
    <div class="cd-list"></div>`;
  panel.style.display = 'block';
  wrap.querySelector('.cd-trigger').classList.add('open');
  _openCd = id;
  cdFilter(id, '');
  panel.querySelector('.cd-search').focus();
}

function cdClose(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const panel = wrap.querySelector('.cd-panel');
  if (panel) panel.style.display = 'none';
  const trigger = wrap.querySelector('.cd-trigger');
  if (trigger) trigger.classList.remove('open');
  if (_openCd === id) _openCd = null;
}

function cdFilter(id, q) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  const list = wrap.querySelector('.cd-list');
  if (!list) return;
  const current = wrap.dataset.value || '';
  const items = wrap._cdItems !== undefined ? wrap._cdItems : _cdItems;
  const ro = wrap._cdRenderOpt || (it => ({ value: it.item_code, primary: it.item_code, secondary: it.description || '' }));
  const filtered = q
    ? items.filter(it => { const o = ro(it); return (o.primary||'').toLowerCase().includes(q.toLowerCase()) || (o.secondary||'').toLowerCase().includes(q.toLowerCase()); })
    : items;
  list.innerHTML = filtered.slice(0, 60).map(it => {
    const o = ro(it);
    return `
      <div class="cd-opt ${String(o.value ?? '') === current ? 'cd-active' : ''}"
           data-code="${esc(String(o.value ?? ''))}"
           onmousedown="cdSelect('${id}', this.dataset.code)">
        <span class="cd-code">${esc(o.primary || '')}</span>
        ${o.secondary ? `<span class="cd-desc">${esc(o.secondary)}</span>` : ''}
      </div>`;
  }).join('')
  || `<div style="padding:10px;font-size:12px;color:var(--text-muted);">No items found</div>`;
}

function cdSelect(id, value) {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  wrap.dataset.value = value;
  const items = wrap._cdItems !== undefined ? wrap._cdItems : _cdItems;
  const ro = wrap._cdRenderOpt || (it => ({ value: it.item_code, primary: it.item_code, secondary: it.description || '' }));
  const found = items.find(it => String(ro(it).value ?? '') === String(value ?? ''));
  wrap.querySelector('.cd-value').textContent = found ? ro(found).primary : (value || wrap.dataset.placeholder || '— Select item —');
  cdClose(id);
  if (wrap._cdOnSelect) { wrap._cdOnSelect(value, found); return; }
  const poId   = parseInt(wrap.dataset.poId);
  const lineId = parseInt(wrap.dataset.lineId);
  if (poId && lineId) poSaveLineField(poId, lineId, 'item_code', value || null);
}

function cdMount(id, items, renderOpt, onSelect, placeholder = '— Select —') {
  const wrap = document.getElementById(id);
  if (!wrap) return;
  wrap._cdItems     = items;
  wrap._cdRenderOpt = renderOpt;
  wrap._cdOnSelect  = onSelect;
  wrap.dataset.placeholder = placeholder;
}

document.addEventListener('click', e => {
  if (_openCd && !e.target.closest(`#${_openCd}`)) cdClose(_openCd);
});

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
    { label: 'Company', render: p => `
        <div style="font-size:12.5px;font-weight:600;">${esc(p.company_name||'—')}</div>
        ${p.poc_name ? `<div style="font-size:10px;color:var(--text-muted);margin-top:1px;">${esc(p.poc_name)}</div>` : ''}
    `},
    { label: 'Status', render: p => {
        const today   = new Date().toISOString().slice(0, 10);
        const overdue = p.status === 'confirmed' && p.expected_dispatch_date && p.expected_dispatch_date < today;
        const partial = p.status === 'confirmed' && (p.outward_count||0) > 0;
        if (overdue) return `<span class="po-badge" style="background:color-mix(in srgb,var(--danger) 15%,transparent);color:var(--danger);">Overdue</span>`;
        if (partial) return `<span class="po-badge" style="background:color-mix(in srgb,var(--warning) 15%,transparent);color:var(--warning);">Partial</span>`;
        return `<span class="po-badge ${p.status}">${esc(PO_STATUS[p.status]||p.status)}</span>`;
    }},
    { label: 'Dispatch', render: p => {
        if (p.status === 'dispatched') {
          return `<div style="font-size:12px;">${_fmtDate(p.dispatch_date)}</div>
                  <div style="font-size:10px;color:var(--success);margin-top:2px;">dispatched</div>`;
        }
        if (!p.expected_dispatch_date || p.status === 'cancelled')
          return '<span style="color:var(--text-muted);font-size:11px;">—</span>';
        const late = p.status === 'confirmed' && p.expected_dispatch_date < new Date().toISOString().slice(0,10);
        return `<div style="font-size:12px;${late?'color:var(--danger);font-weight:700;':''}">${_fmtDate(p.expected_dispatch_date)}</div>${_timelineChip(p)}`;
    }},
    { label: 'Items / Shipped', render: p => {
        const items    = p.item_count    != null ? p.item_count    : null;
        const shipped  = p.outward_count != null ? p.outward_count : null;
        if (items == null && shipped == null) return '<span style="color:var(--text-muted);font-size:11px;">—</span>';
        return `
          ${items    != null ? `<div style="font-size:12px;font-weight:600;">${items} item${items!==1?'s':''}</div>` : ''}
          ${shipped  >  0    ? `<div style="font-size:10px;color:var(--success);margin-top:1px;">↑ ${shipped} reel${shipped!==1?'s':''} out</div>` : ''}`;
    }},
    { label: '', render: p => {
        let actionBtn = '';
        if (p.status === 'draft') {
          actionBtn = `<button onclick="event.stopPropagation();_poQuickConfirm(${p.id})"
            style="font-size:9.5px;font-weight:700;padding:4px 9px;background:color-mix(in srgb,var(--primary) 10%,var(--bg));color:var(--primary);border:1px solid color-mix(in srgb,var(--primary) 25%,transparent);border-radius:var(--radius);cursor:pointer;white-space:nowrap;"
            onmouseover="this.style.background='var(--primary)';this.style.color='#fff';"
            onmouseout="this.style.background='color-mix(in srgb,var(--primary) 10%,var(--bg))';this.style.color='var(--primary)';">
            Confirm
          </button>`;
        } else if (p.status === 'confirmed') {
          actionBtn = `<button onclick="event.stopPropagation();_poQuickDispatch(${p.id})"
            style="font-size:9.5px;font-weight:700;padding:4px 9px;background:color-mix(in srgb,var(--success) 10%,var(--bg));color:var(--success);border:1px solid color-mix(in srgb,var(--success) 25%,transparent);border-radius:var(--radius);cursor:pointer;white-space:nowrap;"
            onmouseover="this.style.background='var(--success)';this.style.color='#fff';"
            onmouseout="this.style.background='color-mix(in srgb,var(--success) 10%,var(--bg))';this.style.color='var(--success)';">
            Dispatch
          </button>`;
        }
        return `<div style="display:flex;gap:6px;align-items:center;justify-content:flex-end;">
          ${actionBtn}
          <button class="trash-btn" title="Delete" onclick="event.stopPropagation();_poDeleteRow(${p.id})">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="color:var(--danger)">
              <path fill-rule="evenodd" d="M16.5 4.478v.227a48.816 48.816 0 0 1 3.878.512.75.75 0 1 1-.256 1.478l-.209-.035-1.005 13.07a3 3 0 0 1-2.991 2.77H8.084a3 3 0 0 1-2.991-2.77L4.087 6.66l-.209.035a.75.75 0 0 1-.256-1.478A48.567 48.567 0 0 1 7.5 4.705v-.227c0-1.564 1.213-2.9 2.816-2.951a52.662 52.662 0 0 1 3.369 0c1.603.051 2.815 1.387 2.815 2.951Zm-6.136-1.452a51.196 51.196 0 0 1 3.273 0C14.39 3.05 15 3.684 15 4.478v.113a49.488 49.488 0 0 0-6 0v-.113c0-.794.609-1.428 1.364-1.452Zm-.355 5.945a.75.75 0 1 0-1.5.058l.347 9a.75.75 0 1 0 1.499-.058l-.346-9Zm5.48.058a.75.75 0 1 0-1.498-.058l-.347 9a.75.75 0 0 0 1.5.058l.345-9Z" clip-rule="evenodd"/>
            </svg>
          </button>
        </div>`;
    }}
  ]
});

/* ── Intelligence ──────────────────────────────────────────────── */
function _renderPOIntel(pos) {
  const box = document.getElementById('poPane-intel');
  if (!box) return;

  const today     = new Date().toISOString().slice(0, 10);
  const in7Days   = new Date(Date.now() + 7*24*60*60*1000).toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);

  const draft      = pos.filter(p => p.status === 'draft');
  const confirmed  = pos.filter(p => p.status === 'confirmed');
  const dispatched = pos.filter(p => p.status === 'dispatched');
  const overdue    = confirmed.filter(p => p.expected_dispatch_date && p.expected_dispatch_date < today);
  const dueSoon    = confirmed.filter(p =>
    p.expected_dispatch_date && p.expected_dispatch_date >= today && p.expected_dispatch_date <= in7Days);
  const recentDisp = dispatched.filter(p => p.dispatch_date && p.dispatch_date.startsWith(thisMonth));

  // Partial dispatch: confirmed POs that already have outward records but aren't closed yet
  const partial = confirmed.filter(p => (p.outward_count||0) > 0);

  // Stale drafts: created more than 5 days ago, still not confirmed
  const stale = draft.filter(p => {
    if (!p.created_at) return false;
    return Math.round((new Date() - new Date(p.created_at)) / 86400000) > 5;
  });

  // On-time rate
  const onTime     = dispatched.filter(p =>
    p.dispatch_date && p.expected_dispatch_date && p.dispatch_date <= p.expected_dispatch_date);
  const onTimeRate = dispatched.length ? Math.round((onTime.length / dispatched.length) * 100) : null;

  // Upcoming: overdue first, then due soon
  const upcoming = [...overdue, ...dueSoon.filter(p => !overdue.includes(p))]
    .sort((a,b) => new Date(a.expected_dispatch_date) - new Date(b.expected_dispatch_date))
    .slice(0, 6);

  // Active pipeline by company (supplier concentration)
  const active    = pos.filter(p => ['draft','confirmed'].includes(p.status));
  const byCompany = {};
  for (const p of active) { const c = p.company_name||'—'; byCompany[c] = (byCompany[c]||0) + 1; }
  const topCos   = Object.entries(byCompany).sort((a,b) => b[1]-a[1]).slice(0, 5);
  const maxCo    = Math.max(1, ...topCos.map(([,n]) => n));
  const topShare = topCos.length && active.length ? Math.round((topCos[0][1]/active.length)*100) : 0;

  box.style.cssText = 'display:block;margin-bottom:20px;';
  box.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px;">

      <div class="tab-stat" style="margin:0;">
        <div class="ts-value">${draft.length}</div>
        <div class="ts-label">Draft</div>
        <div class="ts-sub">${stale.length
          ? `<span style="color:var(--warning);">${stale.length} stale (&gt;5d)</span>`
          : 'pending confirmation'}</div>
      </div>

      <div class="tab-stat" style="margin:0;">
        <div class="ts-value" style="color:var(--primary)">${confirmed.length}</div>
        <div class="ts-label">Confirmed</div>
        <div class="ts-sub">${overdue.length
          ? `<span style="color:var(--danger);font-weight:700;">${overdue.length} overdue</span>`
          : partial.length
          ? `<span style="color:var(--warning);">${partial.length} partially dispatched</span>`
          : 'in pipeline'}</div>
      </div>

      <div class="tab-stat" style="margin:0;${overdue.length
          ? 'border-color:color-mix(in srgb,var(--danger) 35%,var(--border));background:color-mix(in srgb,var(--danger) 3%,var(--surface));' : ''}">
        <div class="ts-value" style="color:${overdue.length ? 'var(--danger)' : 'var(--success)'}">${overdue.length}</div>
        <div class="ts-label">Overdue</div>
        <div class="ts-sub" style="color:${overdue.length?'var(--danger)':'var(--success)'};">${overdue.length ? 'dispatch now' : 'all on track'}</div>
      </div>

      <div class="tab-stat" style="margin:0;${dueSoon.length ? 'border-color:color-mix(in srgb,var(--warning) 35%,var(--border));' : ''}">
        <div class="ts-value" style="color:${dueSoon.length ? 'var(--warning)' : 'var(--text)'}">${dueSoon.length}</div>
        <div class="ts-label">Due This Week</div>
        <div class="ts-sub">${onTimeRate !== null
          ? `${onTimeRate}% on-time (${dispatched.length} total)`
          : `${recentDisp.length} dispatched this month`}</div>
      </div>

    </div>

    <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px;">

      <div class="tab-stat" style="margin:0;padding:14px 16px;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:${upcoming.length||partial.length ? '10px' : '4px'};">
          ${overdue.length ? `⚠ ${overdue.length} Need${overdue.length>1?'':'s'} Dispatch`
            : dueSoon.length ? 'Due This Week' : 'Upcoming Dispatch'}
        </div>
        ${upcoming.map(p => {
          const diff  = Math.round((new Date(p.expected_dispatch_date) - new Date()) / 86400000);
          const color = diff < 0 || diff === 0 ? 'var(--danger)' : diff <= 3 ? 'var(--danger)' : 'var(--warning)';
          const label = diff < 0 ? `${Math.abs(diff)}d late` : diff === 0 ? 'today' : `${diff}d left`;
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border);">
              <div style="flex:1;min-width:0;">
                <span style="font-size:12px;font-weight:700;color:var(--primary);cursor:pointer;" onclick="openPO(${p.id})">${esc(p.po_number)}</span>
                <span style="font-size:10px;color:var(--text-muted);margin-left:6px;">${esc(p.company_name||'')}</span>
              </div>
              <span style="font-size:10px;font-weight:700;color:${color};white-space:nowrap;">${label}</span>
              <button onclick="event.stopPropagation();_poQuickDispatch(${p.id})"
                style="font-size:9px;font-weight:700;padding:3px 7px;background:none;color:var(--success);border:1px solid var(--success);border-radius:4px;cursor:pointer;flex-shrink:0;letter-spacing:0.3px;text-transform:uppercase;">
                Dispatch
              </button>
            </div>`; }).join('')}
        ${partial.length ? `
          <div style="margin-top:${upcoming.length?'10px':'0'};${upcoming.length?'padding-top:10px;border-top:1px solid var(--border);':''}">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--warning);margin-bottom:6px;">Partial Dispatch — verify &amp; close</div>
            ${partial.filter(p => !upcoming.find(u => u.id === p.id)).slice(0,3).map(p => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;">
                <span style="font-size:12px;font-weight:700;color:var(--primary);cursor:pointer;" onclick="openPO(${p.id})">${esc(p.po_number)}</span>
                <span style="font-size:10px;color:var(--warning);">${p.outward_count} reel${p.outward_count!==1?'s':''} out</span>
              </div>`).join('')}
          </div>` : ''}
        ${!upcoming.length && !partial.length ? `<div style="font-size:12px;color:var(--text-muted);">${
          confirmed.length ? 'All confirmed POs on schedule.' : 'No confirmed POs in pipeline.'}</div>` : ''}
      </div>

      <div class="tab-stat" style="margin:0;padding:14px 16px;">
        <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:${topCos.length?'10px':'4px'};">
          Active Pipeline
        </div>
        ${topCos.map(([name, count]) => `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <div style="font-size:9.5px;color:var(--primary);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;"
                 title="${esc(name)}" onclick="_poFilterByCompany('${esc(name).replace(/'/g,"\\'")}')">
              ${esc(name)}
            </div>
            <div style="flex:1;height:7px;background:var(--bg);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${Math.round((count/maxCo)*100)}%;background:var(--primary);border-radius:3px;"></div>
            </div>
            <div style="font-size:10px;font-weight:700;color:var(--text);width:14px;text-align:right;">${count}</div>
          </div>`).join('') || `<div style="font-size:12px;color:var(--text-muted);">No active POs.</div>`}
        ${topShare >= 80 && active.length >= 2 ? `
          <div style="margin-top:8px;font-size:9px;color:var(--warning);font-weight:600;">⚠ ${topShare}% from one supplier</div>` : ''}
        ${onTimeRate !== null && dispatched.length > 0 ? `
          <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">On-time rate</span>
            <span style="font-size:15px;font-weight:800;color:${onTimeRate>=80?'var(--success)':onTimeRate>=50?'var(--warning)':'var(--danger)'};">${onTimeRate}%</span>
          </div>` : ''}
      </div>

    </div>`;
}

/* ── Toolbar injection ─────────────────────────────────────────── */
function _injectPOToolbar() {
  const tableContainer = document.getElementById('poPane-table');
  if (!tableContainer || document.getElementById('poCustomToolbar')) return;
  document.querySelector('#pane-po .tab-toolbar')?.style.setProperty('display', 'none');

  const wrapper = document.createElement('div');
  wrapper.id = 'poCustomToolbar';
  wrapper.style.cssText = 'margin-bottom:12px;';
  wrapper.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;">
      <!-- Left: Create + Upload -->
      <button onclick="POTab.openNew()"
        style="flex-shrink:0;font-size:12px;font-weight:700;padding:7px 13px;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:var(--radius);cursor:pointer;white-space:nowrap;">
        + Create
      </button>
      <label style="flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:7px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);cursor:pointer;white-space:nowrap;">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/>
        </svg>
        Upload
        <input type="file" id="poFileInputNew" accept="application/pdf" style="display:none"
               onchange="POTab.handleUpload(this.files)">
      </label>

      <!-- Center: Search -->
      <div style="flex:1;position:relative;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--text-muted);display:flex;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/>
          </svg>
        </span>
        <input id="poSearchInput" placeholder="Search PO number or company…"
               style="width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:7px 10px 7px 34px;font-size:12px;font-family:var(--font);"
               oninput="POTab.handleSearch(this.value)">
      </div>

      <!-- Right: Filters -->
      <button id="poFilterBtn" onclick="_togglePOFilters()"
        style="flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:7px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);cursor:pointer;white-space:nowrap;transition:background 0.15s,border-color 0.15s;">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z"/>
        </svg>
        Filters
        <span id="poFilterCount" style="display:none;background:var(--primary);color:#fff;font-size:9px;font-weight:800;padding:1px 5px;border-radius:10px;min-width:14px;text-align:center;"></span>
      </button>
    </div>

    <!-- Filter panel -->
    <div id="poFilterPanel" style="display:none;margin-top:8px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);">
      <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;">
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;">Company</div>
          <select id="poCompanySelect"
            onchange="_poCompanyFilter=this.value;_updateFilterCount();_applyPOFilter();"
            style="font-family:var(--font);font-size:12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);padding:6px 10px;min-width:180px;">
            <option value="">All companies</option>
            ${_poCompanies.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;">Stage</div>
          <div class="doc-filters" id="poStageFilters" style="margin:0;">
            <button class="doc-filter active" data-stage="all"        onclick="POTab.setFilter('all')">All</button>
            <button class="doc-filter"        data-stage="draft"      onclick="POTab.setFilter('draft')">Draft</button>
            <button class="doc-filter"        data-stage="confirmed"  onclick="POTab.setFilter('confirmed')">Confirmed</button>
            <button class="doc-filter"        data-stage="overdue"    onclick="POTab.setFilter('overdue')">Overdue</button>
            <button class="doc-filter"        data-stage="dispatched" onclick="POTab.setFilter('dispatched')">Dispatched</button>
            <button class="doc-filter"        data-stage="cancelled"  onclick="POTab.setFilter('cancelled')">Cancelled</button>
          </div>
        </div>
      </div>
    </div>`;

  tableContainer.parentNode.insertBefore(wrapper, tableContainer);
}

function _togglePOFilters() {
  const panel = document.getElementById('poFilterPanel');
  const btn   = document.getElementById('poFilterBtn');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (btn) btn.style.background = open ? 'var(--bg)' : 'color-mix(in srgb,var(--primary) 10%,var(--bg))';
}

function _updateFilterCount() {
  const el = document.getElementById('poFilterCount');
  if (!el) return;
  const n = (_poFilter !== 'all' ? 1 : 0) + (_poCompanyFilter ? 1 : 0);
  el.textContent = n; el.style.display = n > 0 ? 'inline' : 'none';
}

/* ── Data pipeline ─────────────────────────────────────────────── */
async function _loadPOs() {
  try {
    _poAllRows = await api('/api/po');
    _renderPOIntel(_poAllRows);
    _injectPOToolbar();
    _applyPOFilter();
  } catch(e) { console.error('PO tab load failed:', e); }
}

function _applyPOFilter() {
  const today = new Date().toISOString().slice(0, 10);
  let rows = _poAllRows;

  if (_poFilter === 'overdue') {
    rows = rows.filter(p => p.status === 'confirmed' && p.expected_dispatch_date && p.expected_dispatch_date < today);
  } else if (_poFilter !== 'all') {
    rows = rows.filter(p => p.status === _poFilter);
  }

  if (_poCompanyFilter) rows = rows.filter(p => String(p.company_id) === String(_poCompanyFilter));

  if (_poSearch) {
    const q = _poSearch.toLowerCase();
    rows = rows.filter(p =>
      (p.po_number    && p.po_number.toLowerCase().includes(q)) ||
      (p.company_name && p.company_name.toLowerCase().includes(q)) ||
      (p.poc_name     && p.poc_name.toLowerCase().includes(q))
    );
  }

  poTable.load(rows);
}

function _setFilter(stage) {
  _poFilter = stage;
  document.querySelectorAll('#poStageFilters .doc-filter')
    .forEach(b => b.classList.toggle('active', b.dataset.stage === stage));
  _updateFilterCount();
  _applyPOFilter();
}

function _poFilterByCompany(companyName) {
  const company = _poCompanies.find(c => c.name === companyName);
  if (!company) return;
  _poCompanyFilter = String(company.id);
  const sel = document.getElementById('poCompanySelect');
  if (sel) sel.value = _poCompanyFilter;
  const panel = document.getElementById('poFilterPanel');
  if (panel && panel.style.display === 'none') _togglePOFilters();
  _setFilter('all');
}

/* ── Tab init ──────────────────────────────────────────────────── */
async function _initPOTab() {
  if (_poTabInited) { _loadPOs(); return; }
  _poTabInited = true;
  _poUser = await fetch('/api/auth/me').then(r => r.json()).catch(() => null);
  try {
    [_poCompanies, _poItems] = await Promise.all([api('/api/po/companies'), api('/api/po/items')]);
    _cdItems = _poItems;
  } catch(e) {}
  _loadPOs();
}

/* ── Quick actions ─────────────────────────────────────────────── */
async function _poQuickConfirm(id) {
  try {
    await api(`/api/po/${id}/confirm`, { method: 'POST' });
    showToast('PO confirmed');
    _loadPOs();
  } catch(e) { showToast(e.message || 'Failed to confirm', 'error'); }
}

async function _poQuickDispatch(id) {
  const today = new Date().toISOString().slice(0, 10);
  if (!confirm(`Mark as dispatched today (${today})?`)) return;
  try {
    await api(`/api/po/${id}/dispatch`, { method: 'POST', body: { dispatch_date: today } });
    showToast('PO dispatched');
    _loadPOs();
  } catch(e) { showToast(e.message || 'Failed to dispatch', 'error'); }
}

/* ── CREATE panel ──────────────────────────────────────────────── */
async function openPONew() {
  await cdEnsureItems();
  if (!_poCompanies.length) try { _poCompanies = await api('/api/po/companies'); } catch(e) {}
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
      <div id="cd_new_company" data-value="">
        <button class="cd-trigger" onclick="cdToggle('cd_new_company')">
          <span class="cd-value">— Select company —</span>
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="cd-panel" style="display:none;"></div>
      </div>
    </div>
    <div class="rv-field">
      <label>Contact (optional)</label>
      <div id="cd_new_contact" data-value="">
        <button class="cd-trigger" onclick="cdToggle('cd_new_contact')">
          <span class="cd-value">— Select contact —</span>
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="cd-panel" style="display:none;"></div>
      </div>
    </div>
    <div class="rv-grid">
      <div class="rv-field"><label>Order Date</label><input type="date" id="po_order_date"></div>
      <div class="rv-field"><label>Expected Dispatch</label><input type="date" id="po_exp_dispatch"></div>
    </div>
    <div class="rv-field"><label>Notes</label><input id="po_notes" placeholder="Any remarks"></div>
    <div class="rv-section-label">Line items</div>
    <div class="po-item-row head"><span>Item</span><span>Qty</span><span>Unit ₹</span><span></span></div>
    <div id="poNewLines"></div>
    <button class="rv-line-add" onclick="poNewLineAdd()">+ Add item</button>`;

  _poRenderNewLines();
  cdMount('cd_new_company', _poCompanies,
    c => ({ value: String(c.id), primary: c.name, secondary: '' }),
    async (val) => {
      const cw = document.getElementById('cd_new_contact');
      if (!cw) return;
      cw._cdItems = []; cw.dataset.value = '';
      cw.querySelector('.cd-value').textContent = '— Select contact —';
      if (!val) return;
      try {
        const contacts = await api(`/api/clients?company_id=${val}`);
        cdMount('cd_new_contact', contacts,
          c => ({ value: String(c.id), primary: c.poc_name, secondary: c.designation || '' }),
          null, '— Select contact —');
      } catch(e) {}
    },
    '— Select company —'
  );
  cdMount('cd_new_contact', [], null, null, '— Select contact —');
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

function _poRenderNewLines() {
  document.getElementById('poNewLines').innerHTML = _poNewLines.map((l, i) => `
    <div class="po-item-row">
      <div id="cd_nl_${i}" data-value="${esc(l.item_code||'')}" style="position:relative;">
        <button class="cd-trigger" onclick="cdToggle('cd_nl_${i}')">
          <span class="cd-value">${esc(l.item_code||'— Item —')}</span>
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="cd-panel" style="display:none;position:absolute;left:0;right:0;z-index:200;top:100%;"></div>
      </div>
      <input type="number" min="1" placeholder="Qty" value="${esc(l.qty)}" oninput="_poNewLines[${i}].qty=this.value">
      <input type="number" step="0.01" placeholder="₹" value="${esc(l.price)}" oninput="_poNewLines[${i}].price=this.value">
      <button class="x" onclick="poNewLineDel(${i})">✕</button>
    </div>`).join('');
  _poNewLines.forEach((l, i) => cdMount(`cd_nl_${i}`, _cdItems,
    it => ({ value: it.item_code, primary: it.item_code, secondary: it.description || '' }),
    val => { _poNewLines[i].item_code = val; },
    '— Item —'
  ));
}

function poNewLineAdd() { _poNewLines.push({ item_code:'', qty:'', price:'' }); _poRenderNewLines(); }
function poNewLineDel(i) { _poNewLines.splice(i, 1); _poRenderNewLines(); }

async function poCreate() {
  const gen        = document.getElementById('po_gen').checked;
  const company_id = document.getElementById('cd_new_company').dataset.value;
  if (!company_id) return showToast('Select a company', 'error');
  const po_number  = document.getElementById('po_number').value.trim();
  if (!gen && !po_number) return showToast('Enter a PO number or auto-generate', 'error');
  const items = _poNewLines
    .filter(l => l.item_code && parseInt(l.qty) > 0)
    .map(l => ({ item_code: l.item_code, quantity_ordered: parseInt(l.qty), unit_price: parseFloat(l.price) || null }));
  try {
    const r = await api('/api/po', { method: 'POST', body: {
      generate_number: gen,
      po_number: gen ? undefined : po_number,
      company_id: parseInt(company_id),
      contact_id: parseInt(document.getElementById('cd_new_contact').dataset.value) || null,
      order_date: document.getElementById('po_order_date').value || null,
      expected_dispatch_date: document.getElementById('po_exp_dispatch').value || null,
      notes: document.getElementById('po_notes').value.trim() || null,
      items
    }});
    showToast(`${r.po_number} created`);
    closeReview(); setTab('po'); _loadPOs();
  } catch(e) { showToast(e.message || 'Failed to create', 'error'); }
}

/* ── VIEW / EDIT panel ─────────────────────────────────────────── */
async function openPO(id) {
  window._poMode = true;
  const panel = document.getElementById('reviewPanel');
  panel.classList.add('open');
  panel.classList.remove('rv-wide-layout');
  document.getElementById('rvBody').innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Loading…</div>';
  document.getElementById('rvFoot').innerHTML = '';
  try {
    await cdEnsureItems();
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

    const sourceTag = po.po_source === 'upload' ? ' <span class="po-source-tag">IMPORTED</span>'
                    : po.po_source === 'system'  ? ' <span class="po-source-tag">SYS</span>' : '';
    document.getElementById('rvDocNo').innerHTML = esc(po.po_number) + sourceTag;

    const stMap = { draft:'pending', confirmed:'pushed', dispatched:'approved', cancelled:'rejected' };
    const st    = document.getElementById('rvStatus');
    st.textContent = po.status; st.className = `rv-status ${stMap[po.status] || 'pending'}`;

    const totalValue = (po.items||[]).reduce((s,i) => s + (i.quantity_ordered||0)*(i.unit_price||0), 0);

    // Outward records — grouped by invoice
    const outwardsHtml = (() => {
      const ow = po.outwards || [];
      if (!ow.length) return '';
      const byInv = {};
      for (const o of ow) {
        const key = o.invoice_number || '—';
        if (!byInv[key]) byInv[key] = { invoice_number: key, date: o.outward_date, reels: 0, pcs: 0 };
        byInv[key].reels++;
        byInv[key].pcs += o.quantity_shipped || 0;
      }
      const groups   = Object.values(byInv).sort((a,b) => new Date(b.date) - new Date(a.date));
      const totalPcs = ow.reduce((s,o) => s + (o.quantity_shipped||0), 0);
      return `<div class="rv-section-label">Dispatched — ${ow.length} reels · ${totalPcs.toLocaleString('en-IN')} pcs</div>` +
        groups.map(g => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;">
            <div>
              <div style="font-size:12px;font-weight:700;">Inv: ${esc(g.invoice_number)}</div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${g.reels} reel${g.reels!==1?'s':''} · ${_fmtDate(g.date)}</div>
            </div>
            <div style="font-size:13px;font-weight:800;color:var(--primary);">${g.pcs.toLocaleString('en-IN')} pcs</div>
          </div>`).join('');
    })();

    // Related invoices — matched by company name
    const relInvHtml = (() => {
      const ri = po.relatedInvoices || [];
      if (!ri.length) return '';
      const fmt       = v => v ? '₹' + Number(v).toLocaleString('en-IN', {minimumFractionDigits:2}) : '—';
      const typeLabel = { purchase_invoice:'Purchase', freight_invoice:'Freight', bill_of_entry:'BOE', bank_statement:'Bank' };
      return `<div class="rv-section-label">Invoices — ${esc(po.company_name)} (${ri.length})</div>` +
        ri.map(inv => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:6px;cursor:pointer;"
               onclick="closeReview();setTimeout(()=>openReview(${inv.id}),180)">
            <div>
              <div style="font-size:12px;font-weight:700;color:var(--primary);">${esc(inv.invoice_no||'—')}</div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${esc(typeLabel[inv.doc_type]||inv.doc_type)} · ${_fmtDate(inv.invoice_date)}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:12px;font-weight:700;">${fmt(inv.net_amount)}</div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${esc(inv.status)}</div>
            </div>
          </div>`).join('');
    })();

    document.getElementById('rvBody').innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;">
        <span>${esc(po.company_name||'')}${po.poc_name?' · '+esc(po.poc_name):''}</span>
        ${totalValue > 0 ? `<span style="font-weight:700;color:var(--text);font-size:13px;">₹${totalValue.toLocaleString('en-IN',{minimumFractionDigits:2})}</span>` : ''}
      </div>
      <div class="rv-grid" style="margin-bottom:14px;">
        <div class="rv-field"><label>Order Date</label><input type="date" id="po_order_date" value="${po.order_date||''}" ${_poEditable?'':'disabled'}></div>
        <div class="rv-field"><label>Expected Delivery</label><input type="date" id="po_exp_delivery" value="${po.expected_dispatch_date||''}" ${_poEditable?'':'disabled'}></div>
      </div>
      ${po.dispatch_date ? `<div class="rv-field"><label>Dispatched On</label><input value="${_fmtDate(po.dispatch_date)}" disabled></div>` : ''}
      ${po.notes ? `<div style="font-size:11px;padding:8px 10px;background:color-mix(in srgb,var(--warning) 8%,var(--surface));border:1px solid color-mix(in srgb,var(--warning) 25%,var(--border));border-radius:var(--radius);margin-bottom:14px;color:var(--text-muted);">${esc(po.notes)}</div>` : ''}
      <div class="rv-section-label">Line Items (${po.items.length})</div>
      <div id="poLineItems">${renderPOLines(po)}</div>
      ${_poEditable ? `<button class="rv-line-add" style="margin-top:8px;" onclick="poAddLine(${po.id})">+ Add line item</button>` : ''}
      ${outwardsHtml}
      ${relInvHtml}`;

    const foot      = document.getElementById('rvFoot');
    const canCancel = _poUser && ['admin','manager'].includes(_poUser.role)
      && !['dispatched','cancelled'].includes(po.status);
    let btns = '';
    if (po.status === 'draft') {
      btns = `<button class="rv-btn-save" onclick="poSaveHeader(${po.id})">Save</button>
              <button class="rv-btn-approve" onclick="poConfirm(${po.id})">Confirm PO</button>`;
    } else if (po.status === 'confirmed') {
      btns = `<button class="rv-btn-save" onclick="poSaveHeader(${po.id})">Save</button>
              <button class="rv-btn-dispatch" onclick="poDispatch(${po.id})">Mark Dispatched</button>`;
    } else {
      btns = `<button class="rv-btn-save" onclick="closeReview()">Close (${esc(po.status)})</button>`;
    }
    if (canCancel) btns = `<button class="rv-btn-reject" onclick="poCancel(${po.id})">Cancel</button>` + btns;
    foot.innerHTML = btns;
  } catch(e) {
    console.error('openPO failed:', e);
    document.getElementById('rvBody').innerHTML = '<div style="color:var(--danger)">Failed to load PO.</div>';
  }
}

/* ── Panel line rendering ──────────────────────────────────────── */
function renderPOLines(po) {
  if (!po.items.length) return '<div style="color:var(--text-muted);font-size:12px;padding:4px 0;">No line items yet.</div>';
  return po.items.map(item => {
    const cdId = `cd_po_${item.id}`;
    return `
      <div style="border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:8px;background:var(--bg);">
        ${!item.item_code ? `<div style="font-size:10px;font-weight:700;color:var(--warning);margin-bottom:6px;">⚠ Unassigned${item.notes?' — '+esc(item.notes):''}</div>` : ''}
        <div class="rv-field" style="margin-bottom:8px;">
          <label>Item</label>
          ${_poEditable ? `
            <div id="${cdId}" data-value="${esc(item.item_code||'')}" data-po-id="${po.id}" data-line-id="${item.id}">
              <button class="cd-trigger" onclick="cdToggle('${cdId}')">
                <span class="cd-value">${esc(item.item_code||'— Select item —')}</span>
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0;"><path stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6"/></svg>
              </button>
              <div class="cd-panel" style="display:none;"></div>
            </div>` : `<div style="font-size:13px;font-weight:700;color:var(--primary);">${esc(item.item_code||'—')}</div>`}
          ${item.description ? `<div style="font-size:10px;color:var(--text-muted);margin-top:3px;">${esc(item.description)}</div>` : ''}
        </div>
        <div class="rv-grid">
          <div class="rv-field">
            <label>Qty (NOS)</label>
            <input type="number" min="1" value="${item.quantity_ordered||''}" style="font-weight:700;"
                   ${_poEditable ? `onchange="poSaveLineField(${po.id},${item.id},'quantity_ordered',this.value)"` : 'disabled'}>
          </div>
          <div class="rv-field">
            <label>Unit Price (₹)</label>
            <input type="number" step="0.01" value="${item.unit_price!=null?item.unit_price:''}" placeholder="—"
                   ${_poEditable ? `onchange="poSaveLineField(${po.id},${item.id},'unit_price',this.value)"` : 'disabled'}>
          </div>
        </div>
        ${_poEditable ? `
          <div style="margin-top:6px;">
            <button class="rv-add-btn" style="border-style:solid;border-color:var(--danger);color:var(--danger);width:100%;"
                    onclick="poRemoveLine(${po.id},${item.id})">Remove</button>
          </div>` : ''}
      </div>`;
  }).join('');
}

async function poSaveLineField(poId, itemId, field, value) {
  try { await api(`/api/po/${poId}/items/${itemId}`, { method:'PATCH', body:{ [field]: value||null } }); }
  catch(e) { showToast('Save failed: '+(e.message||''), 'error'); }
}

async function poRemoveLine(poId, itemId) {
  try { await api(`/api/po/${poId}/items/${itemId}`, { method:'DELETE' }); openPO(poId); }
  catch(e) { showToast('Remove failed', 'error'); }
}

async function poAddLine(poId) {
  try { await api(`/api/po/${poId}/items`, { method:'POST', body:{ quantity_ordered:1 } }); openPO(poId); }
  catch(e) { showToast('Failed to add line', 'error'); }
}

async function poSaveHeader(poId) {
  try {
    await api(`/api/po/${poId}`, { method:'PATCH', body:{
      order_date: document.getElementById('po_order_date')?.value || null,
      expected_dispatch_date: document.getElementById('po_exp_delivery')?.value || null,
    }});
    showToast('Saved'); _loadPOs();
  } catch(e) { showToast('Save failed', 'error'); }
}

async function poConfirm(poId) {
  try { await api(`/api/po/${poId}/confirm`, { method:'POST' }); showToast('PO confirmed'); openPO(poId); _loadPOs(); }
  catch(e) { showToast(e.message||'Failed to confirm', 'error'); }
}

async function poDispatch(poId) {
  const date = document.getElementById('po_exp_delivery')?.value;
  if (!date) return showToast('Set a delivery date first', 'error');
  try { await api(`/api/po/${poId}/dispatch`, { method:'POST', body:{ dispatch_date:date } }); showToast('PO dispatched'); closeReview(); _loadPOs(); }
  catch(e) { showToast(e.message||'Failed to dispatch', 'error'); }
}

async function poCancel(id) {
  if (!confirm('Cancel this PO? This cannot be undone.')) return;
  try { await api(`/api/po/${id}/cancel`, { method:'POST' }); showToast('PO cancelled'); closeReview(); _loadPOs(); }
  catch(e) {}
}

/* ── Selectors for create form ─────────────────────────────────── */
function poItemOptions(sel) {
  if (!_poItems || !_poItems.length) return '<option value="">— No items synced —</option>';
  return `<option value="">— Item —</option>` +
    _poItems.map(i =>
      `<option value="${esc(i.item_code)}" ${i.item_code===sel?'selected':''}>${esc(i.item_code)}${i.description?' — '+esc(i.description):''}</option>`
    ).join('');
}

function poCompanyOptions(sel) {
  return `<option value="">— Select company —</option>` +
    _poCompanies.map(c =>
      `<option value="${c.id}" ${c.id==sel?'selected':''}>${esc(c.name)}</option>`
    ).join('');
}

/* ── Table row actions ─────────────────────────────────────────── */
async function _poDeleteRow(id) {
  if (!confirm('Delete this Purchase Order permanently?')) return;
  try { await api(`/api/po/${id}`, { method:'DELETE' }); showToast('Deleted'); _loadPOs(); }
  catch(e) { showToast(e.message || 'Delete failed — you may not have permission', 'error'); }
}

async function _handlePOUpload(files) {
  const file = files[0];
  const _fi = document.getElementById('poFileInputNew') || document.getElementById('poFileInput');
  if (_fi) _fi.value = '';
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('Only PDF files are supported', 'error'); return; }
  const fd = new FormData();
  fd.append('pdf', file);
  fd.append('hint_doc_type', 'purchase_order');
  try {
    const res  = await fetch('/api/invoices/upload', { method:'POST', body:fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    startProcessing(data.invoiceId, file.name, true);
  } catch(e) { console.error('[PO Upload] Upload request failed:', e); showToast(e.message || 'Upload failed', 'error'); }
}

/* ── Public namespace ──────────────────────────────────────────── */
window.POTab = {
  init:         _initPOTab,
  load:         _loadPOs,
  handleUpload: _handlePOUpload,
  openNew:      openPONew,
  setFilter:    _setFilter,
  handleSearch(val) { _poSearch = val.trim(); _applyPOFilter(); }
};