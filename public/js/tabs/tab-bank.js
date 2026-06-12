// public/js/tabs/tab-bank.js
// Bank Statements tab — sub-tabs per bank, account info card, sortable
// transaction table with date filter and search.
// Depends on: app.js (esc, api, formatDate, PaginatedTable)
// NOTE: openReview() in docs.html is intentionally NOT called here —
//       the sidebar review panel stays scoped to the All tab only.

let _bankTabInited  = false;
let _bankAllRows    = [];   // summary list from /api/invoices (no line_items)
let _bankStmtCache  = {};   // id → full invoice object with line_items
let _bankActiveBank = null;
let _bankActiveStmt = null; // currently selected statement id
let _bankSortCol    = 'date';
let _bankSortDir    = 'asc';
let _bankDateFrom   = '';
let _bankDateTo     = '';
let _bankTxSearch   = '';
let _bankReconByIdx = {};   // original line index → Tally match status (active statement)
let _bankReconCache = {};   // statement id → { byIdx, summary, bank_ledger }

/* ── Formatters ─────────────────────────────────────────────────── */
const _fmtMoney = v =>
  '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const _bankFmtDate = s => {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/* ── Intelligence KPI strip ─────────────────────────────────────── */
function _renderBankIntel(rows) {
  const box = document.getElementById('bankPane-intel');
  if (!box) return;

  const pending = rows.filter(d => d.status === 'pending').length;
  const pushed  = rows.filter(d => d.status === 'pushed').length;
  const errors  = rows.filter(d => ['extract_failed', 'push_failed'].includes(d.status)).length;
  const totalDr = rows.reduce((s, d) => s + (parseFloat(d.total_debit)  || 0), 0);
  const totalCr = rows.reduce((s, d) => s + (parseFloat(d.total_credit) || 0), 0);

  box.style.display = 'grid';
  box.style.gridTemplateColumns = 'repeat(auto-fit, minmax(180px, 1fr))';
  box.style.gap = '12px';
  box.style.width = '100%';
  
  box.innerHTML = `
    <div class="tab-stat" style="margin:0; min-height:85px;">
      <div class="ts-value">${rows.length}</div>
      <div class="ts-label">Statements</div>
    </div>
    <div class="tab-stat" style="margin:0; min-height:85px;">
      <div class="ts-value" style="color:var(--warning)">${pending}</div>
      <div class="ts-label">Pending Review</div>
    </div>
    <div class="tab-stat" style="margin:0; min-height:85px;">
      <div class="ts-value" style="color:var(--success)">${pushed}</div>
      <div class="ts-label">In Tally</div>
    </div>
    <div class="tab-stat" style="margin:0; min-height:85px; min-width:240px;">
      <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:6px;">Transaction Volume</div>
      <div style="display:flex;gap:16px;align-items:center;">
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--danger);">${_fmtMoney(totalDr)}</div>
          <div style="font-size:8px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-top:2px;">Total Dr</div>
        </div>
        <div style="border-left:1px solid var(--border);height:20px;"></div>
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--success);">${_fmtMoney(totalCr)}</div>
          <div style="font-size:8px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-top:2px;">Total Cr</div>
        </div>
      </div>
    </div>`;
}

/* ── Bank sub-tabs ──────────────────────────────────────────────── */
function _renderBankSubTabs() {
  const container = document.getElementById('bankSubTabs');
  if (!container) return;

  const banks = [...new Set(_bankAllRows.map(r => r.bank_ledger || 'Unassigned'))].sort();
  if (!_bankActiveBank || !banks.includes(_bankActiveBank)) _bankActiveBank = banks[0] || null;

  const tabsHtml = banks.map(b => {
    const cnt    = _bankAllRows.filter(r => (r.bank_ledger || 'Unassigned') === b).length;
    const active = b === _bankActiveBank;
    return `
      <button onclick="BankTab.selectBank(${JSON.stringify(b)})"
        style="background:none;border:none;
               border-bottom:2px solid ${active ? 'var(--primary)' : 'transparent'};
               color:${active ? 'var(--primary)' : 'var(--text-muted)'};
               cursor:pointer;font-family:var(--font);font-size:11px;font-weight:700;
               letter-spacing:0.5px;margin-bottom:-1px;padding:0 18px 12px;
               text-transform:uppercase;white-space:nowrap;
               transition:color 0.15s,border-color 0.15s;
               display:inline-flex;align-items:center;gap:6px;">
        ${esc(b)}
        <span style="background:${active ? 'var(--primary)' : 'var(--border)'};
                     color:${active ? '#fff' : 'var(--text-muted)'};
                     font-size:9px;font-weight:800;min-width:16px;height:16px;
                     border-radius:8px;padding:0 4px;
                     display:inline-flex;align-items:center;justify-content:center;">
          ${cnt}
        </span>
      </button>`;
  }).join('');

  container.innerHTML = `
    <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;
                border-bottom:1px solid var(--border);margin-bottom:20px;">
      <div style="display:flex;align-items:flex-end;flex:1;min-width:0;
                  overflow-x:auto;scrollbar-width:none;">
        ${tabsHtml}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;padding-bottom:8px;">
        <button onclick="BankTab.create()"
          style="font-size:12px;font-weight:700;padding:6px 13px;background:var(--primary);
                 color:#fff;border:1px solid var(--primary);border-radius:var(--radius);
                 cursor:pointer;white-space:nowrap;">
          + Create
        </button>
        <label style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;
                      padding:6px 13px;background:var(--bg);border:1px solid var(--border);
                      border-radius:var(--radius);color:var(--text);cursor:pointer;white-space:nowrap;
                      transition:border-color 0.15s,color 0.15s;"
               onmouseover="this.style.borderColor='var(--primary)';this.style.color='var(--primary)'"
               onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text)'">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/>
          </svg>
          Upload
          <input type="file" id="bankFileInput" accept="application/pdf" style="display:none"
                 onchange="BankTab.handleUpload(this.files)">
        </label>
      </div>
    </div>`;
}

