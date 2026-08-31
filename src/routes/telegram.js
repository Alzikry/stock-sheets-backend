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

// Batas minimal stok (koli) supaya produk masuk hitungan /slowmoving.
// Sengaja dipisah jadi konstanta -- kalau suatu saat mau diubah jadi
// argumen command (mis. /slowmoving 07-2026 100), tinggal pakai variabel
// ini sebagai default-nya.
const SLOWMOVING_MIN_STOK = 50;

// Kategori yang ditampilkan di /stokkosong. Dicocokkan ke field
// `kategori` produk dengan partial match (case-insensitive), bukan
// exact match -- supaya tetap kena walau penulisan kategorinya agak
// beda-beda di database, misal "Kipas Angin", "Kompor Gas 2 Tungku",
// "Magic Com" dll, selama mengandung salah satu kata kunci ini.
const STOKKOSONG_KATEGORI_FILTER = ['kipas', 'kompor', 'antena', 'blender', 'dispenser', 'magicom'];

// Kata kunci kategori yang DIKECUALIKAN dari /stokkosong meski cocok
// dengan STOKKOSONG_KATEGORI_FILTER -- khususnya "kipas import" tidak
// mau ikut ditampilkan (kipas import ditangani terpisah dari kipas
// biasa). Dicek dengan partial match juga, case-insensitive.
const STOKKOSONG_KATEGORI_EXCLUDE = ['import'];

// Ambang batas stok (koli) untuk /stokkosong -- semua produk dengan
// stok DI BAWAH angka ini (termasuk yang kosong/0 dan yang negatif/minus)
// akan ditampilkan.
const STOKKOSONG_MAX_STOK = 100;

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
  `/slowmoving [MM-YYYY] - semua produk berstok di atas ${SLOWMOVING_MIN_STOK} koli dengan Keluar rendah/nol 1 bulan, dikelompokkan per kategori di Excel. Tanpa argumen = bulan berjalan. Contoh: /slowmoving 07-2026`,
  `/stokkosong [MM-YYYY] - semua produk kategori Kipas(non-import)/Kompor/Antena/Blender/Dispenser/Magicom dengan stok kosong atau di bawah ${STOKKOSONG_MAX_STOK} koli 1 bulan, + daftar lengkap Excel. Tanpa argumen = bulan berjalan. Contoh: /stokkosong 07-2026`,
  `/banding MM-YYYY - bandingkan volume Masuk & Keluar bulan itu dengan bulan sebelumnya, + breakdown per produk Excel. Contoh: /banding 08-2026`,
  `/banding MM-YYYY MM-YYYY - bandingkan dua bulan spesifik. Contoh: /banding 07-2026 08-2026`,
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

  // "Exact" di sini mencakup 2 kemungkinan:
  // 1. Kode produk sama persis dengan query, mis. kode "1663" vs query "1663"
  // 2. Bagian AKHIR kode produk (setelah tanda "-" terakhir) sama persis
  //    dengan query, mis. kode "WKC-31A" vs query "31A" -- karena banyak
  //    kode produk di sini pakai format PREFIX-SUFFIX (WKC-31A, WKC-31AS,
  //    WKC-31AT), dan user biasanya cuma ketik suffix-nya saja tanpa
  //    prefix. Tanpa ini, "31A" akan selalu dianggap cocok dengan
  //    "WKC-31A", "WKC-31AS", DAN "WKC-31AT" sekaligus (karena semuanya
  //    mengandung substring "31A"), padahal user mau yang PERSIS "31A".
  const queryLower = productQuery.toLowerCase();
  const exactMatch = products.find((p) => {
    const codeLower = p.code.toLowerCase();
    if (codeLower === queryLower) return true;
    const suffix = codeLower.slice(codeLower.lastIndexOf('-') + 1);
    return suffix === queryLower;
  });
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
 * Ubah { year, month } jadi nama bulan berbahasa Indonesia + tahun,
 * mis. year=2026, month=8 -> "Agustus 2026". Dipakai untuk judul utama
 * di file Excel /slowmoving dan /stokkosong, supaya lebih mudah dibaca
 * dibanding format singkat "08-2026".
 */
function namaBulanIndonesia(year, month) {
  const NAMA_BULAN = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ];
  return `${NAMA_BULAN[month - 1]} ${year}`;
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

