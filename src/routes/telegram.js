// src/routes/telegram.js
// Bot Telegram, model ON-DEMAND SAJA (tidak ada notifikasi otomatis).
// Telegram mengirim tiap pesan baru ke endpoint webhook di bawah lewat
// HTTP POST -- ini WAJIB karena backend kita serverless (Vercel), jadi
// tidak bisa "polling" terus-menerus kayak bot Telegram pada umumnya.
//
// Command yang didukung:
//   /stok <nama produk>  -> cari & tampilkan stok
//   /sync                -> jalankan sync dari Google Sheets
//   /opname               -> ringkasan sesi Stock Opname yang masih open
//   /laporan               -> top 10 volume masuk & keluar, 30 hari terakhir
//   /help atau /start      -> daftar command
//
// KEAMANAN: hanya chat ID yang cocok dengan TELEGRAM_ALLOWED_CHAT_ID yang
// akan dilayani. Kalau env var itu BELUM diisi (mode setup awal), bot akan
// membalas chat ID pengirim -- supaya gampang disalin ke .env / Vercel env
// var, tanpa perlu manggil endpoint getUpdates Telegram secara manual.

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { Prisma } = require('@prisma/client');
const { syncFromSheets } = require('../services/syncService');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Jumlah item yang ditampilkan per kategori di /laporan. Sengaja lebih
// kecil dari versi web (top 30), karena balasan chat Telegram lebih enak
// dibaca kalau ringkas -- 10 item x 2 kategori (In & Out) sudah cukup
// padat untuk 1 pesan chat di HP.
const LAPORAN_TOP_N = 10;

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function currentPeriodLabel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function fmt(n) {
  return Number(n).toLocaleString('id-ID');
}

const HELP_TEXT = [
  'Perintah yang tersedia:',
  '/stok <nama produk> - cari stok produk',
  '/sync - jalankan sync dari Google Sheets',
  '/opname - ringkasan sesi Stock Opname yang masih berjalan',
  `/laporan - top ${LAPORAN_TOP_N} volume masuk & keluar (30 hari terakhir)`,
  `/laporan DD-MM-YYYY - laporan untuk tanggal tertentu saja, contoh: /laporan 15-07-2026`,
  `/masuk DD-MM-YYYY - daftar LENGKAP semua barang masuk pada tanggal itu, contoh: /masuk 15-07-2026`,
  `/masuk <kode> DD-MM-YYYY s/d DD-MM-YYYY - riwayat masuk 1 produk dalam rentang tanggal, contoh: /masuk 1681 01-07-2026 s/d 31-07-2026`,
  `/keluar DD-MM-YYYY - daftar LENGKAP semua barang keluar pada tanggal itu, contoh: /keluar 15-07-2026`,
  `/keluar <kode> DD-MM-YYYY s/d DD-MM-YYYY - riwayat keluar 1 produk dalam rentang tanggal, contoh: /keluar 1681 01-07-2026 s/d 31-07-2026`,
  `/retur DD-MM-YYYY - daftar LENGKAP semua retur pada tanggal itu, contoh: /retur 15-07-2026`,
  `/retur <kode> DD-MM-YYYY s/d DD-MM-YYYY - riwayat retur 1 produk dalam rentang tanggal, contoh: /retur 1681 01-07-2026 s/d 31-07-2026`,
].join('\n');

// ===== Handler tiap command =====

async function handleStok(query) {
  if (!query) return 'Format: /stok <nama produk>\nContoh: /stok Stand Fan 1681';

  const periodLabel = currentPeriodLabel();
  const products = await prisma.product.findMany({
    where: { code: { contains: query, mode: 'insensitive' } },
    take: 5,
  });
  if (products.length === 0) return `Tidak ada produk yang cocok dengan "${query}".`;

  const summaries = await prisma.stockSummary.findMany({
    where: { productId: { in: products.map((p) => p.id) }, periodLabel },
  });
  const summaryByProduct = new Map(summaries.map((s) => [s.productId, s]));

  const lines = products.map((p) => {
    const summary = summaryByProduct.get(p.id);
    const stok = summary ? fmt(summary.stockCountFinal) : 'belum ada data periode ini';
    return `${p.code} (${p.kategori || '-'})\nStok: ${stok} koli`;
  });

  return lines.join('\n\n');
}