/* ── Statement period dropdown (only when > 1 statement per bank) ─ */
function _renderStmtSelector(stmts) {
  if (stmts.length <= 1) return '';
  return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <label style="font-size:10px;font-weight:700;text-transform:uppercase;
                    letter-spacing:0.5px;color:var(--text-muted);white-space:nowrap;flex-shrink:0;">
        Statement Period
      </label>
      <select class="tab-select" onchange="BankTab.selectStmt(parseInt(this.value))"
              style="max-width:340px;">
        ${stmts.map(s => `
          <option value="${s.id}" ${s.id === _bankActiveStmt ? 'selected' : ''}>
            ${s.account_no ? s.account_no + ' · ' : ''}
            ${_fmtDate(s.statement_from)} → ${_fmtDate(s.statement_to)}
            ${s.status !== 'pushed' ? ' (' + esc(s.status) + ')' : ''}
          </option>`).join('')}
      </select>
    </div>`;
}

/* ── Account & Period info grid ─────────────────────────────────── */
function _renderAccountInfo(stmt) {
  if (!stmt) return '';

  // Effective period: user filter → tx-date bounds → statement header
  const lines = Array.isArray(stmt.line_items) ? stmt.line_items : [];
  const sortedTxDates = lines.map(l => l.date).filter(Boolean).sort();
  const effectiveFrom = _bankDateFrom || (sortedTxDates.length ? sortedTxDates[0] : stmt.statement_from);
  const effectiveTo   = _bankDateTo   || (sortedTxDates.length ? sortedTxDates[sortedTxDates.length - 1] : stmt.statement_to);

  const lblT = 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-bottom:2px;';
  const lblB = 'font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);margin-bottom:1px;';
  const num  = 'font-variant-numeric:tabular-nums;letter-spacing:-0.2px;';
  const rule = '<div style="width:1px;background:var(--border);height:24px;align-self:center;"></div>';

  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;
                padding:16px 20px;margin-bottom:20px;display:flex;flex-wrap:wrap;
                justify-content:space-between;gap:24px;align-items:center;box-shadow:var(--shadow);">

      <!-- Left: identity -->
      <div style="display:flex;flex-wrap:wrap;gap:24px;align-items:center;">
        <div>
          <div style="${lblT}">Account Number</div>
          <div style="font-size:14px;font-weight:700;color:var(--text);font-family:monospace;">${stmt.account_no || '—'}</div>
        </div>
        ${rule}
        <div>
          <div style="${lblT}">Statement Period</div>
          <div style="font-size:13px;font-weight:600;color:var(--text);">${_fmtDate(effectiveFrom)} — ${_fmtDate(effectiveTo)}</div>
        </div>
        ${rule}
        <div>
          <div style="${lblT}">Downloaded On</div>
          <div style="font-size:13px;font-weight:600;color:var(--text-muted);">${_fmtDate(stmt.invoice_date)}</div>
        </div>
      </div>

      <!-- Right: balances, grouped on one line with hairline dividers -->
      <div style="display:flex;flex-wrap:wrap;gap:20px;align-items:center;
                  background:var(--bg);padding:8px 18px;border-radius:8px;border:1px solid var(--border);">
        <div>
          <div style="${lblB}">Opening Bal</div>
          <div style="font-size:12.5px;font-weight:700;color:var(--text);${num}">${stmt.opening_balance != null ? _fmtMoney(stmt.opening_balance) : '—'}</div>
        </div>
        ${rule}
        <div>
          <div style="${lblB}">Closing Bal</div>
          <div style="font-size:12.5px;font-weight:700;color:var(--text);${num}">${stmt.closing_balance != null ? _fmtMoney(stmt.closing_balance) : '—'}</div>
        </div>
        ${rule}
        <div>
          <div style="${lblB}">Withdrawals</div>
          <div style="font-size:12.5px;font-weight:700;color:var(--danger);${num}">${stmt.total_debit != null ? _fmtMoney(stmt.total_debit) : '—'}</div>
        </div>
        ${rule}
        <div>
          <div style="${lblB}">Deposits</div>
          <div style="font-size:12.5px;font-weight:700;color:var(--success);${num}">${stmt.total_credit != null ? _fmtMoney(stmt.total_credit) : '—'}</div>
        </div>
      </div>
    </div>`;
}

