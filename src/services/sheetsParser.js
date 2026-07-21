// src/services/sheetsParser.js
//
// Tanggung jawab file ini: MEMBACA data mentah dari Google Sheets dan
// mengubahnya jadi struktur JavaScript yang gampang diolah.
// Tidak ada logic hitung Stock Akhir di sini — murni parsing/transform.

const { getSheetsClient } = require('../lib/googleSheets');

/**
 * Ubah format tanggal "13/07/2026" (DD/MM/YYYY) jadi objek Date.
 * Sheet pakai format Indonesia (tanggal/bulan/tahun).
 */
function parseSheetDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split('/');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map((p) => parseInt(p, 10));
  if (!day || !month || !year) return null;
  // Date bulan di JS itu 0-indexed, makanya month - 1
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Ubah angka dari sheet (kadang pakai koma, kadang kosong) jadi number.
 * Contoh isi sheet: "2.935" (titik sebagai pemisah ribuan), "" (kosong), atau angka biasa.
 */
function parseSheetNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  // Hapus titik pemisah ribuan, ganti koma desimal (jika ada) jadi titik
  const cleaned = String(value).replace(/\./g, '').replace(',', '.').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

/**
 * Baca seluruh data tab "Stock In/Out Summary" dan parsing jadi struktur:
 * {
 *   products: [
 *     { rowOrder, code, pcsPerKoli, kategori, stockHandKoli,
 *       dailyEntries: [ { date, inKoli, outKoli }, ... ] }
 *   ]
 * }
 */
async function readSummarySheet(spreadsheetId) {
  const sheets = getSheetsClient();

  // Ambil semua kolom sekaligus (A sampai kolom yang cukup jauh, ZZ untuk jaga-jaga)
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Stock In/Out Summary'!A1:ZZ1000",
  });

  const rows = res.data.values || [];
  if (rows.length < 2) {
    throw new Error('Tab "Stock In/Out Summary" tidak punya cukup baris (minimal 2 baris header).');
  }

  const headerRow1 = rows[0]; // baris tanggal, contoh: ["NO","ITEM","pcs","Kategori","stock hand","01/07/2026","","02/07/2026",...]
  const headerRow2 = rows[1]; // baris label, contoh: ["","","","","","In","Out","In","Out",...]

  // Kolom tetap: A=No(0), B=Item(1), C=pcs(2), D=Kategori(3), E=stock hand(4)
  // Kolom F dst (index 5+) adalah pasangan tanggal In/Out
  const FIXED_COLS = 5;

  // Bangun peta kolom tanggal: untuk tiap index kolom >= FIXED_COLS,
  // simpan { date, type: 'In' | 'Out' }
  //
  // PENTING: setiap tanggal SELALU berupa PASANGAN 2 kolom (In lalu Out).
  // Tanggal cuma ditulis di kolom pertama pasangan (kolom "In"), kolom
  // "Out" di sebelahnya kosong di row1 karena merged cell secara visual.
  //
  // Kita TIDAK pakai logic "carry-over tanggal terakhir" tanpa batas,
  // karena itu menyebabkan kolom ringkasan/total di ujung kanan (yang
  // row1-nya kosong tapi row2-nya masih "In"/"Out") ikut salah dianggap
  // sebagai bagian dari tanggal terakhir. Sebagai gantinya, begitu kita
  // ketemu kolom row1 kosong DUA KALI berturut-turut sambil row2 masih
  // "In"/"Out", kita anggap sudah keluar dari area tanggal dan berhenti.
  const dateColumns = [];
  let lastDate = null;
  let emptyHeaderStreak = 0;

  for (let col = FIXED_COLS; col < headerRow1.length; col++) {
    const dateCell = (headerRow1[col] || '').trim();
    const typeCell = (headerRow2[col] || '').trim();

    if (typeCell !== 'In' && typeCell !== 'Out') {
      // Bukan kolom In/Out sama sekali -> pasti sudah keluar area tanggal
      break;
    }

    if (dateCell !== '') {
      // Kolom ini punya tanggal eksplisit (selalu kolom "In" pembuka pasangan)
      lastDate = parseSheetDate(dateCell);
      emptyHeaderStreak = 0;
    } else if (typeCell === 'Out' && lastDate) {
      // Kolom "Out" pasangan dari tanggal yang baru saja ditemukan -> valid
      emptyHeaderStreak = 0;
    } else {
      // row1 kosong padahal bukan kolom "Out" pasangan langsung -> mencurigakan
      emptyHeaderStreak++;
      if (emptyHeaderStreak >= 1) {
        // Ini kolom ringkasan/total di ujung kanan, bukan data harian -> stop
        break;
      }
    }

    if (!lastDate) continue;
    dateColumns.push({ col, date: lastDate, type: typeCell });
  }

  // Parsing tiap baris produk (mulai baris index 2, karena 0 dan 1 adalah header)
  const products = [];
  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[1] || row[1].trim() === '') continue; // baris kosong, skip

    const code = row[1].trim();
    const pcsPerKoli = parseInt(row[2], 10) || 1;
    const kategori = row[3] ? row[3].trim() : null;
    const stockHandKoli = parseSheetNumber(row[4]);

    // Kumpulkan In/Out per tanggal untuk baris ini
    const dailyMap = new Map(); // key: "YYYY-MM-DD", value: { date, inKoli, outKoli }

    for (const dc of dateColumns) {
      const cellValue = row[dc.col];
      // PENTING: JANGAN skip cell kosong. Kalau di-skip, dan cell ini
      // SEBELUMNYA pernah berisi angka lalu dikosongkan user, nilai lama
      // di database tidak akan pernah ter-reset (bug yang pernah kejadian:
      // Stand Fan 1683 tanggal 06/07 dikosongkan tapi DB masih simpan
      // angka lama). Solusinya: tetap proses, parseSheetNumber('') -> 0.

      const dateKey = dc.date.toISOString().slice(0, 10);
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { date: dc.date, inKoli: 0, outKoli: 0 });
      }
      const entry = dailyMap.get(dateKey);
      if (dc.type === 'In') entry.inKoli = parseSheetNumber(cellValue);
      if (dc.type === 'Out') entry.outKoli = parseSheetNumber(cellValue);
    }

    products.push({
      rowOrder: r,
      code,
      pcsPerKoli,
      kategori,
      stockHandKoli,
      dailyEntries: Array.from(dailyMap.values()),
    });
  }

  return { products };
}

