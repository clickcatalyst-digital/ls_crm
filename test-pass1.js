#!/usr/bin/env node
// node scripts/test-extract.js path/to/doc.pdf [another.pdf …]
// Runs the extraction prompt against real PDFs and prints raw JSON output.
// Tweak PROMPT here first; once satisfied, copy it into routes/invoices.js.
require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const MODEL = process.env.EXTRACTION_MODEL || 'deepseek/deepseek-v4-flash:free';

const PROMPT = `You are a precise data extraction system for Indian GST documents.
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
- purchase_order: invoice_no = the PO Number as labeled on the document ('P.O. No.', 'PO No.', 'P.O. Number', etc.).
- purchase_order: delivery_date = the EARLIEST delivery date across all line items in YYYY-MM-DD format. Each line item must also carry its own delivery_date field (YYYY-MM-DD).
- bank_statement: account_no = the account number. statement_from / statement_to = period start/end (YYYY-MM-DD). opening_balance / closing_balance from the summary section (use negative values for overdraft/debit balances as shown). total_debit = total withdrawals, total_credit = total deposits. invoice_date = statement download/generation date. Each transaction → line_item with date (YYYY-MM-DD), description (transaction remarks), amount (positive = credit/deposit, negative = debit/withdrawal). Cap at 50 line items. Each description must be a single clean line — collapse any embedded newlines or line breaks into a single space. CRITICAL for signs: use the running balance column between consecutive rows to determine direction — if the balance decreases (becomes more negative), the transaction is a DEBIT (negative amount); if the balance increases (becomes less negative/more positive), it is a CREDIT (positive amount). Never guess sign from description keywords. Three exceptions that override the balance rule: (1) 'Int.Coll' = interest charged by the bank on the account = DEBIT = negative. (2) Any NEFT/RTGS/IMPS/INF transfer where 'LS TECHNOLOGIES' or 'L S TECHNOLOGIES' appears as the beneficiary/recipient in the description = money arriving INTO this account = CREDIT = positive. (3) opening_balance must be read from the 'Opening Bal' line in the Page Total or statement summary section at the end (NOT the balance shown after the first transaction row) — preserve its negative sign if the account is overdrawn.`;

async function callOpenRouter(buffer) {
  const b64 = buffer.toString('base64');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'file', file: { filename: 'doc.pdf', file_data: `data:application/pdf;base64,${b64}` } },
      ]}],
      max_tokens: 8192,
      plugins: [{ id: 'file-parser', pdf: { engine: 'pdf-text' } }],
    }),
  });
  if (r.status === 429) throw new Error('Rate limited — wait and retry');
  const data = await r.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  let raw = (data.choices?.[0]?.message?.content || '').trim();
  if (raw.startsWith('```')) raw = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); }
  catch {
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) return JSON.parse(raw.slice(first, last + 1));
    throw new Error('Could not parse JSON from model response:\n' + raw.slice(0, 500));
  }
}

async function main() {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.log('Usage: node scripts/test-extract.js file.pdf [more.pdf ...]');
    process.exit(1);
  }
  for (const f of files) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`FILE: ${path.basename(f)}`);
    console.log('─'.repeat(60));
    try {
      const result = await callOpenRouter(fs.readFileSync(f));
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('FAILED:', e.message);
    }
  }
}

main().catch(console.error);