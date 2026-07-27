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
//   /laporan               -> top 5 volume masuk & keluar, 30 hari terakhir
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
  '/laporan - top 5 volume masuk & keluar (30 hari terakhir)',
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

async function handleLaporan() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 30);

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
  const topIn = [...all].sort((a, b) => b.totalIn.comparedTo(a.totalIn)).slice(0, 5);
  const topOut = [...all].sort((a, b) => b.totalOut.comparedTo(a.totalOut)).slice(0, 5);

  return [
    '📥 Top 5 Volume Masuk (30 hari terakhir):',
    ...topIn.map((s, i) => `${i + 1}. ${s.code} - ${fmt(s.totalIn)} koli`),
    '',
    '📤 Top 5 Volume Keluar (30 hari terakhir):',
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

    // Chat ID tidak cocok -> abaikan diam-diam
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
        reply = await handleLaporan();
        break;
      default:
        reply = `Perintah tidak dikenali.\n\n${HELP_TEXT}`;
    }

    await sendMessage(chatId, reply);
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram webhook error:', err);
    res.json({ ok: true });
  }
});

module.exports = router;