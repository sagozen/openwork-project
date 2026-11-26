// Package store opens agent.db, the SQLite file behind ADK sessions and the QA memory tables.
package store

import (
	"database/sql"
	"net/url"
	"os"
	"path/filepath"

	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"chatqa/internal/agentx/store/gormlite"
)

// Open opens (creating if needed) the SQLite file at path with the same pragmas as the other local stores:
// WAL, a 5s busy timeout, foreign keys on, and a single connection so writes never contend.
func Open(path string) (*gorm.DB, gorm.Dialector, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, nil, err
	}
	q := url.Values{}
	for _, p := range []string{"busy_timeout(5000)", "journal_mode(WAL)", "synchronous(NORMAL)", "foreign_keys(1)"} {
		q.Add("_pragma", p)
	}
	conn, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+q.Encode())
	if err != nil {
		return nil, nil, err
	}
	conn.SetMaxOpenConns(1)
	dialector := &gormlite.Dialector{Conn: conn}
	db, err := gorm.Open(dialector, &gorm.Config{Logger: gormlogger.Default.LogMode(gormlogger.Silent)})
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	return db, dialector, nil
}
