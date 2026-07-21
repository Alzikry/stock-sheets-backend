// src/testSheets.js
// Script sederhana untuk test koneksi ke Google Sheets API
// Jalankan dengan: node src/testSheets.js

require('dotenv').config();
const { getSheetsClient } = require('./lib/googleSheets');

async function main() {
  try {
    const sheets = getSheetsClient();
    const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

    console.log('Mencoba konek ke spreadsheet:', spreadsheetId);

    // Test 1: Baca beberapa cell dari tab "Stock In/Out Summary"
    const summaryRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Stock In/Out Summary!A1:J10', // ambil 10 baris pertama, kolom A-J
    });

    console.log('\n=== Data dari tab "Stock In/Out Summary" ===');
    console.log(summaryRes.data.values);

    // Test 2: Baca beberapa cell dari tab "Stock Retur"
    const returRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Stock Retur!A1:J10',
    });

    console.log('\n=== Data dari tab "Stock Retur" ===');
    console.log(returRes.data.values);

    console.log('\n✅ Koneksi berhasil! Data di atas adalah data mentah dari spreadsheet.');
  } catch (err) {
    console.error('\n❌ Gagal konek ke Google Sheets:');
    console.error(err.message);
  }
}

main();