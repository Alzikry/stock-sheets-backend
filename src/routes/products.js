// src/routes/products.js
// Endpoint untuk dashboard: daftar produk + Stock Awal/Akhir per produk

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

/**
 * GET /api/products
 * GET /api/products?period=2026-07
 *
 * Mengembalikan daftar semua produk beserta StockSummary untuk periode
 * tertentu (Stock Awal, Stock Akhir, dll). Kalau ?period tidak diisi,
 * pakai periode bulan berjalan (tahun-bulan sekarang).
 */
router.get('/', async (req, res) => {
  try {
    const periodLabel =
      req.query.period ||
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

    const products = await prisma.product.findMany({
      orderBy: { rowOrder: 'asc' },
      include: {
        stockSummaries: {
          where: { periodLabel },
        },
      },
    });

    // Ratakan struktur biar gampang dipakai di frontend:
    // gabungkan field Product dengan StockSummary periode itu (kalau ada)
    const result = products.map((p) => {
      const summary = p.stockSummaries[0] || null;
      return {
        id: p.id,
        code: p.code,
        pcsPerKoli: p.pcsPerKoli,
        kategori: p.kategori,
        periodLabel,
        stockHandKoli: summary?.stockHandKoli ?? null,
        totalInKoli: summary?.totalInKoli ?? null,
        totalOutKoli: summary?.totalOutKoli ?? null,
        totalReturKoli: summary?.totalReturKoli ?? null,
        endStockKoli: summary?.endStockKoli ?? null,
        endStockPcs: summary?.endStockPcs ?? null,
        stockCountFinal: summary?.stockCountFinal ?? null,
        lastSyncedAt: summary?.lastSyncedAt ?? null,
      };
    });

    res.json({ periodLabel, count: result.length, products: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/products/:code/history
 *
 * Mengembalikan history In/Out dan Retur harian untuk 1 produk (by code),
 * diurutkan berdasarkan tanggal. Dipakai untuk tampilan detail/history
 * di dashboard.
 */
router.get('/:code/history', async (req, res) => {
  try {
    const { code } = req.params;

    const product = await prisma.product.findUnique({
      where: { code },
      include: {
        dailyStockEntries: { orderBy: { date: 'asc' } },
        dailyReturEntries: { orderBy: { date: 'asc' } },
      },
    });

    if (!product) {
      return res.status(404).json({ error: `Produk dengan code "${code}" tidak ditemukan.` });
    }

    res.json({
      code: product.code,
      kategori: product.kategori,
      pcsPerKoli: product.pcsPerKoli,
      stockHistory: product.dailyStockEntries.map((e) => ({
        date: e.date,
        inKoli: e.inKoli,
        outKoli: e.outKoli,
      })),
      returHistory: product.dailyReturEntries.map((e) => ({
        date: e.date,
        returKoli: e.returKoli,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;