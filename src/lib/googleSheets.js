// src/lib/googleSheets.js
// Helper untuk koneksi ke Google Sheets API menggunakan Service Account

const { google } = require('googleapis');
const path = require('path');

function getSheetsClient() {
  const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(keyFilePath),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({ version: 'v4', auth });
}

module.exports = { getSheetsClient };