/* ── Transaction toolbar: search + date range ───────────────────── */
function _renderTxToolbar() {
  const hasFilter = _bankDateFrom || _bankDateTo || _bankTxSearch;
  return `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">

      <div style="position:relative;flex:1;min-width:160px;max-width:280px;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);
                     pointer-events:none;color:var(--text-muted);display:flex;align-items:center;">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"/>
          </svg>
        </span>
        <input class="search-input" placeholder="Search description or note…"
               value="${esc(_bankTxSearch)}"
               oninput="BankTab.setSearch(this.value)"
               style="padding-left:34px;width:100%;box-sizing:border-box;">
      </div>

      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <label style="font-size:10px;font-weight:700;text-transform:uppercase;
                      letter-spacing:0.5px;color:var(--text-muted);">From</label>
        <input type="date" class="tab-select" value="${_bankDateFrom}"
               onchange="BankTab.setDateFrom(this.value)">
      </div>

      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <label style="font-size:10px;font-weight:700;text-transform:uppercase;
                      letter-spacing:0.5px;color:var(--text-muted);">To</label>
        <input type="date" class="tab-select" value="${_bankDateTo}"
               onchange="BankTab.setDateTo(this.value)">
      </div>

      <button onclick="bankSaveNotes()"
        style="margin-left:auto;background:var(--bg);border:1px solid var(--border);
               border-radius:var(--radius);color:var(--text-muted);font-family:var(--font);
               font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;
               padding:7px 14px;cursor:pointer;white-space:nowrap;
               display:inline-flex;align-items:center;gap:5px;transition:all 0.15s;"
        onmouseover="this.style.borderColor='var(--success)';this.style.color='var(--success)'"
        onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round"
            d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M17 21v-8H7v8M7 3v5h8"/>
        </svg>
        Save Notes
      </button>
      ${hasFilter ? `
        <button onclick="BankTab.clearFilters()"
          style="background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);
                 color:var(--text-muted);font-family:var(--font);font-size:11px;font-weight:700;
                 text-transform:uppercase;letter-spacing:0.4px;padding:7px 14px;cursor:pointer;
                 white-space:nowrap;transition:all 0.15s;"
          onmouseover="this.style.borderColor='var(--danger)';this.style.color='var(--danger)'"
          onmouseout="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)'">
          Clear
        </button>` : ''}
    </div>`;
}

