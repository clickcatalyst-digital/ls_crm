// routes/invoices.js
// Handles PDF upload, extraction, approval, and Tally XML generation.
// New dependencies: multer (memory storage), pdf-parse
// npm install multer pdf-parse

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── CONFIG: update to match your Tally ledger names ────────────────────────
const EXPENSE_LEDGER_MAP = {
  AGENCY:    'Agency Charges',
  EDI:       'EDI Charges',
  CMC:       'EDI Charges',
  CFS:       'CFS Charges',
  FREIGHT:   'Freight & Handling Charges',
  HANDLING:  'Freight & Handling Charges',
  CUSTOMS:   'Customs Duty',
  TRANSPORT: 'Transport Charges',
  STORAGE:   'Godown / Storage Charges',
};
const DEFAULT_LEDGER     = 'Freight & Other Charges';
const CGST_LEDGER        = 'CGST Input';
const SGST_LEDGER        = 'SGST Input';
const IGST_LEDGER        = 'IGST Input';
const TALLY_COMPANY_NAME = 'LS Technologies';

// ── EXTRACTION ENGINES (test harness — pick the winner later) ───────────────

const EXTRACTION_PROMPT = `You are a precise data extraction system for Indian GST documents.
Extract fields and return ONLY raw JSON (no markdown, no prose). Use null for any field not present:
{
  "doc_type": "freight_invoice | purchase_invoice | bill_of_entry | purchase_order | bank_statement | unknown",
  "invoice_no": string|null, "invoice_date": string|null,
  "party_name": string|null, "party_gstin": string|null, "buyer_gstin": string|null,
  "place_of_supply": string|null, "mawb_no": string|null, "flight_no": string|null,
  "commodity": string|null, "origin_airport": string|null, "dest_airport": string|null,
  "gross_weight": number|null, "supplier_ref": string|null,
  "taxable_value": number|null, "cgst": number|null, "sgst": number|null, "igst": number|null,
  "total_tax": number|null, "net_amount": number|null,
  "line_items": [{ "description": string, "hsn": string|null, "qty": number|null, "uom": string|null, "rate": number|null, "amount": number|null }]
}
Rules:
- party_name is ALWAYS the OTHER company — the issuer/counterparty — NEVER "L S Technologies" / "LS Technologies" (that entity is our client and is the BUYER on every document, regardless of how prominently its name appears).
- Identify the issuer by the LETTERHEAD/logo at the top, the "For, <COMPANY>" signature block, and the issuer's own GSTIN — NOT by the "M/S." or "Bill To" addressee, which is the buyer (L S Technologies).
- A document addressed "M/S. L S TECHNOLOGIES" is addressed TO our client; the party_name is whoever ISSUED it (e.g. the company in the letterhead).
- For invoices/bills: party_name is the supplier issuing it. For a purchase_order: party_name is the vendor/issuer the order is placed with.
- party_gstin is the ISSUER's GSTIN (the counterparty in the letterhead); buyer_gstin is L S Technologies' own GSTIN as printed on the document.
- doc_type — decide by these decisive structural tells, in priority order:
  1. If the document title contains "Purchase Order" or "P.O." AND there is NO invoice number / NO IRN / NO Ack No., it is purchase_order. A PO is an order being placed, not a demand for payment; it often has per-line delivery dates. This holds even if it has GST, HSN, and tax breakdowns.
  2. If it has an IRN or Ack No. (e-invoice), or is titled "Tax Invoice" / "GST Invoice" with an Invoice No., it is purchase_invoice (for goods) — UNLESS it is dominated by freight/logistics charges.
  3. A freight/logistics bill with MAWB / airport / flight / CFS / agency charges = freight_invoice.
  4. A customs bill of entry = bill_of_entry. A bank account statement = bank_statement.
- Numbers plain (no commas/symbols). Some docs use IGST only, others CGST+SGST. net_amount is the final payable total after tax and round-off.`;

