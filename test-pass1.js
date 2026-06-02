#!/usr/bin/env node
// Per-type extraction tester. Uses the SAME focused prompts as production.
//
// Usage:
//   node scripts/test-extract.js <type> file.pdf [more.pdf ...]
//
//   <type> is one of:
//     purchase_invoice | freight_invoice | bill_of_entry | purchase_order | bank_statement
//     (or "auto" to use the universal fallback prompt)
//
// Examples:
//   node scripts/test-extract.js bank_statement DS.pdf
//   node scripts/test-extract.js purchase_order P0054033.pdf
//   node scripts/test-extract.js auto unknown.pdf
//
// Prints raw JSON. No DB writes. Tweak the prompt in routes/invoices.js, not here —
// this script imports the live prompts so the two never drift.

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const MODEL = process.env.EXTRACTION_MODEL || 'google/gemini-2.5-flash';

// Pull the real prompts out of the route module so tests match production exactly.
// invoices.js doesn't export them, so we read the file and eval the prompt block.
// Simpler + robust: re-require via a tiny shim. If you prefer, export promptFor
// from invoices.js and require it directly.
function loadPrompts() {
  const src = fs.readFileSync(path.join(__dirname, 'routes', 'invoices.js'), 'utf8');
  // Grab the SCHEMA_BLOCK, PARTY_RULE, NUM_RULE, PROMPTS, EXTRACTION_PROMPT, promptFor.
  // We evaluate just the constant/function declarations in an isolated scope.
  const start = src.indexOf('const SCHEMA_BLOCK');
  const end   = src.indexOf('async function callOpenRouter');
  if (start === -1 || end === -1) {
    throw new Error('Could not locate prompt block in routes/invoices.js — check the markers.');
  }
  const block = src.slice(start, end);
  const factory = new Function(`${block}; return { promptFor };`);
  return factory();
}

const { promptFor } = loadPrompts();

const VALID = ['purchase_invoice','freight_invoice','bill_of_entry','purchase_order','bank_statement','auto'];

async function callOpenRouter(buffer, prompt) {
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
        { type: 'text', text: prompt },
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
  const fence = '`'.repeat(3);
  if (raw.startsWith(fence)) raw = raw.split(fence).join('').replace(/^json/i, '').trim();
  try { return JSON.parse(raw); }
  catch (err) {
    const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
    if (first !== -1 && last > first) {
      let cleanStr = raw.slice(first, last + 1);
      // Clean up trailing commas safely before matching closing brackets
      cleanStr = cleanStr.replace(/,\s*([\]}])/g, '$1');
      try { return JSON.parse(cleanStr); } catch (innerErr) { 
        throw new Error(`JSON Parse Error: ${innerErr.message}\nFull Response Content:\n${raw}`);
      }
    }
    throw new Error(`Could not locate JSON boundaries: ${err.message}\nFull Response Content:\n${raw}`);
  }
}

// Quick sanity helpers per type so a glance tells you if it worked.
function summarize(type, r) {
  const lines = [];
  lines.push(`  doc_type:   ${r.doc_type}`);
  if (type === 'bank_statement' || r.doc_type === 'bank_statement') {
    const items = r.line_items || [];
    const credits = items.filter(i => Number(i.amount) > 0).length;
    const debits  = items.filter(i => Number(i.amount) < 0).length;
    lines.push(`  account_no: ${r.account_no}`);
    lines.push(`  period:     ${r.statement_from} → ${r.statement_to}`);
    lines.push(`  open/close: ${r.opening_balance} / ${r.closing_balance}`);
    lines.push(`  txns:       ${items.length} (${credits} credit, ${debits} debit)`);
  } else if (type === 'purchase_order' || r.doc_type === 'purchase_order') {
    lines.push(`  po_no:      ${r.invoice_no}`);
    lines.push(`  party:      ${r.party_name}`);
    lines.push(`  delivery:   ${r.delivery_date}`);
    lines.push(`  lines:      ${(r.line_items||[]).length}`);
  } else {
    lines.push(`  invoice_no: ${r.invoice_no}`);
    lines.push(`  party:      ${r.party_name}`);
    lines.push(`  party_gstin:${r.party_gstin}   buyer_gstin:${r.buyer_gstin}`);
    lines.push(`  net_amount: ${r.net_amount}   (cgst ${r.cgst} sgst ${r.sgst} igst ${r.igst})`);
    lines.push(`  lines:      ${(r.line_items||[]).length}`);
  }
  return lines.join('\n');
}

async function main() {
  const [type, ...files] = process.argv.slice(2);
  if (!type || !VALID.includes(type) || !files.length) {
    console.log('Usage: node scripts/test-extract.js <type> file.pdf [more.pdf ...]');
    console.log('  type: ' + VALID.join(' | '));
    process.exit(1);
  }
  const hint = type === 'auto' ? null : type;
  const prompt = promptFor(hint);

  for (const f of files) {
    console.log(`\n${'─'.repeat(64)}`);
    console.log(`TYPE: ${type}    FILE: ${path.basename(f)}`);
    console.log('─'.repeat(64));
    try {
      let result;
      if (type === 'bank_statement') {
        for (let page = 1; page <= 8; page++) {
          console.log(`Processing Chunk: Page ${page}/8...`);
          const pagePrompt = prompt + `\nCRITICAL: Process ONLY transactions listed under "--- PAGE ${page} ---". Ignore all other pages. If no transactions exist on this page, return an empty line_items array.`;
          const parsed = await callOpenRouter(fs.readFileSync(f), pagePrompt);
          if (!result) { 
            result = parsed; 
            if (!Array.isArray(result.line_items)) result.line_items = []; 
          } else if (parsed && Array.isArray(parsed.line_items)) { 
            result.line_items.push(...parsed.line_items); 
          }
        }
      } else {
        result = await callOpenRouter(fs.readFileSync(f), prompt);
      }

      if (type === 'bank_statement' && result && Array.isArray(result.line_items)) {
        const seenSis = new Set();
        result.line_items = result.line_items.filter(item => {
          if (!item.si_no) return true;
          if (seenSis.has(item.si_no)) return false;
          seenSis.add(item.si_no);
          return true;
        });
      }

      console.log(summarize(type, result));
      console.log('\n  --- full JSON ---');
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('FAILED:', e.message);
    }
  }
}

main().catch(console.error);