/**
 * Baca seluruh data tab "Stock Retur" dan parsing jadi struktur:
 * {
 *   returByCode: {
 *     "Stand Fan 1681": [ { date, returKoli }, ... ],
 *     ...
 *   }
 * }
 *
 * Header tab Retur cuma angka tanggal polos (1, 2, 3, ..., 31) tanpa bulan/tahun.
 * Makanya fungsi ini WAJIB diberi tahu periode aktif (year, month) supaya
 * angka tanggal itu bisa diubah jadi Date yang lengkap.
 *
 * @param {string} spreadsheetId
 * @param {number} year  - contoh: 2026
 * @param {number} month - 1-12, contoh: 7 untuk Juli
 */
async function readReturSheet(spreadsheetId, year, month) {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Stock Retur'!A1:ZZ1000",
  });

  const rows = res.data.values || [];
  if (rows.length < 2) {
    throw new Error('Tab "Stock Retur" tidak punya cukup baris (minimal 2 baris header).');
  }

  const headerRow1 = rows[0]; // baris angka tanggal, contoh: ["","Code Material","PCS","1","2","3",...]
  const headerRow2 = rows[1]; // baris label "In", contoh: ["","","","In","In","In",...]

  // Kolom tetap: A=No(0), B=Code Material(1), C=PCS(2)
  const FIXED_COLS = 3;

  // Bangun peta kolom tanggal: index kolom -> Date lengkap
  const dateColumns = [];
  for (let col = FIXED_COLS; col < headerRow1.length; col++) {
    const dayCell = (headerRow1[col] || '').trim();
    const typeCell = (headerRow2[col] || '').trim();

    if (!dayCell || typeCell !== 'In') continue; // hanya proses kolom "In" yang valid

    const day = parseInt(dayCell, 10);
    if (!day || day < 1 || day > 31) continue; // bukan angka tanggal yang valid

    const date = new Date(Date.UTC(year, month - 1, day));
    dateColumns.push({ col, date });
  }

  // Parsing tiap baris produk, dikumpulkan by code (nama item)
  const returByCode = {};

  for (let r = 2; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row[1] || row[1].trim() === '') continue; // baris kosong, skip

    const code = row[1].trim();
    const dailyEntries = [];

    for (const dc of dateColumns) {
      const cellValue = row[dc.col];
      // Sama seperti di readSummarySheet: JANGAN skip cell kosong atau
      // bernilai 0, supaya nilai lama di database tetap ter-overwrite
      // dengan benar kalau user mengosongkan/menol-kan cell yang tadinya
      // ada isinya.
      const returKoli = parseSheetNumber(cellValue);
      dailyEntries.push({ date: dc.date, returKoli });
    }

    returByCode[code] = dailyEntries;
  }

  return { returByCode };
}

module.exports = {
  parseSheetDate,
  parseSheetNumber,
  readSummarySheet,
  readReturSheet,
};