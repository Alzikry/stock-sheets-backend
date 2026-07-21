// src/services/syncService.js
//
// Tanggung jawab file ini: MENYATUKAN semua langkah (baca sheets -> hitung -> simpan DB)
// jadi satu fungsi syncFromSheets() yang bisa dipanggil dari cron job atau endpoint manual.
//
// CATATAN PERFORMA (penting, jangan diubah tanpa paham alasan berikut):
// Setelah bug "cell kosong tidak ter-reset" diperbaiki (lihat sheetsParser.js),
// setiap produk sekarang punya SEMUA hari dalam sebulan (~31 StockDailyEntry
// + ~31 ReturDailyEntry), bukan cuma hari yang ada transaksinya. Dikali ~211
// produk, itu jadi belasan ribu baris yang perlu di-upsert setiap sync.
//
// Kalau di-upsert SATU PER SATU pakai await berurutan (`prisma.x.upsert()`
// di dalam for-loop), setiap baris = 1 round-trip jaringan terpisah ke
// database Neon -> BISA MEMAKAN WAKTU BERMENIT-MENIT bahkan freeze/timeout.
//
// Solusi di file ini: kumpulkan SEMUA baris StockDailyEntry (dari SEMUA
// produk) jadi satu array besar, lalu kirim sebagai SATU query raw SQL
// "INSERT ... ON CONFLICT DO UPDATE" (upsert massal). Sama untuk
// ReturDailyEntry. Ini mengubah ribuan round-trip jadi hanya beberapa query
// saja, jauh lebih cepat.
//
// CATATAN FIX (terbaru): kolom "createdAt" dan "updatedAt" di StockDailyEntry
// dan ReturDailyEntry adalah NOT NULL di database, tapi tidak otomatis terisi
// lewat raw SQL (default @updatedAt/@default(now()) Prisma cuma jalan lewat
// Prisma Client biasa, bukan $executeRawUnsafe). Makanya kedua kolom itu
// WAJIB disertakan eksplisit di setiap INSERT lewat NOW().

const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { readSummarySheet, readReturSheet } = require('./sheetsParser');
const { calculateAllStock } = require('./stockCalculator');

/**
 * Jalankan sync penuh: baca dari Google Sheets, hitung, simpan ke database.
 *
 * @param {object} options
 * @param {string} options.spreadsheetId
 * @param {number} options.year  - tahun periode aktif, contoh: 2026
 * @param {number} options.month - bulan periode aktif (1-12), contoh: 7
 * @param {string} options.triggeredBy - "schedule" | "manual"
 * @returns {object} ringkasan hasil sync
 */
