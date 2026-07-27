// src/routes/reports.js
// Endpoint untuk laporan pergerakan barang: produk dengan volume in/out
// tertinggi, produk dengan frekuensi transaksi tersering, dan produk
// yang PUNYA STOK tapi jarang/tidak bergerak (slow-moving stock).
//
// Sumber data: StockDailyEntry (riwayat in/out harian per produk),
// difilter berdasarkan rentang tanggal yang diminta. Semua kategori
// (bukan cuma slow-moving) juga disandingkan dengan StockSummary
// periode berjalan untuk menampilkan stok hari ini.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');

const TOP_N = 30;

/**
 * GET /api/reports/movement?startDate=2026-07-01&endDate=2026-07-27
 *
 * startDate & endDate wajib diisi, format YYYY-MM-DD (inclusive di kedua
 * ujung). Mengembalikan 4 kategori ranking, masing-masing top 30:
 *   - topIn: total IN (koli) terbesar dalam periode (barang paling banyak masuk)
 *   - topOut: total OUT (koli) terbesar dalam periode (barang paling banyak keluar)
 *   - topFrequency: jumlah hari yang punya aktivitas (in>0 atau out>0) terbanyak
 *   - slowMoving: stockCountFinal > 100 (periode BERJALAN, bukan periode
 *     filter), tapi total in+out dalam periode filter PALING KECIL
 *     (termasuk yang 0 sama sekali)
 *
 * Semua kategori sekarang menyertakan stockCountFinal (stok hari ini,
 * dari periode berjalan), bukan cuma slowMoving.
 */
router.get('/movement', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'startDate dan endDate wajib diisi (format YYYY-MM-DD).' });
    }

    const start = new Date(startDate + 'T00:00:00.000Z');
    const end = new Date(endDate + 'T23:59:59.999Z');

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Format startDate/endDate tidak valid. Gunakan YYYY-MM-DD.' });
    }
    if (start > end) {
      return res.status(400).json({ error: 'startDate tidak boleh lebih besar dari endDate.' });
    }

    // Ambil semua entry dalam range, sekaligus data produknya (code,
    // kategori, pcsPerKoli) supaya tidak perlu query terpisah per produk.
    const entries = await prisma.stockDailyEntry.findMany({
      where: { date: { gte: start, lte: end } },
      include: { product: { select: { id: true, code: true, kategori: true, pcsPerKoli: true } } },
    });

    // Agregasi per productId secara manual (bukan pakai groupBy Prisma,
    // supaya lebih gampang gabungkan info produk + hitung "hari aktif"
    // dengan Decimal yang presisi).
    const statsByProduct = new Map();

    for (const entry of entries) {
      const pid = entry.productId;
      if (!statsByProduct.has(pid)) {
        statsByProduct.set(pid, {
          productId: pid,
          code: entry.product.code,
          kategori: entry.product.kategori,
          pcsPerKoli: entry.product.pcsPerKoli,
          totalInKoli: new Prisma.Decimal(0),
          totalOutKoli: new Prisma.Decimal(0),
          activeDays: 0,
        });
      }
      const stat = statsByProduct.get(pid);
      const inKoli = new Prisma.Decimal(entry.inKoli);
      const outKoli = new Prisma.Decimal(entry.outKoli);

      stat.totalInKoli = stat.totalInKoli.plus(inKoli);
      stat.totalOutKoli = stat.totalOutKoli.plus(outKoli);
      if (!inKoli.plus(outKoli).isZero()) stat.activeDays += 1;
    }

    const allStats = Array.from(statsByProduct.values());

    // Ambil StockSummary periode BERJALAN (bulan sekarang, bukan periode
    // filter tanggal) untuk tahu stok hari ini tiap produk. Dipakai untuk
    // SEMUA kategori sekarang, bukan cuma slowMoving.
    const currentPeriodLabel = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const allSummaries = await prisma.stockSummary.findMany({
      where: { periodLabel: currentPeriodLabel },
      select: { productId: true, stockCountFinal: true },
    });
    const stockByProduct = new Map(allSummaries.map((s) => [s.productId, s.stockCountFinal]));

    const withStock = (s) => ({
      productId: s.productId,
      code: s.code,
      kategori: s.kategori,
      totalInKoli: s.totalInKoli,
      totalOutKoli: s.totalOutKoli,
      activeDays: s.activeDays,
      stockCountFinal: stockByProduct.has(s.productId) ? stockByProduct.get(s.productId) : null,
    });

    // ===== Kategori 1: Volume IN tertinggi =====
    const topIn = [...allStats]
      .sort((a, b) => b.totalInKoli.comparedTo(a.totalInKoli))
      .slice(0, TOP_N)
      .map(withStock);

    // ===== Kategori 2: Volume OUT tertinggi =====
    const topOut = [...allStats]
      .sort((a, b) => b.totalOutKoli.comparedTo(a.totalOutKoli))
      .slice(0, TOP_N)
      .map(withStock);

    // ===== Kategori 3: Frekuensi tersering (hari aktif terbanyak) =====
    const topFrequency = [...allStats]
      .sort((a, b) => b.activeDays - a.activeDays)
      .slice(0, TOP_N)
      .map(withStock);

    // ===== Kategori 4: Punya stok tapi jarang/tidak bergerak =====
    const summariesWithStock = await prisma.stockSummary.findMany({
      where: { periodLabel: currentPeriodLabel, stockCountFinal: { gt: 100 } },
      include: { product: { select: { id: true, code: true, kategori: true, pcsPerKoli: true } } },
    });

    const slowMoving = summariesWithStock
      .map((summary) => {
        const stat = statsByProduct.get(summary.productId);
        const totalInKoli = stat ? stat.totalInKoli : new Prisma.Decimal(0);
        const totalOutKoli = stat ? stat.totalOutKoli : new Prisma.Decimal(0);
        return {
          productId: summary.productId,
          code: summary.product.code,
          kategori: summary.product.kategori,
          stockCountFinal: summary.stockCountFinal,
          totalInKoli,
          totalOutKoli,
          activeDays: stat ? stat.activeDays : 0,
        };
      })
      .sort((a, b) => a.totalInKoli.plus(a.totalOutKoli).comparedTo(b.totalInKoli.plus(b.totalOutKoli)))
      .slice(0, TOP_N);

    res.json({
      startDate,
      endDate,
      topIn,
      topOut,
      topFrequency,
      slowMoving,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;