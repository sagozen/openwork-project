package google

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sync/atomic"
	"testing"
)

func TestWriteCellRawPutsOneCellRaw(t *testing.T) {
	var got map[string]any
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Errorf("method %s, muốn PUT", r.Method)
		}
		if r.URL.Path != "/spreadsheets/S1/values/'Yêu cầu''s'!AN7" {
			t.Errorf("path %q", r.URL.Path)
		}
		if q := r.URL.Query(); q.Get("valueInputOption") != "RAW" || len(q) != 1 {
			t.Errorf("query %q, muốn chỉ valueInputOption=RAW", r.URL.RawQuery)
		}
		if r.Header.Get("Authorization") != "Bearer tok" || r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("header %v", r.Header)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"updatedCells": 1})
	})
	val := "cũ\n[HS Desk 19/11 10:05] =SUM(A1)"
	if err := c.WriteCellRaw(context.Background(), "S1", "'Yêu cầu''s'!AN7", val); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"range": "'Yêu cầu''s'!AN7", "majorDimension": "ROWS", "values": []any{[]any{val}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("thân %v, muốn %v", got, want)
	}
}

func TestWriteCellRawRejectsRangesLocally(t *testing.T) {
	var calls atomic.Int32
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	for _, a1 := range []string{"'Yêu cầu'!A1:A2", "AN5", "'Yêu cầu'!AN", "'Yêu cầu'!5", "'Yêu cầu'!AN0", "!AN5", "'Yêu cầu'!AN5:AN", "'Tab'!A1,B2", ""} {
		err := c.WriteCellRaw(context.Background(), "S1", a1, "x")
		var ge *Error
		if !errors.As(err, &ge) || ge.Status != http.StatusBadRequest {
			t.Errorf("%q: lỗi %v, muốn google_api 400", a1, err)
		}
	}
	if err := c.WriteCellRaw(context.Background(), " ", "'Yêu cầu'!AN5", "x"); err == nil {
		t.Error("thiếu mã Sheet mà vẫn ghi")
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("%d yêu cầu, muốn 0", n)
	}
}

func TestWriteCellRawAcceptsTabWithColonOrBang(t *testing.T) {
	var calls atomic.Int32
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1) })
	if err := c.WriteCellRaw(context.Background(), "S1", "'Q1: Yêu cầu!'!AN5", "x"); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("%d yêu cầu, muốn 1", calls.Load())
	}
}

func TestWriteCellRawScopeErrorHasReason(t *testing.T) {
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":403,"message":"Request had insufficient authentication scopes.",` +
			`"errors":[{"reason":"insufficientPermissions"}],"status":"PERMISSION_DENIED",` +
			`"details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}`))
	})
	err := c.WriteCellRaw(context.Background(), "S1", "'Yêu cầu'!AN5", "x")
	var ge *Error
	if !errors.As(err, &ge) || ge.Status != http.StatusForbidden || ge.Reason != "insufficientPermissions" {
		t.Fatalf("lỗi %#v", err)
	}
}