/**
 * /slowmoving [MM-YYYY] -- semua produk yang STOKNYA DI ATAS
 * SLOWMOVING_MIN_STOK (default 50 koli) tapi volume Keluar (Out) rendah
 * atau nol dalam periode 1 bulan. Berguna untuk identifikasi barang yang
 * menumpuk di gudang / jarang terjual, supaya bisa ditindaklanjuti
 * (promo, retur ke supplier, dll).
 *
 * Kriteria "slow moving" di sini SENGAJA fokus ke volume Keluar saja
 * (bukan In+Out), karena barang yang banyak masuk tapi sedikit/tidak
 * keluar itu justru DEFINISI slow moving -- kalau dihitung In+Out,
 * barang yang rajin di-restock (In besar) bisa keliru dianggap "laku"
 * padahal outnya kecil.
 *
 * Filter stok > SLOWMOVING_MIN_STOK sengaja dipakai supaya produk
 * dengan sisa stok kecil (mis. 1-2 koli sisa terakhir yang memang wajar
 * jarang bergerak) tidak ikut membanjiri daftar -- fokusnya ke barang
 * yang jumlahnya besar tapi macet, bukan sisa-sisa kecil yang wajar.
 *
 * Tanpa argumen -> bulan berjalan. Dengan argumen MM-YYYY -> bulan itu.
 *
 * Urutan hasil: Out TERKECIL dulu (0 di paling atas) DI DALAM tiap
 * kategori, supaya produk paling "macet" langsung kelihatan tanpa perlu
 * scroll.
 *
 * OUTPUT:
 *   1. Pesan teks ringkas: total produk, jumlah yang Keluar = 0, dan
 *      breakdown per kategori (berapa produk tiap kategori).
 *   2. File Excel, dikelompokkan per SECTION KATEGORI (mis. "Kipas -
 *      Slow Moving", "Kompor - Slow Moving", dst -- kategori yang tidak
 *      diisi di database dikelompokkan sebagai "Lainnya"). Tiap section
 *      berisi kolom NO, Nama Material, Stok (Koli), Total Keluar
 *      (Koli), Sisa Stok (Koli) -- format ini SENGAJA dibuat meniru
 *      template Excel manual yang sudah dipakai tim gudang selama ini,
 *      supaya file dari bot bisa langsung dipakai tanpa perlu format
 *      ulang manual.
 */
