package google

// Ghi một ô của Google Sheet bằng RAW: hàm ghi duy nhất cho Sheet Vipo (HS Desk chỉ nối câu hỏi vào ô Ghi chú). Không
// nhận vùng nhiều ô, không dùng USER_ENTERED (câu bắt đầu bằng "=" phải được lưu nguyên chữ, không thành công thức).

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// cellRe: tên đúng một ô ("AN5"), không vùng, không cả cột hay cả dòng.
var cellRe = regexp.MustCompile(`^[A-Za-z]{1,3}[1-9][0-9]*$`)

// WriteCellRaw ghi value vào đúng một ô a1Cell ("'Tab'!AN5") bằng valueInputOption=RAW. a1Cell phải có tên tab và tên
// một ô; vùng ("A1:A2"), cả cột, thiếu tab bị từ chối ngay trên máy (lỗi google_api 400, không gọi mạng). Lỗi Google qua
// *Error như mọi hàm khác.
func (c *Client) WriteCellRaw(ctx context.Context, sheetID, a1Cell, value string) error {
	if err := checkSingleCell(sheetID, a1Cell); err != nil {
		return err
	}
	u := fmt.Sprintf("%s/spreadsheets/%s/values/%s?valueInputOption=RAW", c.SheetsBase, url.PathEscape(sheetID), url.PathEscape(a1Cell))
	body := map[string]any{"range": a1Cell, "majorDimension": "ROWS", "values": [][]any{{value}}}
	return c.doJSON(ctx, http.MethodPut, u, body, nil)
}

// checkSingleCell: sheetID có, a1Cell = "<tab>!<một ô>" (tách ở dấu "!" cuối, vì tên tab trong nháy có thể chứa "!" hay ":").
func checkSingleCell(sheetID, a1Cell string) error {
	if strings.TrimSpace(sheetID) == "" {
		return &Error{Status: http.StatusBadRequest, Message: "thiếu mã Sheet"}
	}
	i := strings.LastIndex(a1Cell, "!")
	if i <= 0 {
		return &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("ô %q thiếu tên tab", a1Cell)}
	}
	if !cellRe.MatchString(a1Cell[i+1:]) {
		return &Error{Status: http.StatusBadRequest, Message: fmt.Sprintf("%q không phải đúng một ô", a1Cell)}
	}
	return nil
}

// WriteCellsRaw ghi nhiều ô đơn lẻ trong một lần gọi (values:batchUpdate, valueInputOption=RAW). cells: tên ô có tab
// ("'Tab'!AA5") -> giá trị kiểu chữ, số hoặc đúng/sai (số ghi đúng là số, đúng/sai ghi đúng là ô tích). Mỗi tên ô phải là
// đúng một ô (checkSingleCell); một ô sai thì không gọi mạng. Thứ tự gửi theo tên ô để kết quả ổn định.
func (c *Client) WriteCellsRaw(ctx context.Context, sheetID string, cells map[string]any) error {
	if len(cells) == 0 {
		return nil
	}
	keys := make([]string, 0, len(cells))
	for k := range cells {
		if err := checkSingleCell(sheetID, k); err != nil {
			return err
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	data := make([]map[string]any, 0, len(keys))
	for _, k := range keys {
		data = append(data, map[string]any{"range": k, "majorDimension": "ROWS", "values": [][]any{{cells[k]}}})
	}
	u := fmt.Sprintf("%s/spreadsheets/%s/values:batchUpdate", c.SheetsBase, url.PathEscape(sheetID))
	return c.doJSON(ctx, http.MethodPost, u, map[string]any{"valueInputOption": "RAW", "data": data}, nil)
}
