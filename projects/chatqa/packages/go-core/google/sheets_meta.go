package google

// Đọc thông tin một Google Sheet (chỉ đọc): tên tệp, danh sách tab, tab nào đang lọc, dòng nào đang ẩn; và đọc nhiều
// vùng một cột với cách hiện giá trị chọn được (giá trị gốc hay giá trị như trên màn hình). Không có hàm ghi nào ở đây.

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// SheetTab: một tab của Google Sheet.
type SheetTab struct {
	ID       int64  `json:"id"`
	Title    string `json:"title"`
	RowCount int    `json:"rowCount"`
	// Filtered: tab đang bật bộ lọc cơ bản (dán vào tab đang lọc dễ lệch dòng).
	Filtered bool `json:"filtered"`
}

// SheetInfo: tên Google Sheet và các tab theo thứ tự.
type SheetInfo struct {
	Title string     `json:"title"`
	Tabs  []SheetTab `json:"tabs"`
}

// Tab: tab có tên title (so đúng chữ); ok=false nếu không có.
func (s SheetInfo) Tab(title string) (SheetTab, bool) {
	for _, t := range s.Tabs {
		if t.Title == title {
			return t, true
		}
	}
	return SheetTab{}, false
}

// Cách hiện giá trị khi đọc (valueRenderOption của Sheets v4).
const (
	RenderUnformatted = "UNFORMATTED_VALUE"
	RenderFormatted   = "FORMATTED_VALUE"
	RenderFormula     = "FORMULA" // công thức của ô (chuỗi bắt đầu bằng "="), ô không có công thức trả như UNFORMATTED
)

// QuoteTab: tên tab trong vùng A1, luôn đặt trong dấu nháy đơn, nháy đơn bên trong nhân đôi ('Tab”s').
func QuoteTab(tab string) string { return "'" + strings.ReplaceAll(tab, "'", "''") + "'" }

// SpreadsheetInfo: tên và các tab của Google Sheet id.
func (c *Client) SpreadsheetInfo(ctx context.Context, id string) (SheetInfo, error) {
	q := url.Values{"fields": {"properties.title,sheets(properties(sheetId,title,gridProperties.rowCount),basicFilter)"}}
	var r struct {
		Properties struct {
			Title string `json:"title"`
		} `json:"properties"`
		Sheets []struct {
			Properties struct {
				SheetID        int64  `json:"sheetId"`
				Title          string `json:"title"`
				GridProperties struct {
					RowCount int `json:"rowCount"`
				} `json:"gridProperties"`
			} `json:"properties"`
			BasicFilter *struct{} `json:"basicFilter"`
		} `json:"sheets"`
	}
	u := fmt.Sprintf("%s/spreadsheets/%s?%s", c.SheetsBase, url.PathEscape(id), q.Encode())
	if err := c.doJSON(ctx, http.MethodGet, u, nil, &r); err != nil {
		return SheetInfo{}, err
	}
	out := SheetInfo{Title: r.Properties.Title, Tabs: make([]SheetTab, 0, len(r.Sheets))}
	for _, s := range r.Sheets {
		out.Tabs = append(out.Tabs, SheetTab{ID: s.Properties.SheetID, Title: s.Properties.Title,
			RowCount: s.Properties.GridProperties.RowCount, Filtered: s.BasicFilter != nil})
	}
	return out, nil
}

// HiddenRows: dòng nào trong rows (số dòng từ 1) của tab đang bị ẩn (ẩn tay hoặc do bộ lọc). Mỗi đoạn dòng liền nhau là
// một vùng trong cùng một lần đọc. Dòng không ẩn không có trong kết quả.
func (c *Client) HiddenRows(ctx context.Context, id, tab string, rows []int) (map[int]bool, error) {
	out := map[int]bool{}
	runs := rowRuns(rows)
	if len(runs) == 0 {
		return out, nil
	}
	q := url.Values{"fields": {"sheets(data(startRow,rowMetadata(hiddenByUser,hiddenByFilter)))"}}
	for _, r := range runs {
		q.Add("ranges", fmt.Sprintf("%s!A%d:A%d", QuoteTab(tab), r[0], r[1]))
	}
	var resp struct {
		Sheets []struct {
			Data []struct {
				StartRow    int `json:"startRow"`
				RowMetadata []struct {
					HiddenByUser   bool `json:"hiddenByUser"`
					HiddenByFilter bool `json:"hiddenByFilter"`
				} `json:"rowMetadata"`
			} `json:"data"`
		} `json:"sheets"`
	}
	u := fmt.Sprintf("%s/spreadsheets/%s?%s", c.SheetsBase, url.PathEscape(id), q.Encode())
	if err := c.doJSON(ctx, http.MethodGet, u, nil, &resp); err != nil {
		return nil, err
	}
	want := map[int]bool{}
	for _, n := range rows {
		want[n] = true
	}
	for _, s := range resp.Sheets {
		for _, d := range s.Data {
			for i, m := range d.RowMetadata {
				row := d.StartRow + i + 1 // startRow tính từ 0
				if (m.HiddenByUser || m.HiddenByFilter) && want[row] {
					out[row] = true
				}
			}
		}
	}
	return out, nil
}

// rowRuns: các đoạn [đầu, cuối] liền nhau của rows (bỏ số <= 0, bỏ trùng).
func rowRuns(rows []int) [][2]int {
	seen := map[int]bool{}
	var s []int
	for _, n := range rows {
		if n > 0 && !seen[n] {
			seen[n] = true
			s = append(s, n)
		}
	}
	sort.Ints(s)
	var out [][2]int
	for _, n := range s {
		if len(out) > 0 && out[len(out)-1][1] == n-1 {
			out[len(out)-1][1] = n
			continue
		}
		out = append(out, [2]int{n, n})
	}
	return out
}

// BatchGetColumnsRender: như BatchGetColumns, với cách hiện giá trị render (RenderUnformatted / RenderFormatted).
func (c *Client) BatchGetColumnsRender(ctx context.Context, sheetID string, ranges []string, render string) ([][]any, error) {
	if render == "" {
		render = RenderUnformatted
	}
	q := url.Values{"valueRenderOption": {render}, "majorDimension": {"COLUMNS"}}
	for _, r := range ranges {
		q.Add("ranges", r)
	}
	var r struct {
		ValueRanges []struct {
			Values [][]any `json:"values"`
		} `json:"valueRanges"`
	}
	u := fmt.Sprintf("%s/spreadsheets/%s/values:batchGet?%s", c.SheetsBase, url.PathEscape(sheetID), q.Encode())
	if err := c.doJSON(ctx, http.MethodGet, u, nil, &r); err != nil {
		return nil, err
	}
	out := make([][]any, len(ranges))
	for i, vr := range r.ValueRanges {
		if i < len(out) && len(vr.Values) > 0 {
			out[i] = vr.Values[0]
		}
	}
	return out, nil
}
