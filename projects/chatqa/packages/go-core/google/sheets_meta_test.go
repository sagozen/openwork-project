package google

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func sheetsClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c := New(func(context.Context) (string, error) { return "tok", nil })
	c.SheetsBase = srv.URL
	return c
}

func TestSheetsSpreadsheetInfoParsesTabsAndFilter(t *testing.T) {
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/spreadsheets/S1" || !strings.Contains(r.URL.Query().Get("fields"), "basicFilter") {
			t.Errorf("yêu cầu lạ %s ?%s", r.URL.Path, r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"properties": map[string]any{"title": "Theo dõi báo giá"},
			"sheets": []any{
				map[string]any{"properties": map[string]any{"sheetId": 0, "title": "Yêu cầu", "gridProperties": map[string]any{"rowCount": 25000}},
					"basicFilter": map[string]any{"range": map[string]any{}}},
				map[string]any{"properties": map[string]any{"sheetId": 7, "title": "Cũ", "gridProperties": map[string]any{"rowCount": 10}}},
			},
		})
	})
	info, err := c.SpreadsheetInfo(context.Background(), "S1")
	if err != nil {
		t.Fatal(err)
	}
	want := SheetInfo{Title: "Theo dõi báo giá", Tabs: []SheetTab{{ID: 0, Title: "Yêu cầu", RowCount: 25000, Filtered: true}, {ID: 7, Title: "Cũ", RowCount: 10}}}
	if !reflect.DeepEqual(info, want) {
		t.Fatalf("có %+v, muốn %+v", info, want)
	}
	if tab, ok := info.Tab("Cũ"); !ok || tab.ID != 7 {
		t.Fatalf("Tab(Cũ) = %+v %v", tab, ok)
	}
	if _, ok := info.Tab("Không có"); ok {
		t.Fatal("tab không có mà vẫn thấy")
	}
}

func TestSheetsHiddenRowsOneRangePerRun(t *testing.T) {
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) {
		got := r.URL.Query()["ranges"]
		want := []string{"'Yêu cầu''s'!A5:A7", "'Yêu cầu''s'!A10:A10"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ranges %v, muốn %v", got, want)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"sheets": []any{map[string]any{"data": []any{
			map[string]any{"startRow": 4, "rowMetadata": []any{map[string]any{}, map[string]any{"hiddenByFilter": true}, map[string]any{}}},
			map[string]any{"startRow": 9, "rowMetadata": []any{map[string]any{"hiddenByUser": true}}},
		}}}})
	})
	got, err := c.HiddenRows(context.Background(), "S1", "Yêu cầu's", []int{7, 5, 6, 10, 6, 0})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, map[int]bool{6: true, 10: true}) {
		t.Fatalf("dòng ẩn %v", got)
	}
	none, err := c.HiddenRows(context.Background(), "S1", "x", nil)
	if err != nil || len(none) != 0 {
		t.Fatalf("không có dòng: %v %v", none, err)
	}
}

func TestSheetsBatchGetColumnsRenderAndErrors(t *testing.T) {
	c := sheetsClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("valueRenderOption") == RenderFormatted {
			_ = json.NewEncoder(w).Encode(map[string]any{"valueRanges": []any{map[string]any{"values": []any{[]any{"01012100"}}}, map[string]any{}}})
			return
		}
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"The caller does not have permission","errors":[{"reason":"forbidden"}],"status":"PERMISSION_DENIED"}}`))
	})
	got, err := c.BatchGetColumnsRender(context.Background(), "S1", []string{"'T'!AB2:AB2", "'T'!AD2:AD2"}, RenderFormatted)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0][0] != "01012100" || got[1] != nil {
		t.Fatalf("giá trị %v", got)
	}
	_, err = c.BatchGetColumnsRender(context.Background(), "S1", []string{"'T'!A1:A1"}, "")
	var ge *Error
	if !errors.As(err, &ge) || ge.Status != http.StatusForbidden || ge.Reason != "forbidden" {
		t.Fatalf("lỗi %v", err)
	}
}