async function handleSync() {
  const now = new Date();
  const result = await syncFromSheets({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    triggeredBy: 'telegram',
  });
  return `Sync selesai.\nProduk tersinkron: ${result.rowsSynced}\nPeriode: ${result.periodLabel}`;
}

async function handleOpname() {
  const session = await prisma.stockOpnameSession.findFirst({
    where: { status: 'open' },
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { entries: true, product: { select: { code: true } } } } },
  });

  if (!session) return 'Tidak ada sesi Stock Opname yang sedang berjalan.';

  let selisihCount = 0;
  const itemLines = session.items.map((item) => {
    const total = item.entries.reduce((sum, e) => sum.plus(e.countedKoli), new Prisma.Decimal(0));
    const selisih = total.minus(item.systemKoli);
    if (!selisih.isZero()) selisihCount += 1;
    return `${item.product.code}: ${fmt(total)} koli (selisih ${selisih.isZero() ? '0' : (selisih.isPositive() ? '+' : '') + fmt(selisih)})`;
  });

  return [
    `Sesi: ${session.name}`,
    `Produk dihitung: ${session.items.length} | Ada selisih: ${selisihCount}`,
    '',
    itemLines.length > 0 ? itemLines.join('\n') : '(belum ada produk ditambahkan)',
  ].join('\n');
}

/**
 * Parse tanggal format "DD-MM-YYYY" (dipisah strip, sesuai format
 * command /laporan) jadi objek Date. Return null kalau formatnya salah.
 */
