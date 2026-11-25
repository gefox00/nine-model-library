const fs = require('node:fs/promises');
const path = require('node:path');

class ThumbnailBatchStore {
  constructor(database, dataDir) {
    this.legacyFile = path.join(dataDir, 'thumbnail-batch.json');
    database.exec(`CREATE TABLE IF NOT EXISTS thumbnail_batch_report (
      id INTEGER PRIMARY KEY CHECK (id = 1), report_json TEXT NOT NULL
    ) STRICT`);
    this.readReport = database.prepare('SELECT report_json FROM thumbnail_batch_report WHERE id = 1');
    this.saveReport = database.prepare(`INSERT INTO thumbnail_batch_report (id, report_json) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET report_json = excluded.report_json`);
  }

  async load() {
    const saved = this.readReport.get()?.report_json ?? await fs.readFile(this.legacyFile, 'utf8');
    return JSON.parse(saved);
  }

  save(report) {
    this.saveReport.run(JSON.stringify(report));
  }
}

module.exports = { ThumbnailBatchStore };