async function syncFromSheets({ spreadsheetId, year, month, triggeredBy = 'manual' }) {
  const periodLabel = `${year}-${String(month).padStart(2, '0')}`; // contoh: "2026-07"

  // Catat log sync dengan status "running"
  const syncLog = await prisma.syncLog.create({
    data: {
      status: 'running',
      triggeredBy,
    },
  });

  try {
    // 1. Baca data mentah dari kedua tab
    const summaryData = await readSummarySheet(spreadsheetId);
    const returData = await readReturSheet(spreadsheetId, year, month);

    // 2. Hitung Stock Akhir untuk semua produk
    const results = calculateAllStock(summaryData, returData);

    // 3a. Upsert semua Product dulu, satu-satu (jumlahnya cuma ~211,
    // masih wajar untuk berurutan, dan kita butuh product.id balik untuk
    // langkah berikutnya). Disimpan ke Map supaya gampang dicari lagi.
    const productIdByCode = new Map();

    for (const r of results) {
      const product = await prisma.product.upsert({
        where: { code: r.code },
        update: {
          pcsPerKoli: r.pcsPerKoli,
          kategori: r.kategori,
          rowOrder: r.rowOrder,
        },
        create: {
          code: r.code,
          pcsPerKoli: r.pcsPerKoli,
          kategori: r.kategori,
          rowOrder: r.rowOrder,
        },
      });
      productIdByCode.set(r.code, product.id);
    }

    // 3b. Upsert semua StockSummary secara batch lewat $transaction.
    // Ini masih ~211 operasi (1 per produk), jauh lebih sedikit daripada
    // StockDailyEntry/ReturDailyEntry. Timeout dinaikkan ke 30 detik
    // (default Prisma 5 detik terlalu pendek untuk ~211 operasi berurutan).
    const summaryOps = results.map((r) => {
      const productId = productIdByCode.get(r.code);
      return prisma.stockSummary.upsert({
        where: {
          productId_periodLabel: { productId, periodLabel },
        },
        update: {
          stockHandKoli: r.stockHandKoli,
          totalInKoli: r.totalInKoli,
          totalOutKoli: r.totalOutKoli,
          totalReturKoli: r.totalReturKoli,
          endStockKoli: r.endStockKoli,
          endStockPcs: r.endStockPcs,
          stockCountFinal: r.stockCountFinal,
          lastSyncedAt: new Date(),
        },
        create: {
          productId,
          periodLabel,
          stockHandKoli: r.stockHandKoli,
          totalInKoli: r.totalInKoli,
          totalOutKoli: r.totalOutKoli,
          totalReturKoli: r.totalReturKoli,
          endStockKoli: r.endStockKoli,
          endStockPcs: r.endStockPcs,
          stockCountFinal: r.stockCountFinal,
        },
      });
    });
    await prisma.$transaction(summaryOps, { timeout: 30000 });

    // 3c. Upsert MASSAL semua StockDailyEntry dari SEMUA produk sekaligus,
    // pakai raw SQL "INSERT ... ON CONFLICT DO UPDATE". Ini yang paling
    // banyak barisnya (~211 x 31 hari = ~6500+ baris), makanya WAJIB batch,
    // bukan satu-satu.
    const allStockEntries = [];
    for (const r of results) {
      const productId = productIdByCode.get(r.code);
      for (const entry of r.dailyStockEntries) {
        allStockEntries.push({ productId, date: entry.date, inKoli: entry.inKoli, outKoli: entry.outKoli });
      }
    }
    // PENTING: kalau ada 2 baris produk di spreadsheet dengan CODE yang
    // sama persis (misal typo/duplikat tidak sengaja), keduanya akan
    // mengarah ke productId yang sama, sehingga bisa menghasilkan
    // productId+date yang identik lebih dari sekali dalam batch ini.
    // PostgreSQL menolak "ON CONFLICT DO UPDATE" kalau target konflik
    // yang sama muncul >1 kali dalam satu statement (error 21000).
    // dedupEntries() membuang duplikat itu sebelum dikirim, entry yang
    // MUNCUL TERAKHIR yang dipakai (konsisten dengan perilaku upsert:
    // data terbaru menang).
    await batchUpsertStockDailyEntries(dedupEntries(allStockEntries, ['productId', 'date']));

    // 3d. Sama untuk ReturDailyEntry
    const allReturEntries = [];
    for (const r of results) {
      const productId = productIdByCode.get(r.code);
      for (const entry of r.dailyReturEntries) {
        allReturEntries.push({ productId, date: entry.date, returKoli: entry.returKoli });
      }
    }
    await batchUpsertReturDailyEntries(dedupEntries(allReturEntries, ['productId', 'date']));

    const rowsSynced = results.length;

    // 4. Update log jadi sukses
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: 'success',
        finishedAt: new Date(),
        rowsSynced,
      },
    });

    return {
      success: true,
      rowsSynced,
      periodLabel,
      syncLogId: syncLog.id,
    };
  } catch (err) {
    // Kalau ada error di tengah jalan, catat di log supaya bisa di-debug
    await prisma.syncLog.update({
      where: { id: syncLog.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        errorMessage: err.message,
      },
    });
    throw err;
  }
}