/* ── Sortable column header ─────────────────────────────────────── */
function _th(col, label, align) {
  const active = _bankSortCol === col;
  const arrow  = active ? (_bankSortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const dimArr = active ? '' : '<span style="color:var(--border);font-size:10px;"> ↕</span>';
  return `
    <th onclick="BankTab.sort('${col}')"
        style="padding:10px;text-align:${align || 'left'};cursor:pointer;
               user-select:none;white-space:nowrap;">
      <span style="color:${active ? 'var(--primary)' : 'var(--text-muted)'};">
        ${label}${arrow}
      </span>${dimArr}
    </th>`;
}

/* ── Smart Description Parser Utility ────────────────────────────── */
function _parseSmartTags(desc) {
  if (!desc) return '—';
  const s = String(desc).toUpperCase().replace(/\s+/g, ' ').trim();
  let badges = [];

  // 1. Invoices / Reference Extractions
  const billIdMatch = s.match(/BILL\s*ID:\s*\[?([A-Z0-9\s_-]+)\]?/i);
  const qcInfoMatch = s.match(/(QC\s*TI\s*[\d\s\/]+)/i);
  const againstMatch = s.match(/AGAINST\s*([A-Z0-9\s\/-]+)/i);
  const invMatch = s.match(/INV\s*([\d\w_-]+)/i);
  
  if (billIdMatch) badges.push(`<span style="background:color-mix(in srgb, var(--primary) 12%, var(--bg)); color:var(--primary); padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">📄 Invoice: ${billIdMatch[1].trim()}</span>`);
  else if (qcInfoMatch) badges.push(`<span style="background:color-mix(in srgb, var(--primary) 12%, var(--bg)); color:var(--primary); padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">📄 Invoice: ${qcInfoMatch[1].trim()}</span>`);
  else if (againstMatch) badges.push(`<span style="background:color-mix(in srgb, var(--primary) 12%, var(--bg)); color:var(--primary); padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">📄 Ref: ${againstMatch[1].trim()}</span>`);
  else if (invMatch) badges.push(`<span style="background:color-mix(in srgb, var(--primary) 12%, var(--bg)); color:var(--primary); padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">📄 Ref: ${invMatch[1].trim()}</span>`);

  // 2. Comprehensive UTR / RRN Extraction Engine
  const upiRrnMatch = s.match(/UPI\/(\d{12})/);
  const prefixUtrMatch = s.match(/(?:NEFT|RTGS)-([A-Z0-9]+)/);
  const rawUtrMatch = s.match(/\b([A-Z]{4}[RN]\d{11,16})\b/);

  if (upiRrnMatch) badges.push(`<span style="background:var(--surface); border:1px solid var(--border); color:var(--text-muted); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:10px;">RRN: ${upiRrnMatch[1]}</span>`);
  if (prefixUtrMatch) badges.push(`<span style="background:var(--surface); border:1px solid var(--border); color:var(--text-muted); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:10px;">UTR: ${prefixUtrMatch[1]}</span>`);
  else if (rawUtrMatch) badges.push(`<span style="background:var(--surface); border:1px solid var(--border); color:var(--text-muted); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:10px;">UTR: ${rawUtrMatch[1]}</span>`);

  // 3. Extract Institutional Operations & Statutory Clearings
  if (s.includes('ICEGATE')) badges.push(`<span style="background:color-mix(in srgb, var(--warning) 15%, var(--bg)); color:#d97706; padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">🛃 Customs Duty</span>`);
  else if (s.includes('GST')) badges.push(`<span style="background:color-mix(in srgb, var(--warning) 15%, var(--bg)); color:#d97706; padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">🏛️ GST Tax</span>`);
  else if (s.includes('INT.COLL')) badges.push(`<span style="background:color-mix(in srgb, var(--danger) 10%, var(--bg)); color:var(--danger); padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">📉 Bank Interest</span>`);
  else if (s.includes('LOAN PROCESSING')) badges.push(`<span style="background:color-mix(in srgb, var(--danger) 10%, var(--bg)); color:var(--danger); padding:2px 6px; border-radius:4px; font-weight:700; font-size:10px;">⚙️ Loan Fee</span>`);
  
  // 4. Classify Banking Clearing & Channels
  if (s.startsWith('CLG/')) badges.push(`<span style="background:var(--surface); border:1px solid var(--border); color:var(--text); padding:2px 6px; border-radius:4px; font-size:10px;">🎫 Cheque Clearing</span>`);
  else if (s.startsWith('CMS/')) badges.push(`<span style="background:color-mix(in srgb, var(--primary) 8%, var(--bg)); color:var(--primary); padding:2px 6px; border-radius:4px; font-size:10px;">💻 Bulk CMS Pay</span>`);
  else if (s.includes('BIL/ONL/')) badges.push(`<span style="background:var(--surface); border:1px solid var(--border); color:var(--text-muted); padding:2px 6px; border-radius:4px; font-size:10px;">🌐 Online Gateway</span>`);

  // 5. Intelligent Multi-Channel Prefix Vendor Extraction System
  let vendorName = '';
  const parts = s.split('/').map(p => p.trim()).filter(Boolean);

  if (s.startsWith('CLG/') && parts.length > 1) {
    // [CLG, VENDOR NAME, TRACKING ID] -> index 1 is guaranteed to hold the vendor name
    vendorName = parts[1];
  } else if (s.startsWith('CMS/') && parts.length > 1) {
    // CMS always places descriptive text at the very end of the slash layout
    vendorName = parts[parts.length - 1];
  } else if (s.startsWith('UPI/') && parts.length > 2) {
    // Extract standard mid-segment descriptor strings for UPI payments
    if (parts[2] !== 'UPI PAY') vendorName = parts[2];
  } else if (s.startsWith('INF/') && parts.length > 1) {
    // Walk backwards through internal transfers to find the first non-numeric merchant tag
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!/^\d+$/.test(part) && !part.startsWith('HDFC') && !part.startsWith('ICIC') && !['NEFT', 'INFT', 'DR', 'CR', 'INR'].includes(part) && part.length > 2) {
        vendorName = part;
        break;
      }
    }
  } else if ((s.startsWith('NEFT-') || s.startsWith('RTGS-')) && s.includes('-')) {
    // Hyphen loop splitter system for standard bank-to-bank electronic wires
    const hyphenParts = s.split('-').map(p => p.trim()).filter(Boolean);
    for (let part of hyphenParts) {
      if (!/^\d+$/.test(part) && !/(SIBL|HDFC|SBIN|MAHB|BKID|RATN)[A-Z0-9]+/i.test(part) && !['NEFT', 'RTGS', 'FAST', 'L S TECHNOLOGIES', 'LS TECHNOLOGIES', 'PRO', 'ADVAN'].includes(part) && part.length > 2) {
        vendorName = part;
        break;
      }
    }
  }

  // Validate that the isolated string contains real entity context, not tracking numbers
  if (vendorName) {
    if (!/^\d{2}\.\d{2}\.\d{4}/.test(vendorName) && !/^\d+$/.test(vendorName)) {
      badges.push(`<span style="background:var(--border); color:var(--text); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:600;">👤 ${vendorName}</span>`);
    }
  }

  return badges.length ? `<div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">${badges.join('')}</div>` : '—';
}

/* ── Tally reconciliation badge ──────────────────────────────────── */
function _reconBadge(status) {
  const inTally = (status === 'confirmed' || status === 'high' || status === 'matched');
  if (inTally) {
    const note = status === 'confirmed' ? 'Matched in Tally (reference + amount)'
               : status === 'high'      ? 'Matched in Tally (exact date + amount)'
               :                          'Matched in Tally (amount, within ±3 days)';
    return `<span title="${note}"
      style="display:inline-flex;align-items:center;gap:4px;
             background:color-mix(in srgb,var(--success) 12%,var(--bg));color:var(--success);
             border:1px solid color-mix(in srgb,var(--success) 30%,transparent);
             padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;white-space:nowrap;">
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
      In Tally</span>`;
  }
  if (status === 'review') {
    return `<span title="Possible match — needs manual review"
      style="display:inline-flex;align-items:center;gap:4px;
             background:color-mix(in srgb,var(--warning) 14%,var(--bg));color:#d97706;
             border:1px solid color-mix(in srgb,var(--warning) 30%,transparent);
             padding:2px 7px;border-radius:5px;font-size:10px;font-weight:800;white-space:nowrap;">
      Review</span>`;
  }
  return `<span title="Not found in Tally" style="color:var(--text-muted);font-size:11px;opacity:0.45;">—</span>`;
}