async function callOpenRouter(body) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (r.status === 429) throw new Error('RATE_LIMIT: OpenRouter free-tier limit hit (20/min or 200/day). Try again later or add credits.');
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  let raw = (data.choices?.[0]?.message?.content || '').trim();
  if (raw.startsWith('```')) raw = raw.replace(/```json|```/g, '').trim();
  // Salvage: model sometimes wraps JSON in stray prose — grab the outermost object
  try {
    return JSON.parse(raw);
  } catch (e) {
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
    throw e;
  }
}

function normalizeExtraction(parsed, fallbackType) {
  const items = Array.isArray(parsed.line_items) ? parsed.line_items : [];
  return {
    doc_type: parsed.doc_type || fallbackType || 'unknown',
    invoice_no: parsed.invoice_no || '', invoice_date: parsed.invoice_date || '',
    party_name: parsed.party_name || '', party_gstin: parsed.party_gstin || '', buyer_gstin: parsed.buyer_gstin || '',
    place_of_supply: parsed.place_of_supply || '', mawb_no: parsed.mawb_no || '', flight_no: parsed.flight_no || '',
    commodity: parsed.commodity || '', origin_airport: parsed.origin_airport || '', dest_airport: parsed.dest_airport || '',
    gross_weight: parsed.gross_weight || 0, supplier_ref: parsed.supplier_ref || '',
    taxable_value: parsed.taxable_value || 0, cgst: parsed.cgst || 0, sgst: parsed.sgst || 0, igst: parsed.igst || 0,
    total_tax: parsed.total_tax || ((parsed.cgst||0)+(parsed.sgst||0)+(parsed.igst||0)),
    net_amount: parsed.net_amount || 0, line_items: items,
  };
}

// Map a raw extraction error to a short, human reason (mirrors t2t.py's classifier)
function classifyExtractError(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('rate_limit'))            return 'Rate limited';
  if (m.includes('json') || m.includes('unexpected token')) return 'Bad AI response';
  if (m.includes('timeout') || m.includes('timed out'))     return 'Timed out';
  if (m.includes('fetch failed') || m.includes('network'))  return 'Network error';
  if (m.includes('401') || m.includes('unauthorized') || m.includes('api key')) return 'Auth/key error';
  if (m.includes('insufficient') || m.includes('credit'))   return 'No credits';
  return 'Extraction error';
}

