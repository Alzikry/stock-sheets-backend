// src/routes/opname.js
// Endpoint untuk fitur Stock Opname (REDESIGN v2, Sesi #7-8).
//
// Model 3-level:
//   StockOpnameSession  -> 1 sesi opname, bisa cakup BANYAK produk
//   StockOpnameItem     -> 1 produk di dalam sesi, snapshot systemKoli
//   StockOpnameEntry    -> banyak baris hitungan manual per item
//                          (dari tim/sumber berbeda, totalnya dijumlah)
//
// Alur pemakaian:
//   1. Mulai sesi baru (nama auto dari tanggal) -> POST /session
//   2. Tambah produk ke sesi (search dilakukan di frontend dari data
//      GET /api/products yang sudah ada) -> POST /session/:id/item
//   3. Tambah baris hitungan ke item -> POST /item/:id/entry
//   4. Edit/hapus baris hitungan selama sesi masih "open"
//      -> PUT /entry/:id, DELETE /entry/:id
//   5. Approve final -> POST /session/:id/finalize (mengunci SEMUA
//      item & entry di sesi itu jadi read-only)
//   6. Riwayat semua sesi -> GET /history

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');

/**
 * Helper: hitung total (SUM) countedKoli dari sekumpulan entries.
 * Pakai Prisma.Decimal.plus() (BUKAN operator + biasa JS), karena
 * countedKoli bertipe Decimal di database.
 */
function sumEntries(entries) {
  return entries.reduce((total, e) => total.plus(e.countedKoli), new Prisma.Decimal(0));
}

/**
 * Helper: format nama sesi otomatis dari tanggal saat ini.
 * Format: "Stock Opname DD/MM/YY" (sesuai prototype yang sudah disetujui).
 */
function generateSessionName() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `Stock Opname ${dd}/${mm}/${yy}`;
}

/**
 * Helper: ambil 1 sesi lengkap (item + entries di dalamnya + info produk),
 * lalu bentuk jadi response JSON yang gampang dipakai frontend. Dipakai
 * di beberapa endpoint supaya bentuk response konsisten.
 */
