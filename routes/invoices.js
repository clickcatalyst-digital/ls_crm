// routes/invoices.js
// Handles PDF upload, extraction, approval, and Tally XML generation.
// npm install multer

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');
const { createPOFromExtraction } = require('./po');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Connect an enterprise-grade S3-compatible interface straight to your Cloudflare R2 bucket storage space
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const EXPENSE_LEDGER_MAP = [
  { kw: 'AGENCY',           ledger: 'Agency Charges'          },
  { kw: 'CFS',              ledger: 'CFS CHARGE'              },
  { kw: 'EDI',              ledger: 'DO Charges'              },
  { kw: 'DO CHARGE',        ledger: 'DO Charges'              },
  { kw: 'AIR FREIGHT',      ledger: 'Air Freight'             },
  { kw: 'AIR LINE',         ledger: 'AILINE DO CHARGE'        },
  { kw: 'AIRLINE',          ledger: 'AILINE DO CHARGE'        },
  { kw: 'OCEAN',            ledger: 'OCEAN / SEA Freight'     },
  { kw: 'SEA FREIGHT',      ledger: 'OCEAN / SEA Freight'     },
  { kw: 'FREIGHT',          ledger: 'Freight on Import'       },
  { kw: 'HANDLING',         ledger: 'HNNDLING CHARGES'        },
  { kw: 'IGM',              ledger: 'IGM CHARGES'             },
  { kw: 'THS',              ledger: 'THS CHARGE'              },
  { kw: 'DOCUMENTATION',    ledger: 'DOCUMENTATION'           },
  { kw: 'AMENDMENT',        ledger: 'Amendment Charges'       },
  { kw: 'CUSTOMS CLEARANCE',ledger: 'CUSTOMS CLEARANCE'       },
  { kw: 'CUSTOM',           ledger: 'CUSTOMS CLEARANCE'       },
  { kw: 'FCA',              ledger: 'FCA Charges'             },
  { kw: 'EX-WORK',          ledger: 'EX-WORKS'               },
  { kw: 'WAREHOUSE',        ledger: 'Warehouse Charges'       },
  { kw: 'STORAGE',          ledger: 'Warehouse Charges'       },
  { kw: 'COURIER',          ledger: 'Courier Exp.'            },
  { kw: 'TRANSPORT',        ledger: 'Freight on Import'       },
  { kw: 'CERTIFICATION',    ledger: 'Certification Charges'   },
  { kw: 'DIGITAL SIG',      ledger: 'Digital Signature'       },
  { kw: 'MISC',             ledger: 'Misc Charges'            },
];
const DEFAULT_EXPENSE_LEDGER = 'Misc Charges';

const CGST_LEDGER        = 'CGST';
const SGST_LEDGER        = 'SGST';
const IGST_LEDGER        = 'IGST';
const IGST_IMPORT_LEDGER = 'IGST Paid on Import';
const CUSTOMS_DUTY_LEDGER= 'Custom Duty / Import Duty';
const FREIGHT_IMPORT_LDG = 'Freight on Import';
const INSURANCE_IMPORT_LDG='Insurance on Import';
const PURCHASE_LOCAL     = 'GST LOCAL PURCHASE 18%';
const PURCHASE_INTRA     = 'GST INTRA STATE PURCHASE 18%';
const PURCHASE_IMPORT    = 'GST Import Purchase 18%';
const BANK_LEDGER        = 'South Indian Bank';
const SUSPENSE_LEDGER    = 'Suspense A/c';
const TALLY_COMPANY_NAME = '';

// const EXTRACTION_PROMPT = `You are a precise data extraction system for Indian GST documents.
// Extract fields and return ONLY raw JSON (no markdown, no prose). Use null for any field not present:
// {
//   "doc_type": "freight_invoice | purchase_invoice | bill_of_entry | purchase_order | bank_statement | unknown",
//   "invoice_no": string|null, "invoice_date": string|null,
//   "party_name": string|null, "party_gstin": string|null, "buyer_gstin": string|null,
//   "place_of_supply": string|null, "mawb_no": string|null, "flight_no": string|null,
//   "commodity": string|null, "origin_airport": string|null, "dest_airport": string|null,
//   "gross_weight": number|null, "supplier_ref": string|null,
//   "taxable_value": number|null, "cgst": number|null, "sgst": number|null, "igst": number|null,
//   "total_tax": number|null, "net_amount": number|null,
//   "delivery_date": string|null,
//   "account_no": string|null, "statement_from": string|null, "statement_to": string|null,
//   "opening_balance": number|null, "closing_balance": number|null,
//   "total_debit": number|null, "total_credit": number|null,
//   "line_items": [{ "description": string, "hsn": string|null, "qty": number|null, "uom": string|null, "rate": number|null, "amount": number|null, "date": string|null, "delivery_date": string|null }]
// }
// Rules:
// - party_name is ALWAYS the OTHER company — the issuer/counterparty — NEVER "L S Technologies" / "LS Technologies" (that entity is our client and is the BUYER on every document, regardless of how prominently its name appears).
// - Identify the issuer by the LETTERHEAD/logo at the top, the "For, <COMPANY>" signature block, and the issuer's own GSTIN — NOT by the "M/S." or "Bill To" addressee, which is the buyer (L S Technologies).
// - A document addressed "M/S. L S TECHNOLOGIES" is addressed TO our client; the party_name is whoever ISSUED it (e.g. the company in the letterhead).
// - For invoices/bills: party_name is the supplier issuing it. For a purchase_order: party_name is the company in the LETTERHEAD who issued this PO (they are the buyer placing the order with LS Technologies as their vendor).
// - party_gstin = the GSTIN that appears alongside or is directly associated with party_name's company name in the document. buyer_gstin = the GSTIN that appears alongside or is directly associated with 'L S TECHNOLOGIES' / 'LS TECHNOLOGIES' in the document. Simple test: look at each GSTIN on the page, identify the company name next to it, then assign: if the adjacent company name is L S Technologies → buyer_gstin; if it is party_name → party_gstin. party_gstin must NEVER belong to L S Technologies.
// - doc_type — decide by these decisive structural tells, in priority order:
//   1. If the document title contains "Purchase Order" or "P.O." AND there is NO invoice number / NO IRN / NO Ack No., it is purchase_order. A PO is an order being placed, not a demand for payment; it often has per-line delivery dates. This holds even if it has GST, HSN, and tax breakdowns.
//   2. If it has an IRN or Ack No. (e-invoice), or is titled "Tax Invoice" / "GST Invoice" with an Invoice No., it is purchase_invoice (for goods) — UNLESS it is dominated by freight/logistics charges.
//   3. A freight/logistics bill with MAWB / airport / flight / CFS / agency charges = freight_invoice.
//   4. A customs bill of entry = bill_of_entry. A bank account statement = bank_statement.
// - Numbers plain (no commas/symbols). Some docs use IGST only, others CGST+SGST. net_amount is the final payable total after tax and round-off.
// - purchase_order: delivery_date = the EARLIEST delivery date across all line items in YYYY-MM-DD format. Each line item must also carry its own delivery_date field (YYYY-MM-DD).
// - purchase_order: invoice_no = the PO Number as labeled on the document ('P.O. No.', 'PO No.', 'P.O. Number', etc.).
// - bank_statement: account_no = the account number. statement_from / statement_to = period start/end (YYYY-MM-DD). opening_balance / closing_balance from the summary section (negative for overdraft/debit balance as shown). total_debit = total withdrawals, total_credit = total deposits. invoice_date = statement download/generation date. Each transaction → line_item with date (YYYY-MM-DD), description (transaction remarks), amount (positive=credit, negative=debit). 
// Cap at 50 line items. Each description must be a single clean line — collapse any embedded newlines or line breaks into a single space. CRITICAL for signs: use the running balance column between consecutive rows to determine direction — if the balance decreases (becomes more negative), the transaction is a DEBIT (negative amount); if the balance increases (becomes less negative/more positive), it is a CREDIT (positive amount). Never guess sign from description keywords. Three exceptions that override the balance rule: (1) 'Int.Coll' = interest charged by the bank on the account = DEBIT = negative. (2) Any NEFT/RTGS/IMPS/INF transfer where 'LS TECHNOLOGIES' or 'L S TECHNOLOGIES' appears as the beneficiary/recipient in the description = money arriving INTO this account = CREDIT = positive. (3) opening_balance must be read from the 'Opening Bal' line in the Page Total or statement summary section at the end (NOT the balance shown after the first transaction row) — preserve its negative sign if the account is overdrawn.`;

