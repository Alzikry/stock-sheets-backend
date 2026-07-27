require('dotenv').config();
const prisma = require('./src/lib/prisma');

async function main() {
  const product = await prisma.product.findUnique({ where: { code: 'Out Juli' } });

  if (!product) {
    console.log('[SKIP] Produk "Out Juli" tidak ditemukan (mungkin sudah terhapus).');
  } else {
    console.log(`[HAPUS] Produk "Out Juli" (${product.id})`);

    const opnameItems = await prisma.stockOpnameItem.findMany({ where: { productId: product.id } });
    for (const item of opnameItems) {
      await prisma.stockOpnameEntry.deleteMany({ where: { itemId: item.id } });
    }
    await prisma.stockOpnameItem.deleteMany({ where: { productId: product.id } });

    await prisma.stockSummary.deleteMany({ where: { productId: product.id } });
    await prisma.stockDailyEntry.deleteMany({ where: { productId: product.id } });
    await prisma.returDailyEntry.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });

    console.log('[OK] Produk "Out Juli" berhasil dihapus beserta seluruh data terkait.');
  }

  console.log('\nSelesai.');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Terjadi error:', err);
  await prisma.$disconnect();
  process.exit(1);
});
