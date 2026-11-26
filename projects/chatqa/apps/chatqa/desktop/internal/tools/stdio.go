package tools

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// RunStdio: lối vào stdio cho client MCP chạy tiến trình (ChatQASoftware --mcp). Phiên đăng nhập và thiết bị nằm trong
// app đang mở (chỉ một bản chạy được), nên lối này chuyển từng thông điệp JSON-RPC (mỗi dòng một thông điệp) sang
// máy chủ HTTP cục bộ của app kèm token, rồi in câu trả lời ra stdout.
func RunStdio(in io.Reader, out io.Writer, url, token string) error {
	client := &http.Client{Timeout: 15 * time.Minute} // dispatch chờ xong, biên dịch có thể lâu
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 1<<20), maxBody)
	w := bufio.NewWriter(out)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var head struct {
			Method string `json:"method"`
			Params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		if json.Unmarshal(line, &head) == nil && head.Method == "tools/call" { // stderr của tiến trình này nằm trong log MCP của client
			logCallArgs("stdio "+head.Params.Name, head.Params.Arguments)
		}
		resp, err := forward(client, url, token, line)
		if err != nil {
			resp = stdioError(line, err)
		}
		if len(resp) == 0 {
			continue
		}
		// Mỗi câu trả lời một dòng: bỏ xuống dòng trong JSON (đặc tả stdio).
		var compact bytes.Buffer
		if json.Compact(&compact, resp) == nil {
			resp = compact.Bytes()
		}
		if _, err := w.Write(append(resp, '\n')); err != nil {
			return err
		}
		if err := w.Flush(); err != nil {
			return err
		}
	}
	return sc.Err()
}

func forward(client *http.Client, url, token string, msg []byte) ([]byte, error) {
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(msg))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ChatQASoftware chưa mở hoặc chưa bật MCP: %w", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if err != nil {
		return nil, err
	}
	switch {
	case res.StatusCode == http.StatusAccepted:
		return nil, nil
	case res.StatusCode == http.StatusUnauthorized:
		return nil, fmt.Errorf("token MCP sai: đặt CHATQA_MCP_TOKEN bằng token hiện trong app")
	case res.StatusCode >= 300 && !strings.HasPrefix(strings.TrimSpace(string(body)), "{"):
		return nil, fmt.Errorf("http %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// stdioError: lỗi chuyển tiếp thành câu trả lời JSON-RPC cho đúng id (thông báo thì bỏ qua).
func stdioError(msg []byte, err error) []byte {
	var req rpcRequest
	if json.Unmarshal(msg, &req) != nil || len(req.ID) == 0 {
		return nil
	}
	b, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: req.ID, Error: &rpcError{Code: -32000, Message: err.Error()}})
	return b
}
