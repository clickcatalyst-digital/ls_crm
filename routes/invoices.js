// routes/invoices.js
// Handles PDF upload, extraction, approval, and Tally XML generation.
// npm install multer

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { queryAll, queryOne, execute, nowIST } = require('../db/schema');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
  "delivery_date": string|null,
  "account_no": string|null, "statement_from": string|null, "statement_to": string|null,
  "opening_balance": number|null, "closing_balance": number|null,
  "total_debit": number|null, "total_credit": number|null,
  "line_items": [{ "description": string, "hsn": string|null, "qty": number|null, "uom": string|null, "rate": number|null, "amount": number|null, "date": string|null, "delivery_date": string|null }]
}
Rules:
- party_name is ALWAYS the OTHER company — the issuer/counterparty — NEVER "L S Technologies" / "LS Technologies" (that entity is our client and is the BUYER on every document, regardless of how prominently its name appears).
- Identify the issuer by the LETTERHEAD/logo at the top, the "For, <COMPANY>" signature block, and the issuer's own GSTIN — NOT by the "M/S." or "Bill To" addressee, which is the buyer (L S Technologies).
- A document addressed "M/S. L S TECHNOLOGIES" is addressed TO our client; the party_name is whoever ISSUED it (e.g. the company in the letterhead).
- For invoices/bills: party_name is the supplier issuing it. For a purchase_order: party_name is the company in the LETTERHEAD who issued this PO (they are the buyer placing the order with LS Technologies as their vendor).
- party_gstin = the GSTIN that appears alongside or is directly associated with party_name's company name in the document. buyer_gstin = the GSTIN that appears alongside or is directly associated with 'L S TECHNOLOGIES' / 'LS TECHNOLOGIES' in the document. Simple test: look at each GSTIN on the page, identify the company name next to it, then assign: if the adjacent company name is L S Technologies → buyer_gstin; if it is party_name → party_gstin. party_gstin must NEVER belong to L S Technologies.
- doc_type — decide by these decisive structural tells, in priority order:
  1. If the document title contains "Purchase Order" or "P.O." AND there is NO invoice number / NO IRN / NO Ack No., it is purchase_order. A PO is an order being placed, not a demand for payment; it often has per-line delivery dates. This holds even if it has GST, HSN, and tax breakdowns.
  2. If it has an IRN or Ack No. (e-invoice), or is titled "Tax Invoice" / "GST Invoice" with an Invoice No., it is purchase_invoice (for goods) — UNLESS it is dominated by freight/logistics charges.
  3. A freight/logistics bill with MAWB / airport / flight / CFS / agency charges = freight_invoice.
  4. A customs bill of entry = bill_of_entry. A bank account statement = bank_statement.
- Numbers plain (no commas/symbols). Some docs use IGST only, others CGST+SGST. net_amount is the final payable total after tax and round-off.
- purchase_order: delivery_date = the EARLIEST delivery date across all line items in YYYY-MM-DD format. Each line item must also carry its own delivery_date field (YYYY-MM-DD).
- purchase_order: invoice_no = the PO Number as labeled on the document ('P.O. No.', 'PO No.', 'P.O. Number', etc.).
- bank_statement: account_no = the account number. statement_from / statement_to = period start/end (YYYY-MM-DD). opening_balance / closing_balance from the summary section (negative for overdraft/debit balance as shown). total_debit = total withdrawals, total_credit = total deposits. invoice_date = statement download/generation date. Each transaction → line_item with date (YYYY-MM-DD), description (transaction remarks), amount (positive=credit, negative=debit). 
Cap at 50 line items. Each description must be a single clean line — collapse any embedded newlines or line breaks into a single space. CRITICAL for signs: use the running balance column between consecutive rows to determine direction — if the balance decreases (becomes more negative), the transaction is a DEBIT (negative amount); if the balance increases (becomes less negative/more positive), it is a CREDIT (positive amount). Never guess sign from description keywords. Three exceptions that override the balance rule: (1) 'Int.Coll' = interest charged by the bank on the account = DEBIT = negative. (2) Any NEFT/RTGS/IMPS/INF transfer where 'LS TECHNOLOGIES' or 'L S TECHNOLOGIES' appears as the beneficiary/recipient in the description = money arriving INTO this account = CREDIT = positive. (3) opening_balance must be read from the 'Opening Bal' line in the Page Total or statement summary section at the end (NOT the balance shown after the first transaction row) — preserve its negative sign if the account is overdrawn.`;


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

async function parseInvoice(buffer) {
  const b64 = buffer.toString('base64');
  const parsed = await callOpenRouter({
    model: process.env.EXTRACTION_MODEL || 'google/gemini-2.5-flash',
    temperature: 0,
    messages: [{ role: 'user', content: [
      { type: 'text', text: EXTRACTION_PROMPT },
      { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${b64}` } }
    ]}],
    max_tokens: 8192,
    plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
  });
  return normalizeExtraction(parsed);
}

async function runExtraction(invoiceId, buffer) {
  try {
    let inv;
    try {
      inv = await parseInvoice(buffer);
    } catch (e1) {
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
    if (inv.doc_type === 'purchase_order' && inv.delivery_date) {
      const uploader = await queryOne('SELECT uploaded_by FROM crm_invoices WHERE id=?', [invoiceId]);
      await execute(
        `INSERT INTO crm_tasks (title, due_date, status, assigned_to, created_by, created_at, invoice_id)
         VALUES (?, ?, 'open', ?, 'system', ?, ?)`,
        [
          `Delivery due: ${inv.invoice_no || 'PO'} — ${inv.party_name || 'supplier'}`,
          inv.delivery_date,
          uploader?.uploaded_by || 'system',
          nowIST(), invoiceId,
        ]
      );
    }
  } catch (err) {
    console.error('Background extraction failed for', invoiceId, err.message);
    await execute(
      `UPDATE crm_invoices SET status='extract_failed', extract_error=? WHERE id=?`,
      [classifyExtractError(err.message), invoiceId]
    );
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

router.post('/upload', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });
  try {
    const result = await execute(
      `INSERT INTO crm_invoices (uploaded_by, original_filename, status, line_items, tally_xml)
       VALUES (?, ?, 'reading', '[]', '')`,
      [req.user.username, req.file.originalname]
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
    runExtraction(invoiceId, req.file.buffer);
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
  fields.tally_xml = buildTallyXML(merged);
  if (typeof fields.line_items !== 'string') fields.line_items = JSON.stringify(fields.line_items || []);
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

router.delete('/:id', async (req, res) => {
  const inv = await queryOne('SELECT status, task_id FROM crm_invoices WHERE id = ?', [req.params.id]);
  if (!inv) return res.status(404).json({ error: 'Not found' });
  if (inv.task_id) {
    await execute("UPDATE crm_tasks SET status='done', completed_at=? WHERE id=? AND status!='done'",
      [nowIST(), inv.task_id]);
  }
  if (inv.status === 'pushed') {
    await execute('UPDATE crm_invoices SET deleted_at = ? WHERE id = ?', [nowIST(), req.params.id]);
    return res.json({ success: true, soft: true,
      message: 'Record was pushed to Tally — archived, not erased. Reverse the voucher in Tally if needed.' });
  }
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

module.exports = router;