// src/lib/googleSheets.js
// Helper untuk koneksi ke Google Sheets API menggunakan Service Account

const { google } = require('googleapis');
const path = require('path');

function getSheetsClient() {
  let authOptions = {
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  };

  if (process.env.GOOGLE_CREDENTIALS_JSON) {
    // Vercel / production: kredensial disimpan sebagai environment variable
    // berisi seluruh isi JSON service account, bukan file fisik
    authOptions.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  } else {
    // Lokal development: tetap baca dari file fisik seperti biasa
    const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    authOptions.keyFile = path.resolve(keyFilePath);
  }

  const auth = new google.auth.GoogleAuth(authOptions);

  return google.sheets({ version: 'v4', auth });
}

module.exports = { getSheetsClient };