async function handleSlowMoving(chatId, arg) {
  let year, month, periodLabel;

  if (arg) {
    const parsed = parsePeriodArg(arg);
    if (!parsed) {
      await sendMessage(chatId, 'Format: /slowmoving MM-YYYY\nContoh: /slowmoving 07-2026\n\nAtau /slowmoving tanpa argumen untuk bulan berjalan.');
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
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  // Format periodLabel di StockSummary itu "YYYY-MM" (beda dari
  // periodLabel command ini yang "MM-YYYY"), sama seperti di /rekap.
  const dbPeriodLabel = `${year}-${String(month).padStart(2, '0')}`;

  // Ambil produk yang stoknya DI ATAS ambang batas di periode ini (dari
  // StockSummary) -- ini basis utama, bukan StockDailyEntry, karena
  // kita justru mau termasuk produk yang TIDAK PUNYA entry sama sekali
  // bulan ini (artinya Out-nya otomatis 0, kandidat paling "slow
  // moving"), selama stoknya masih di atas ambang batas.
  const summaries = await prisma.stockSummary.findMany({
    where: { periodLabel: dbPeriodLabel, stockCountFinal: { gt: SLOWMOVING_MIN_STOK } },
    include: { product: { select: { id: true, code: true, kategori: true } } },
  });

  if (summaries.length === 0) {
    await sendMessage(chatId, `Tidak ada produk dengan stok di atas ${fmt(SLOWMOVING_MIN_STOK)} koli untuk periode ${periodLabel}.`);
    return;
  }

  // Hitung total Out per produk dari StockDailyEntry di periode yang
  // sama. Produk yang tidak muncul di sini berarti Out-nya 0.
  const entries = await prisma.stockDailyEntry.findMany({
    where: {
      date: { gte: start, lte: end },
      productId: { in: summaries.map((s) => s.productId) },
    },
  });
  const outByProduct = new Map();
  for (const e of entries) {
    const prev = outByProduct.get(e.productId) || new Prisma.Decimal(0);
    outByProduct.set(e.productId, prev.plus(e.outKoli));
  }

  // Gabungkan: tiap produk berstok (di atas ambang batas) dengan
  // kategori & total Out-nya (0 kalau tidak ada entry sama sekali).
  // Kategori kosong/null dikelompokkan sebagai "Lainnya" supaya tidak
  // hilang dari laporan.
  const rows = summaries.map((s) => ({
    code: s.product.code,
    kategori: (s.product.kategori && s.product.kategori.trim()) || 'Lainnya',
    stok: s.stockCountFinal,
    totalOut: outByProduct.get(s.productId) || new Prisma.Decimal(0),
  }));

  const zeroOutCount = rows.filter((r) => r.totalOut.isZero()).length;

  // Kelompokkan per kategori, tiap grup diurutkan Out terkecil dulu.
  const rowsByKategori = new Map();
  for (const r of rows) {
    if (!rowsByKategori.has(r.kategori)) rowsByKategori.set(r.kategori, []);
    rowsByKategori.get(r.kategori).push(r);
  }
  for (const groupRows of rowsByKategori.values()) {
    groupRows.sort((a, b) => a.totalOut.comparedTo(b.totalOut));
  }
  // Urutkan kategori berdasarkan JUMLAH produk terbanyak dulu, supaya
  // kategori paling "bermasalah" (paling banyak barang macet) muncul
  // di section atas file Excel.
  const kategoriSorted = Array.from(rowsByKategori.keys()).sort(
    (a, b) => rowsByKategori.get(b).length - rowsByKategori.get(a).length
  );

  // Ringkasan teks: breakdown jumlah produk per kategori
  const kategoriBreakdown = kategoriSorted.map((kat) => `- ${kat}: ${rowsByKategori.get(kat).length} produk`);

  const TOP_N_DI_CHAT = 20;
  const allSortedByOut = [...rows].sort((a, b) => a.totalOut.comparedTo(b.totalOut));
  const previewLines = allSortedByOut.slice(0, TOP_N_DI_CHAT).map((r, i) =>
    `${i + 1}. ${r.code} (${r.kategori}) — Keluar: ${fmt(r.totalOut)} koli | Stok: ${fmt(r.stok)} koli`
  );

  const summaryText = [
    `🐌 Slow Moving — ${periodLabel} (stok di atas ${fmt(SLOWMOVING_MIN_STOK)} koli)`,
    '',
    `Total produk berstok besar: ${rows.length}`,
    `Produk dengan Keluar = 0: ${zeroOutCount}`,
    '',
    'Breakdown per kategori:',
    ...kategoriBreakdown,
    '',
    `Top ${Math.min(TOP_N_DI_CHAT, allSortedByOut.length)} paling lambat bergerak (Keluar terkecil, semua kategori):`,
    ...previewLines,
    '',
    'Daftar LENGKAP per kategori (dipisah per sheet section) terlampir di file Excel.',
  ].join('\n');
  await sendMessage(chatId, summaryText);

  // File Excel: 1 sheet, dikelompokkan jadi beberapa SECTION per
  // kategori (meniru format template manual tim gudang) -- tiap
  // section punya judul sendiri, lalu header kolom sendiri, baru
  // daftar produknya. ExcelJS menulis section-section ini sebagai
  // baris-baris berurutan dalam 1 sheet yang sama.
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`Slow Moving ${periodLabel}`);

  // Lebar kolom disamakan untuk semua section, karena semua section
  // berbagi kolom A-E yang sama.
  sheet.columns = [
    { key: 'a', width: 6 },   // NO
    { key: 'b', width: 40 },  // Nama Material
    { key: 'c', width: 16 },  // Stok (Koli)
    { key: 'd', width: 18 },  // Total Keluar (Koli)
    { key: 'e', width: 14 },  // Sisa Stok (Koli)
  ];

  // Warna & border dipakai supaya file mirip template manual tim
  // gudang: judul section biru tua dengan teks putih, header kolom
  // biru muda, dan SEMUA sel (judul, header, data) diberi border tipis
  // supaya terlihat "berkotak-kotak" seperti contoh.
  const THIN_BORDER = { style: 'thin', color: { argb: 'FF999999' } };
  const CELL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  const TITLE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } }; // biru tua
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } }; // biru muda
  // Warna baris data diselang-seling (putih / biru sangat muda) supaya
  // lebih mudah dibaca untuk daftar yang panjang -- efek "zebra stripes".
  const ROW_FILL_EVEN = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FC' } };

  // Judul UTAMA di paling atas sheet, di atas semua section kategori --
  // menyebutkan nama laporan + periode dalam format nama bulan
  // (mis. "LAPORAN SLOW MOVING - AGUSTUS 2026"), supaya file langsung
  // jelas ini laporan bulan apa tanpa perlu buka nama file dulu.
  const mainTitleRow = sheet.addRow([`LAPORAN SLOW MOVING — ${namaBulanIndonesia(year, month).toUpperCase()}`]);
  sheet.mergeCells(mainTitleRow.number, 1, mainTitleRow.number, 5);
  mainTitleRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sheet.addRow([]); // baris kosong pemisah antara judul utama dan section pertama

  for (const kategori of kategoriSorted) {
    const groupRows = rowsByKategori.get(kategori);

    // Judul section, mis. "Kipas - Slow Moving" -- background biru tua,
    // teks putih & bold, di-merge dari kolom A sampai E.
    const titleRow = sheet.addRow([`${kategori} - Slow Moving`]);
    sheet.mergeCells(titleRow.number, 1, titleRow.number, 5);
    titleRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      cell.fill = TITLE_FILL;
      cell.border = CELL_BORDER;
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
    });

    // Header kolom section ini -- background biru muda, bold, border
    const headerRow = sheet.addRow(['NO', 'Nama Material', 'Stok (Koli)', 'Total Keluar (Koli)', 'Sisa Stok (Koli)']);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = CELL_BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    // Baris data produk di section ini -- border di semua sel, warna
    // selang-seling per baris
    groupRows.forEach((r, i) => {
      const dataRow = sheet.addRow([i + 1, r.code, Number(r.stok), Number(r.totalOut), Number(r.stok)]);
      dataRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = CELL_BORDER;
        if (i % 2 === 1) cell.fill = ROW_FILL_EVEN;
      });
      dataRow.getCell(1).alignment = { horizontal: 'center' };
      dataRow.getCell(3).alignment = { horizontal: 'right' };
      dataRow.getCell(4).alignment = { horizontal: 'right' };
      dataRow.getCell(5).alignment = { horizontal: 'right' };
    });

    // Baris kosong pemisah sebelum section berikutnya (tanpa border,
    // supaya jelas beda antar section)
    sheet.addRow([]);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  await sendDocument(chatId, buffer, `Slow Moving ${periodLabel}.xlsx`, `Semua produk berstok di atas ${fmt(SLOWMOVING_MIN_STOK)} koli, dikelompokkan per kategori — ${periodLabel}`);
}