// ── Shared JSON schema block (identical across every doc type) ──
const SCHEMA_BLOCK = `Return ONLY raw JSON (no markdown, no prose). Use null for any field not present:
{
  "doc_type": "freight_invoice | purchase_invoice | bill_of_entry | purchase_order | bank_statement | unknown",
  "invoice_no": string|null, "invoice_date": string|null,
  "party_name": string|null, "party_gstin": string|null, "buyer_gstin": string|null,
  "place_of_supply": string|null, "mawb_no": string|null, "flight_no": string|null,
  "commodity": string|null, "origin_airport": string|null, "dest_airport": string|null,
  "gross_weight": number|null, "supplier_ref": string|null,
  "taxable_value": number|null, "cgst": number|null, "sgst": number|null, "igst": number|null,
  "total_tax": number|null, "net_amount": number|null,
  "delivery_date": string|null,
  "account_no": string|null, "statement_from": string|null, "statement_to": string|null,
  "opening_balance": number|null, "closing_balance": number|null,
  "total_debit": number|null, "total_credit": number|null,
  "line_items": [{ "si_no": number|null, "tran_id": string|null, "description": string, "hsn": string|null, "qty": number|null, "uom": string|null, "rate": number|null, "amount": number|null, "date": string|null, "delivery_date": string|null }]
}`;

// ── Shared party identity rule (LS Technologies is always the buyer) ──
const PARTY_RULE = `party_name is ALWAYS the OTHER company — the issuer/counterparty — NEVER "L S Technologies" / "LS Technologies" (our client, the BUYER on every document regardless of how prominently its name appears). Identify the issuer by the LETTERHEAD/logo at the top, the "For, <COMPANY>" signature block, and the issuer's own GSTIN — NOT by the "M/S." or "Bill To" addressee (that is the buyer, LS Technologies).
party_gstin = the GSTIN beside party_name's company name. buyer_gstin = the GSTIN beside 'L S TECHNOLOGIES'. Test: for each GSTIN, read the company name next to it; if that name is LS Technologies → buyer_gstin, else → party_gstin. party_gstin must NEVER belong to LS Technologies.`;

const NUM_RULE = `Numbers plain (no commas/symbols). Dates YYYY-MM-DD. Some docs use IGST only, others CGST+SGST. net_amount is the final payable total after tax and round-off.`;

// ── Focused per-type prompts. hint_doc_type selects one; no hint → UNIVERSAL ──
const PROMPTS = {
  purchase_invoice: `You are a precise data extraction system for Indian GST purchase invoices (goods).
${SCHEMA_BLOCK}
Rules:
- doc_type is "purchase_invoice".
- ${PARTY_RULE}
- This is a Tax Invoice / GST Invoice / e-invoice for goods (it has an Invoice No., often an IRN or Ack No.). party_name is the supplier issuing it.
- Each goods line → line_item with description, hsn, qty, uom, rate, amount.
- ${NUM_RULE}`,

  freight_invoice: `You are a precise data extraction system for Indian freight / logistics invoices.
${SCHEMA_BLOCK}
Rules:
- doc_type is "freight_invoice".
- ${PARTY_RULE}
- This is a freight/logistics bill — expect MAWB, flight no., airport codes, CFS / agency / handling charges. Capture mawb_no, flight_no, origin_airport, dest_airport, commodity, gross_weight where present.
- Each charge line → line_item with its description and amount (these map to expense ledgers downstream).
- ${NUM_RULE}`,

  bill_of_entry: `You are a precise data extraction system for Indian customs Bills of Entry.
${SCHEMA_BLOCK}
Rules:
- doc_type is "bill_of_entry".
- ${PARTY_RULE}
- This is a customs bill of entry for an import. Capture mawb_no, flight_no, origin_airport, dest_airport, commodity where present.
- Each charge line (basic customs duty / BCD, IGST on import, freight, insurance) → line_item with a clear description and amount so it routes to the right import ledger.
- ${NUM_RULE}`,

//   purchase_order: `You are a precise data extraction system for Indian Purchase Orders.
// ${SCHEMA_BLOCK}
// Rules:
// - doc_type is "purchase_order".
// - party_name is the company in the LETTERHEAD who issued this PO (the buyer placing the order with LS Technologies as their vendor).
// - CRITICAL FOR GSTIN: In this document, "24AAKFL3607J1ZB" belongs to LS TECHNOLOGIES and MUST be mapped to buyer_gstin. "24AACCG5735H1ZQ" belongs to GELCO ELECTRONICS and MUST be mapped to party_gstin. Do not swap them.
// - invoice_no = the PO Number as labeled ('P.O. No.', 'PO No.', 'P.O. Number', etc.).
// - delivery_date = the EARLIEST delivery date across all line items (YYYY-MM-DD). Each line item must also carry its own delivery_date (YYYY-MM-DD).
// - Each ordered item → line_item with description, hsn, qty, uom, rate, amount, delivery_date.
// - ${NUM_RULE}`,

  purchase_order: `You are a precise data extraction system for Indian Purchase Orders.
${SCHEMA_BLOCK}
Rules:
- doc_type is "purchase_order".
- party_name is the company in the LETTERHEAD who issued this PO (the buyer placing the order with LS Technologies as their vendor).
- CRITICAL FOR GSTIN ASSIGNMENT: Identify the GSTIN explicitly associated with the company in the letterhead (the issuer/buyer) and assign it to "party_gstin". Identify the GSTIN explicitly associated with "LS TECHNOLOGIES" / "L S TECHNOLOGIES" and assign it to "buyer_gstin". Do not swap them based on document page reading order.
- invoice_no = the PO Number as labeled ('P.O. No.', 'PO No.', 'P.O. Number', etc.).
- delivery_date = the EARLIEST delivery date across all line items (YYYY-MM-DD). Each line item must also carry its own delivery_date (YYYY-MM-DD).
- Each ordered item → line_item with description, hsn, qty, uom, rate, amount, delivery_date.
- ${NUM_RULE}`,

  bank_statement: `You are a precise data extraction system for Indian bank statements.
${SCHEMA_BLOCK}
Rules:
- doc_type is "bank_statement".
- account_no = the account number. statement_from / statement_to = period start/end (YYYY-MM-DD). invoice_date = statement download/generation date.
- opening_balance / closing_balance from the summary section. total_debit = total withdrawals, total_credit = total deposits.
- Each transaction → line_item with si_no (the sequential SI No from the first column), date, description (transaction remarks), amount. Process all transactions present in the document sequentially. Each description must be a single clean line — collapse embedded newlines into a single space, and strictly remove or escape any raw double quotes (") or backslashes (\) to maintain valid JSON string boundaries.
- CRITICAL for signs: This is an Overdraft Account (Negative Baseline). Look at the 'Withdrawal (Dr)' and 'Deposit (Cr)' headers directly. Any transaction under 'Withdrawal (Dr)' MUST be formatted as a negative number. Any transaction under 'Deposit (Cr)' MUST be formatted as a positive number. Three overrides: (1) 'Int.Coll' = interest charged by the bank = DEBIT = negative. (2) Any NEFT/RTGS/IMPS/INF transfer where 'LS TECHNOLOGIES' / 'L S TECHNOLOGIES' is the beneficiary = money IN = CREDIT = positive. (3) opening_balance must be read from the 'Opening Bal' line in the Page Total / summary at the end (NOT the balance after the first row) — preserve its negative sign if overdrawn.
- ${NUM_RULE}`,
};

