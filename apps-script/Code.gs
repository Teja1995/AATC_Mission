/**
 * AATC_UrineVolume — Google Apps Script web app.
 *
 * Bound to the AATC_UrineVolume spreadsheet (Extensions -> Apps Script).
 * Deploy -> New deployment -> Web app:
 *   Execute as: Me
 *   Who has access: Anyone
 * Paste the resulting /exec URL into APPS_SCRIPT_URL in firebase-config.js.
 *
 * Redeploy (not just save) after editing, or the /exec URL keeps serving the
 * old code.
 */

var COLUMNS = [
  'Crew Code',
  'Mission Day',
  'Mission Time',
  'UTC Date & Time',
  'Volume (mL)',
  'Colour (1-8)',
];

var CREW_CODES = ['FE01', 'FE02', 'FE03', 'FE04', 'FE05', 'FE06', 'FE07'];

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(data.crewCode);
  if (!sheet) return ContentService.createTextOutput('Unknown crew code');

  // The client retries until it is told the row landed, so a void survives a
  // dropped connection. A retry after a lost response can therefore repeat a
  // row: same crew code and same UTC timestamp means the same void, once.
  var last = sheet.getLastRow();
  if (last > 1) {
    var existing = sheet.getRange(last, 1, 1, COLUMNS.length).getValues()[0];
    if (String(existing[0]) === String(data.crewCode)
        && String(existing[3]) === String(data.utcDateTime)) {
      return ContentService.createTextOutput('OK (duplicate ignored)');
    }
  }

  sheet.appendRow([
    data.crewCode,
    data.missionDay,
    data.missionTime,
    data.utcDateTime,
    data.volumeMl,
    data.colourScore,
  ]);
  return ContentService.createTextOutput('OK');
}

/**
 * Run once from the Apps Script editor to create the seven crew tabs with
 * headers. Existing tabs are left alone.
 */
function setupSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  CREW_CODES.forEach(function (code) {
    var sheet = ss.getSheetByName(code) || ss.insertSheet(code);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(COLUMNS);
      sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  });
}