/**
 * Buang entry duplikat berdasarkan kombinasi field yang dipakai sebagai
 * kunci unik di database (misal productId+date). Kalau ada lebih dari
 * satu entry dengan kunci yang sama, yang dipertahankan adalah entry
 * yang MUNCUL TERAKHIR di array -- konsisten dengan perilaku upsert
 * biasa (data terbaru menang, bukan data pertama).
 *
 * Ini pagar pengaman terhadap data sumber yang tidak bersih, misalnya
 * kalau ada nama produk yang kebetulan tertulis dua kali di spreadsheet
 * (typo/duplikat tidak sengaja). Tanpa dedup ini, batch INSERT akan
 * gagal total dengan error PostgreSQL 21000 begitu ada 2 baris dengan
 * kunci konflik yang sama dalam satu statement.
 *
 * @param {object[]} entries
 * @param {string[]} keyFields - field yang membentuk kunci unik, misal ['productId', 'date']
 */
function dedupEntries(entries, keyFields) {
  const map = new Map();
  for (const entry of entries) {
    const key = keyFields
      .map((f) => {
        const val = entry[f];
        // Date perlu dinormalisasi ke string supaya perbandingan konsisten
        return val instanceof Date ? val.toISOString() : String(val);
      })
      .join('|');
    map.set(key, entry); // set ulang -> entry terakhir yang menang
  }
  return Array.from(map.values());
}

/**
 * Upsert massal StockDailyEntry pakai raw SQL, dipecah jadi CHUNK supaya
 * tidak melebihi batas parameter query PostgreSQL (umumnya ~65535 parameter
 * per query). Tiap baris pakai 5 parameter (id, productId, date, inKoli,
 * outKoli), jadi chunk 1000 baris = 5000 parameter, aman jauh di bawah batas.
 *
 * createdAt dan updatedAt diisi lewat NOW() langsung di SQL (bukan sebagai
 * parameter), karena kedua kolom itu NOT NULL dan tidak otomatis terisi
 * lewat raw SQL seperti saat pakai Prisma Client biasa.
 */
async function batchUpsertStockDailyEntries(entries) {
  if (entries.length === 0) return;

  const CHUNK_SIZE = 1000;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);

    // Bangun VALUES (...), (...), ... secara dinamis dengan parameter aman ($1, $2, dst)
    const values = [];
    const params = [];
    chunk.forEach((e, idx) => {
      const base = idx * 5;
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}::date, $${base + 4}, $${base + 5}, NOW(), NOW())`
      );
      params.push(crypto.randomUUID(), e.productId, e.date, e.inKoli, e.outKoli);
    });

    const sql = `
      INSERT INTO "StockDailyEntry" ("id", "productId", "date", "inKoli", "outKoli", "createdAt", "updatedAt")
      VALUES ${values.join(', ')}
      ON CONFLICT ("productId", "date")
      DO UPDATE SET "inKoli" = EXCLUDED."inKoli", "outKoli" = EXCLUDED."outKoli", "updatedAt" = NOW()
    `;

    await prisma.$executeRawUnsafe(sql, ...params);
  }
}

/**
 * Sama seperti batchUpsertStockDailyEntries, tapi untuk ReturDailyEntry
 * (cuma 1 kolom nilai: returKoli, jadi 4 parameter per baris: id, productId,
 * date, returKoli). createdAt/updatedAt juga diisi lewat NOW() langsung.
 */
async function batchUpsertReturDailyEntries(entries) {
  if (entries.length === 0) return;

  const CHUNK_SIZE = 1000;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);

    const values = [];
    const params = [];
    chunk.forEach((e, idx) => {
      const base = idx * 4;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}::date, $${base + 4}, NOW(), NOW())`);
      params.push(crypto.randomUUID(), e.productId, e.date, e.returKoli);
    });

    const sql = `
      INSERT INTO "ReturDailyEntry" ("id", "productId", "date", "returKoli", "createdAt", "updatedAt")
      VALUES ${values.join(', ')}
      ON CONFLICT ("productId", "date")
      DO UPDATE SET "returKoli" = EXCLUDED."returKoli", "updatedAt" = NOW()
    `;

    await prisma.$executeRawUnsafe(sql, ...params);
  }
}

module.exports = { syncFromSheets };