// Universal fallback — used only when no hint_doc_type is supplied (e.g. legacy callers).
const EXTRACTION_PROMPT = `You are a precise data extraction system for Indian GST documents.
${SCHEMA_BLOCK}
Rules:
- ${PARTY_RULE}
- doc_type — decide by these decisive structural tells, in priority order:
  1. Title contains "Purchase Order" or "P.O." AND there is NO invoice number / NO IRN / NO Ack No. → purchase_order (an order being placed, not a demand for payment; often has per-line delivery dates; holds even with GST/HSN/tax).
  2. Has an IRN or Ack No. (e-invoice), or titled "Tax Invoice" / "GST Invoice" with an Invoice No. → purchase_invoice (goods) — UNLESS dominated by freight/logistics charges.
  3. Freight/logistics bill with MAWB / airport / flight / CFS / agency charges → freight_invoice.
  4. Customs bill of entry → bill_of_entry. Bank account statement → bank_statement.
- purchase_order: delivery_date = EARLIEST line-item delivery date (YYYY-MM-DD); each line item carries its own delivery_date; invoice_no = the PO Number.
- bank_statement: account_no, statement_from/to (YYYY-MM-DD), opening_balance/closing_balance from summary (negative if overdrawn), total_debit = withdrawals, total_credit = deposits, invoice_date = download date. Each transaction → line_item with date, description, amount (positive=credit, negative=debit). Cap 50, single-line descriptions. Sign from running balance, not keywords; overrides: Int.Coll = debit; NEFT/RTGS/IMPS to LS Technologies = credit; opening_balance from the 'Opening Bal' summary line.
- ${NUM_RULE}`;

// Resolve a prompt from an optional hint, falling back to the universal prompt.
function promptFor(hint) {
  return (hint && PROMPTS[hint]) ? PROMPTS[hint] : EXTRACTION_PROMPT;
}


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
  const fence = '`'.repeat(3);
  if (raw.startsWith(fence)) raw = raw.split(fence).join('').replace(/^json/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) {
      let cleanStr = raw.slice(first, last + 1);
      cleanStr = cleanStr.replace(/\n/g, ' ').replace(/,\s*([\]}])/g, '$1');
      try { return JSON.parse(cleanStr); } catch (e2) {}
    }
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
    delivery_date: parsed.delivery_date || null,
    account_no: parsed.account_no || null,
    statement_from: parsed.statement_from || null,
    statement_to: parsed.statement_to || null,
    opening_balance: parsed.opening_balance ?? null,
    closing_balance: parsed.closing_balance ?? null,
    total_debit: parsed.total_debit ?? null,
    total_credit: parsed.total_credit ?? null,
  };
}

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

// async function parseInvoice(buffer, hint) {
//   const b64 = buffer.toString('base64');
//   const parsed = await callOpenRouter({
//     model: process.env.EXTRACTION_MODEL || 'google/gemini-2.5-flash',
//     temperature: 0,
//     messages: [{ role: 'user', content: [
//       { type: 'text', text: promptFor(hint) },
//       { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${b64}` } }
//     ]}],
//     max_tokens: 8192,
//     plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
//   });
//   return normalizeExtraction(parsed, hint);
// }

async function parseInvoice(buffer, hint) {
  const b64 = buffer.toString('base64');
  if (hint === 'bank_statement') {
    let aggregated = null;
    for (let page = 1; page <= 8; page++) {
      const parsed = await callOpenRouter({
        model: process.env.EXTRACTION_MODEL || 'google/gemini-2.5-flash',
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'text', text: promptFor(hint) + `\nCRITICAL: Process ONLY transactions listed under "--- PAGE ${page} ---". Ignore all other pages. If no transactions exist on this page, return an empty line_items array.` },
          { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${b64}` } }
        ]}],
        max_tokens: 8192,
        plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
      });
      if (!aggregated) { 
        aggregated = parsed; 
        if (!Array.isArray(aggregated.line_items)) aggregated.line_items = []; 
      } else if (parsed && Array.isArray(parsed.line_items)) { 
        aggregated.line_items.push(...parsed.line_items); 
      }
    }
    if (aggregated && Array.isArray(aggregated.line_items)) {
      const seenSis = new Set();
      aggregated.line_items = aggregated.line_items.filter(item => {
        if (!item.si_no) return true; // Safety fallback
        if (seenSis.has(item.si_no)) return false;
        seenSis.add(item.si_no);
        return true;
      });
    }
    return normalizeExtraction(aggregated || {}, hint);
  }
  const parsed = await callOpenRouter({
    model: process.env.EXTRACTION_MODEL || 'google/gemini-2.5-flash',
    temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: promptFor(hint) },
      { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${b64}` } }
    ]}],
    max_tokens: 8192,
    plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
  });
  return normalizeExtraction(parsed, hint);
}

