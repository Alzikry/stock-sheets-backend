// src/routes/opname.js
// Endpoint untuk fitur Stock Opname: bandingkan hasil hitung fisik manual
// dengan angka sistem (stockCountFinal dari StockSummary).
//
// Alur: user cari produk (search dilakukan di frontend dari data
// GET /api/products yang sudah ada, TIDAK butuh endpoint search terpisah)
// -> ambil/buat sesi opname "open" untuk produk+periode itu -> input
// partial (bisa lebih dari satu, misal dihitung di beberapa lokasi) ->
// setelah dirasa lengkap, approve final untuk mengunci sesi.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

/**
 * Helper: hitung total (SUM) semua partial milik satu sesi.
 * Dipakai di beberapa endpoint di bawah supaya tidak duplikat logic.
 */
function sumPartials(partials) {
  return partials.reduce((total, p) => total.plus(p.countedKoli), new (require('@prisma/client')).Prisma.Decimal(0));
}

/**
 * GET /api/opname/session?productId=...&period=2026-07
 *
 * Ambil sesi opname yang sedang "open" untuk produk+periode ini.
 * Kalau belum ada sesi "open" sama sekali, BUAT BARU otomatis (snapshot
 * systemKoli diambil dari StockSummary produk itu SAAT INI).
 * Kalau produk belum pernah disync (belum punya StockSummary untuk
 * periode itu), systemKoli di-default 0 dan tetap boleh lanjut opname
 * (berguna untuk kasus barang baru yang belum tersentuh sync).
 *
 * Response menyertakan daftar partial yang sudah ada + total live-nya,
 * supaya frontend langsung tahu kondisi sesi ini tanpa request tambahan.
 */
