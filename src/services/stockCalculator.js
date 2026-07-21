// src/services/stockCalculator.js
//
// Tanggung jawab file ini: MENGGABUNGKAN hasil parsing dari tab Summary + Retur,
// lalu MENGHITUNG Stock Akhir sesuai rumus yang sudah disepakati:
//
//   End Stock Koli    = Stock Hand + Σ(In) − Σ(Out)
//   Stock Count Final = End Stock Koli + Total Retur     (satuan KOLI)
//   End Stock Pcs     = End Stock Koli × pcs per koli     (jalur tampilan terpisah)

/**
 * Gabungkan data 1 produk dari Summary dengan data Retur-nya (dicari by code),
 * lalu hitung semua angka akhir.
 *
 * @param {object} summaryProduct - satu item dari hasil readSummarySheet().products
 * @param {Array} returEntries - array dari returByCode[code], bisa undefined kalau tidak ada retur
 * @returns {object} hasil kalkulasi lengkap untuk 1 produk
 */
function calculateProductStock(summaryProduct, returEntries = []) {
  const { code, pcsPerKoli, kategori, stockHandKoli, dailyEntries, rowOrder } = summaryProduct;

  // Total In & Out dari seluruh transaksi harian
  let totalInKoli = 0;
  let totalOutKoli = 0;
  for (const entry of dailyEntries) {
    totalInKoli += entry.inKoli;
    totalOutKoli += entry.outKoli;
  }

  // Total Retur dari seluruh transaksi harian retur
  let totalReturKoli = 0;
  for (const entry of returEntries) {
    totalReturKoli += entry.returKoli;
  }

  // Rumus inti sesuai kesepakatan
  const endStockKoli = stockHandKoli + totalInKoli - totalOutKoli;
  const stockCountFinal = endStockKoli + totalReturKoli; // satuan koli, retur digabung di sini
  const endStockPcs = endStockKoli * pcsPerKoli; // jalur tampilan terpisah, TIDAK termasuk retur

  return {
    rowOrder,
    code,
    pcsPerKoli,
    kategori,
    stockHandKoli,
    totalInKoli,
    totalOutKoli,
    totalReturKoli,
    endStockKoli,
    endStockPcs,
    stockCountFinal,
    dailyStockEntries: dailyEntries, // diteruskan untuk disimpan sebagai history harian
    dailyReturEntries: returEntries, // diteruskan untuk disimpan sebagai history harian
  };
}

/**
 * Proses seluruh produk dari hasil parsing Summary + Retur sekaligus.
 *
 * @param {object} summaryData - hasil dari readSummarySheet()
 * @param {object} returData - hasil dari readReturSheet()
 * @returns {Array} array hasil kalkulasi untuk semua produk
 */
function calculateAllStock(summaryData, returData) {
  const results = [];

  for (const product of summaryData.products) {
    const returEntries = returData.returByCode[product.code] || [];
    const calculated = calculateProductStock(product, returEntries);
    results.push(calculated);
  }

  return results;
}

module.exports = {
  calculateProductStock,
  calculateAllStock,
};