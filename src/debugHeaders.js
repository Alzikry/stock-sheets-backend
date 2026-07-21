// src/debugHeaders.js
// Debug: cetak SEMUA header row 1 & row 2 secara mentah, per index kolom.
// Tujuan: cari tahu kenapa hasil parsing In/Out jadi 2x lipat dari yang seharusnya.
//
// Jalankan dengan: node src/debugHeaders.js

require('dotenv').config();
const { getSheetsClient } = require('./lib/googleSheets');

// Ubah index kolom angka (0,1,2,...) jadi huruf kolom spreadsheet (A,B,C,...AA,AB,...)
function colIndexToLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

async function main() {
  const sheets = getSheetsClient();
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Stock In/Out Summary'!A1:BR2",
  });

  const rows = res.data.values || [];
  const headerRow1 = rows[0];
  const headerRow2 = rows[1];

  console.log(`Panjang headerRow1: ${headerRow1.length} kolom`);
  console.log(`Panjang headerRow2: ${headerRow2.length} kolom\n`);

  console.log('=== Cetak semua kolom (index | huruf | row1 | row2) ===\n');

  const maxLen = Math.max(headerRow1.length, headerRow2.length);
  for (let i = 0; i < maxLen; i++) {
    const letter = colIndexToLetter(i);
    const r1 = headerRow1[i] !== undefined ? headerRow1[i] : '(kosong)';
    const r2 = headerRow2[i] !== undefined ? headerRow2[i] : '(kosong)';
    console.log(`[${i}] ${letter} | row1: "${r1}" | row2: "${r2}"`);
  }

  console.log('\n=== Ambil juga baris data Stand Fan 1681 (row index 2 / row ke-3) untuk kolom 0-30 ===\n');
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "'Stock In/Out Summary'!A3:BR3",
  });
  const dataRow = dataRes.data.values[0] || [];
  dataRow.forEach((val, i) => {
    const letter = colIndexToLetter(i);
    console.log(`[${i}] ${letter} | value: "${val}"`);
  });

  // ===== TAMBAHAN DEBUG: replay logic dateColumns dari sheetsParser.js =====
  console.log('\n=== Replay logic dateColumns (meniru sheetsParser.js) ===\n');
  const FIXED_COLS = 5;
  const dateColumns = [];
  let lastDate = null;
  for (let col = FIXED_COLS; col < headerRow1.length; col++) {
    const dateCell = headerRow1[col];
    const typeCell = (headerRow2[col] || '').trim();

    if (dateCell && dateCell.trim() !== '') {
      lastDate = dateCell.trim();
    }
    if (!lastDate) continue;
    if (typeCell !== 'In' && typeCell !== 'Out') continue;

    dateColumns.push({ col, date: lastDate, type: typeCell });
  }
  console.log(`Total dateColumns terbentuk: ${dateColumns.length}`);
  console.log('20 pertama:', JSON.stringify(dateColumns.slice(0, 20), null, 0));
  console.log('\nTotal kolom data Stand Fan 1681 yang punya isi (bukan kosong):');
  const filledCols = dataRow.map((v, i) => ({ i, v })).filter((x) => x.v !== undefined && x.v !== '');
  console.log(JSON.stringify(filledCols, null, 0));

  // ===== TAMBAHAN: hitung total In & Out murni dari dateColumns + dataRow =====
  console.log('\n=== Hitung ulang Total In & Out untuk Stand Fan 1681 (cross-check) ===\n');
  let sumIn = 0;
  let sumOut = 0;
  const detailIn = [];
  const detailOut = [];
  for (const dc of dateColumns) {
    const val = dataRow[dc.col];
    if (val === undefined || val === '') continue;
    const num = parseFloat(String(val).replace(/\./g, '').replace(',', '.'));
    if (dc.type === 'In') {
      sumIn += num;
      detailIn.push({ col: dc.col, date: dc.date, val: num });
    }
    if (dc.type === 'Out') {
      sumOut += num;
      detailOut.push({ col: dc.col, date: dc.date, val: num });
    }
  }
  console.log(`Total In (hitung ulang)  : ${sumIn}`);
  console.log(`Detail kolom In yang kepakai:`, JSON.stringify(detailIn));
  console.log(`\nTotal Out (hitung ulang) : ${sumOut}`);
  console.log(`Detail kolom Out yang kepakai:`, JSON.stringify(detailOut));
  console.log(`\n(Bandingkan dengan angka asli sheet: In = 1950, Out = 3103)`);

  console.log('\n✅ Debug selesai.');
}

main().catch((err) => {
  console.error('❌ Error:', err.message);
  console.error(err.stack);
});