/* ── Transaction table ───────────────────────────────────────────── */
function _renderTxTable(lines) {
  // Filter
  let rows = (lines || []).map((li, i) => ({ ...li, _origIdx: i })).filter(li => {
    if (_bankTxSearch) {
      const q = _bankTxSearch;
      if (!(li.description || '').toLowerCase().includes(q) &&
          !(li.comment     || '').toLowerCase().includes(q)) return false;
    }
    if (_bankDateFrom && li.date && li.date < _bankDateFrom) return false;
    if (_bankDateTo   && li.date && li.date > _bankDateTo)   return false;
    return true;
  });

  // Sort
  rows = [...rows].sort((a, b) => {
    let va, vb;
    const aAmt = parseFloat(a.amount) || 0;
    const bAmt = parseFloat(b.amount) || 0;
    switch (_bankSortCol) {
      case 'date':
        va = a.date || ''; vb = b.date || ''; break;
      case 'description':
        va = (a.description || '').toLowerCase(); vb = (b.description || '').toLowerCase(); break;
      case 'withdrawal':
        va = aAmt < 0 ? Math.abs(aAmt) : 0; vb = bAmt < 0 ? Math.abs(bAmt) : 0; break;
      case 'deposit':
        va = aAmt > 0 ? aAmt : 0; vb = bAmt > 0 ? bAmt : 0; break;
      default:
        va = a.date || ''; vb = b.date || '';
    }
    if (va < vb) return _bankSortDir === 'asc' ? -1 :  1;
    if (va > vb) return _bankSortDir === 'asc' ?  1 : -1;
    return 0;
  });

  if (!rows.length) {
    return `
      <div style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px;">
        ${lines && lines.length ? 'No transactions match your filters.' : 'No transaction data for this statement.'}
      </div>`;
  }

  const bodyHtml = rows.map((li, idx) => {
    const amt      = parseFloat(li.amount) || 0;
    const isDr     = amt < 0;
    const disp     = Math.abs(amt) ? _fmtMoney(Math.abs(amt)) : '';
    const stripe   = idx % 2 === 1 ? 'color-mix(in srgb,var(--text) 4%,transparent)' : 'transparent';
    const oi       = li._origIdx;
    return `
      <tr style="background:${stripe};border-bottom:1px solid var(--border);transition:background 0.1s;"
          onmouseover="this.style.background='color-mix(in srgb,var(--primary) 5%,transparent)'"
          onmouseout="this.style.background='${stripe}'">
        <td style="padding:8px 10px;font-size:12px;white-space:nowrap;color:var(--text);">
          ${li.date ? _fmtDate(li.date) : '—'}
        </td>
        <td style="padding:8px 10px;font-size:12px;max-width:240px;">
          <div title="${esc(li.description || '')}"
               style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:240px;
                      font-family:monospace;font-size:11px;color:var(--text-muted);">
            ${esc(li.description || '—')}
          </div>
        </td>
        <td style="padding:8px 10px;font-size:12px;text-align:right;font-weight:700;color:var(--danger);">
          ${isDr && disp ? disp : ''}
        </td>
        <td style="padding:8px 10px;font-size:12px;text-align:right;font-weight:700;color:var(--success);">
          ${!isDr && disp ? disp : ''}
        </td>
        <td style="padding:8px 10px;text-align:center;">
          ${_reconBadge(_bankReconByIdx[oi])}
        </td>
        <td style="padding:8px 10px;font-size:12px;vertical-align:middle;white-space:nowrap;">
          ${_parseSmartTags(li.description)}
        </td>
        <td style="padding:4px 10px;">
          <input value="${esc(li.comment || '')}"
            oninput="_bankStmtCache[_bankActiveStmt].line_items[${oi}].comment=this.value"
            placeholder="Add note…"
            style="width:100%;box-sizing:border-box;font-family:var(--font);font-size:12px;
                   background:transparent;border:1px solid transparent;border-radius:4px;
                   color:var(--text-muted);padding:4px 8px;
                   transition:border-color 0.15s,background 0.15s;"
            onfocus="this.style.borderColor='var(--border)';this.style.background='var(--surface)'"
            onblur="this.style.borderColor='transparent';this.style.background='transparent'">
        </td>
        <td style="padding:8px 10px;text-align:center;">
          ${li.attachment_url
            ? `<div style="display:flex;align-items:center;justify-content:center;gap:5px;">
                <a href="${esc(li.attachment_url)}" target="_blank" rel="noopener"
                  style="color:var(--primary);font-weight:700;font-size:11px;text-decoration:none;">View ↗</a>
                <span onclick="bankClearFile(${oi})"
                  style="color:var(--danger);font-weight:800;font-size:15px;
                         cursor:pointer;line-height:1;padding:0 2px;" title="Remove">×</span>
              </div>`
            : `<label style="cursor:pointer;color:var(--text-muted);display:inline-flex;
                             align-items:center;justify-content:center;padding:4px;
                             border-radius:4px;transition:color 0.15s;"
                      onmouseover="this.style.color='var(--primary)'"
                      onmouseout="this.style.color='var(--text-muted)'"
                      title="Attach file">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                  <path stroke-linecap="round" stroke-linejoin="round"
                    d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32a1.5 1.5 0 01-2.12-2.121L16.31 6.31"/>
                </svg>
                <input type="file" style="display:none;" onchange="bankUploadFile(${oi}, this.files[0])">
              </label>`}
        </td>
      </tr>`;
  }).join('');

  return `
    <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;background:var(--bg);">
      <div style="overflow:auto;max-height:520px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;">
        <table style="width:100%;border-collapse:collapse;font-family:var(--font);">
          <thead style="position:sticky;top:0;background:var(--surface);
                        box-shadow:0 1px 0 var(--border);z-index:5;">
            <tr>
              ${_th('date',        'Date')}
              ${_th('description', 'Description')}
              ${_th('withdrawal',  'Withdrawal (Dr)', 'right')}
              ${_th('deposit',     'Deposit (Cr)',    'right')}
              <th style="padding:10px;text-align:center;font-size:10px;font-weight:700;
                         text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">
                Tally
              </th>
              <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;
                         text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">
                Smart Track / Ref
              </th>
              <th style="padding:10px;text-align:left;font-size:10px;font-weight:700;
                         text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">
                Internal Note
              </th>
              <th style="padding:10px;text-align:center;font-size:10px;font-weight:700;
                         text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">
                Attachment
              </th>
            </tr>
          </thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
      <div style="padding:8px 12px;background:var(--surface);border-top:1px solid var(--border);
                  font-size:11px;font-weight:600;color:var(--text-muted);">
        ${rows.length} of ${lines.length} transaction${lines.length !== 1 ? 's' : ''}
        ${(_bankDateFrom || _bankDateTo || _bankTxSearch) ? ' — filtered' : ''}
      </div>
    </div>`;
}

