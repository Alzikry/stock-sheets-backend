// src/testCalculator.js
// Test hasil kalkulasi Stock Akhir, TANPA simpan ke database dulu.
// Tujuan: cocokkan angka hasil hitung dengan angka asli di kolom
// "End Stock Collie" / "End Stock pcs" / "Stock Count" di spreadsheet,
// sebagai validasi akhir sebelum data ini disimpan ke database.
//
// Jalankan dengan: node src/testCalculator.js

require('dotenv').config();
const { readSummarySheet, readReturSheet } = require('./services/sheetsParser');
const { calculateAllStock } = require('./services/stockCalculator');

async function main() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  console.log('Membaca data dari spreadsheet...\n');
  const summaryData = await readSummarySheet(spreadsheetId);
  const returData = await readReturSheet(spreadsheetId, 2026, 7);

  console.log('Menghitung Stock Akhir untuk semua produk...\n');
  const results = calculateAllStock(summaryData, returData);

  console.log(`Total produk dihitung: ${results.length}\n`);
  console.log('=== Sample hasil hitung (10 produk pertama) ===\n');
  console.log('Bandingkan kolom "Akhir(Koli)", "Akhir(Pcs)", "StockCount" ini dengan');
  console.log('kolom "End Stock Collie", "End Stock pcs", "Stock Count" di spreadsheet asli.\n');

  results.slice(0, 10).forEach((r) => {
    console.log(`${r.code}`);
    console.log(
      `  StockHand: ${r.stockHandKoli} | TotalIn: ${r.totalInKoli} | TotalOut: ${r.totalOutKoli} | TotalRetur: ${r.totalReturKoli}`
    );
    console.log(
      `  => Akhir(Koli): ${r.endStockKoli} | Akhir(Pcs): ${r.endStockPcs} | StockCount(Koli+Retur): ${r.stockCountFinal}`
    );
    console.log('');
  });

  console.log('✅ Test kalkulasi selesai.');
}

main().catch((err) => {
  console.error('❌ Error saat test kalkulasi:', err.message);
  console.error(err.stack);
});