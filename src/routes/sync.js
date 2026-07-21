// src/routes/sync.js
// Endpoint untuk trigger sync secara manual (dipanggil dari tombol "Sync Sekarang" di frontend)

const express = require('express');
const router = express.Router();
const { syncFromSheets } = require('../services/syncService');
const prisma = require('../lib/prisma');

/**
 * POST /api/sync
 * Body (opsional): { year: 2026, month: 7 }
 * Kalau year/month tidak dikirim, pakai bulan & tahun saat ini secara otomatis.
 */
router.post('/', async (req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    const now = new Date();
    const year = req.body.year || now.getFullYear();
    const month = req.body.month || now.getMonth() + 1; // getMonth() 0-indexed

    const result = await syncFromSheets({
      spreadsheetId,
      year,
      month,
      triggeredBy: 'manual',
    });

    res.json(result);
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/sync/status
 * Menampilkan riwayat sync terakhir (untuk ditampilkan di dashboard:
 * "Terakhir sync: ...")
 */
router.get('/status', async (req, res) => {
  try {
    const lastSync = await prisma.syncLog.findFirst({
      orderBy: { startedAt: 'desc' },
    });

    res.json({ lastSync });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/history
 * Menampilkan beberapa riwayat sync terakhir (untuk debugging)
 */
router.get('/history', async (req, res) => {
  try {
    const logs = await prisma.syncLog.findMany({
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;