async function runExtraction(invoiceId, buffer, hint, chatId = null) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  try {
    let inv;
    try {
      inv = await parseInvoice(buffer, hint);
    } catch (e1) {
      if (/json|unexpected token/i.test(e1.message)) {
        console.warn('Extraction parse failed for', invoiceId, '— retrying once');
        inv = await parseInvoice(buffer, hint);
      } else {
        throw e1;
      }
    }

    if ((hint === 'purchase_order' || inv.doc_type === 'purchase_order')) {
      const placeholder = await queryOne('SELECT uploaded_by, task_id, file_url FROM crm_invoices WHERE id=?', [invoiceId]);
      try {
        const po = await createPOFromExtraction(inv, placeholder?.uploaded_by || 'system', placeholder?.file_url || null);
        if (placeholder?.task_id) {
          await execute("UPDATE crm_tasks SET status='done', completed_at=?, title=? WHERE id=?",
            [nowIST(), `PO ${po.po_number} imported — review`, placeholder.task_id]);
        }
        await execute('DELETE FROM crm_invoices WHERE id=?', [invoiceId]);

        // Dispatch instant Telegram confirmation upon structural PO database commit
        if (chatId && botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `✅ *PO Imported Successfully!*\n\nPurchase Order *${po.po_number || 'Draft'}* has been parsed and logged. Your matched items are waiting for validation in the pipeline setup lifecycle layout.`,
              parse_mode: 'Markdown'
            })
          }).catch(e => console.error('Telegram notification routing crashed:', e.message));
        }
      } catch (poErr) {
        console.error('PO import failed for', invoiceId, poErr.message);
        await execute(
          `UPDATE crm_invoices SET status='extract_failed', extract_error=? WHERE id=?`,
          ['PO import failed: ' + classifyExtractError(poErr.message), invoiceId]
        );

        if (chatId && botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: `❌ *PO Processing Halted*\n\nYour purchase order failed to resolve database alignment models: _${poErr.message}_`,
              parse_mode: 'Markdown'
            })
          }).catch(() => {});
        }
      }
      return;
    }
    const xml = buildTallyXML(inv);
    await execute(
      `UPDATE crm_invoices SET
         doc_type=?, invoice_no=?, invoice_date=?, party_name=?, party_gstin=?, buyer_gstin=?,
         place_of_supply=?, mawb_no=?, flight_no=?, commodity=?, origin_airport=?, dest_airport=?,
         gross_weight=?, supplier_ref=?, taxable_value=?, cgst=?, sgst=?, igst=?, total_tax=?,
         net_amount=?, line_items=?, tally_xml=?,
         delivery_date=?, account_no=?, statement_from=?, statement_to=?,
         opening_balance=?, closing_balance=?, total_debit=?, total_credit=?,
         status='pending', extract_error=NULL
       WHERE id=?`,
      [
        inv.doc_type, inv.invoice_no, inv.invoice_date || null, inv.party_name, inv.party_gstin, inv.buyer_gstin,
        inv.place_of_supply, inv.mawb_no, inv.flight_no, inv.commodity, inv.origin_airport, inv.dest_airport,
        inv.gross_weight || null, inv.supplier_ref, inv.taxable_value || null, inv.cgst || null, inv.sgst || null,
        inv.igst || null, inv.total_tax || null, inv.net_amount || null,
        JSON.stringify(inv.line_items), xml,
        inv.delivery_date || null, inv.account_no || null,
        inv.statement_from || null, inv.statement_to || null,
        inv.opening_balance ?? null, inv.closing_balance ?? null,
        inv.total_debit ?? null, inv.total_credit ?? null,
        invoiceId
      ]
    );
    const t = `Approve invoice${inv.invoice_no ? ' ' + inv.invoice_no : ''} — Rs.${inv.net_amount || '?'}`;
    await execute('UPDATE crm_tasks SET title=? WHERE invoice_id=?', [t, invoiceId]);

    // Dispatch instant Telegram confirmation upon normal document status shift to 'pending'
    if (chatId && botToken) {
      const displayLabel = inv.invoice_no ? `Document No. *${inv.invoice_no}*` : 'Your dropped file';
      const cleanTypeLabel = (inv.doc_type || 'Document').replace('_', ' ').toUpperCase();
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `✅ *Processing Complete!*\n\n${displayLabel} has been successfully added to the system as a *${cleanTypeLabel}* and is awaiting your review and approval on the dashboard.`,
          parse_mode: 'Markdown'
        })
      }).catch(e => console.error('Telegram notification routing crashed:', e.message));
    }
  } catch (err) {
    console.error('Background extraction failed for', invoiceId, err.message);
    await execute(
      `UPDATE crm_invoices SET status='extract_failed', extract_error=? WHERE id=?`,
      [classifyExtractError(err.message), invoiceId]
    );

    // Pivot the stalled loading task title into a descriptive error alert on your dashboard timeline
    await execute(
      "UPDATE crm_tasks SET title = ? WHERE invoice_id = ? AND status = 'open'",
      ['⚠️ Extraction Failed — Review Error Log on Dashboard', invoiceId]
    );

    if (chatId && botToken) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `❌ *Extraction Failed*\n\nWe encountered an error reading your document. Please verify its content matrix layouts directly inside your web dashboard portal panel trackers.`,
          parse_mode: 'Markdown'
        })
      }).catch(() => {});
    }
  }
}

function resolveLedger(desc) {
  const d = (desc || '').toUpperCase();
  for (const { kw, ledger } of EXPENSE_LEDGER_MAP) {
    if (d.includes(kw)) return ledger;
  }
  return DEFAULT_EXPENSE_LEDGER;
}

function fmtDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const s = String(raw).replace(/\./g, '/');
  const m1 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m1) return `${m1[3]}${m1[2]}${m1[1]}`;
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}${m2[2]}${m2[3]}`;
  if (/^\d{8}$/.test(s)) return s;
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function n(v) { return parseFloat(v || 0); }
function amt(v) { return n(v).toFixed(2); }

function staticVarsTag() {
  return TALLY_COMPANY_NAME
    ? `<STATICVARIABLES><SVCURRENTCOMPANY>${TALLY_COMPANY_NAME}</SVCURRENTCOMPANY></STATICVARIABLES>`
    : '';
}

function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function entry(ledgerName, isDebit, amount, isParty = false, billRef = null) {
  const absAmt = Math.abs(n(amount)).toFixed(2);
  const sign   = isDebit ? '' : '-';
  const bill   = (isParty && billRef)
    ? `\n              <BILLALLOCATIONS.LIST>
                <NAME>${xmlEscape(billRef)}</NAME>
                <BILLTYPE>New Ref</BILLTYPE>
                <AMOUNT>${sign}${absAmt}</AMOUNT>
              </BILLALLOCATIONS.LIST>` : '';
  return `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(ledgerName)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              ${isParty ? '<ISPARTYLEDGER>Yes</ISPARTYLEDGER>' : ''}
              <AMOUNT>${sign}${absAmt}</AMOUNT>${bill}
            </ALLLEDGERENTRIES.LIST>`;
}

// Inventory entry: a stock line inside a Purchase voucher.
// Contains the stock movement (qty × rate = amount) AND its accounting allocation
// (debits the purchase ledger). Tally requires both halves inside one block.
function inventoryEntry(stockName, qty, rate, amount, accLedger, unit) {
  const unitStr = unit || 'pcs';
  const qtyStr  = `${n(qty) || 0} ${unitStr}`;
  const amtStr  = n(amount).toFixed(2);
  const rateStr = rate ? `${n(rate)}/${unitStr}` : '';
  return `
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${xmlEscape(stockName)}</STOCKITEMNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              ${rateStr ? `<RATE>${xmlEscape(rateStr)}</RATE>` : ''}
              <ACTUALQTY>${qtyStr}</ACTUALQTY>
              <BILLEDQTY>${qtyStr}</BILLEDQTY>
              <AMOUNT>${amtStr}</AMOUNT>
              <ACCOUNTINGALLOCATIONS.LIST>
                <LEDGERNAME>${xmlEscape(accLedger)}</LEDGERNAME>
                <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
                <AMOUNT>${amtStr}</AMOUNT>
              </ACCOUNTINGALLOCATIONS.LIST>
            </ALLINVENTORYENTRIES.LIST>`;
}

function envelope(voucherXML) {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        ${staticVarsTag()}
      </REQUESTDESC>
      <REQUESTDATA>
        ${voucherXML}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function buildPurchaseXML(inv) {
  const party     = inv.party_name || 'Unknown Supplier';
  const invoiceNo = inv.invoice_no || '';
  const date      = fmtDate(inv.invoice_date);
  const cgst      = n(inv.cgst);
  const sgst      = n(inv.sgst);
  const igst      = n(inv.igst);
  const purchaseLedger = inv.purchase_ledger || (igst > 0 ? PURCHASE_INTRA : PURCHASE_LOCAL);
  const items = typeof inv.line_items === 'string'
    ? (() => { try { return JSON.parse(inv.line_items); } catch { return []; } })()
    : (inv.line_items || []);

  // Lines can be 'stock' (→ inventory entry) or 'expense' (→ direct ledger entry).
  // Back-compat: if no line has a 'kind' field, fall back to a single aggregate
  // purchase-ledger entry using taxable_value — preserves the original behavior
  // for invoices created before the hybrid model.
  let lineEntries = '';
  let linesSum = 0;
  const hasKind = items.length > 0 && items.some(it => it.kind);
  if (hasKind) {
    for (const it of items) {
      const amt = n(it.amount);
      if (!amt) continue;
      if (it.kind === 'stock' && it.stock_item_name) {
        lineEntries += inventoryEntry(it.stock_item_name, it.qty, it.rate, amt, purchaseLedger, it.uom);
      } else {
        const ledger = it.ledger || resolveLedger(it.description || '');
        lineEntries += entry(ledger, true, amt);
      }
      linesSum += amt;
    }
  } else {
    const taxable = n(inv.taxable_value);
    lineEntries = entry(purchaseLedger, true, taxable);
    linesSum = taxable;
  }

  const net = linesSum + cgst + sgst + igst;
  const narration = [
    invoiceNo && `Inv: ${invoiceNo}`,
    inv.mawb_no && `MAWB: ${inv.mawb_no}`,
    inv.commodity,
  ].filter(Boolean).join(' | ');
  const voucher = `<TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create"${invoiceNo ? ` REMOTEID="${invoiceNo}"` : ''}>
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(invoiceNo)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>
            <NARRATION>${xmlEscape(narration)}</NARRATION>
            ${lineEntries}
            ${cgst > 0 ? entry(CGST_LEDGER, true, cgst) : ''}
            ${sgst > 0 ? entry(SGST_LEDGER, true, sgst) : ''}
            ${igst > 0 ? entry(IGST_LEDGER, true, igst) : ''}
            ${entry(party, false, net, true, invoiceNo || null)}
          </VOUCHER>
        </TALLYMESSAGE>`;
  return envelope(voucher);
}

function buildFreightXML(inv) {
  const party     = inv.party_name || 'Unknown Freight Agent';
  const invoiceNo = inv.invoice_no || '';
  const date      = fmtDate(inv.invoice_date);
  const cgst      = n(inv.cgst);
  const sgst      = n(inv.sgst);
  const igst      = n(inv.igst);
  const items = typeof inv.line_items === 'string'
    ? (() => { try { return JSON.parse(inv.line_items); } catch { return []; } })()
    : (inv.line_items || []);
  const itemsSum = items.length > 0
    ? items.reduce((s, it) => s + n(it.amount), 0)
    : n(inv.taxable_value);
  const net       = itemsSum + cgst + sgst + igst;
  const expenseEntries = items.length > 0
    ? items.map(it => entry(resolveLedger(it.description || ''), true, n(it.amount))).join('')
    : entry(DEFAULT_EXPENSE_LEDGER, true, n(inv.taxable_value));
  const narration = [
    invoiceNo && `Inv: ${invoiceNo}`,
    inv.mawb_no && `MAWB: ${inv.mawb_no}`,
    inv.flight_no && `Flight: ${inv.flight_no}`,
    inv.commodity,
  ].filter(Boolean).join(' | ');
  const voucher = `<TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create"${invoiceNo ? ` REMOTEID="${invoiceNo}"` : ''}>
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(invoiceNo)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>
            <NARRATION>${xmlEscape(narration)}</NARRATION>
            ${expenseEntries}
            ${cgst > 0 ? entry(CGST_LEDGER, true, cgst) : ''}
            ${sgst > 0 ? entry(SGST_LEDGER, true, sgst) : ''}
            ${igst > 0 ? entry(IGST_LEDGER, true, igst) : ''}
            ${entry(party, false, net, true, invoiceNo || null)}
          </VOUCHER>
        </TALLYMESSAGE>`;
  return envelope(voucher);
}

function buildBOEXML(inv) {
  const party     = inv.party_name || 'Unknown Customs Agent';
  const invoiceNo = inv.invoice_no || '';
  const date      = fmtDate(inv.invoice_date);
  const net       = n(inv.net_amount);
  const items = typeof inv.line_items === 'string'
    ? (() => { try { return JSON.parse(inv.line_items); } catch { return []; } })()
    : (inv.line_items || []);
  let expenseEntries = '';
  if (items.length > 0) {
    expenseEntries = items.map(it => {
      const desc = (it.description || '').toUpperCase();
      let ledger;
      if (desc.includes('CUSTOMS') || desc.includes('BCD') || desc.includes('BASIC DUTY')) {
        ledger = CUSTOMS_DUTY_LEDGER;
      } else if (desc.includes('IGST') || desc.includes('GST')) {
        ledger = IGST_IMPORT_LEDGER;
      } else if (desc.includes('FREIGHT') || desc.includes('TRANSPORT')) {
        ledger = FREIGHT_IMPORT_LDG;
      } else if (desc.includes('INSURANCE')) {
        ledger = INSURANCE_IMPORT_LDG;
      } else {
        ledger = PURCHASE_IMPORT;
      }
      return entry(ledger, true, n(it.amount));
    }).join('');
  } else {
    const taxable  = n(inv.taxable_value);
    const igst     = n(inv.igst);
    const totalIGST = igst + n(inv.cgst) + n(inv.sgst);
    if (taxable > 0)   expenseEntries += entry(PURCHASE_IMPORT,    true, taxable);
    if (totalIGST > 0) expenseEntries += entry(IGST_IMPORT_LEDGER, true, totalIGST);
    const duty = net - taxable - totalIGST;
    if (duty > 0.01)   expenseEntries += entry(CUSTOMS_DUTY_LEDGER, true, duty);
  }
  const narration = [
    invoiceNo && `BOE: ${invoiceNo}`,
    inv.mawb_no && `MAWB: ${inv.mawb_no}`,
    inv.flight_no && `Flight: ${inv.flight_no}`,
    inv.commodity,
    inv.origin_airport && inv.dest_airport && `${inv.origin_airport} → ${inv.dest_airport}`,
  ].filter(Boolean).join(' | ');
  const voucher = `<TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create"${invoiceNo ? ` REMOTEID="${invoiceNo}"` : ''}>
            <DATE>${date}</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(invoiceNo)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(party)}</PARTYLEDGERNAME>
            <NARRATION>${xmlEscape(narration)}</NARRATION>
            ${expenseEntries}
            ${entry(party, false, net, true, invoiceNo || null)}
          </VOUCHER>
        </TALLYMESSAGE>`;
  return envelope(voucher);
}

function buildBankStatementXML(inv) {
  const items = typeof inv.line_items === 'string'
    ? (() => { try { return JSON.parse(inv.line_items); } catch { return []; } })()
    : (inv.line_items || []);
  if (!items.length) return '';
  const baseDate = fmtDate(inv.invoice_date);
  const vouchers = items
    .filter(it => n(it.amount) !== 0)
    .map((it, idx) => {
      const txnAmt  = n(it.amount);
      const absAmt  = Math.abs(txnAmt).toFixed(2);
      const isCredit= txnAmt > 0;
      const vchType = isCredit ? 'Receipt' : 'Payment';
      const narr    = xmlEscape(it.description || `Bank txn ${idx + 1}`);
      const txnDate = it.date ? fmtDate(it.date) : baseDate;
      const bankLedger    = inv.bank_ledger || BANK_LEDGER;
      const bankEntry     = isCredit
        ? entry(bankLedger,      true,  absAmt)
        : entry(bankLedger,      false, absAmt);
      const suspenseEntry = isCredit
        ? entry(SUSPENSE_LEDGER, false, absAmt)
        : entry(SUSPENSE_LEDGER, true,  absAmt);
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${vchType}" ACTION="Create">
            <DATE>${txnDate}</DATE>
            <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
            <NARRATION>${narr}</NARRATION>
            ${bankEntry}
            ${suspenseEntry}
          </VOUCHER>
        </TALLYMESSAGE>`;
    });
  if (!vouchers.length) return '';
  return envelope(vouchers.join('\n        '));
}