/**
 * /stokkosong [MM-YYYY] -- semua produk dengan stok KOSONG (0) atau
 * DI BAWAH STOKKOSONG_MAX_STOK (default 100 koli) -- termasuk yang
 * negatif/minus -- dalam periode 1 bulan. Berguna untuk cepat ketahuan
 * produk mana yang stoknya menipis/habis dan perlu segera di-restock,
 * atau yang datanya bermasalah (stok minus biasanya nunjukin ada
 * kesalahan input Out lebih besar dari In+stok awal).
 *
 * Beda dari /slowmoving yang fokus ke "keluar sedikit", command ini
 * murni lihat angka stockCountFinal itu sendiri -- tidak peduli
 * aktivitas In/Out bulan itu seperti apa.
 *
 * Dibatasi HANYA untuk kategori Kipas, Kompor, Antena, Blender,
 * Dispenser, dan Magicom (STOKKOSONG_KATEGORI_FILTER) -- produk dengan
 * kategori lain tidak ikut ditampilkan sama sekali. Kategori yang
 * mengandung kata "import" (mis. "Kipas Import") DIKECUALIKAN meski
 * kategorinya cocok dengan salah satu di atas
 * (STOKKOSONG_KATEGORI_EXCLUDE).
 *
 * Di pesan ringkasan, hasil dikelompokkan jadi "Negatif (minus)" dan
 * "Kosong (0)" supaya yang paling butuh perhatian kelihatan duluan.
 * Tapi file Excel berisi SEMUA produk yang match (kosong, negatif,
 * MAUPUN yang stoknya 1-99 koli), karena tujuannya sebagai daftar
 * lengkap untuk ditindaklanjuti restock.
 *
 * Tanpa argumen -> bulan berjalan. Dengan argumen MM-YYYY -> bulan itu.
 */
