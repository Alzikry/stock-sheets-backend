// src/findDuplicateProducts.js
// Script debug: cari apakah ada nama produk (code) yang muncul lebih dari
// sekali di tab "Stock In/Out Summary" atau "Stock Retur".
// Duplikat nama produk = sumber paling mungkin dari error SQL 21000
// "ON CONFLICT DO UPDATE command cannot affect row a second time",
// karena 2 baris dengan code sama akan menghasilkan productId sama,
// sehingga entry StockDailyEntry/ReturDailyEntry untuk tanggal yang sama
// jadi terduplikasi dalam satu batch upsert.

require('dotenv').config();
const { readSummarySheet, readReturSheet } = require('./services/sheetsParser');

async function main() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  console.log('=== Cek duplikat code di tab "Stock In/Out Summary" ===');
  const summaryData = await readSummarySheet(spreadsheetId);
  const summaryCodeCount = new Map();
  for (const p of summaryData.products) {
    summaryCodeCount.set(p.code, (summaryCodeCount.get(p.code) || 0) + 1);
  }
  const summaryDupes = [...summaryCodeCount.entries()].filter(([, count]) => count > 1);
  if (summaryDupes.length === 0) {
    console.log('Tidak ada duplikat code di tab Summary.');
  } else {
    console.log('DITEMUKAN duplikat code di tab Summary:');
    console.log(summaryDupes);
  }

  console.log('\n=== Cek duplikat code di tab "Stock Retur" ===');
  const now = new Date();
  const returData = await readReturSheet(spreadsheetId, now.getFullYear(), now.getMonth() + 1);
  const returCodes = Object.keys(returData.returByCode);
  const returCodeCount = new Map();
  for (const code of returCodes) {
    returCodeCount.set(code, (returCodeCount.get(code) || 0) + 1);
  }
  // Object.keys tidak akan pernah punya duplikat key, jadi cek ini kurang berguna
  // untuk tab Retur -- tapi kita tetap cross-check jumlah baris asli vs jumlah key unik.
  console.log(`Jumlah code unik di returByCode: ${returCodes.length}`);

  console.log('\n=== Cek juga: apakah ada 2 produk BEDA NAMA tapi sama-sama menghasilkan entry duplikat tanggal untuk diri sendiri ===');
  for (const p of summaryData.products) {
    const dateKeys = p.dailyEntries.map((e) => e.date.toISOString().slice(0, 10));
    const uniqueDateKeys = new Set(dateKeys);
    if (dateKeys.length !== uniqueDateKeys.size) {
      console.log(`Produk "${p.code}" (row ${p.rowOrder}) punya tanggal duplikat di dailyEntries-nya sendiri!`);
      console.log(`  Total entries: ${dateKeys.length}, unique dates: ${uniqueDateKeys.size}`);
    }
  }

  console.log('\n✅ Cek selesai.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});