function buildTallyXML(inv) {
  switch (inv.doc_type) {
    case 'purchase_invoice': return buildPurchaseXML(inv);
    case 'freight_invoice':  return buildFreightXML(inv);
    case 'bill_of_entry':    return buildBOEXML(inv);
    case 'bank_statement':   return buildBankStatementXML(inv);
    default:                 return '';
  }
}

const VALID_HINTS = ['purchase_invoice', 'freight_invoice', 'bill_of_entry', 'purchase_order', 'bank_statement'];

router.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  const hint = VALID_HINTS.includes(req.body.hint_doc_type) ? req.body.hint_doc_type : null;
  try {
    // Standardize file keys to avoid spatial character rendering glitches inside iframe viewport containers
    const fileKey = `${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`;
    
    // 1. Push raw binary buffer directly to Cloudflare R2 bucket lanes
    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileKey,
      Body: req.file.buffer,
      ContentType: 'application/pdf'
    }));

    // Clean domain wrapper to strip any trailing/leading protocol schemas entered by mistake
    const cleanDomain = (process.env.R2_PUBLIC_DOMAIN_URL || '').trim().replace(/^https?:\/\//i, '');
    const generatedUrl = `https://${cleanDomain}/${fileKey}`;

    // 2. Log record tracking details inside Turso alongside its cloud access URL path
    const result = await execute(
      `INSERT INTO crm_invoices (uploaded_by, original_filename, doc_type, status, line_items, tally_xml, file_url)
       VALUES (?, ?, ?, 'reading', '[]', '', ?)`,
      [req.user.username, req.file.originalname, hint || null, generatedUrl]
    );
    const invoiceId = Number(result.lastId);
    const taskResult = await execute(
      `INSERT INTO crm_tasks (title, due_date, status, assigned_to, created_by, created_at, invoice_id)
       VALUES (?, ?, 'open', ?, ?, ?, ?)`,
      [`Reading ${req.file.originalname}…`, nowIST().substring(0, 10),
       req.user.username, req.user.username, nowIST(), invoiceId]
    );
    await execute('UPDATE crm_invoices SET task_id = ? WHERE id = ?',
      [Number(taskResult.lastId), invoiceId]);
    res.json({ success: true, invoiceId, status: 'reading' });
    runExtraction(invoiceId, req.file.buffer, hint);
  } catch (err) {
    console.error('Invoice upload error:', err);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

router.get('/:id/status', async (req, res) => {
  const inv = await queryOne(
    'SELECT id, status, invoice_no, net_amount, extract_error FROM crm_invoices WHERE id = ?',
    [req.params.id]
  );
  if (!inv) return res.status(404).json({ error: 'Not found' });
  res.json(inv);
});

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

router.get('/', async (req, res) => {
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

// Synced stock items (refreshed every 15 min by the agent). Optionally filter by parent group.
router.get('/tally-stock-items', async (req, res) => {
  const group = req.query.group;
  const sql = group
    ? 'SELECT name, parent, base_units FROM crm_tally_stock_items WHERE parent = ? ORDER BY name'
    : 'SELECT name, parent, base_units FROM crm_tally_stock_items ORDER BY parent, name';
  const rows = await queryAll(sql, group ? [group] : []);
  res.json(rows);
});

router.get('/:id/checks', async (req, res) => {
  const inv = await queryOne('SELECT * FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  const out = { duplicates: [], unknownLedgers: [], ledgerSynced: false };
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
  const ledgerCount = await queryOne('SELECT COUNT(*) AS n FROM crm_tally_ledgers');
  out.ledgerSynced = (ledgerCount?.n || 0) > 0;
  if (out.ledgerSynced) {
    const known = new Set(
      (await queryAll('SELECT name FROM crm_tally_ledgers')).map(r => (r.name || '').toLowerCase().trim())
    );
    const items = typeof inv.line_items === 'string'
      ? (() => { try { return JSON.parse(inv.line_items); } catch { return []; } })()
      : (inv.line_items || []);
    const used = new Set();
    for (const it of items) used.add(resolveLedger(it.description || ''));
    if (inv.party_name) used.add(inv.party_name);
    if (inv.doc_type === 'bill_of_entry') {
      if (n(inv.igst) > 0) used.add(IGST_IMPORT_LEDGER);
      used.add(CUSTOMS_DUTY_LEDGER);
    } else {
      if (n(inv.cgst) > 0) used.add(CGST_LEDGER);
      if (n(inv.sgst) > 0) used.add(SGST_LEDGER);
      if (n(inv.igst) > 0) used.add(IGST_LEDGER);
    }
    out.unknownLedgers = [...used].filter(l => l && !known.has(l.toLowerCase().trim()));
  }
  res.json(out);
});

router.get('/:id', async (req, res) => {
  const inv = await queryOne('SELECT * FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (typeof inv.line_items === 'string') {
    try { inv.line_items = JSON.parse(inv.line_items); } catch { inv.line_items = []; }
  }
  res.json(inv);
});

router.put('/:id', async (req, res) => {
  const allowed = ['doc_type','invoice_no','invoice_date','party_name','party_gstin','buyer_gstin',
    'place_of_supply','taxable_value','cgst','sgst','igst','net_amount',
    'mawb_no','flight_no','commodity','supplier_ref','line_items','review_notes',
    'bank_ledger','purchase_ledger',
    'delivery_date','account_no','statement_from','statement_to',
    'opening_balance','closing_balance','total_debit','total_credit'];
  const fields = {}, params = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) { fields[k] = req.body[k]; }
  }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Nothing to update' });
  const existing = await queryOne('SELECT * FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const merged = { ...existing, ...fields };
  if (typeof merged.line_items === 'string') {
    try { merged.line_items = JSON.parse(merged.line_items); } catch { merged.line_items = []; }
  }
  // fields.tally_xml = buildTallyXML(merged);
  // if (typeof fields.line_items !== 'string') fields.line_items = JSON.stringify(fields.line_items || []);
  // const sets   = Object.keys(fields).map(k => `${k} = ?`).join(', ');

  fields.tally_xml = buildTallyXML(merged);
  
  // Deduplicate transaction rows for Bank Statements dynamically before saving
  if (typeof fields.line_items !== 'string' && fields.line_items) {
    if (merged.doc_type === 'bank_statement') {
      const uniqueLines = [];
      const seenSignatures = new Set();
      
      for (const row of fields.line_items) {
        const fingerprint = `${row.date || ''}_${(row.description || '').trim()}_${row.amount || 0}`;
        if (!seenSignatures.has(fingerprint)) {
          seenSignatures.add(fingerprint);
          uniqueLines.push(row);
        }
      }
      fields.line_items = uniqueLines;
    }
    fields.line_items = JSON.stringify(fields.line_items || []);
  } else if (typeof fields.line_items === 'string' && merged.doc_type === 'bank_statement') {
    // Handling case if it arrives pre-stringified
    try {
      const parsedLines = JSON.parse(fields.line_items);
      const uniqueLines = [];
      const seenSignatures = new Set();
      for (const row of parsedLines) {
        const fingerprint = `${row.date || ''}_${(row.description || '').trim()}_${row.amount || 0}`;
        if (!seenSignatures.has(fingerprint)) {
          seenSignatures.add(fingerprint);
          uniqueLines.push(row);
        }
      }
      fields.line_items = JSON.stringify(uniqueLines);
    } catch(e) {}
  }
  
  const sets   = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = [...Object.values(fields), req.params.id];
  await execute(`UPDATE crm_invoices SET ${sets} WHERE id = ?`, values);
  res.json({ success: true });
});

router.post('/:id/approve', async (req, res) => {
  const notes = req.body.notes || '';
  await execute(
    `UPDATE crm_invoices SET status = 'approved', review_notes = ?, approved_at = ? WHERE id = ?`,
    [notes, nowIST(), req.params.id]
  );
  const inv = await queryOne('SELECT task_id FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (inv?.task_id) {
    await execute("UPDATE crm_tasks SET status = 'done', completed_at = ? WHERE id = ?",
      [nowIST(), inv.task_id]);
  }
  res.json({ success: true, message: 'Invoice approved. Local agent will push to Tally.' });
});

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

// DELETE /api/invoices/attachment — Wipe standalone transaction line attachment from R2 bucket
router.delete('/attachment', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No attachment URL provided' });
  try {
    // Isolate the unique cloud hash key filename from the public storage URL path string
    const key = url.split('/').pop();
    
    await r2Client.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key
    }));
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to purge attachment from R2:', err.message);
    res.status(500).json({ error: 'Failed to delete file from cloud storage' });
  }
});

