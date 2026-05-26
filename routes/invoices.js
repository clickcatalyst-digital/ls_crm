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
- For invoices/bills: party_name is the SUPPLIER issuing it (never "LS Technologies", which is the buyer).
- For a purchase_order: party_name is the counterparty company (the vendor/issuer), never "LS Technologies".
- doc_type: a GST tax invoice or e-invoice for goods = purchase_invoice; a freight/logistics bill with MAWB/airport/CFS/agency charges = freight_invoice; a doc titled "Purchase Order" = purchase_order; a customs bill of entry = bill_of_entry; a bank account statement = bank_statement.
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
  return JSON.parse(raw);
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

// POST /api/invoices/upload — accepts PDF, extracts, creates invoice + task
router.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  try {
    const inv = await parseInvoice(req.file.buffer);
    const docType = inv.doc_type;
    const xml = buildTallyXML(inv);

    // Insert invoice
    const result = await execute(
      `INSERT INTO crm_invoices
         (uploaded_by, original_filename, doc_type,
          invoice_no, invoice_date, party_name, party_gstin, buyer_gstin,
          place_of_supply, mawb_no, flight_no, commodity, origin_airport,
          dest_airport, gross_weight, supplier_ref,
          taxable_value, cgst, sgst, igst, total_tax, net_amount,
          line_items, tally_xml, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
      [
        req.user.username, req.file.originalname, docType,
        inv.invoice_no, inv.invoice_date || null, inv.party_name, inv.party_gstin, inv.buyer_gstin,
        inv.place_of_supply, inv.mawb_no, inv.flight_no, inv.commodity, inv.origin_airport,
        inv.dest_airport, inv.gross_weight || null, inv.supplier_ref,
        inv.taxable_value || null, inv.cgst || null, inv.sgst || null,
        inv.igst || null, inv.total_tax || null, inv.net_amount || null,
        JSON.stringify(inv.line_items), xml,
      ]
    );
    const invoiceId = Number(result.lastId);

    // Create an approval task on the dashboard
    const taskTitle = `Approve invoice${inv.invoice_no ? ' ' + inv.invoice_no : ''} — ₹${inv.net_amount || '?'}`;
    const today     = nowIST().substring(0, 10);
    const taskResult = await execute(
      `INSERT INTO crm_tasks (title, due_date, status, assigned_to, created_by, created_at, invoice_id)
       VALUES (?, ?, 'open', ?, ?, ?, ?)`,
      [taskTitle, today, req.user.username, req.user.username, nowIST(), invoiceId]
    );

    await execute('UPDATE crm_invoices SET task_id = ? WHERE id = ?',
      [Number(taskResult.lastId), invoiceId]);

    res.json({
      success:   true,
      invoiceId,
      docType,
      invoiceNo: inv.invoice_no,
      netAmount: inv.net_amount,
      lineItems: inv.line_items.length,
    });
  } catch (err) {
    console.error('Invoice upload error:', err);
    res.status(500).json({ error: 'Extraction failed: ' + err.message });
  }
});

// GET /api/invoices — list all
router.get('/', async (req, res) => {
  const status = req.query.status;
  const where  = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  res.json(await queryAll(
    `SELECT * FROM crm_invoices ${where} ORDER BY created_at DESC LIMIT 200`,
    params
  ));
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

// GET /api/invoices/:id/xml — download Tally XML file
router.get('/:id/xml', async (req, res) => {
  const inv = await queryOne('SELECT invoice_no, tally_xml FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv?.tally_xml) return res.status(404).json({ error: 'No XML found' });
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="tally_${inv.invoice_no || req.params.id}.xml"`);
  res.send(inv.tally_xml);
});

module.exports = router;