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
const ExcelJS = require('exceljs');

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

/**
 * Kirim foto ke Telegram dari URL gambar (bukan upload file). Dipakai
 * untuk /chart -- gambar chart digenerate lewat QuickChart.io (layanan
 * gratis, render chart dari config Chart.js yang dikirim lewat URL),
 * sehingga backend kita TIDAK perlu install library canvas/gambar
 * apapun (chartjs-node-canvas dkk sering gagal di lingkungan serverless
 * seperti Vercel karena butuh native binary Cairo).
 */
async function sendPhoto(chatId, photoUrl, caption) {
  await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
  });
}

/**
 * Kirim file (dokumen) ke Telegram dari Buffer, misal file Excel hasil
 * generate ExcelJS. Beda dari sendMessage/sendPhoto yang JSON biasa --
 * endpoint sendDocument Telegram butuh multipart/form-data, makanya
 * pakai FormData + Blob bawaan Node (tersedia sejak Node 18+, TIDAK
 * perlu install library form-data tambahan).
 */
async function sendDocument(chatId, buffer, filename, caption) {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  if (caption) formData.append('caption', caption);
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  formData.append('document', blob, filename);

  await fetch(`${TELEGRAM_API}/sendDocument`, {
    method: 'POST',
    body: formData,
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
  '/stok <kode1>, <kode2>, ... - cari banyak produk sekaligus, contoh: /stok 1681, 1682, 1683',
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
  `/chart <kode> DD-MM-YYYY s/d DD-MM-YYYY - kirim grafik batang In vs Out 1 produk dalam rentang tanggal, contoh: /chart 1681 01-07-2026 s/d 31-07-2026`,
  `/rekap [MM-YYYY] - grand total Masuk & Keluar SEMUA produk 1 bulan, + breakdown Excel. Tanpa argumen = bulan berjalan. Contoh: /rekap 07-2026`,
].join('\n');

// ===== Handler tiap command =====

/**
 * /stok <query> -- cari & tampilkan stok produk.
 *
 * Bisa diisi 1 kata kunci (perilaku lama, dibatasi 5 hasil), atau
 * BEBERAPA kata kunci dipisah koma untuk cari banyak produk sekaligus,
 * contoh: /stok 1681, 1682, 1683 -- masing-masing kata kunci diproses
 * TERPISAH dan hasilnya dikelompokkan per kata kunci biar jelas. Kalau
 * mode banyak kata kunci, TIDAK dibatasi 5 hasil per kata kunci (semua
 * yang cocok ditampilkan), karena user sudah eksplisit tahu kode yang
 * dicari, beda dari pencarian bebas 1 kata kunci yang bisa sangat umum.
 */
async function handleStok(query) {
  if (!query) return 'Format: /stok <nama produk>\nContoh: /stok Stand Fan 1681\n\nBisa juga banyak sekaligus, dipisah koma:\n/stok 1681, 1682, 1683';

  const periodLabel = currentPeriodLabel();
  const keywords = query.split(',').map((k) => k.trim()).filter(Boolean);

  // Mode 1 kata kunci: perilaku lama persis, dibatasi 5 hasil
  if (keywords.length === 1) {
    return formatStokResult(keywords[0], periodLabel, 5);
  }

  // Mode banyak kata kunci: proses tiap kata kunci terpisah, tanpa
  // batas hasil, dikelompokkan per kata kunci
  const sections = [];
  for (const keyword of keywords) {
    const result = await formatStokResult(keyword, periodLabel, null);
    sections.push(`🔎 "${keyword}"\n${result}`);
  }
  return sections.join('\n\n---\n\n');
}

/**
 * Helper: cari produk by keyword, gabungkan dengan StockSummary periode
 * berjalan, format jadi teks siap kirim. limit null berarti tanpa batas.
 */
async function formatStokResult(keyword, periodLabel, limit) {
  const products = await prisma.product.findMany({
    where: { code: { contains: keyword, mode: 'insensitive' } },
    ...(limit ? { take: limit } : {}),
  });
  if (products.length === 0) return `Tidak ada produk yang cocok dengan "${keyword}".`;

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

/**
 * Cari produk by kode/keyword untuk konteks di mana kita butuh TEPAT 1
 * produk (dipakai /chart, /masuk, /keluar, /retur mode rentang tanggal).
 *
 * Kalau ada yang EXACT match (case-insensitive) dengan productQuery,
 * langsung pakai itu -- meski ada produk lain yang kodenya mengandung
 * productQuery sebagai substring (mis. cari "31A" tapi ada juga "31AS"
 * dan "31AT"). Ini supaya user yang sudah ketik kode lengkap & persis
 * tidak perlu ditanya lagi "perjelas kodenya".
 *
 * Kalau TIDAK ada exact match dan hasil pencarian lebih dari 1, baru
 * dianggap ambigu dan user diminta memperjelas.
 *
 * Return { error: string } kalau 0 hasil atau ambigu.
 * Return { product } kalau berhasil ketemu 1 produk pasti.
 */
async function resolveSingleProduct(productQuery) {
  const products = await prisma.product.findMany({
    where: { code: { contains: productQuery, mode: 'insensitive' } },
    take: 6,
  });

  if (products.length === 0) {
    return { error: `Tidak ada produk yang cocok dengan "${productQuery}".` };
  }

  const exactMatch = products.find(
    (p) => p.code.toLowerCase() === productQuery.toLowerCase()
  );
  if (exactMatch) {
    return { product: exactMatch };
  }

  if (products.length > 1) {
    const codes = products.map((p) => `- ${p.code}`).join('\n');
    return { error: `Ada ${products.length} produk yang cocok dengan "${productQuery}", perjelas kodenya:\n\n${codes}` };
  }

  return { product: products[0] };
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
  const [dayStr, monthStr, yearStr] = parts;
  // Tahun WAJIB 4 digit -- tanpa ini, input seperti "15-07-26" akan
  // ke-parse jadi tahun 1926 (parseInt("26") = 26), bukan error, dan
  // hasilnya diam-diam kosong tanpa user tahu kenapa.
  if (!/^\d{4}$/.test(yearStr)) return null;
  const day = parseInt(dayStr, 10);
  const month = parseInt(monthStr, 10);
  const year = parseInt(yearStr, 10);
  if (!day || !month || month < 1 || month > 12 || day < 1 || day > 31) return null;
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
 * Kalau productQuery cocok lebih dari 1 produk tanpa exact match,
 * resolveSingleProduct akan minta user perjelas (supaya tidak salah
 * tampilkan data produk yang salah).
 */
async function handleMasukProdukRange(productQuery, start, end) {
  const resolved = await resolveSingleProduct(productQuery);
  if (resolved.error) return resolved.error;
  const product = resolved.product;

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
  const resolved = await resolveSingleProduct(productQuery);
  if (resolved.error) return resolved.error;
  const product = resolved.product;

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
  const resolved = await resolveSingleProduct(productQuery);
  if (resolved.error) return resolved.error;
  const product = resolved.product;

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

/**
 * /chart <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY -- kirim bar chart
 * (gambar) In vs Out harian untuk 1 produk dalam rentang tanggal.
 *
 * Beda dari handler lain: fungsi ini TIDAK return string biasa, tapi
 * langsung kirim foto ke chatId (lewat sendPhoto) karena hasilnya
 * berupa gambar, bukan teks. Caller (router.post) perlu tahu ini --
 * lihat pengecekan `isChart` di switch-case.
 */
async function handleChart(chatId, arg) {
  if (!arg) {
    await sendMessage(chatId, 'Format: /chart <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: /chart 1681 01-07-2026 s/d 31-07-2026');
    return;
  }

  const rangeResult = parseProductDateRangeArg(arg);
  if (!rangeResult) {
    await sendMessage(chatId, 'Format: /chart <kode_produk> DD-MM-YYYY s/d DD-MM-YYYY\nContoh: /chart 1681 01-07-2026 s/d 31-07-2026');
    return;
  }
  if (rangeResult.error) {
    await sendMessage(chatId, rangeResult.error);
    return;
  }

  const { productQuery, start, end } = rangeResult;

  const resolved = await resolveSingleProduct(productQuery);
  if (resolved.error) {
    await sendMessage(chatId, resolved.error);
    return;
  }
  const product = resolved.product;

  const entries = await prisma.stockDailyEntry.findMany({
    where: { productId: product.id, date: { gte: start, lte: end } },
    orderBy: { date: 'asc' },
  });

  const withActivity = entries.filter((e) => !(new Prisma.Decimal(e.inKoli).plus(e.outKoli)).isZero());

  if (withActivity.length === 0) {
    await sendMessage(chatId, `📊 ${product.code}\nTidak ada aktivitas In/Out dari ${formatDateLabel(start)} s/d ${formatDateLabel(end)}.`);
    return;
  }

  const labels = withActivity.map((e) => {
    const d = new Date(e.date);
    return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
  const inData = withActivity.map((e) => Number(e.inKoli));
  const outData = withActivity.map((e) => Number(e.outKoli));

  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Masuk', data: inData, backgroundColor: 'rgba(34, 197, 94, 0.8)' },
        { label: 'Keluar', data: outData, backgroundColor: 'rgba(239, 68, 68, 0.8)' },
      ],
    },
    options: {
      title: { display: true, text: `${product.code} (koli)` },
      legend: { display: true },
    },
  };

  const chartUrl = `https://quickchart.io/chart?width=700&height=400&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;

  const totalIn = withActivity.reduce((sum, e) => sum.plus(e.inKoli), new Prisma.Decimal(0));
  const totalOut = withActivity.reduce((sum, e) => sum.plus(e.outKoli), new Prisma.Decimal(0));
  const caption = `📊 ${product.code}\nPeriode: ${formatDateLabel(start)} s/d ${formatDateLabel(end)}\nTotal Masuk: ${fmt(totalIn)} koli | Total Keluar: ${fmt(totalOut)} koli`;

  await sendPhoto(chatId, chartUrl, caption);
}

/**
 * Parse periode format "MM-YYYY" (contoh: "07-2026") jadi { year, month,
 * label }. Return null kalau formatnya salah.
 */
function parsePeriodArg(arg) {
  const parts = arg.trim().split('-');
  if (parts.length !== 2) return null;
  const [monthStr, yearStr] = parts;
  // Tahun WAJIB 4 digit -- tanpa ini, input seperti "07-26" akan
  // ke-parse jadi tahun 26 Masehi (bukan 2026), yang lolos validasi
  // angka tapi jelas bukan maksud user. Selalu bikin bingung karena
  // sistem tidak kasih error, cuma diam-diam hasilnya kosong.
  if (!/^\d{4}$/.test(yearStr)) return null;
  const month = parseInt(monthStr, 10);
  const year = parseInt(yearStr, 10);
  if (!month || month < 1 || month > 12) return null;
  return { year, month, label: `${String(month).padStart(2, '0')}-${year}` };
}

/**
 * /rekap [MM-YYYY] -- grand total Masuk & Keluar SEMUA produk dalam 1
 * bulan penuh, dikirim sebagai 2 bagian:
 *   1. Pesan teks: grand total keseluruhan (cepat dilihat)
 *   2. File Excel: breakdown lengkap per produk (kode, kategori, in, out)
 *
 * Tanpa argumen -> bulan berjalan. Dengan argumen MM-YYYY -> bulan itu.
 *
 * Beda dari handler lain: fungsi ini TIDAK return string, tapi langsung
 * kirim pesan + file sendiri (chatId diperlukan sebagai parameter),
 * sama seperti pola handleChart.
 */
async function handleRekap(chatId, arg) {
  let year, month, periodLabel;

  if (arg) {
    const parsed = parsePeriodArg(arg);
    if (!parsed) {
      await sendMessage(chatId, 'Format: /rekap MM-YYYY\nContoh: /rekap 07-2026\n\nAtau /rekap tanpa argumen untuk bulan berjalan.');
      return;
    }
    ({ year, month } = parsed);
    periodLabel = parsed.label;
  } else {
    const now = new Date();
    year = now.getFullYear();
    month = now.getMonth() + 1;
    periodLabel = `${String(month).padStart(2, '0')}-${year}`;
  }

  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)); // hari terakhir bulan itu

  const entries = await prisma.stockDailyEntry.findMany({
    where: { date: { gte: start, lte: end } },
    include: { product: { select: { code: true, kategori: true } } },
  });
  const returEntriesCheck = await prisma.returDailyEntry.count({
    where: { date: { gte: start, lte: end } },
  });

  if (entries.length === 0 && returEntriesCheck === 0) {
    await sendMessage(chatId, `Tidak ada data In/Out/Retur untuk periode ${periodLabel}.`);
    return;
  }

  const statsByProduct = new Map();
  let grandTotalIn = new Prisma.Decimal(0);
  let grandTotalOut = new Prisma.Decimal(0);

  for (const e of entries) {
    if (!statsByProduct.has(e.productId)) {
      statsByProduct.set(e.productId, {
        code: e.product.code,
        kategori: e.product.kategori || '-',
        totalIn: new Prisma.Decimal(0),
        totalOut: new Prisma.Decimal(0),
        totalRetur: new Prisma.Decimal(0),
      });
    }
    const stat = statsByProduct.get(e.productId);
    stat.totalIn = stat.totalIn.plus(e.inKoli);
    stat.totalOut = stat.totalOut.plus(e.outKoli);
    grandTotalIn = grandTotalIn.plus(e.inKoli);
    grandTotalOut = grandTotalOut.plus(e.outKoli);
  }

  // Gabungkan data retur bulan yang sama. Produk yang punya retur tapi
  // TIDAK punya In/Out (jarang, tapi bisa terjadi) tetap dimasukkan ke
  // statsByProduct supaya returnya tidak hilang dari rekap.
  const returEntries = await prisma.returDailyEntry.findMany({
    where: { date: { gte: start, lte: end } },
    include: { product: { select: { code: true, kategori: true } } },
  });
  let grandTotalRetur = new Prisma.Decimal(0);
  for (const e of returEntries) {
    if (!statsByProduct.has(e.productId)) {
      statsByProduct.set(e.productId, {
        code: e.product.code,
        kategori: e.product.kategori || '-',
        totalIn: new Prisma.Decimal(0),
        totalOut: new Prisma.Decimal(0),
        totalRetur: new Prisma.Decimal(0),
      });
    }
    const stat = statsByProduct.get(e.productId);
    stat.totalRetur = stat.totalRetur.plus(e.returKoli);
    grandTotalRetur = grandTotalRetur.plus(e.returKoli);
  }

  // Ambil stockCountFinal (Retur + Stock Akhir) untuk periode yang sama
  // -- dipakai isi kolom "Stok" di Excel. Format periodLabel di
  // StockSummary itu "YYYY-MM" (beda dari periodLabel command ini yang
  // "MM-YYYY"), jadi perlu dikonversi dulu.
  const dbPeriodLabel = `${year}-${String(month).padStart(2, '0')}`;
  const summaries = await prisma.stockSummary.findMany({
    where: { productId: { in: Array.from(statsByProduct.keys()) }, periodLabel: dbPeriodLabel },
  });
  const stockByProduct = new Map(summaries.map((s) => [s.productId, s.stockCountFinal]));

  // Kirim dulu ringkasan teks, biar user langsung dapat angka besarnya
  // tanpa perlu buka file Excel dulu
  const summaryText = [
    `📊 Rekap Barang Masuk & Keluar — ${periodLabel}`,
    '',
    `Total Masuk: ${fmt(grandTotalIn)} koli`,
    `Total Keluar: ${fmt(grandTotalOut)} koli`,
    `Total Retur: ${fmt(grandTotalRetur)} koli`,
    `Jumlah produk aktif: ${statsByProduct.size}`,
    '',
    'Breakdown lengkap per produk (+ retur & stok saat ini) terlampir di file Excel.',
  ].join('\n');
  await sendMessage(chatId, summaryText);

  // Susun file Excel breakdown per produk, urut dari total in+out terbesar
  const rows = Array.from(statsByProduct.entries()).sort(([, a], [, b]) =>
    b.totalIn.plus(b.totalOut).comparedTo(a.totalIn.plus(a.totalOut))
  );

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`Rekap ${periodLabel}`);
  sheet.columns = [
    { header: 'Kode Produk', key: 'code', width: 35 },
    { header: 'Kategori', key: 'kategori', width: 18 },
    { header: 'Total Masuk (Koli)', key: 'totalIn', width: 18 },
    { header: 'Total Keluar (Koli)', key: 'totalOut', width: 18 },
    { header: 'Total Retur (Koli)', key: 'totalRetur', width: 18 },
    { header: 'Stok (Koli)', key: 'stok', width: 14 },
  ];
  sheet.getRow(1).font = { bold: true };

  for (const [productId, row] of rows) {
    const stok = stockByProduct.get(productId);
    sheet.addRow({
      code: row.code,
      kategori: row.kategori,
      totalIn: Number(row.totalIn),
      totalOut: Number(row.totalOut),
      totalRetur: Number(row.totalRetur),
      stok: stok !== undefined ? Number(stok) : 'tidak ada data',
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  await sendDocument(chatId, buffer, `Rekap ${periodLabel}.xlsx`, `Breakdown per produk — ${periodLabel}`);
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
      case '/chart':
        // Beda dari handler lain: handleChart kirim foto sendiri
        // (lewat sendPhoto), jadi TIDAK perlu reply teks biasa di akhir.
        await handleChart(chatId, arg);
        return res.json({ ok: true });
      case '/rekap':
        // Sama seperti /chart: handleRekap kirim pesan + file sendiri.
        await handleRekap(chatId, arg);
        return res.json({ ok: true });
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