// PDF → OpenRouter native file handling (no pdf-parse, no local render)
async function parseInvoice(buffer) {
  const b64 = buffer.toString('base64');
  const parsed = await callOpenRouter({
    model: 'google/gemma-4-31b-it',
    temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: EXTRACTION_PROMPT },
      { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${b64}` } }
    ]}]
  });
  return normalizeExtraction(parsed);
}

// Background extraction: runs AFTER the upload response is sent.
// Updates the row to 'pending' on success, or 'extract_failed' with a short reason.
async function runExtraction(invoiceId, buffer) {
  try {
    let inv;
    try {
      inv = await parseInvoice(buffer);
    } catch (e1) {
      // One automatic retry on a malformed-JSON / transient model error
      if (/json|unexpected token/i.test(e1.message)) {
        console.warn('Extraction parse failed for', invoiceId, '— retrying once');
        inv = await parseInvoice(buffer);
      } else {
        throw e1;
      }
    }
    const xml = buildTallyXML(inv);
    await execute(
      `UPDATE crm_invoices SET
         doc_type=?, invoice_no=?, invoice_date=?, party_name=?, party_gstin=?, buyer_gstin=?,
         place_of_supply=?, mawb_no=?, flight_no=?, commodity=?, origin_airport=?, dest_airport=?,
         gross_weight=?, supplier_ref=?, taxable_value=?, cgst=?, sgst=?, igst=?, total_tax=?,
         net_amount=?, line_items=?, tally_xml=?, status='pending', extract_error=NULL
       WHERE id=?`,
      [
        inv.doc_type, inv.invoice_no, inv.invoice_date || null, inv.party_name, inv.party_gstin, inv.buyer_gstin,
        inv.place_of_supply, inv.mawb_no, inv.flight_no, inv.commodity, inv.origin_airport, inv.dest_airport,
        inv.gross_weight || null, inv.supplier_ref, inv.taxable_value || null, inv.cgst || null, inv.sgst || null,
        inv.igst || null, inv.total_tax || null, inv.net_amount || null,
        JSON.stringify(inv.line_items), xml, invoiceId
      ]
    );
    // Update the linked task title now that we know the invoice no / amount
    const t = `Approve invoice${inv.invoice_no ? ' ' + inv.invoice_no : ''} — ₹${inv.net_amount || '?'}`;
    await execute('UPDATE crm_tasks SET title=? WHERE invoice_id=?', [t, invoiceId]);
  } catch (err) {
    console.error('Background extraction failed for', invoiceId, err.message);
    await execute(
      `UPDATE crm_invoices SET status='extract_failed', extract_error=? WHERE id=?`,
      [classifyExtractError(err.message), invoiceId]
    );
  }
}


// ── TALLY XML BUILDER ─────────────────────────────────────────────────────

function resolveLedger(desc) {
  const d = desc.toUpperCase();
  for (const [kw, ledger] of Object.entries(EXPENSE_LEDGER_MAP)) {
    if (d.includes(kw)) return ledger;
  }
  return DEFAULT_LEDGER;
}

function fmtDate(raw) {
  const s = (raw || '').replace(/\./g, '/');
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}${m[2]}${m[1]}` : new Date().toISOString().slice(0,10).replace(/-/g,'');
}

function buildTallyXML(inv) {
  // Only invoices map to a Tally Purchase Voucher. PO is CRM-only;
  // bill_of_entry / bank_statement mappings are not built yet.
  const TALLY_TYPES = ['purchase_invoice', 'freight_invoice'];
  if (!TALLY_TYPES.includes(inv.doc_type)) return '';

  const partyName  = inv.party_name || 'Unknown Supplier';
  const partyGstin = inv.party_gstin || '';
  const invoiceNo  = inv.invoice_no || '';
  const date       = fmtDate(inv.invoice_date);
  const place      = (inv.place_of_supply || 'Gujarat');
  const net        = parseFloat(inv.net_amount || 0).toFixed(2);
  const cgst       = parseFloat(inv.cgst || 0).toFixed(2);
  const sgst       = parseFloat(inv.sgst || 0).toFixed(2);
  const igst       = parseFloat(inv.igst || 0).toFixed(2);
  const taxable    = parseFloat(inv.taxable_value || 0).toFixed(2);
  const items      = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : (inv.line_items || []);

  const ledgerEntries = items.map(item => `
    <LEDGERENTRIES.LIST>
      <LEDGERNAME>${resolveLedger(item.description || '')}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <AMOUNT>${item.amount || '0'}</AMOUNT>
      <GSTAPPLICABLE>_APPLICABLE_</GSTAPPLICABLE>
      <TAXCLASSIFICATIONDETAILS.LIST><GSTOVRDNTAXRATE>0</GSTOVRDNTAXRATE></TAXCLASSIFICATIONDETAILS.LIST>
    </LEDGERENTRIES.LIST>`).join('');

  const gstEntries = [
    parseFloat(cgst) > 0 ? `<LEDGERENTRIES.LIST><LEDGERNAME>${CGST_LEDGER}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${cgst}</AMOUNT><GSTAPPLICABLE>_NOTAPPLICABLE_</GSTAPPLICABLE></LEDGERENTRIES.LIST>` : '',
    parseFloat(sgst) > 0 ? `<LEDGERENTRIES.LIST><LEDGERNAME>${SGST_LEDGER}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${sgst}</AMOUNT><GSTAPPLICABLE>_NOTAPPLICABLE_</GSTAPPLICABLE></LEDGERENTRIES.LIST>` : '',
    parseFloat(igst) > 0 ? `<LEDGERENTRIES.LIST><LEDGERNAME>${IGST_LEDGER}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>${igst}</AMOUNT><GSTAPPLICABLE>_NOTAPPLICABLE_</GSTAPPLICABLE></LEDGERENTRIES.LIST>` : '',
  ].join('');

  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES><SVCURRENTCOMPANY>${TALLY_COMPANY_NAME}</SVCURRENTCOMPANY></STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER REMOTEID="${invoiceNo}" VCHTYPE="Purchase" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${date}</DATE>
            <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${invoiceNo}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${partyName}</PARTYLEDGERNAME>
            <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
            <ISINVOICE>Yes</ISINVOICE>
            <ISRCMAPPLICABLE>No</ISRCMAPPLICABLE>
            <PLACEOFSUPPLY>${place}</PLACEOFSUPPLY>
            <STATENAME>${place}</STATENAME>
            <PARTYGSTIN>${partyGstin}</PARTYGSTIN>
            <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>
            <NARRATION>Inv: ${invoiceNo} | MAWB: ${inv.mawb_no||''} | ${inv.commodity||''}</NARRATION>
            ${ledgerEntries}
            ${gstEntries}
            <LEDGERENTRIES.LIST>
              <LEDGERNAME>${partyName}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
              <AMOUNT>-${net}</AMOUNT>
              <GSTAPPLICABLE>_NOTAPPLICABLE_</GSTAPPLICABLE>
              <BILLALLOCATIONS.LIST>
                <NAME>${invoiceNo}</NAME>
                <BILLTYPE>New Ref</BILLTYPE>
                <AMOUNT>-${net}</AMOUNT>
              </BILLALLOCATIONS.LIST>
            </LEDGERENTRIES.LIST>
            <GSTDETAILS.LIST>
              <TAXTYPE>GST</TAXTYPE>
              <STATENAME>${place}</STATENAME>
              <ASSESSABLEVALUE>${taxable}</ASSESSABLEVALUE>
              <CGST>${cgst}</CGST>
              <SGST>${sgst}</SGST>
              <IGST>${igst}</IGST>
              <ISREVERSECHARGEABLE>No</ISREVERSECHARGEABLE>
            </GSTDETAILS.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ── ROUTES ────────────────────────────────────────────────────────────────

// POST /api/invoices/upload — accepts PDF, inserts a 'reading' row, returns immediately,
// then extracts in the background (avoids Render request-timeout on slow PDFs).
router.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  try {
    // Insert a placeholder row in 'reading' state
    const result = await execute(
      `INSERT INTO crm_invoices (uploaded_by, original_filename, status, line_items, tally_xml)
       VALUES (?, ?, 'reading', '[]', '')`,
      [req.user.username, req.file.originalname]
    );
    const invoiceId = Number(result.lastId);

    // Create the approval task up front (title gets refined once extraction lands)
    const taskResult = await execute(
      `INSERT INTO crm_tasks (title, due_date, status, assigned_to, created_by, created_at, invoice_id)
       VALUES (?, ?, 'open', ?, ?, ?, ?)`,
      [`Reading ${req.file.originalname}…`, nowIST().substring(0, 10),
       req.user.username, req.user.username, nowIST(), invoiceId]
    );
    await execute('UPDATE crm_invoices SET task_id = ? WHERE id = ?',
      [Number(taskResult.lastId), invoiceId]);

    // Respond NOW — do not await extraction
    res.json({ success: true, invoiceId, status: 'reading' });

    // Fire-and-forget; runExtraction updates the row when done
    runExtraction(invoiceId, req.file.buffer);
  } catch (err) {
    console.error('Invoice upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// GET /api/invoices/:id/status — lightweight poll for the processing overlay
router.get('/:id/status', async (req, res) => {
  const inv = await queryOne(
    'SELECT id, status, invoice_no, net_amount, extract_error FROM crm_invoices WHERE id = ?',
    [req.params.id]
  );
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

// POST /api/invoices/manual — create a blank pending record for manual entry
router.post('/manual', async (req, res) => {
  const docType = req.body.doc_type || 'purchase_invoice';
  const result = await execute(
    `INSERT INTO crm_invoices (uploaded_by, original_filename, doc_type, status, line_items, tally_xml)
     VALUES (?, ?, ?, 'pending', '[]', '')`,
    [req.user.username, 'Manual entry', docType]
  );
  const invoiceId = Number(result.lastId);
  const taskResult = await execute(
    `INSERT INTO crm_tasks (title, due_date, status, assigned_to, created_by, created_at, invoice_id)
     VALUES (?, ?, 'open', ?, ?, ?, ?)`,
    [`Complete & approve ${docType}`, nowIST().substring(0,10), req.user.username, req.user.username, nowIST(), invoiceId]
  );
  await execute('UPDATE crm_invoices SET task_id = ? WHERE id = ?', [Number(taskResult.lastId), invoiceId]);
  res.json({ success: true, invoiceId });
});

// GET /api/invoices — list all (excludes soft-deleted unless explicitly asked)
router.get('/', async (req, res) => {
  // Reap stale 'reading' rows (service slept mid-extraction → never resolves)
  await execute(
    `UPDATE crm_invoices SET status='extract_failed', extract_error='Timeout'
     WHERE status='reading' AND created_at < datetime('now','-5 minutes')`
  );

  const status = req.query.status;
  let where, params;
  if (status === 'deleted') {
    where = 'WHERE deleted_at IS NOT NULL';     params = [];
  } else if (status) {
    where = 'WHERE status = ? AND deleted_at IS NULL'; params = [status];
  } else {
    where = 'WHERE deleted_at IS NULL';          params = [];
  }
  res.json(await queryAll(
    `SELECT * FROM crm_invoices ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  ));
});

// GET /api/invoices/:id/checks — advisory duplicate + ledger checks for the review panel.
// Read-only and non-blocking; the human decides what to do with the warnings.
router.get('/:id/checks', async (req, res) => {
  const inv = await queryOne('SELECT * FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });

  const out = { duplicates: [], unknownLedgers: [], ledgerSynced: false };

  // ── Duplicate: same party + same invoice_no, any other non-deleted record ──
  if (inv.party_name && inv.invoice_no) {
    out.duplicates = await queryAll(
      `SELECT id, invoice_no, party_name, net_amount, status, created_at
         FROM crm_invoices
        WHERE id != ?
          AND deleted_at IS NULL
          AND lower(trim(party_name)) = lower(trim(?))
          AND lower(trim(invoice_no)) = lower(trim(?))
        ORDER BY created_at DESC LIMIT 5`,
      [inv.id, inv.party_name, inv.invoice_no]
    );
  }

  // ── Ledger validation: only meaningful once the agent has synced Tally ledgers ──
  const ledgerCount = await queryOne('SELECT COUNT(*) AS n FROM crm_tally_ledgers');
  out.ledgerSynced = (ledgerCount?.n || 0) > 0;
  if (out.ledgerSynced) {
    const known = new Set(
      (await queryAll('SELECT name FROM crm_tally_ledgers')).map(r => (r.name || '').toLowerCase().trim())
    );
    // Resolve the ledgers this invoice's line items would post to, and flag any not in Tally
    const items = typeof inv.line_items === 'string'
      ? (() => { try { return JSON.parse(inv.line_items); } catch { return []; } })()
      : (inv.line_items || []);
    const used = new Set();
    for (const it of items) used.add(resolveLedger(it.description || ''));
    used.add(DEFAULT_LEDGER);
    if (parseFloat(inv.cgst) > 0) used.add(CGST_LEDGER);
    if (parseFloat(inv.sgst) > 0) used.add(SGST_LEDGER);
    if (parseFloat(inv.igst) > 0) used.add(IGST_LEDGER);
    if (inv.party_name) used.add(inv.party_name); // party ledger must also exist
    out.unknownLedgers = [...used].filter(l => l && !known.has(l.toLowerCase().trim()));
  }

  res.json(out);
});

// GET /api/invoices/:id — single invoice
router.get('/:id', async (req, res) => {
  const inv = await queryOne('SELECT * FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (typeof inv.line_items === 'string') {
    try { inv.line_items = JSON.parse(inv.line_items); } catch { inv.line_items = []; }
  }
  res.json(inv);
});

// PUT /api/invoices/:id — update editable fields + rebuild XML
router.put('/:id', async (req, res) => {
  const allowed = ['invoice_no','invoice_date','party_name','party_gstin','buyer_gstin',
    'place_of_supply','taxable_value','cgst','sgst','igst','net_amount',
    'mawb_no','flight_no','commodity','supplier_ref','line_items','review_notes'];
  const fields = {}, params = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { fields[k] = req.body[k]; }
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });

  // Rebuild Tally XML after edit
  const existing = await queryOne('SELECT * FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const merged   = { ...existing, ...fields };
  if (typeof merged.line_items === 'string') {
    try { merged.line_items = JSON.parse(merged.line_items); } catch { merged.line_items = []; }
  }
  fields.tally_xml = buildTallyXML(merged);
  if (typeof fields.line_items !== 'string') fields.line_items = JSON.stringify(fields.line_items || []);

  const sets   = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), req.params.id];
  await execute(`UPDATE crm_invoices SET ${sets} WHERE id = ?`, values);
  res.json({ success: true });
});

// POST /api/invoices/:id/approve — approve + mark task done
router.post('/:id/approve', async (req, res) => {
  const notes = req.body.notes || '';
  await execute(
    `UPDATE crm_invoices SET status = 'approved', review_notes = ?, approved_at = ? WHERE id = ?`,
    [notes, nowIST(), req.params.id]
  );
  // Mark linked task as done
  const inv = await queryOne('SELECT task_id FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (inv?.task_id) {
    await execute("UPDATE crm_tasks SET status = 'done', completed_at = ? WHERE id = ?",
      [nowIST(), inv.task_id]);
  }
  res.json({ success: true, message: 'Invoice approved. Local agent will push to Tally.' });
});

// POST /api/invoices/:id/reject
router.post('/:id/reject', async (req, res) => {
  const notes = req.body.notes || '';
  await execute(
    `UPDATE crm_invoices SET status = 'rejected', review_notes = ? WHERE id = ?`,
    [notes, req.params.id]
  );
  const inv = await queryOne('SELECT task_id FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (inv?.task_id) {
    await execute("UPDATE crm_tasks SET status = 'done', completed_at = ? WHERE id = ?",
      [nowIST(), inv.task_id]);
  }
  res.json({ success: true });
});

// DELETE /api/invoices/:id — soft-delete pushed rows, hard-delete the rest
router.delete('/:id', async (req, res) => {
  const inv = await queryOne('SELECT status, task_id FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });

  // Close any open linked task either way
  if (inv.task_id) {
    await execute("UPDATE crm_tasks SET status='done', completed_at=? WHERE id=? AND status!='done'",
      [nowIST(), inv.task_id]);
  }

  if (inv.status === 'pushed') {
    // Already in Tally — never hard-delete; keep the record, mark deleted
    await execute('UPDATE crm_invoices SET deleted_at = ? WHERE id = ?', [nowIST(), req.params.id]);
    return res.json({ success: true, soft: true,
      message: 'Record was pushed to Tally — archived, not erased. Reverse the voucher in Tally if needed.' });
  }

  await execute('DELETE FROM crm_invoices WHERE id = ?', [req.params.id]);
  res.json({ success: true, soft: false });
});

// GET /api/invoices/:id/xml — download Tally XML file
router.get('/:id/xml', async (req, res) => {
  const inv = await queryOne('SELECT invoice_no, tally_xml FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv?.tally_xml) return res.status(404).json({ error: 'No XML found' });
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="tally_${inv.invoice_no || req.params.id}.xml"`);
  res.send(inv.tally_xml);
});

module.exports = router;