/* ── Render content area for selected bank ───────────────────────── */
async function _renderBankContent() {
  const content = document.getElementById('bankContent');
  if (!content) return;

  if (!_bankActiveBank) {
    content.innerHTML = `
      <div style="color:var(--text-muted);font-size:13px;padding:32px 0;text-align:center;">
        No bank statements found.
      </div>`;
    return;
  }

  const stmts = _bankAllRows.filter(r => (r.bank_ledger || 'Unassigned') === _bankActiveBank);
  if (!_bankActiveStmt || !stmts.find(s => s.id === _bankActiveStmt)) {
    _bankActiveStmt = stmts[0]?.id ?? null;
  }

  // Fetch full statement (with line_items) if not already cached
  if (_bankActiveStmt && !_bankStmtCache[_bankActiveStmt]) {
    // Show skeleton while fetching
    content.innerHTML = `
      ${_renderStmtSelector(stmts)}
      <div style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px;">
        Loading statement…
      </div>`;
    try {
      _bankStmtCache[_bankActiveStmt] = await api(`/api/invoices/${_bankActiveStmt}`);
    } catch (e) {
      content.innerHTML = `
        <div style="color:var(--danger);padding:16px;font-size:13px;">
          Failed to load statement data.
        </div>`;
      return;
    }
  }

  // Tally reconciliation status for this statement (non-blocking — never breaks the table)
  if (_bankActiveStmt && !_bankReconCache[_bankActiveStmt]) {
    try {
      const recon = await api(`/api/invoices/${_bankActiveStmt}/reconcile`);
      const byIdx = {};
      (recon.lines || []).forEach(l => { byIdx[l._idx] = (l.match && l.match.status) || 'unmatched'; });
      _bankReconCache[_bankActiveStmt] = { byIdx, summary: recon.summary || {}, bank_ledger: recon.bank_ledger };
    } catch (e) {
      _bankReconCache[_bankActiveStmt] = { byIdx: {}, summary: {}, bank_ledger: null };
    }
  }
  _bankReconByIdx = (_bankReconCache[_bankActiveStmt] || {}).byIdx || {};

  const stmt  = _bankStmtCache[_bankActiveStmt] || null;
  const lines = (stmt && Array.isArray(stmt.line_items)) ? stmt.line_items : [];

  content.innerHTML = `
    ${_renderStmtSelector(stmts)}
    ${_renderAccountInfo(stmt)}
    <div class="card" style="margin-top:0;">
      ${_renderTxToolbar()}
      <div id="bankTxTableWrap">${_renderTxTable(lines)}</div>
    </div>`;
}

/* ── Refresh only the table without touching the toolbar ────────── */
function _refreshTxTable() {
  const wrap = document.getElementById('bankTxTableWrap');
  if (!wrap) return;
  const stmt  = _bankStmtCache[_bankActiveStmt] || null;
  const lines = (stmt && Array.isArray(stmt.line_items)) ? stmt.line_items : [];
  wrap.innerHTML = _renderTxTable(lines);
}