router.delete('/:id', async (req, res) => {
  // Pull both status and file_url coordinates to evaluate object lifecycles accurately
  const inv = await queryOne('SELECT status, file_url FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });

  if (inv.status === 'pushed') {
    // Soft delete: Find and close ALL active tasks linked to this specific invoice layout
    await execute(
      "UPDATE crm_tasks SET status='done', completed_at=? WHERE invoice_id=? AND status!='done'",
      [nowIST(), req.params.id]
    );
    await execute('UPDATE crm_invoices SET deleted_at = ? WHERE id = ?', [nowIST(), req.params.id]);
    return res.json({ 
      success: true, 
      soft: true,
      message: 'Record was pushed to Tally — archived, not erased. Reverse the voucher in Tally if needed.' 
    });
  }

  // Hard delete: Physically purge the main document file from Cloudflare R2 first if a cloud path exists
  if (inv.file_url) {
    try {
      const key = inv.file_url.split('/').pop();
      await r2Client.send(new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key
      }));
    } catch (r2Err) {
      console.error('Failed to purge document from R2 on hard delete:', r2Err.message);
    }
  }

  // Clean up database rows safely
  await execute('DELETE FROM crm_tasks WHERE invoice_id = ?', [req.params.id]);
  await execute('DELETE FROM crm_invoices WHERE id = ?', [req.params.id]);
  res.json({ success: true, soft: false });
});

