// src/testParser.js
// Test parsing data sheets TANPA simpan ke database dulu.
// Tujuan: pastikan hasil parsing sudah benar sebelum lanjut ke logic hitung & simpan.
//
// Jalankan dengan: node src/testParser.js

require('dotenv').config();
const { readSummarySheet, readReturSheet } = require('./services/sheetsParser');

async function main() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  console.log('=== Test Parser: Stock In/Out Summary ===\n');
  const summaryData = await readSummarySheet(spreadsheetId);
  console.log(`Total produk ditemukan: ${summaryData.products.length}\n`);

  // Tampilkan detail 3 produk pertama sebagai sample
  summaryData.products.slice(0, 3).forEach((p) => {
    console.log(`--- ${p.code} ---`);
    console.log(`  pcsPerKoli: ${p.pcsPerKoli}, kategori: ${p.kategori}, stockHandKoli: ${p.stockHandKoli}`);
    console.log(`  Jumlah hari dengan transaksi: ${p.dailyEntries.length}`);
    p.dailyEntries.slice(0, 5).forEach((d) => {
      console.log(`    ${d.date.toISOString().slice(0, 10)} | In: ${d.inKoli} | Out: ${d.outKoli}`);
    });
    console.log('');
  });

  console.log('\n=== Test Parser: Stock Retur ===\n');
  // GANTI year & month ini sesuai periode aktif spreadsheet testing kamu
  const returData = await readReturSheet(spreadsheetId, 2026, 7);
  const returCodes = Object.keys(returData.returByCode);
  console.log(`Total produk dengan data retur: ${returCodes.length}\n`);

  returCodes.slice(0, 3).forEach((code) => {
    console.log(`--- ${code} ---`);
    returData.returByCode[code].forEach((d) => {
      console.log(`    ${d.date.toISOString().slice(0, 10)} | Retur: ${d.returKoli}`);
    });
    console.log('');
  });

  console.log('✅ Test parser selesai.');
}

main().catch((err) => {
  console.error('❌ Error saat test parser:', err.message);
  console.error(err.stack);
});