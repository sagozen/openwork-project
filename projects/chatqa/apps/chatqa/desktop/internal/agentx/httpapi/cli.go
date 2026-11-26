package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	agentrt "chatqa/internal/agentx/runtime"
	"chatqa/internal/agentx/workflows"
)

// Exit codes of "chatqa --pipeline", for CI:
//
//	0  started (without --wait), or finished with every flow passing
//	1  error: the app refused the request or is not reachable, or the run failed (status failed)
//	2  usage: bad flags, or CHATQA_MCP_TOKEN not set
//	3  finished, and at least one flow failed
//	4  waiting for a person to approve in the app (--wait)
//	5  --wait gave up after --timeout; the run goes on in the app
const (
	ExitOK              = 0
	ExitError           = 1
	ExitUsage           = 2
	ExitFlowsFailed     = 3
	ExitWaitingApproval = 4
	ExitTimeout         = 5
)

// CLI is a parsed "chatqa --pipeline" command line.
type CLI struct {
	Repo, From, To string
	MergeBase      bool
	Wait           bool
	Poll           time.Duration
	Timeout        time.Duration
}

// ParseCLI reads the flags of "chatqa --pipeline --repo R --from A [--to B] [--merge-base] [--wait] [--poll 5s]
// [--timeout 2h]". --repo defaults to the current folder and is made absolute.
func ParseCLI(args []string, stderr io.Writer) (CLI, error) {
	fs := flag.NewFlagSet("chatqa --pipeline", flag.ContinueOnError)
	fs.SetOutput(stderr)
	var c CLI
	fs.Bool("pipeline", true, "chạy pipeline sau deploy trên app ChatQASoftware đang mở")
	fs.StringVar(&c.Repo, "repo", ".", "repo git trên máy này")
	fs.StringVar(&c.From, "from", "", "commit cũ (bắt buộc)")
	fs.StringVar(&c.To, "to", "", "commit mới (mặc định HEAD)")
	fs.BoolVar(&c.MergeBase, "merge-base", false, "so từ điểm rẽ nhánh, như pull request (from...to)")
	fs.BoolVar(&c.Wait, "wait", false, "chờ tới khi xong hoặc cần duyệt")
	fs.DurationVar(&c.Poll, "poll", 5*time.Second, "chu kỳ hỏi trạng thái khi --wait")
	fs.DurationVar(&c.Timeout, "timeout", 2*time.Hour, "chờ tối đa khi --wait")
	if err := fs.Parse(args); err != nil {
		return CLI{}, err
	}
	if fs.NArg() > 0 {
		return CLI{}, fmt.Errorf("tham số thừa: %s", strings.Join(fs.Args(), " "))
	}
	if strings.TrimSpace(c.From) == "" {
		return CLI{}, errors.New("cần --from (commit cũ)")
	}
	if c.Poll <= 0 || c.Timeout <= 0 {
		return CLI{}, errors.New("--poll và --timeout phải lớn hơn 0")
	}
	abs, err := filepath.Abs(c.Repo)
	if err != nil {
		return CLI{}, fmt.Errorf("--repo %q: %w", c.Repo, err)
	}
	c.Repo = abs
	return c, nil
}

// Client calls the API of the running app.
type Client struct {
	Base  string // e.g. http://127.0.0.1:39017 (no /agent)
	Token string // the MCP token (CHATQA_MCP_TOKEN)
	HTTP  *http.Client
}

func (c Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.Base, "/")+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	hc := c.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("không gọi được ChatQASoftware (app có đang mở và đã bật MCP?): %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(raw))
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		return &StatusError{Code: resp.StatusCode, Message: msg}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// StatusError is a non-2xx answer of the app.
type StatusError struct {
	Code    int
	Message string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("ChatQASoftware trả %d: %s", e.Code, e.Message)
}

// RunCLI starts the pipeline through the running app and, with Wait, polls until it finishes or waits for approval.
// It prints the session id and status lines to out and returns an exit code (see ExitOK and the others).
func RunCLI(ctx context.Context, c Client, cli CLI, out, errOut io.Writer) int {
	var started startResponse
	req := startRequest{Repo: cli.Repo, From: cli.From, To: cli.To, MergeBase: cli.MergeBase, Trigger: workflows.TriggerCLI}
	if err := c.do(ctx, http.MethodPost, Prefix+"/pipeline", req, &started); err != nil {
		fmt.Fprintln(errOut, "chatqa --pipeline:", err)
		return ExitError
	}
	fmt.Fprintf(out, "session: %s\nstatus_url: %s\n", started.SessionID, started.StatusURL)
	if !cli.Wait {
		fmt.Fprintln(out, "status: running")
		return ExitOK
	}
	ctx, cancel := context.WithTimeout(ctx, cli.Timeout)
	defer cancel()
	last, misses := "", 0
	for {
		var st agentrt.PipelineStatus
		err := c.do(ctx, http.MethodGet, started.StatusURL, nil, &st)
		if err != nil {
			var se *StatusError
			if ctx.Err() == nil && !errors.As(err, &se) && misses < 3 {
				misses++ // the app may be busy for a moment; a refusal (4xx/5xx) is final
			} else if ctx.Err() == nil {
				fmt.Fprintln(errOut, "chatqa --pipeline:", err)
				return ExitError
			}
		} else {
			misses = 0
			if st.Status != last {
				fmt.Fprintf(out, "status: %s\n", st.Status)
				last = st.Status
			}
			switch st.Status {
			case workflows.StatusWaitingApproval:
				for _, p := range st.Pending {
					fmt.Fprintf(out, "pending: %s\n", oneLine(p.Text))
				}
				fmt.Fprintln(out, "Cần người duyệt trong app ChatQASoftware; sau khi duyệt, theo dõi tiếp bằng status_url.")
				return ExitWaitingApproval
			case workflows.StatusDone:
				printResult(out, st)
				if st.Failed != nil && *st.Failed {
					return ExitFlowsFailed
				}
				return ExitOK
			case workflows.StatusFailed:
				printResult(out, st)
				return ExitError
			}
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				fmt.Fprintf(errOut, "chatqa --pipeline: hết %s chờ; pipeline vẫn chạy trong app (%s)\n", cli.Timeout, started.StatusURL)
				return ExitTimeout
			}
			return ExitError
		case <-time.After(cli.Poll):
		}
	}
}

func printResult(out io.Writer, st agentrt.PipelineStatus) {
	if st.Failed != nil {
		fmt.Fprintf(out, "failed: %v\n", *st.Failed)
	}
	for _, f := range st.Flaky {
		fmt.Fprintf(out, "flaky: %s\n", f)
	}
	if st.Report != "" {
		fmt.Fprintf(out, "report:\n%s\n", st.Report)
	}
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }
