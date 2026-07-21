// src/testSync.js
// Test menjalankan syncFromSheets() SEKALI secara manual dari terminal.
// Setelah ini jalan, data akan benar-benar masuk ke database Neon.
//
// Jalankan dengan: node src/testSync.js

require('dotenv').config();
const { syncFromSheets } = require('./services/syncService');
const prisma = require('./lib/prisma');

async function main() {
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  console.log('Menjalankan sync...\n');
  const result = await syncFromSheets({
    spreadsheetId,
    year: 2026,
    month: 7,
    triggeredBy: 'manual',
  });

  console.log('✅ Sync selesai!');
  console.log(JSON.stringify(result, null, 2));

  // Verifikasi: ambil 3 produk dari database untuk dicek
  console.log('\n=== Verifikasi data di database (3 produk pertama) ===\n');
  const products = await prisma.product.findMany({
    take: 3,
    orderBy: { rowOrder: 'asc' },
    include: {
      stockSummaries: {
        where: { periodLabel: '2026-07' },
      },
    },
  });

  products.forEach((p) => {
    console.log(`${p.code} (pcsPerKoli: ${p.pcsPerKoli}, kategori: ${p.kategori})`);
    const summary = p.stockSummaries[0];
    if (summary) {
      console.log(
        `  StockHand: ${summary.stockHandKoli} | EndStockKoli: ${summary.endStockKoli} | EndStockPcs: ${summary.endStockPcs} | StockCountFinal: ${summary.stockCountFinal}`
      );
    }
    console.log('');
  });

  // Verifikasi jumlah history harian yang tersimpan
  const totalDailyStock = await prisma.stockDailyEntry.count();
  const totalDailyRetur = await prisma.returDailyEntry.count();
  console.log(`Total baris StockDailyEntry tersimpan: ${totalDailyStock}`);
  console.log(`Total baris ReturDailyEntry tersimpan: ${totalDailyRetur}`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('❌ Error saat sync:', err.message);
  console.error(err.stack);
  await prisma.$disconnect();
  process.exit(1);
});