router.get('/session', async (req, res) => {
  try {
    const { productId, period } = req.query;
    console.log('DEBUG productId:', JSON.stringify(productId), 'length:', productId?.length);
    if (!productId || !period) {
      return res.status(400).json({ error: 'productId dan period wajib diisi.' });
    }

    // Cari sesi "open" yang sudah ada untuk produk+periode ini
    let session = await prisma.stockOpnameSession.findFirst({
      where: { productId, periodLabel: period, status: 'open' },
      include: { partials: { orderBy: { createdAt: 'asc' } } },
    });

    // Belum ada sesi open -> buat baru, snapshot systemKoli dari StockSummary saat ini
    if (!session) {
      const summary = await prisma.stockSummary.findUnique({
        where: { productId_periodLabel: { productId, periodLabel: period } },
      });

      session = await prisma.stockOpnameSession.create({
        data: {
          productId,
          periodLabel: period,
          systemKoli: summary?.stockCountFinal ?? 0,
          status: 'open',
        },
        include: { partials: true },
      });
    }

    const totalCountedKoli = sumPartials(session.partials);

    res.json({
      id: session.id,
      productId: session.productId,
      periodLabel: session.periodLabel,
      systemKoli: session.systemKoli,
      status: session.status,
      finalCountedKoli: session.finalCountedKoli,
      selisihKoli: session.selisihKoli,
      finalizedAt: session.finalizedAt,
      totalCountedKoli, // live sum, cuma relevan selagi status "open"
      partials: session.partials.map((p) => ({
        id: p.id,
        countedKoli: p.countedKoli,
        note: p.note,
        countedBy: p.countedBy,
        createdAt: p.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/opname/partial
 * Body: { sessionId, countedKoli, note?, countedBy? }
 *
 * Tambah satu input hitung manual (partial) ke sesi yang sedang "open".
 * Ditolak kalau sesi sudah "final" (terkunci).
 */
router.post('/partial', async (req, res) => {
  try {
    const { sessionId, countedKoli, note, countedBy } = req.body;
    if (!sessionId || countedKoli === undefined || countedKoli === null) {
      return res.status(400).json({ error: 'sessionId dan countedKoli wajib diisi.' });
    }

    const session = await prisma.stockOpnameSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Sesi opname tidak ditemukan.' });
    }
    if (session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa menambah input baru.' });
    }

    const partial = await prisma.stockOpnamePartial.create({
      data: { sessionId, countedKoli, note: note || null, countedBy: countedBy || null },
    });

    res.status(201).json(partial);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/opname/partial/:id
 * Body: { countedKoli?, note?, countedBy? }
 *
 * Edit satu partial. Ditolak kalau sesi induknya sudah "final".
 */
router.put('/partial/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { countedKoli, note, countedBy } = req.body;

    const partial = await prisma.stockOpnamePartial.findUnique({
      where: { id },
      include: { session: true },
    });
    if (!partial) {
      return res.status(404).json({ error: 'Input partial tidak ditemukan.' });
    }
    if (partial.session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa mengedit input.' });
    }

    const updated = await prisma.stockOpnamePartial.update({
      where: { id },
      data: {
        ...(countedKoli !== undefined && { countedKoli }),
        ...(note !== undefined && { note }),
        ...(countedBy !== undefined && { countedBy }),
      },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/opname/partial/:id
 *
 * Hapus satu partial. Ditolak kalau sesi induknya sudah "final".
 */
router.delete('/partial/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const partial = await prisma.stockOpnamePartial.findUnique({
      where: { id },
      include: { session: true },
    });
    if (!partial) {
      return res.status(404).json({ error: 'Input partial tidak ditemukan.' });
    }
    if (partial.session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa menghapus input.' });
    }

    await prisma.stockOpnamePartial.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/opname/session/:id/finalize
 *
 * Approve final: kunci sesi opname. Setelah ini, partial di sesi tersebut
 * tidak bisa lagi ditambah/diedit/dihapus (endpoint di atas akan menolak).
 * finalCountedKoli dan selisihKoli di-snapshot di sini (bukan dihitung
 * ulang tiap kali dibaca), supaya nilai final tidak pernah berubah lagi
 * setelah dikunci, apapun yang terjadi di tabel lain setelahnya.
 */
router.post('/session/:id/finalize', async (req, res) => {
  try {
    const { id } = req.params;

    const session = await prisma.stockOpnameSession.findUnique({
      where: { id },
      include: { partials: true },
    });
    if (!session) {
      return res.status(404).json({ error: 'Sesi opname tidak ditemukan.' });
    }
    if (session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan sebelumnya.' });
    }

    const finalCountedKoli = sumPartials(session.partials);
    const selisihKoli = finalCountedKoli.minus(session.systemKoli);

    const updated = await prisma.stockOpnameSession.update({
      where: { id },
      data: {
        status: 'final',
        finalCountedKoli,
        selisihKoli,
        finalizedAt: new Date(),
      },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/opname/history
 * GET /api/opname/history?period=2026-07
 * GET /api/opname/history?productId=...
 *
 * Daftar semua sesi opname (final maupun open), untuk halaman Riwayat
 * Opname. Bisa difilter by periode dan/atau by produk.
 */
router.get('/history', async (req, res) => {
  try {
    const { period, productId } = req.query;

    const sessions = await prisma.stockOpnameSession.findMany({
      where: {
        ...(period && { periodLabel: period }),
        ...(productId && { productId }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        product: { select: { code: true, kategori: true } },
        partials: true,
      },
    });

    const result = sessions.map((s) => ({
      id: s.id,
      productCode: s.product.code,
      kategori: s.product.kategori,
      periodLabel: s.periodLabel,
      systemKoli: s.systemKoli,
      status: s.status,
      totalCountedKoli: s.status === 'open' ? sumPartials(s.partials) : s.finalCountedKoli,
      selisihKoli: s.selisihKoli,
      partialCount: s.partials.length,
      finalizedAt: s.finalizedAt,
      createdAt: s.createdAt,
    }));

    res.json({ count: result.length, sessions: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;