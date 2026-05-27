// test-pass1.js — run from project root:  node test-pass1.js
// Tests the three paths you can't exercise from the UI:
//   1. stale-'reading' reaper (time-math correctness)
//   2. soft-delete of a 'pushed' row
//   3. push_failed banner data
//
// It SEEDS rows directly, then tells you exactly what to check in the UI.
// Safe: every row it creates is prefixed TEST- so you can spot/delete them.

const { initDB, execute, queryOne, queryAll, nowIST } = require('./db/schema');

(async () => {
  await initDB();
  console.log('\n=== Pass 1 state-path tests ===\n');

  // ---------- 1. STALE READING REAPER ----------
  // Insert a row stuck in 'reading' with created_at 6 minutes in the PAST (UTC),
  // then run the EXACT reaper query from routes/invoices.js and see if it flips.
  const r1 = await execute(
    `INSERT INTO crm_invoices (original_filename, status, line_items, tally_xml, created_at)
     VALUES ('TEST-reaper.pdf', 'reading', '[]', '', datetime('now','-6 minutes'))`
  );
  const reaperId = Number(r1.lastId);

  const before = await queryOne('SELECT status, created_at FROM crm_invoices WHERE id=?', [reaperId]);
  // This is the identical statement your GET /api/invoices runs on every list load:
  await execute(
    `UPDATE crm_invoices SET status='extract_failed', extract_error='Timeout'
     WHERE status='reading' AND created_at < datetime('now','-5 minutes')`
  );
  const after = await queryOne('SELECT status, extract_error, created_at FROM crm_invoices WHERE id=?', [reaperId]);

  console.log('1) STALE READING REAPER');
  console.log(`   created_at (stored): ${before.created_at}`);
  console.log(`   status before: ${before.status}`);
  console.log(`   status after : ${after.status}  ${after.extract_error ? '('+after.extract_error+')' : ''}`);
  console.log(after.status === 'extract_failed'
    ? '   ✅ PASS — reaper fired. Time-math is correct (UTC vs UTC).\n'
    : '   ❌ FAIL — reaper did NOT fire. created_at is NOT comparable to datetime("now") — likely IST/UTC mismatch. DO NOT SHIP.\n');

  // Bonus: confirm a FRESH reading row is NOT reaped (no false positives)
  const r1b = await execute(
    `INSERT INTO crm_invoices (original_filename, status, line_items, tally_xml)
     VALUES ('TEST-reaper-fresh.pdf', 'reading', '[]', '')`
  );
  const freshId = Number(r1b.lastId);
  await execute(
    `UPDATE crm_invoices SET status='extract_failed', extract_error='Timeout'
     WHERE status='reading' AND created_at < datetime('now','-5 minutes')`
  );
  const fresh = await queryOne('SELECT status FROM crm_invoices WHERE id=?', [freshId]);
  console.log(`   Fresh reading row status: ${fresh.status}`);
  console.log(fresh.status === 'reading'
    ? '   ✅ PASS — fresh row left alone (no premature reaping).\n'
    : '   ❌ FAIL — fresh row was reaped too early. Reaper is too aggressive. DO NOT SHIP.\n');

  // ---------- 2 & 3. PUSHED (for soft-delete) + PUSH_FAILED (for banner) ----------
  // These can't be created via UI. Seed them so you can eyeball the UI.
  const r2 = await execute(
    `INSERT INTO crm_invoices
       (original_filename, doc_type, invoice_no, party_name, net_amount,
        status, line_items, tally_xml, pushed_at)
     VALUES ('TEST-pushed.pdf','purchase_invoice','TEST-PUSHED-001','Test Supplier Co',
             12345.67,'pushed','[]','<ENVELOPE>test</ENVELOPE>', ?)`,
    [nowIST()]
  );
  const pushedId = Number(r2.lastId);

  const r3 = await execute(
    `INSERT INTO crm_invoices
       (original_filename, doc_type, invoice_no, party_name, net_amount,
        status, line_items, tally_xml, push_error)
     VALUES ('TEST-pushfail.pdf','purchase_invoice','TEST-FAIL-002','Test Supplier Co',
             9999.00,'push_failed','[]','<ENVELOPE>test</ENVELOPE>','Ledger missing')`
  );
  const failId = Number(r3.lastId);

  console.log('2) SOFT-DELETE — seeded a PUSHED row');
  console.log(`   id=${pushedId}, invoice_no=TEST-PUSHED-001`);
  console.log('   → In the UI: open it, click delete. Confirm dialog WARNS about Tally.');
  console.log('   → After delete: row should LEAVE the All view and APPEAR under the "Deleted" filter (not vanish).\n');

  console.log('3) PUSH_FAILED BANNER — seeded a push_failed row');
  console.log(`   id=${failId}, invoice_no=TEST-FAIL-002, push_error="Ledger missing"`);
  console.log('   → In the UI: open it. Confirm a RED banner shows "Tally push failed — Ledger missing".\n');

  // ---------- cleanup helper ----------
  console.log('=== When done eyeballing the UI, clean up these test rows by running: ===');
  console.log('    node test-pass1.js --cleanup\n');

  if (process.argv.includes('--cleanup')) {
    const del = await execute(`DELETE FROM crm_invoices WHERE original_filename LIKE 'TEST-%' OR invoice_no LIKE 'TEST-%'`);
    console.log(`🧹 Cleanup: removed ${del.changes} test row(s).\n`);
  }

  process.exit(0);
})();