/* ── Inline note & attachment helpers (called from rendered HTML) ─ */
window.bankUploadFile = async function(origIdx, file) {
  if (!file || !_bankActiveStmt) return;
  const fd = new FormData();
  fd.append('file', file);
  showToast('Uploading…');
  try {
    const res  = await fetch('/api/invoices/attachment', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    _bankStmtCache[_bankActiveStmt].line_items[origIdx].attachment_url = data.file_url;
    
    // Auto-save the updated lines directly to the database so it sticks on refresh
    await api(`/api/invoices/${_bankActiveStmt}`, {
      method: 'PUT',
      body: { line_items: _bankStmtCache[_bankActiveStmt].line_items }
    });
    
    showToast('Attached'); _refreshTxTable();
  } catch (e) { showToast(e.message || 'Upload failed', 'error'); }
};

window.bankClearFile = async function(origIdx) {
  if (!_bankActiveStmt) return;
  const url = (_bankStmtCache[_bankActiveStmt]?.line_items?.[origIdx] || {}).attachment_url;
  if (!url) return;
  showToast('Removing…');
  try {
    const res = await fetch('/api/invoices/attachment', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    if (!res.ok) throw new Error('Delete failed');
    _bankStmtCache[_bankActiveStmt].line_items[origIdx].attachment_url = null;
    
    // Persist the updated state to the database using the correct single /api/ path
    await api(`/api/invoices/${_bankActiveStmt}`, {
      method: 'PUT',
      body: { line_items: _bankStmtCache[_bankActiveStmt].line_items }
    });
    
    showToast('Removed'); _refreshTxTable();
  } catch (e) { showToast(e.message || 'Remove failed', 'error'); }
};

window.bankSaveNotes = async function() {
  if (!_bankActiveStmt) return;
  const stmt = _bankStmtCache[_bankActiveStmt];
  if (!stmt) return;
  try {
    await api(`/api/invoices/${_bankActiveStmt}`, { method: 'PUT', body: { line_items: stmt.line_items } });
    showToast('Notes saved');
  } catch (e) { showToast('Save failed', 'error'); }
};

/* ── Tab-level Create / Upload toolbar ──────────────────────────── */
// function _injectBankToolbar() {
//   const subTabs = document.getElementById('bankSubTabs');
//   if (!subTabs || document.getElementById('bankCustomToolbar')) return;

//   const wrapper = document.createElement('div');
//   wrapper.id = 'bankCustomToolbar';
//   wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:16px;';
//   wrapper.innerHTML = `
//     <button onclick="BankTab.create()"
//       style="flex-shrink:0;font-size:12px;font-weight:700;padding:7px 13px;background:var(--primary);color:#fff;border:1px solid var(--primary);border-radius:var(--radius);cursor:pointer;white-space:nowrap;">
//       + Create
//     </button>
//     <label style="flex-shrink:0;display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:7px 13px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);cursor:pointer;white-space:nowrap;">
//       <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
//         <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"/>
//       </svg>
//       Upload
//       <input type="file" id="bankFileInput" accept="application/pdf" style="display:none"
//              onchange="BankTab.handleUpload(this.files)">
//     </label>`;

//   subTabs.parentNode.insertBefore(wrapper, subTabs);
// }

function _bankCreate() {
  if (typeof openManual === 'function') openManual('bank_statement');   // global, defined in docs.html
  else showToast('Create unavailable', 'error');
}

async function _handleBankUpload(files) {
  const file = files[0];
  const fi = document.getElementById('bankFileInput');
  if (fi) fi.value = '';
  if (!file) return;
  if (file.type !== 'application/pdf') { showToast('Only PDF files are supported', 'error'); return; }
  const fd = new FormData();
  fd.append('pdf', file);
  fd.append('hint_doc_type', 'bank_statement');
  try {
    const res  = await fetch('/api/invoices/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    startProcessing(data.invoiceId, file.name, false);      // global, defined in docs.html
  } catch (e) {
    console.error('[Bank Upload] failed:', e);
    showToast(e.message || 'Upload failed', 'error');
  }
}

/* ── Full data reload ────────────────────────────────────────────── */
async function _loadBank() {
  try {
    const all      = await api('/api/invoices');
    _bankAllRows   = all.filter(d => d.doc_type === 'bank_statement');
    _bankStmtCache = {}; // bust cache so edits to a statement are reflected
    _bankReconCache = {}; // bust reconciliation cache too
    _renderBankIntel(_bankAllRows);
    _renderBankSubTabs();
    await _renderBankContent();
  } catch (e) {
    console.error('BankTab load error:', e);
  }
}

/* ── Init ────────────────────────────────────────────────────────── */
async function _initBankTab() {
  if (_bankTabInited) { await _loadBank(); return; }
  _bankTabInited = true;
  await _loadBank();
}

/* ── Public namespace ────────────────────────────────────────────── */
window.BankTab = {
  init: _initBankTab,
  load: _loadBank,
  create:       _bankCreate,
  handleUpload: _handleBankUpload,

  selectBank(bank) {
    _bankActiveBank = bank;
    _bankActiveStmt = null;
    _bankDateFrom = ''; _bankDateTo = ''; _bankTxSearch = '';
    _renderBankSubTabs();
    _renderBankContent();
  },

  selectStmt(id) {
    _bankActiveStmt = id;
    _bankDateFrom = ''; _bankDateTo = ''; _bankTxSearch = '';
    _renderBankContent();
  },

  sort(col) {
    if (_bankSortCol === col) {
      _bankSortDir = _bankSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      _bankSortCol = col;
      _bankSortDir = 'asc';
    }
    _refreshTxTable();
  },

  setSearch(val)   { _bankTxSearch = val.trim().toLowerCase(); _refreshTxTable(); },
  setDateFrom(val) { _bankDateFrom = val; _renderBankContent(); },
  setDateTo(val)   { _bankDateTo   = val; _renderBankContent(); },
  clearFilters()   { _bankDateFrom = ''; _bankDateTo = ''; _bankTxSearch = ''; _renderBankContent(); },
};