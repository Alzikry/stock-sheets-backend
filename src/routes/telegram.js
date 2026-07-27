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

// ===== Webhook utama =====

router.post('/webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.json({ ok: true }); // abaikan update non-teks (foto, stiker, dll)
    }

    const chatId = message.chat.id;
    const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;

    // Mode setup: env var belum diisi -> kasih tau chat ID pengirim
    if (!allowedChatId) {
      await sendMessage(chatId, `Chat ID kamu: ${chatId}\n\nSalin ke .env / Vercel env var sebagai TELEGRAM_ALLOWED_CHAT_ID, lalu restart server.`);
      return res.json({ ok: true });
    }

    // Chat ID tidak cocok -> abaikan diam-diam (jangan balas apapun,
    // supaya tidak membocorkan bahwa bot ini "hidup" ke orang lain)
    if (String(chatId) !== String(allowedChatId)) {
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