async function getSessionDetail(sessionId) {
  const session = await prisma.stockOpnameSession.findUnique({
    where: { id: sessionId },
    include: {
      items: {
        include: {
          product: { select: { code: true, kategori: true, pcsPerKoli: true } },
          entries: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!session) return null;

  const items = session.items.map((item) => {
    const totalCountedKoli = sumEntries(item.entries);
    const selisihKoli = totalCountedKoli.minus(item.systemKoli);
    return {
      id: item.id,
      productId: item.productId,
      code: item.product.code,
      kategori: item.product.kategori,
      pcsPerKoli: item.product.pcsPerKoli,
      systemKoli: item.systemKoli,
      totalCountedKoli,
      selisihKoli,
      entries: item.entries.map((e) => ({
        id: e.id,
        countedKoli: e.countedKoli,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  });

  return {
    id: session.id,
    name: session.name,
    status: session.status,
    finalizedAt: session.finalizedAt,
    createdAt: session.createdAt,
    itemCount: items.length,
    selisihCount: items.filter((i) => !i.selisihKoli.isZero()).length,
    items,
  };
}

/**
 * POST /api/opname/session
 * Body: {} (tidak butuh input apapun, nama di-generate otomatis)
 *
 * Mulai sesi opname baru.
 */
router.post('/session', async (req, res) => {
  try {
    const session = await prisma.stockOpnameSession.create({
      data: { name: generateSessionName(), status: 'open' },
    });
    res.status(201).json(session);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/opname/session/:id
 *
 * Ambil detail 1 sesi lengkap (semua item + entries + total & selisih
 * per item).
 */
router.get('/session/:id', async (req, res) => {
  try {
    const detail = await getSessionDetail(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: 'Sesi opname tidak ditemukan.' });
    }
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/opname/session/:id/item
 * Body: { productId }
 *
 * Tambah 1 produk ke sesi (search produknya dilakukan di frontend).
 * systemKoli di-snapshot dari StockSummary produk itu SAAT INI (pakai
 * periode bulan berjalan). Ditolak kalau produk itu SUDAH ada di sesi
 * ini (constraint @@unique([sessionId, productId]) di schema) -- kalau
 * mau nambah hitungan lagi untuk produk yang sudah ada, pakai endpoint
 * tambah entry, BUKAN tambah item baru.
 */
router.post('/session/:id/item', async (req, res) => {
  try {
    const { id: sessionId } = req.params;
    const { productId } = req.body;
    if (!productId) {
      return res.status(400).json({ error: 'productId wajib diisi.' });
    }

    const session = await prisma.stockOpnameSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Sesi opname tidak ditemukan.' });
    }
    if (session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa menambah produk.' });
    }

    // Ambil periode bulan berjalan, sama seperti default di GET /api/products
    const periodLabel = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const summary = await prisma.stockSummary.findUnique({
      where: { productId_periodLabel: { productId, periodLabel } },
    });

    const item = await prisma.stockOpnameItem.create({
      data: {
        sessionId,
        productId,
        systemKoli: summary?.stockCountFinal ?? 0,
        // Setiap item baru langsung dikasih 1 entry kosong (countedKoli 0),
        // konsisten dengan pola di prototype (item baru selalu ada
        // minimal 1 baris hitungan siap diisi).
        entries: { create: { countedKoli: 0, note: null } },
      },
      include: {
        product: { select: { code: true, kategori: true, pcsPerKoli: true } },
        entries: true,
      },
    });

    res.status(201).json(item);
  } catch (err) {
    // Kalau produk sudah ada di sesi ini, Prisma akan lempar error unique
    // constraint (P2002) -- kasih pesan yang jelas alih-alih 500 generik.
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'Produk ini sudah ada di sesi ini. Tambahkan hitungan baru untuk produk yang sudah ada, bukan produk baru.' });
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/opname/item/:id
 *
 * Hapus 1 produk (beserta semua entry-nya) dari sesi. Ditolak kalau
 * sesi induknya sudah "final".
 */
router.delete('/item/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const item = await prisma.stockOpnameItem.findUnique({
      where: { id },
      include: { session: true },
    });
    if (!item) {
      return res.status(404).json({ error: 'Item produk tidak ditemukan.' });
    }
    if (item.session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa menghapus produk.' });
    }

    // Hapus semua entry milik item ini dulu (foreign key), baru hapus itemnya
    await prisma.stockOpnameEntry.deleteMany({ where: { itemId: id } });
    await prisma.stockOpnameItem.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/opname/item/:id/entry
 * Body: { countedKoli, note? }
 *
 * Tambah 1 baris hitungan baru ke sebuah item. Ditolak kalau sesi
 * induknya sudah "final".
 */
router.post('/item/:id/entry', async (req, res) => {
  try {
    const { id: itemId } = req.params;
    const { countedKoli, note } = req.body;
    if (countedKoli === undefined || countedKoli === null) {
      return res.status(400).json({ error: 'countedKoli wajib diisi.' });
    }

    const item = await prisma.stockOpnameItem.findUnique({
      where: { id: itemId },
      include: { session: true },
    });
    if (!item) {
      return res.status(404).json({ error: 'Item produk tidak ditemukan.' });
    }
    if (item.session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa menambah hitungan.' });
    }

    const entry = await prisma.stockOpnameEntry.create({
      data: { itemId, countedKoli, note: note || null },
    });

    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/opname/entry/:id
 * Body: { countedKoli?, note? }
 *
 * Edit 1 baris hitungan. Ditolak kalau sesi induknya sudah "final".
 */
router.put('/entry/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { countedKoli, note } = req.body;

    const entry = await prisma.stockOpnameEntry.findUnique({
      where: { id },
      include: { item: { include: { session: true } } },
    });
    if (!entry) {
      return res.status(404).json({ error: 'Baris hitungan tidak ditemukan.' });
    }
    if (entry.item.session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa mengedit hitungan.' });
    }

    const updated = await prisma.stockOpnameEntry.update({
      where: { id },
      data: {
        ...(countedKoli !== undefined && { countedKoli }),
        ...(note !== undefined && { note }),
      },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/opname/entry/:id
 *
 * Hapus 1 baris hitungan. Ditolak kalau sesi induknya sudah "final".
 * (Boleh hapus sampai 0 entry tersisa di 1 item -- beda dari behaviour
 * prototype yang auto-buat entry kosong pengganti; keputusan itu bisa
 * ditangani di level frontend kalau memang mau dipertahankan.)
 */
router.delete('/entry/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const entry = await prisma.stockOpnameEntry.findUnique({
      where: { id },
      include: { item: { include: { session: true } } },
    });
    if (!entry) {
      return res.status(404).json({ error: 'Baris hitungan tidak ditemukan.' });
    }
    if (entry.item.session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan, tidak bisa menghapus hitungan.' });
    }

    await prisma.stockOpnameEntry.delete({ where: { id } });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/opname/session/:id/finalize
 *
 * Approve final: kunci sesi opname. Setelah ini, SEMUA item & entry di
 * sesi tersebut tidak bisa lagi ditambah/diedit/dihapus (endpoint di
 * atas akan menolak). Tidak ada snapshot angka gabungan di level sesi
 * (beda dari desain lama) -- total & selisih tetap dihitung on-the-fly
 * dari entries yang sudah ada, karena begitu sesi "final", entries itu
 * tidak akan berubah lagi juga.
 */
router.post('/session/:id/finalize', async (req, res) => {
  try {
    const { id } = req.params;

    const session = await prisma.stockOpnameSession.findUnique({ where: { id } });
    if (!session) {
      return res.status(404).json({ error: 'Sesi opname tidak ditemukan.' });
    }
    if (session.status === 'final') {
      return res.status(400).json({ error: 'Sesi ini sudah di-final-kan sebelumnya.' });
    }

    const updated = await prisma.stockOpnameSession.update({
      where: { id },
      data: { status: 'final', finalizedAt: new Date() },
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/opname/history
 *
 * Daftar semua sesi opname (final maupun open), untuk halaman Riwayat
 * Opname. Menampilkan ringkasan per sesi (jumlah produk, jumlah yang
 * ada selisih), BUKAN detail penuh (pakai GET /session/:id untuk itu).
 */
router.get('/history', async (req, res) => {
  try {
    const sessions = await prisma.stockOpnameSession.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { entries: true } },
      },
    });

    const result = sessions.map((s) => {
      const selisihCount = s.items.filter((item) => {
        const total = sumEntries(item.entries);
        return !total.minus(item.systemKoli).isZero();
      }).length;

      return {
        id: s.id,
        name: s.name,
        status: s.status,
        itemCount: s.items.length,
        selisihCount,
        finalizedAt: s.finalizedAt,
        createdAt: s.createdAt,
      };
    });

    res.json({ count: result.length, sessions: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;