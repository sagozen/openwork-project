package store

import (
	"path/filepath"
	"testing"

	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/session/database"
	"google.golang.org/adk/v2/session/sessiontestsuite"
)

func newSessionService(t *testing.T) session.Service {
	t.Helper()
	db, dialector, err := Open(filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { sqlDB.Close() })
	svc, err := database.NewSessionService(dialector)
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AutoMigrate(svc); err != nil {
		t.Fatal(err)
	}
	return svc
}

// The ADK session suite is the contract for the SQLite-backed session service, so a dialect problem in the
// vendored dialector shows up here rather than in a user's chat history.
func TestSessionServiceSuite(t *testing.T) {
	opts := sessiontestsuite.SuiteOptions{SupportsUserProvidedSessionID: true, ChecksRequestedAuthConfigs: true}
	sessiontestsuite.RunServiceTests(t, opts, newSessionService)
}

func TestOpenSetsPragmas(t *testing.T) {
	db, _, err := Open(filepath.Join(t.TempDir(), "sub", "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if sqlDB, err := db.DB(); err == nil {
			sqlDB.Close() // Windows cannot delete the temp dir while the file is open
		}
	})
	var mode string
	db.Raw("PRAGMA journal_mode").Scan(&mode)
	var fk int
	db.Raw("PRAGMA foreign_keys").Scan(&fk)
	if mode != "wal" || fk != 1 {
		t.Fatalf("journal_mode=%q foreign_keys=%d", mode, fk)
	}
}