function parseCommandDate(dateStr) {
  const parts = dateStr.trim().split('-');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map((p) => parseInt(p, 10));
  if (!day || !month || !year || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Parse argumen /masuk atau /keluar yang mengandung kode produk +
 * rentang tanggal, format: "<kode_produk> DD-MM-YYYY s/d DD-MM-YYYY"
 * Contoh: "1681 01-07-2026 s/d 31-07-2026"
 *
 * Kata penghubung "s/d" WAJIB ada persis di tengah -- ini sengaja,
 * supaya tidak ambigu menebak mana bagian kode produk (yang mungkin
 * mengandung angka, misal "1681") dan mana bagian tanggal awal/akhir.
 * Tanpa penanda jelas, "1681 01-07-2026 31-07-2026" bisa salah tafsir.
 *
 * Return null kalau argumen tidak mengandung pola "s/d" sama sekali
 * (artinya ini bukan format rentang, kemungkinan format 1-tanggal biasa).
 * Return { error: string } kalau pola "s/d" ada tapi formatnya salah.
 * Return { productQuery, start, end } kalau berhasil di-parse.
 */
function parseProductDateRangeArg(arg) {
  if (!/\bs\/d\b/i.test(arg)) return null; // bukan format rentang, biarkan caller coba format lain

  const parts = arg.split(/\s+s\/d\s+/i);
  if (parts.length !== 2) {
    return { error: 'Format salah. Gunakan: <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: 1681 01-07-2026 s/d 31-07-2026' };
  }

  const [beforePart, endDateStr] = parts;
  const beforeTokens = beforePart.trim().split(/\s+/);
  const startDateStr = beforeTokens[beforeTokens.length - 1];
  const productQuery = beforeTokens.slice(0, -1).join(' ').trim();

  if (!productQuery) {
    return { error: 'Kode produk belum diisi. Format: <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: 1681 01-07-2026 s/d 31-07-2026' };
  }

  const start = parseCommandDate(startDateStr);
  const end = parseCommandDate(endDateStr);
  if (!start || !end) {
    return { error: 'Format tanggal salah. Gunakan: DD-MM-YYYY\nContoh: 1681 01-07-2026 s/d 31-07-2026' };
  }
  if (start > end) {
    return { error: 'Tanggal awal tidak boleh lebih besar dari tanggal akhir.' };
  }

  end.setUTCHours(23, 59, 59, 999);
  return { productQuery, start, end };
}

async function handleLaporan(arg) {
  let start, end, labelPeriode;

  if (arg) {
    // Mode tanggal spesifik: /laporan 15-07-2026 -> data hari itu saja
    const targetDate = parseCommandDate(arg);
    if (!targetDate) {
      return 'Format tanggal salah. Gunakan: /laporan DD-MM-YYYY\nContoh: /laporan 15-07-2026\n\nAtau /laporan tanpa tanggal untuk 30 hari terakhir.';
    }
    start = new Date(targetDate);
    end = new Date(targetDate);
    end.setUTCHours(23, 59, 59, 999);
    labelPeriode = arg;
  } else {
    // Mode default: 30 hari terakhir (perilaku lama, tidak berubah)
    end = new Date();
    start = new Date();
    start.setDate(start.getDate() - 30);
    labelPeriode = '30 hari terakhir';
  }

  const entries = await prisma.stockDailyEntry.findMany({
    where: { date: { gte: start, lte: end } },
    include: { product: { select: { code: true } } },
  });

  const statsByProduct = new Map();
  for (const e of entries) {
    if (!statsByProduct.has(e.productId)) {
      statsByProduct.set(e.productId, { code: e.product.code, totalIn: new Prisma.Decimal(0), totalOut: new Prisma.Decimal(0) });
    }
    const stat = statsByProduct.get(e.productId);
    stat.totalIn = stat.totalIn.plus(e.inKoli);
    stat.totalOut = stat.totalOut.plus(e.outKoli);
  }

  const all = Array.from(statsByProduct.values());
  const topIn = [...all].sort((a, b) => b.totalIn.comparedTo(a.totalIn)).slice(0, LAPORAN_TOP_N);
  const topOut = [...all].sort((a, b) => b.totalOut.comparedTo(a.totalOut)).slice(0, LAPORAN_TOP_N);

  return [
    `📥 Top ${LAPORAN_TOP_N} Volume Masuk (${labelPeriode}):`,
    ...topIn.map((s, i) => `${i + 1}. ${s.code} - ${fmt(s.totalIn)} koli`),
    '',
    `📤 Top ${LAPORAN_TOP_N} Volume Keluar (${labelPeriode}):`,
    ...topOut.map((s, i) => `${i + 1}. ${s.code} - ${fmt(s.totalOut)} koli`),
  ].join('\n');
}

/**
 * /masuk DD-MM-YYYY -- daftar LENGKAP semua produk yang ada aktivitas
 * IN pada tanggal tersebut (tanpa batas jumlah).
 *
 * /masuk <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY -- riwayat IN harian
 * untuk 1 produk spesifik dalam rentang tanggal.
 */
async function handleMasuk(arg) {
  if (!arg) {
    return 'Format: /masuk DD-MM-YYYY\nAtau: /masuk <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: /masuk 15-07-2026\nContoh: /masuk 1681 01-07-2026 s/d 31-07-2026';
  }

  const rangeResult = parseProductDateRangeArg(arg);
  if (rangeResult) {
    if (rangeResult.error) return rangeResult.error;
    return handleMasukProdukRange(rangeResult.productQuery, rangeResult.start, rangeResult.end);
  }

  // Format lama: 1 tanggal, semua produk
  const targetDate = parseCommandDate(arg);
  if (!targetDate) {
    return 'Format tanggal salah. Gunakan: /masuk DD-MM-YYYY\nContoh: /masuk 15-07-2026';
  }

  const start = new Date(targetDate);
  const end = new Date(targetDate);
  end.setUTCHours(23, 59, 59, 999);

  const entries = await prisma.stockDailyEntry.findMany({
    where: { date: { gte: start, lte: end }, inKoli: { gt: 0 } },
    include: { product: { select: { code: true } } },
    orderBy: { inKoli: 'desc' },
  });

  if (entries.length === 0) {
    return `Tidak ada barang masuk pada tanggal ${arg}.`;
  }

  const lines = entries.map((e, i) => `${i + 1}. ${e.product.code} - ${fmt(e.inKoli)} koli`);

  return [`📥 Barang Masuk pada ${arg} (${entries.length} produk):`, ...lines].join('\n');
}

/**
 * Riwayat harian IN untuk 1 produk spesifik dalam rentang tanggal.
 * Kalau productQuery cocok lebih dari 1 produk, minta user perjelas
 * (supaya tidak salah tampilkan data produk yang salah).
 */
async function handleMasukProdukRange(productQuery, start, end) {
  const products = await prisma.product.findMany({
    where: { code: { contains: productQuery, mode: 'insensitive' } },
    take: 6,
  });

  if (products.length === 0) {
    return `Tidak ada produk yang cocok dengan "${productQuery}".`;
  }
  if (products.length > 1) {
    const codes = products.map((p) => `- ${p.code}`).join('\n');
    return `Ada ${products.length} produk yang cocok dengan "${productQuery}", perjelas kodenya:\n\n${codes}`;
  }

  const product = products[0];
  const entries = await prisma.stockDailyEntry.findMany({
    where: { productId: product.id, date: { gte: start, lte: end } },
    orderBy: { date: 'asc' },
  });

  const withActivity = entries.filter((e) => !new Prisma.Decimal(e.inKoli).isZero());
  const totalIn = entries.reduce((sum, e) => sum.plus(e.inKoli), new Prisma.Decimal(0));

  const startLabel = formatDateLabel(start);
  const endLabel = formatDateLabel(end);

  if (withActivity.length === 0) {
    return `📥 ${product.code}\nTidak ada barang masuk dari ${startLabel} s/d ${endLabel}.`;
  }

  const lines = withActivity.map((e) => `${formatDateLabel(e.date)}: ${fmt(e.inKoli)} koli`);

  return [
    `📥 Riwayat Masuk — ${product.code}`,
    `Periode: ${startLabel} s/d ${endLabel}`,
    '',
    ...lines,
    '',
    `Total: ${fmt(totalIn)} koli`,
  ].join('\n');
}

function formatDateLabel(date) {
  const d = new Date(date);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * /keluar DD-MM-YYYY -- daftar LENGKAP semua produk yang ada aktivitas
 * OUT pada tanggal tersebut (tanpa batas jumlah).
 *
 * /keluar <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY -- riwayat OUT harian
 * untuk 1 produk spesifik dalam rentang tanggal.
 */
async function handleKeluar(arg) {
  if (!arg) {
    return 'Format: /keluar DD-MM-YYYY\nAtau: /keluar <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: /keluar 15-07-2026\nContoh: /keluar 1681 01-07-2026 s/d 31-07-2026';
  }

  const rangeResult = parseProductDateRangeArg(arg);
  if (rangeResult) {
    if (rangeResult.error) return rangeResult.error;
    return handleKeluarProdukRange(rangeResult.productQuery, rangeResult.start, rangeResult.end);
  }

  // Format lama: 1 tanggal, semua produk
  const targetDate = parseCommandDate(arg);
  if (!targetDate) {
    return 'Format tanggal salah. Gunakan: /keluar DD-MM-YYYY\nContoh: /keluar 15-07-2026';
  }

  const start = new Date(targetDate);
  const end = new Date(targetDate);
  end.setUTCHours(23, 59, 59, 999);

  const entries = await prisma.stockDailyEntry.findMany({
    where: { date: { gte: start, lte: end }, outKoli: { gt: 0 } },
    include: { product: { select: { code: true } } },
    orderBy: { outKoli: 'desc' },
  });

  if (entries.length === 0) {
    return `Tidak ada barang keluar pada tanggal ${arg}.`;
  }

  const lines = entries.map((e, i) => `${i + 1}. ${e.product.code} - ${fmt(e.outKoli)} koli`);

  return [`📤 Barang Keluar pada ${arg} (${entries.length} produk):`, ...lines].join('\n');
}

/**
 * Riwayat harian OUT untuk 1 produk spesifik dalam rentang tanggal.
 * Sama persis polanya dengan handleMasukProdukRange, cuma outKoli.
 */
async function handleKeluarProdukRange(productQuery, start, end) {
  const products = await prisma.product.findMany({
    where: { code: { contains: productQuery, mode: 'insensitive' } },
    take: 6,
  });

  if (products.length === 0) {
    return `Tidak ada produk yang cocok dengan "${productQuery}".`;
  }
  if (products.length > 1) {
    const codes = products.map((p) => `- ${p.code}`).join('\n');
    return `Ada ${products.length} produk yang cocok dengan "${productQuery}", perjelas kodenya:\n\n${codes}`;
  }

  const product = products[0];
  const entries = await prisma.stockDailyEntry.findMany({
    where: { productId: product.id, date: { gte: start, lte: end } },
    orderBy: { date: 'asc' },
  });

  const withActivity = entries.filter((e) => !new Prisma.Decimal(e.outKoli).isZero());
  const totalOut = entries.reduce((sum, e) => sum.plus(e.outKoli), new Prisma.Decimal(0));

  const startLabel = formatDateLabel(start);
  const endLabel = formatDateLabel(end);

  if (withActivity.length === 0) {
    return `📤 ${product.code}\nTidak ada barang keluar dari ${startLabel} s/d ${endLabel}.`;
  }

  const lines = withActivity.map((e) => `${formatDateLabel(e.date)}: ${fmt(e.outKoli)} koli`);

  return [
    `📤 Riwayat Keluar — ${product.code}`,
    `Periode: ${startLabel} s/d ${endLabel}`,
    '',
    ...lines,
    '',
    `Total: ${fmt(totalOut)} koli`,
  ].join('\n');
}

/**
 * /retur DD-MM-YYYY -- daftar LENGKAP semua produk yang ada retur pada
 * tanggal tersebut (tanpa batas jumlah).
 *
 * /retur <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY -- riwayat retur harian
 * untuk 1 produk spesifik dalam rentang tanggal.
 *
 * Sama persis polanya dengan /masuk, cuma sumber datanya
 * ReturDailyEntry (returKoli), bukan StockDailyEntry. Retur cuma ada
 * "masuk" saja (tidak ada versi "keluar"), makanya cuma 1 command.
 */
async function handleRetur(arg) {
  if (!arg) {
    return 'Format: /retur DD-MM-YYYY\nAtau: /retur <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: /retur 15-07-2026\nContoh: /retur 1681 01-07-2026 s/d 31-07-2026';
  }

  const rangeResult = parseProductDateRangeArg(arg);
  if (rangeResult) {
    if (rangeResult.error) return rangeResult.error;
    return handleReturProdukRange(rangeResult.productQuery, rangeResult.start, rangeResult.end);
  }

  // Format lama: 1 tanggal, semua produk
  const targetDate = parseCommandDate(arg);
  if (!targetDate) {
    return 'Format tanggal salah. Gunakan: /retur DD-MM-YYYY\nContoh: /retur 15-07-2026';
  }

  const start = new Date(targetDate);
  const end = new Date(targetDate);
  end.setUTCHours(23, 59, 59, 999);

  const entries = await prisma.returDailyEntry.findMany({
    where: { date: { gte: start, lte: end }, returKoli: { gt: 0 } },
    include: { product: { select: { code: true } } },
    orderBy: { returKoli: 'desc' },
  });

  if (entries.length === 0) {
    return `Tidak ada retur pada tanggal ${arg}.`;
  }

  const lines = entries.map((e, i) => `${i + 1}. ${e.product.code} - ${fmt(e.returKoli)} koli`);

  return [`↩️ Retur pada ${arg} (${entries.length} produk):`, ...lines].join('\n');
}

/**
 * Riwayat harian retur untuk 1 produk spesifik dalam rentang tanggal.
 * Sama persis polanya dengan handleMasukProdukRange, cuma returKoli
 * dari tabel ReturDailyEntry.
 */
async function handleReturProdukRange(productQuery, start, end) {
  const products = await prisma.product.findMany({
    where: { code: { contains: productQuery, mode: 'insensitive' } },
    take: 6,
  });

  if (products.length === 0) {
    return `Tidak ada produk yang cocok dengan "${productQuery}".`;
  }
  if (products.length > 1) {
    const codes = products.map((p) => `- ${p.code}`).join('\n');
    return `Ada ${products.length} produk yang cocok dengan "${productQuery}", perjelas kodenya:\n\n${codes}`;
  }

  const product = products[0];
  const entries = await prisma.returDailyEntry.findMany({
    where: { productId: product.id, date: { gte: start, lte: end } },
    orderBy: { date: 'asc' },
  });

  const withActivity = entries.filter((e) => !new Prisma.Decimal(e.returKoli).isZero());
  const totalRetur = entries.reduce((sum, e) => sum.plus(e.returKoli), new Prisma.Decimal(0));

  const startLabel = formatDateLabel(start);
  const endLabel = formatDateLabel(end);

  if (withActivity.length === 0) {
    return `↩️ ${product.code}\nTidak ada retur dari ${startLabel} s/d ${endLabel}.`;
  }

  const lines = withActivity.map((e) => `${formatDateLabel(e.date)}: ${fmt(e.returKoli)} koli`);

  return [
    `↩️ Riwayat Retur — ${product.code}`,
    `Periode: ${startLabel} s/d ${endLabel}`,
    '',
    ...lines,
    '',
    `Total: ${fmt(totalRetur)} koli`,
  ].join('\n');
}

router.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.json({ ok: true }); // abaikan update non-teks (foto, stiker, dll)
    }

    const chatId = message.chat.id;
    // TELEGRAM_ALLOWED_CHAT_ID bisa berisi lebih dari 1 chat ID, dipisah
    // koma, supaya beberapa orang bisa pakai bot yang sama. Contoh:
    // TELEGRAM_ALLOWED_CHAT_ID=6591808653,1234567890
    const allowedChatIdRaw = process.env.TELEGRAM_ALLOWED_CHAT_ID;
    const allowedChatIds = allowedChatIdRaw
      ? allowedChatIdRaw.split(',').map((id) => id.trim()).filter(Boolean)
      : [];

    // Mode setup: env var belum diisi -> kasih tau chat ID pengirim
    if (allowedChatIds.length === 0) {
      await sendMessage(chatId, `Chat ID kamu: ${chatId}\n\nSalin ke .env / Vercel env var sebagai TELEGRAM_ALLOWED_CHAT_ID, lalu restart server.\n\nUntuk beberapa orang sekaligus, pisahkan dengan koma, contoh:\nTELEGRAM_ALLOWED_CHAT_ID=6591808653,1234567890`);
      return res.json({ ok: true });
    }

    // Chat ID tidak ada di daftar yang diizinkan -> abaikan diam-diam
    // (jangan balas apapun, supaya tidak membocorkan bahwa bot ini
    // "hidup" ke orang lain)
    if (!allowedChatIds.includes(String(chatId))) {
      return res.json({ ok: true });
    }

    const text = message.text.trim();
    const [command, ...rest] = text.split(' ');
    const arg = rest.join(' ').trim();

    let reply;
    switch (command.toLowerCase()) {
      case '/start':
      case '/help':
        reply = HELP_TEXT;
        break;
      case '/stok':
        reply = await handleStok(arg);
        break;
      case '/sync':
        await sendMessage(chatId, 'Sync dimulai, tunggu sebentar...');
        reply = await handleSync();
        break;
      case '/opname':
        reply = await handleOpname();
        break;
      case '/laporan':
        reply = await handleLaporan(arg);
        break;
      case '/masuk':
        reply = await handleMasuk(arg);
        break;
      case '/keluar':
        reply = await handleKeluar(arg);
        break;
      case '/retur':
        reply = await handleRetur(arg);
        break;
      default:
        reply = `Perintah tidak dikenali.\n\n${HELP_TEXT}`;
    }

    await sendMessage(chatId, reply);
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram webhook error:', err);
    // Tetap balas 200 ke Telegram supaya tidak retry berulang-ulang
    res.json({ ok: true });
  }
});

module.exports = router;