router.get('/:id/xml', async (req, res) => {
  const inv = await queryOne('SELECT invoice_no, tally_xml FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv?.tally_xml) return res.status(404).json({ error: 'No XML found' });
  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Content-Disposition', `attachment; filename="tally_${inv.invoice_no || req.params.id}.xml"`);
  res.send(inv.tally_xml);
});

// Interactive Telegram Bot Webhook Integration with Inline Buttons
router.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge instantly to prevent Telegram timeout retry loops

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const { message, callback_query } = req.body || {};

  // Scenario 1: User sends a brand new PDF document
  if (message?.document && message.document.mime_type === 'application/pdf') {
    const doc = message.document;
    const senderName = `Telegram: ${message.from?.username || message.from?.first_name || 'User'}`;
    const filename = doc.file_name || 'telegram_upload.pdf';

    try {
      // Create a temporary placeholder row, saving the file_id inside tally_xml column to handle state
      const result = await execute(
        `INSERT INTO crm_invoices (uploaded_by, original_filename, doc_type, status, line_items, tally_xml)
         VALUES (?, ?, null, 'pending_type', '[]', ?)`,
        [senderName, filename, doc.file_id]
      );
      const invoiceId = Number(result.lastId);

      // Push an interactive inline keyboard choice panel to the user's mobile screen
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: message.chat.id,
          text: `📄 Received file: *${filename}*\n\nPlease select the document classification type to begin parsing:`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🏦 Bank Statement', callback_data: `tg_act:bank_statement:${invoiceId}` },
                { text: '🛒 Purchase Order', callback_data: `tg_act:purchase_order:${invoiceId}` }
              ],
              [
                { text: '📄 Invoice...', callback_data: `tg_sub:invoice:${invoiceId}` },
                { text: '🛃 Bill of Entry', callback_data: `tg_act:bill_of_entry:${invoiceId}` }
              ]
            ]
          }
        })
      });
    } catch (err) {
      console.error('Telegram tracking initialization failed:', err.message);
    }
    return;
  }

  // Scenario 2: User taps an option button on their inline keyboard layout
  if (callback_query?.data) {
    const dataStr = callback_query.data;
    if (!dataStr.startsWith('tg_')) return;

    const chatId = callback_query.message?.chat?.id;
    const messageId = callback_query.message?.message_id;

    // Submenu router fork logic: User tapped the top-tier Invoice item button
    if (dataStr.startsWith('tg_sub:invoice:')) {
      const invoiceId = dataStr.split(':')[2];
      try {
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `📄 Select the specific invoice type:`,
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🛍️ Purchase Invoice', callback_data: `tg_act:purchase_invoice:${invoiceId}` },
                  { text: '🚚 Freight / Logistics', callback_data: `tg_act:freight_invoice:${invoiceId}` }
                ]
              ]
            }
          })
        });
      } catch (err) {
        console.error('Telegram invoice submenu display failed:', err.message);
      }
      return;
    }

    // Direct Action routing layer execution block
    if (dataStr.startsWith('tg_act:')) {
      const [_, hint, invoiceId] = dataStr.split(':');

      try {
        // 1. Fetch the entry back to resolve our cached file tracking ID
        const inv = await queryOne('SELECT original_filename, tally_xml FROM crm_invoices WHERE id = ?', [invoiceId]);
        if (!inv || !inv.tally_xml) return;

        const fileId = inv.tally_xml;
        const filename = inv.original_filename;

        // 2. Clear the scratch space, set classification target, and advance ingestion status
        await execute(
          `UPDATE crm_invoices SET doc_type = ?, status = 'reading', tally_xml = '' WHERE id = ?`,
          [hint, invoiceId]
        );

        await execute(
          `INSERT INTO crm_tasks (title, due_date, status, assigned_to, created_by, created_at, invoice_id)
           VALUES (?, ?, 'open', 'system', 'system', ?, ?)`,
          [`Review Telegram upload: ${filename}`, nowIST().substring(0, 10), nowIST(), invoiceId]
        );

        // Instantly modify the Telegram message to give visual progress confirmation.
        await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            text: `⚙️ Processing *${filename}* as a *${hint.replace('_', ' ').toUpperCase()}*...`
          })
        });

        // 3. Request actual content delivery routes from Telegram master API nodes
        const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
        const fileInfo = await fileInfoRes.json();
        if (!fileInfo.ok || !fileInfo.result?.file_path) return;

        const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${fileInfo.result.file_path}`);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // Instantly stream incoming Telegram chat document vectors to Cloudflare before spinning background processing workers
        const tgKey = `${Date.now()}-${filename.replace(/\s+/g, '_')}`;
        await r2Client.send(new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: tgKey,
          Body: buffer,
          ContentType: 'application/pdf'
        }));

        // Clean domain wrapper to strip any trailing/leading protocol schemas entered by mistake
        const cleanTgDomain = (process.env.R2_PUBLIC_DOMAIN_URL || '').trim().replace(/^https?:\/\//i, '');
        const tgUrl = `https://${cleanTgDomain}/${tgKey}`;
        await execute('UPDATE crm_invoices SET file_url = ? WHERE id = ?', [tgUrl, invoiceId]);

        // 4. Delegate to your production multimodal extraction worker pool asynchronously with active Chat ID state tracking variables
        runExtraction(invoiceId, buffer, hint, chatId);
      } catch (err) {
        console.error('Telegram button event lifecycle processing failed:', err.message);
      }
    }
  }
});

// POST /api/invoices/attachment — Upload standalone sub-vouchers/receipt attachments per transaction line
router.post('/attachment', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No attachment provided' });
  try {
    const attachmentKey = `tx-${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`;
    
    // Stream raw file buffer directly into your permanent Cloudflare R2 bucket
    await r2Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: attachmentKey,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'application/pdf'
    }));

    // Clean domain wrapper to strip any trailing/leading protocol schemas entered by mistake
    const cleanAttachmentDomain = (process.env.R2_PUBLIC_DOMAIN_URL || '').trim().replace(/^https?:\/\//i, '');
    const url = `https://${cleanAttachmentDomain}/${attachmentKey}`;
    res.json({ success: true, file_url: url });
  } catch (err) {
    console.error('Line attachment streaming crashed:', err.message);
    res.status(500).json({ error: 'Failed to preserve attachment: ' + err.message });
  }
});

module.exports = router;