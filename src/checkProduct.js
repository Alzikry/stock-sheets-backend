// src/checkProduct.js
// Cek kondisi lengkap 1 produk di database: summary + history harian.
// Dipakai berulang kali selama testing edge case (Fase 5) untuk
// membandingkan kondisi "sebelum" dan "sesudah" setiap kali sync ulang.
//
// Jalankan dengan: node src/checkProduct.js "Stand Fan 1683"

require('dotenv').config();
const prisma = require('./lib/prisma');

async function main() {
  const code = process.argv[2]; // ambil dari argument command line
  if (!code) {
    console.error('Cara pakai: node src/checkProduct.js "Nama Produk"');
    process.exit(1);
  }

  const product = await prisma.product.findUnique({
    where: { code },
    include: {
      stockSummaries: {
        where: { periodLabel: '2026-07' },
      },
      dailyStockEntries: {
        orderBy: { date: 'asc' },
      },
      dailyReturEntries: {
        orderBy: { date: 'asc' },
      },
    },
  });

  if (!product) {
    console.log(`❌ Produk "${code}" tidak ditemukan di database.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`=== ${product.code} ===`);
  console.log(`pcsPerKoli: ${product.pcsPerKoli} | kategori: ${product.kategori} | rowOrder: ${product.rowOrder}\n`);

  const summary = product.stockSummaries[0];
  if (summary) {
    console.log('--- StockSummary (periode 2026-07) ---');
    console.log(`StockHand: ${summary.stockHandKoli}`);
    console.log(`TotalIn: ${summary.totalInKoli} | TotalOut: ${summary.totalOutKoli} | TotalRetur: ${summary.totalReturKoli}`);
    console.log(`EndStockKoli: ${summary.endStockKoli} | EndStockPcs: ${summary.endStockPcs} | StockCountFinal: ${summary.stockCountFinal}`);
    console.log(`LastSyncedAt: ${summary.lastSyncedAt.toISOString()}`);
  } else {
    console.log('(Belum ada StockSummary untuk periode ini)');
  }

  console.log(`\n--- StockDailyEntry (${product.dailyStockEntries.length} baris) ---`);
  product.dailyStockEntries.forEach((e) => {
    console.log(`  ${e.date.toISOString().slice(0, 10)} | In: ${e.inKoli} | Out: ${e.outKoli}`);
  });

  console.log(`\n--- ReturDailyEntry (${product.dailyReturEntries.length} baris) ---`);
  product.dailyReturEntries.forEach((e) => {
    console.log(`  ${e.date.toISOString().slice(0, 10)} | Retur: ${e.returKoli}`);
  });

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('❌ Error:', err.message);
  await prisma.$disconnect();
  process.exit(1);
});