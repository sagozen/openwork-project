package store

import (
	"database/sql"
	"fmt"
)

// Migrate creates or upgrades the QA memory tables of agent.db. The schema version lives in PRAGMA user_version
// (ADK's session tables are managed by GORM and do not use it). Each upgrade runs in one transaction, so a failure
// leaves the previous version intact.
func Migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i, schema := range []string{schemaV1} {
		if v >= i+1 {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(schema); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("agent.db schema v%d: %w", i+1, err)
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// v1: QA memory.
//   - flaky_stats is recomputed from testengine.db (flow_runs joined with runs); it is never written by hand.
//   - feature_flow_map links a product feature to the flows that test it.
//   - known_issues are confirmed failure causes with their fix.
//   - memories are facts, fixes, preferences and session summaries.
//
// memories_fts is ONE full-text index over memories (text), known_issues (symptom, cause, fix) and feature_flow_map
// (feature, app, flow, note), kept in step by triggers. One index keeps BM25 scores comparable across the three:
// separate indexes rank a one-row table as a perfect match for any word. source and ref name the indexed row; title
// holds the feature (feature map) or symptom (known issue) for searches on that field alone. remove_diacritics lets
// "loi" find "lỗi".
const schemaV1 = `
CREATE TABLE flaky_stats (
  app TEXT NOT NULL, flow TEXT NOT NULL, platform TEXT NOT NULL,
  runs INTEGER NOT NULL, fails INTEGER NOT NULL, flaky_passes INTEGER NOT NULL,
  last_fail_at INTEGER NOT NULL, top_causes_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (app, flow, platform));

CREATE TABLE feature_flow_map (
  feature TEXT NOT NULL, app TEXT NOT NULL, flow TEXT NOT NULL, note TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('manual', 'planner')), updated_at INTEGER NOT NULL,
  PRIMARY KEY (feature, app, flow));

CREATE TABLE known_issues (
  id INTEGER PRIMARY KEY, symptom TEXT NOT NULL, cause TEXT NOT NULL, fix TEXT NOT NULL, category TEXT NOT NULL,
  app TEXT NOT NULL, flow TEXT NOT NULL, platform TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0);

CREATE TABLE memories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, app_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'fix', 'preference', 'session_summary')),
  text TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX memories_scope ON memories(app_name, user_id, kind);

CREATE VIRTUAL TABLE memories_fts USING fts5(text, title, source UNINDEXED, ref UNINDEXED,
  tokenize='unicode61 remove_diacritics 2');

CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(text, title, source, ref) VALUES (new.text, '', 'memory', new.id);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE source = 'memory' AND ref = old.id;
END;
CREATE TRIGGER memories_au AFTER UPDATE OF text ON memories BEGIN
  DELETE FROM memories_fts WHERE source = 'memory' AND ref = old.id;
  INSERT INTO memories_fts(text, title, source, ref) VALUES (new.text, '', 'memory', new.id);
END;

CREATE TRIGGER known_issues_ai AFTER INSERT ON known_issues BEGIN
  INSERT INTO memories_fts(text, title, source, ref)
  VALUES (new.symptom || ' ' || new.cause || ' ' || new.fix, new.symptom, 'known_issue', CAST(new.id AS TEXT));
END;
CREATE TRIGGER known_issues_ad AFTER DELETE ON known_issues BEGIN
  DELETE FROM memories_fts WHERE source = 'known_issue' AND ref = CAST(old.id AS TEXT);
END;
CREATE TRIGGER known_issues_au AFTER UPDATE OF symptom, cause, fix ON known_issues BEGIN
  DELETE FROM memories_fts WHERE source = 'known_issue' AND ref = CAST(old.id AS TEXT);
  INSERT INTO memories_fts(text, title, source, ref)
  VALUES (new.symptom || ' ' || new.cause || ' ' || new.fix, new.symptom, 'known_issue', CAST(new.id AS TEXT));
END;

CREATE TRIGGER feature_flow_map_ai AFTER INSERT ON feature_flow_map BEGIN
  INSERT INTO memories_fts(text, title, source, ref)
  VALUES (new.feature || ' ' || new.app || ' ' || new.flow || ' ' || new.note, new.feature, 'feature_map',
    new.feature || '|' || new.app || '|' || new.flow);
END;
CREATE TRIGGER feature_flow_map_ad AFTER DELETE ON feature_flow_map BEGIN
  DELETE FROM memories_fts WHERE source = 'feature_map' AND ref = old.feature || '|' || old.app || '|' || old.flow;
END;
CREATE TRIGGER feature_flow_map_au AFTER UPDATE ON feature_flow_map BEGIN
  DELETE FROM memories_fts WHERE source = 'feature_map' AND ref = old.feature || '|' || old.app || '|' || old.flow;
  INSERT INTO memories_fts(text, title, source, ref)
  VALUES (new.feature || ' ' || new.app || ' ' || new.flow || ' ' || new.note, new.feature, 'feature_map',
    new.feature || '|' || new.app || '|' || new.flow);
END;
PRAGMA user_version = 1;`