async function handleStokKosong(chatId, arg) {
  let year, month, periodLabel;

  if (arg) {
    const parsed = parsePeriodArg(arg);
    if (!parsed) {
      await sendMessage(chatId, 'Format: /stokkosong MM-YYYY\nContoh: /stokkosong 07-2026\n\nAtau /stokkosong tanpa argumen untuk bulan berjalan.');
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

  // Format periodLabel di StockSummary itu "YYYY-MM" (beda dari
  // periodLabel command ini yang "MM-YYYY"), sama seperti di /rekap
  // dan /slowmoving.
  const dbPeriodLabel = `${year}-${String(month).padStart(2, '0')}`;

  const summaries = await prisma.stockSummary.findMany({
    where: { periodLabel: dbPeriodLabel, stockCountFinal: { lt: STOKKOSONG_MAX_STOK } },
    include: { product: { select: { id: true, code: true, kategori: true } } },
  });

  if (summaries.length === 0) {
    await sendMessage(chatId, `Tidak ada produk dengan stok di bawah ${fmt(STOKKOSONG_MAX_STOK)} koli untuk periode ${periodLabel}. 👍`);
    return;
  }

  // Filter kategori Kipas/Kompor/Antena/Blender/Dispenser/Magicom
  // (partial match, case-insensitive), lalu buang yang mengandung kata
  // "import" (mis. Kipas Import) -- lihat komentar
  // STOKKOSONG_KATEGORI_FILTER & STOKKOSONG_KATEGORI_EXCLUDE.
  const filteredSummaries = summaries.filter((s) => {
    const kategoriLower = (s.product.kategori || '').toLowerCase();
    const isTargetCategory = STOKKOSONG_KATEGORI_FILTER.some((keyword) => kategoriLower.includes(keyword));
    if (!isTargetCategory) return false;
    const isExcluded = STOKKOSONG_KATEGORI_EXCLUDE.some((keyword) => kategoriLower.includes(keyword));
    return !isExcluded;
  });

  if (filteredSummaries.length === 0) {
    await sendMessage(chatId, `Tidak ada produk kategori Kipas/Kompor/Antena/Blender/Dispenser/Magicom (non-import) dengan stok di bawah ${fmt(STOKKOSONG_MAX_STOK)} koli untuk periode ${periodLabel}. 👍`);
    return;
  }

  const rows = filteredSummaries.map((s) => ({
    code: s.product.code,
    kategori: s.product.kategori || '-',
    stok: s.stockCountFinal,
  }));

  const negatif = rows.filter((r) => new Prisma.Decimal(r.stok).isNegative());
  const kosong = rows.filter((r) => new Prisma.Decimal(r.stok).isZero());
  const dibawah100 = rows.filter((r) => new Prisma.Decimal(r.stok).isPositive());
  // Urut negatif dari yang paling minus dulu, biar yang paling parah
  // langsung kelihatan di atas.
  negatif.sort((a, b) => new Prisma.Decimal(a.stok).comparedTo(b.stok));

  const TOP_N_DI_CHAT = 20;
  const lines = [];
  lines.push(`⚠️ Stok Kosong / Di Bawah ${fmt(STOKKOSONG_MAX_STOK)} Koli — Kipas, Kompor, Antena, Blender, Dispenser, Magicom (non-import) — ${periodLabel}`);
  lines.push('');
  lines.push(`Stok Negatif (minus): ${negatif.length} produk`);
  lines.push(`Stok Kosong (0): ${kosong.length} produk`);
  lines.push(`Stok 1-${fmt(STOKKOSONG_MAX_STOK - 1)} koli: ${dibawah100.length} produk`);
  lines.push('');

  if (negatif.length > 0) {
    lines.push(`🔴 Stok Negatif${negatif.length > TOP_N_DI_CHAT ? ` (top ${TOP_N_DI_CHAT})` : ''}:`);
    lines.push(...negatif.slice(0, TOP_N_DI_CHAT).map((r, i) => `${i + 1}. ${r.code} — ${fmt(r.stok)} koli`));
    lines.push('');
  }

  if (kosong.length > 0) {
    const remainingSlots = Math.max(0, TOP_N_DI_CHAT - Math.min(negatif.length, TOP_N_DI_CHAT));
    lines.push(`⚪ Stok Kosong${kosong.length > remainingSlots ? ` (top ${remainingSlots})` : ''}:`);
    if (remainingSlots > 0) {
      lines.push(...kosong.slice(0, remainingSlots).map((r, i) => `${i + 1}. ${r.code}`));
    } else {
      lines.push('(lihat file Excel untuk daftar lengkap)');
    }
    lines.push('');
  }

  lines.push(`Daftar LENGKAP (termasuk yang stoknya 1-${fmt(STOKKOSONG_MAX_STOK - 1)} koli) terlampir di file Excel.`);

  await sendMessage(chatId, lines.join('\n'));

  // File Excel: SEMUA produk yang match (negatif + kosong + 1-99),
  // urut stok terkecil (paling minus/kritis) dulu.
  const allSorted = [...rows].sort((a, b) => new Prisma.Decimal(a.stok).comparedTo(b.stok));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`Stok Kosong ${periodLabel}`);

  const mainTitleRow = sheet.addRow([`LAPORAN STOK KOSONG — ${namaBulanIndonesia(year, month).toUpperCase()}`]);
  sheet.mergeCells(mainTitleRow.number, 1, mainTitleRow.number, 4);
  mainTitleRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sheet.addRow([]);

  sheet.columns = [
    { key: 'code', width: 35 },
    { key: 'kategori', width: 18 },
    { key: 'stok', width: 14 },
    { key: 'status', width: 14 },
  ];
  const headerRow = sheet.addRow(['Kode Produk', 'Kategori', 'Stok (Koli)', 'Status']);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  for (const r of allSorted) {
    const stokDecimal = new Prisma.Decimal(r.stok);
    let status;
    if (stokDecimal.isNegative()) status = 'Negatif';
    else if (stokDecimal.isZero()) status = 'Kosong';
    else status = `Di bawah ${fmt(STOKKOSONG_MAX_STOK)}`;

    sheet.addRow({
      code: r.code,
      kategori: r.kategori,
      stok: Number(r.stok),
      status,
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  await sendDocument(chatId, buffer, `Stok Kosong ${periodLabel}.xlsx`, `Semua produk stok kosong/di bawah ${fmt(STOKKOSONG_MAX_STOK)} koli (Kipas non-import, Kompor, Antena, Blender, Dispenser, Magicom), urut stok terkecil — ${periodLabel}`);
}

/**
 * Parse argumen /banding, yang mendukung 2 bentuk:
 *   - 1 argumen "MM-YYYY" -> bandingkan bulan itu dengan bulan SEBELUMNYA
 *     secara otomatis (mis. "08-2026" -> Juli 2026 vs Agustus 2026).
 *   - 2 argumen "MM-YYYY MM-YYYY" -> bandingkan dua bulan spesifik sesuai
 *     urutan yang diketik user (bulan pertama = A, bulan kedua = B),
 *     TIDAK harus berurutan kronologis (biar user bisa banding lintas
 *     tahun atau lompat beberapa bulan sesuka mereka).
 *
 * Return { error: string } kalau format salah.
 * Return { periodA: {year,month,label}, periodB: {year,month,label} }
 * kalau berhasil di-parse.
 */
function parseBandingArg(arg) {
  if (!arg) {
    return { error: 'Format: /banding MM-YYYY (dibanding bulan sebelumnya otomatis)\nAtau: /banding MM-YYYY MM-YYYY (dua bulan spesifik)\n\nContoh: /banding 08-2026\nContoh: /banding 07-2026 08-2026' };
  }

  const tokens = arg.trim().split(/\s+/);

  if (tokens.length === 1) {
    const periodB = parsePeriodArg(tokens[0]);
    if (!periodB) {
      return { error: 'Format tanggal salah. Gunakan: MM-YYYY\nContoh: /banding 08-2026' };
    }
    // Bulan sebelumnya: kalau bulan B adalah Januari (1), bulan
    // sebelumnya adalah Desember (12) tahun sebelumnya -- jadi TIDAK
    // bisa asal month - 1, perlu tangani pergantian tahun.
    let prevMonth = periodB.month - 1;
    let prevYear = periodB.year;
    if (prevMonth < 1) {
      prevMonth = 12;
      prevYear -= 1;
    }
    const periodA = { year: prevYear, month: prevMonth, label: `${String(prevMonth).padStart(2, '0')}-${prevYear}` };
    return { periodA, periodB };
  }

  if (tokens.length === 2) {
    const periodA = parsePeriodArg(tokens[0]);
    const periodB = parsePeriodArg(tokens[1]);
    if (!periodA || !periodB) {
      return { error: 'Format tanggal salah. Gunakan: MM-YYYY MM-YYYY\nContoh: /banding 07-2026 08-2026' };
    }
    return { periodA, periodB };
  }

  return { error: 'Format: /banding MM-YYYY\nAtau: /banding MM-YYYY MM-YYYY\n\nContoh: /banding 08-2026\nContoh: /banding 07-2026 08-2026' };
}

/**
 * Hitung persentase perubahan dari nilai lama ke nilai baru. Kasus
 * khusus: kalau nilai lama 0 dan nilai baru > 0, itu artinya "muncul
 * dari nol" -- secara matematis pembagian dengan 0 tidak terdefinisi,
 * jadi kita representasikan sebagai string khusus "Baru" alih-alih
 * angka persen yang menyesatkan (mis. "+Infinity%" atau NaN).
 * Kalau keduanya 0, tidak ada perubahan sama sekali -> "0%".
 */
function hitungPersenPerubahan(lama, baru) {
  const lamaNum = Number(lama);
  const baruNum = Number(baru);
  if (lamaNum === 0 && baruNum === 0) return '0%';
  if (lamaNum === 0) return 'Baru';
  const persen = ((baruNum - lamaNum) / Math.abs(lamaNum)) * 100;
  const sign = persen > 0 ? '+' : '';
  return `${sign}${persen.toFixed(1)}%`;
}

/**
 * /banding MM-YYYY -- bandingkan volume Masuk & Keluar bulan itu dengan
 * bulan SEBELUMNYA secara otomatis.
 * /banding MM-YYYY MM-YYYY -- bandingkan dua bulan spesifik.
 *
 * OUTPUT:
 *   1. Pesan teks: grand total Masuk & Keluar KEDUA bulan, plus
 *      perubahan dalam persen -- supaya langsung kelihatan tren naik
 *      atau turun tanpa perlu buka Excel dulu.
 *   2. File Excel: breakdown PER PRODUK, kolom Masuk & Keluar bulan A,
 *      Masuk & Keluar bulan B, selisih Keluar, dan %perubahan Keluar --
 *      diurutkan dari %perubahan Keluar yang PALING TURUN dulu (supaya
 *      produk yang penjualannya paling anjlok kelihatan di atas, lebih
 *      actionable untuk ditindaklanjuti dibanding yang naik).
 *
 * Sumber data PER PRODUK diambil dari StockDailyEntry (dijumlahkan per
 * bulan), BUKAN dari StockSummary -- karena StockSummary cuma simpan
 * angka totalInKoli/totalOutKoli yang sudah dihitung sebelumnya, dan
 * untuk konsistensi dengan command lain (/rekap, /laporan) yang semua
 * menghitung ulang dari StockDailyEntry secara langsung.
 */
async function handleBanding(chatId, arg) {
  const parsed = parseBandingArg(arg);
  if (parsed.error) {
    await sendMessage(chatId, parsed.error);
    return;
  }
  const { periodA, periodB } = parsed;

  const startA = new Date(Date.UTC(periodA.year, periodA.month - 1, 1));
  const endA = new Date(Date.UTC(periodA.year, periodA.month, 0, 23, 59, 59, 999));
  const startB = new Date(Date.UTC(periodB.year, periodB.month - 1, 1));
  const endB = new Date(Date.UTC(periodB.year, periodB.month, 0, 23, 59, 59, 999));

  const [entriesA, entriesB] = await Promise.all([
    prisma.stockDailyEntry.findMany({
      where: { date: { gte: startA, lte: endA } },
      include: { product: { select: { code: true, kategori: true } } },
    }),
    prisma.stockDailyEntry.findMany({
      where: { date: { gte: startB, lte: endB } },
      include: { product: { select: { code: true, kategori: true } } },
    }),
  ]);

  if (entriesA.length === 0 && entriesB.length === 0) {
    await sendMessage(chatId, `Tidak ada data In/Out untuk periode ${periodA.label} maupun ${periodB.label}.`);
    return;
  }

  // Agregasi per produk untuk masing-masing bulan
  function aggregasiPerProduk(entries) {
    const map = new Map();
    for (const e of entries) {
      if (!map.has(e.productId)) {
        map.set(e.productId, {
          code: e.product.code,
          kategori: e.product.kategori || '-',
          totalIn: new Prisma.Decimal(0),
          totalOut: new Prisma.Decimal(0),
        });
      }
      const stat = map.get(e.productId);
      stat.totalIn = stat.totalIn.plus(e.inKoli);
      stat.totalOut = stat.totalOut.plus(e.outKoli);
    }
    return map;
  }

  const statsA = aggregasiPerProduk(entriesA);
  const statsB = aggregasiPerProduk(entriesB);

  // Grand total kedua bulan, untuk ringkasan teks
  let grandInA = new Prisma.Decimal(0), grandOutA = new Prisma.Decimal(0);
  for (const s of statsA.values()) { grandInA = grandInA.plus(s.totalIn); grandOutA = grandOutA.plus(s.totalOut); }
  let grandInB = new Prisma.Decimal(0), grandOutB = new Prisma.Decimal(0);
  for (const s of statsB.values()) { grandInB = grandInB.plus(s.totalIn); grandOutB = grandOutB.plus(s.totalOut); }

  const summaryText = [
    `📊 Perbandingan Bulan — ${periodA.label} vs ${periodB.label}`,
    '',
    `Total Masuk:`,
    `  ${periodA.label}: ${fmt(grandInA)} koli`,
    `  ${periodB.label}: ${fmt(grandInB)} koli (${hitungPersenPerubahan(grandInA, grandInB)})`,
    '',
    `Total Keluar:`,
    `  ${periodA.label}: ${fmt(grandOutA)} koli`,
    `  ${periodB.label}: ${fmt(grandOutB)} koli (${hitungPersenPerubahan(grandOutA, grandOutB)})`,
    '',
    'Breakdown lengkap per produk (urut dari Keluar paling turun) terlampir di file Excel,',
    'dan grafik ringkasan per kategori menyusul setelah ini.',
  ].join('\n');
  await sendMessage(chatId, summaryText);

  // Gabungkan daftar produk dari KEDUA bulan (union), supaya produk yang
  // cuma ada di salah satu bulan saja (mis. baru mulai dijual bulan B,
  // atau berhenti dijual setelah bulan A) tetap muncul di breakdown,
  // dengan nilai 0 untuk bulan yang tidak punya datanya. Kategori
  // kosong/null dikelompokkan sebagai "Lainnya", sama seperti /slowmoving.
  const allProductIds = new Set([...statsA.keys(), ...statsB.keys()]);
  const rows = Array.from(allProductIds).map((productId) => {
    const a = statsA.get(productId);
    const b = statsB.get(productId);
    const code = (a || b).code;
    const kategoriAsli = (a || b).kategori;
    const kategori = (kategoriAsli && kategoriAsli.trim() && kategoriAsli !== '-') ? kategoriAsli : 'Lainnya';
    const inA = a ? a.totalIn : new Prisma.Decimal(0);
    const outA = a ? a.totalOut : new Prisma.Decimal(0);
    const inB = b ? b.totalIn : new Prisma.Decimal(0);
    const outB = b ? b.totalOut : new Prisma.Decimal(0);
    return {
      code,
      kategori,
      inA, outA, inB, outB,
      selisihOut: outB.minus(outA),
      persenOut: hitungPersenPerubahan(outA, outB),
    };
  });

  // Kelompokkan per kategori, tiap grup diurutkan Keluar paling TURUN
  // dulu (selisih paling negatif di atas) -- sama seperti pengurutan
  // di /slowmoving, supaya produk paling "anjlok" penjualannya langsung
  // kelihatan di baris atas tiap section.
  const rowsByKategori = new Map();
  for (const r of rows) {
    if (!rowsByKategori.has(r.kategori)) rowsByKategori.set(r.kategori, []);
    rowsByKategori.get(r.kategori).push(r);
  }
  for (const groupRows of rowsByKategori.values()) {
    groupRows.sort((x, y) => x.selisihOut.comparedTo(y.selisihOut));
  }
  // Urutkan kategori berdasarkan JUMLAH produk terbanyak dulu, konsisten
  // dengan /slowmoving.
  const kategoriSorted = Array.from(rowsByKategori.keys()).sort(
    (a, b) => rowsByKategori.get(b).length - rowsByKategori.get(a).length
  );

  // File Excel: 1 sheet, dikelompokkan jadi beberapa SECTION per
  // kategori -- sama persis polanya dengan /slowmoving, supaya format
  // konsisten dan gampang dibaca antar laporan.
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`Banding ${periodA.label} vs ${periodB.label}`);

  sheet.columns = [
    { key: 'a', width: 35 },  // Kode Produk
    { key: 'b', width: 14 },  // Masuk A
    { key: 'c', width: 14 },  // Keluar A
    { key: 'd', width: 14 },  // Masuk B
    { key: 'e', width: 14 },  // Keluar B
    { key: 'f', width: 15 },  // Selisih Keluar
    { key: 'g', width: 15 },  // % Perubahan Keluar
  ];

  const THIN_BORDER = { style: 'thin', color: { argb: 'FF999999' } };
  const CELL_BORDER = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };
  const TITLE_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5597' } }; // biru tua
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBDD7EE' } }; // biru muda
  const ROW_FILL_EVEN = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF6FC' } };

  // Judul UTAMA di paling atas sheet, di atas semua section kategori
  const mainTitleRow = sheet.addRow([
    `PERBANDINGAN BULAN — ${namaBulanIndonesia(periodA.year, periodA.month).toUpperCase()} VS ${namaBulanIndonesia(periodB.year, periodB.month).toUpperCase()}`,
  ]);
  sheet.mergeCells(mainTitleRow.number, 1, mainTitleRow.number, 7);
  mainTitleRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { bold: true, size: 14, color: { argb: 'FF1F2937' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  sheet.addRow([]); // baris kosong pemisah

  for (const kategori of kategoriSorted) {
    const groupRows = rowsByKategori.get(kategori);

    // Judul section, mis. "Kipas - Perbandingan Bulan"
    const titleRow = sheet.addRow([`${kategori} - Perbandingan Bulan`]);
    sheet.mergeCells(titleRow.number, 1, titleRow.number, 7);
    titleRow.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
      cell.fill = TITLE_FILL;
      cell.border = CELL_BORDER;
      cell.alignment = { horizontal: 'left', vertical: 'middle' };
    });

    // Header kolom section ini
    const headerRow = sheet.addRow([
      'Kode Produk',
      `Masuk ${periodA.label}`, `Keluar ${periodA.label}`,
      `Masuk ${periodB.label}`, `Keluar ${periodB.label}`,
      'Selisih Keluar', '% Perubahan Keluar',
    ]);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true };
      cell.fill = HEADER_FILL;
      cell.border = CELL_BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    // Baris data produk di section ini
    groupRows.forEach((r, i) => {
      const dataRow = sheet.addRow([
        r.code,
        Number(r.inA), Number(r.outA),
        Number(r.inB), Number(r.outB),
        Number(r.selisihOut), r.persenOut,
      ]);
      dataRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = CELL_BORDER;
        if (i % 2 === 1) cell.fill = ROW_FILL_EVEN;
      });
      for (let col = 2; col <= 7; col++) {
        dataRow.getCell(col).alignment = { horizontal: 'right' };
      }
    });

    // Baris kosong pemisah sebelum section berikutnya
    sheet.addRow([]);
  }

  const buffer2 = await workbook.xlsx.writeBuffer();
  await sendDocument(
    chatId,
    buffer2,
    `Banding ${periodA.label} vs ${periodB.label}.xlsx`,
    `Breakdown per produk per kategori, urut Keluar paling turun — ${periodA.label} vs ${periodB.label}`
  );

  // Kirim juga grafik ringkasan PER KATEGORI (bukan per produk, karena
  // bisa ratusan produk -- terlalu padat untuk 1 grafik yang terbaca)
  // sebagai gambar terpisah via QuickChart, sama seperti /chart. Cuma
  // kategori yang BENAR-BENAR ada transaksi (Masuk atau Keluar > 0 di
  // salah satu bulan) yang dimasukkan -- kategori dengan total nol di
  // kedua bulan di-skip supaya tidak ada bar kosong yang mengotori grafik.
  const kategoriChartData = kategoriSorted
    .map((kategori) => {
      const groupRows = rowsByKategori.get(kategori);
      const totalInA = groupRows.reduce((sum, r) => sum.plus(r.inA), new Prisma.Decimal(0));
      const totalOutA = groupRows.reduce((sum, r) => sum.plus(r.outA), new Prisma.Decimal(0));
      const totalInB = groupRows.reduce((sum, r) => sum.plus(r.inB), new Prisma.Decimal(0));
      const totalOutB = groupRows.reduce((sum, r) => sum.plus(r.outB), new Prisma.Decimal(0));
      return { kategori, totalInA, totalOutA, totalInB, totalOutB };
    })
    .filter((k) => !(k.totalInA.isZero() && k.totalOutA.isZero() && k.totalInB.isZero() && k.totalOutB.isZero()));

  // Urutkan dari Keluar bulan B (data terbaru) TERBESAR dulu -- lalu di
  // chart nanti kita balik lagi urutannya (lihat .reverse() di bawah),
  // karena horizontal bar chart di Chart.js/QuickChart menggambar dari
  // BAWAH ke ATAS secara default, jadi supaya kategori terbesar muncul
  // di posisi PALING ATAS (sesuai ekspektasi visual "urut dari besar"),
  // urutan datanya perlu dibalik dulu sebelum dikirim ke chart.
  kategoriChartData.sort((a, b) => b.totalOutB.comparedTo(a.totalOutB));

  if (kategoriChartData.length > 0) {
    const dataUntukChart = [...kategoriChartData].reverse();
    const labels = dataUntukChart.map((k) => k.kategori);

    // Horizontal bar chart dipilih (bukan vertical) supaya nama
    // kategori yang panjang (mis. "Kompor Import", "Antena Import")
    // bisa dibaca penuh secara horizontal tanpa terpotong/miring, dan
    // supaya kategori dengan volume jauh lebih besar (mis. Kipas) tidak
    // "menenggelamkan" secara visual kategori-kategori kecil lainnya --
    // setiap bar tetap proporsional terhadap lebar chart yang sama.
    const chartConfig = {
      type: 'horizontalBar',
      data: {
        labels,
        datasets: [
          { label: `Keluar ${periodA.label}`, data: dataUntukChart.map((k) => Number(k.totalOutA)), backgroundColor: 'rgba(239, 68, 68, 0.5)' },
          { label: `Keluar ${periodB.label}`, data: dataUntukChart.map((k) => Number(k.totalOutB)), backgroundColor: 'rgba(239, 68, 68, 0.9)' },
        ],
      },
      options: {
        title: { display: true, text: `Perbandingan Keluar per Kategori — ${periodA.label} vs ${periodB.label}` },
        legend: { display: true, position: 'bottom' },
        scales: {
          xAxes: [{ ticks: { beginAtZero: true } }],
        },
      },
    };
    // Tinggi chart menyesuaikan jumlah kategori (tiap kategori butuh
    // ruang vertikal yang cukup untuk 2 bar + label), supaya tetap
    // terbaca walau kategorinya banyak (14+ seperti kasus sekarang)
    // maupun sedikit -- tidak kepepet sempit atau kosong terlalu lega.
    const chartHeight = Math.max(400, dataUntukChart.length * 45 + 120);
    const chartUrl = `https://quickchart.io/chart?width=800&height=${chartHeight}&backgroundColor=white&c=${encodeURIComponent(JSON.stringify(chartConfig))}`;
    await sendPhoto(chatId, chartUrl, `📊 Grafik ringkasan Keluar per kategori (urut terbesar) — ${periodA.label} vs ${periodB.label}`);
  }
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
      case '/slowmoving':
        // Sama seperti /rekap: handleSlowMoving kirim pesan + file sendiri.
        await handleSlowMoving(chatId, arg);
        return res.json({ ok: true });
      case '/stokkosong':
        // Sama seperti /rekap: handleStokKosong kirim pesan + file sendiri.
        await handleStokKosong(chatId, arg);
        return res.json({ ok: true });
      case '/banding':
        // Sama seperti /rekap: handleBanding kirim pesan + file sendiri.
        await handleBanding(chatId, arg);
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