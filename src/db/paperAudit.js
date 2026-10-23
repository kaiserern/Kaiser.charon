import { db } from './connection.js';
let initialized = false;
export function paperAudit(mint, kind, evidence) {
  if (!initialized) {
    db.exec(`CREATE TABLE IF NOT EXISTS paper_execution_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at_ms INTEGER NOT NULL,mint TEXT NOT NULL,kind TEXT NOT NULL,evidence_json TEXT NOT NULL)`);
    initialized = true;
  }
  db.prepare('INSERT INTO paper_execution_events(at_ms,mint,kind,evidence_json) VALUES(?,?,?,?)').run(Date.now(), mint, kind, JSON.stringify(evidence));
}
