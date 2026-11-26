// Command agenteval runs the agent eval scenarios (internal/agentx/eval) against the real Worker, prints their scores
// and, with -record, saves the model replies as the recordings go test replays offline.
//
// It spends the signed-in user's real AI budget, so it refuses to start without -spend. It reaches the Worker with:
//
//	CHATQA_EVAL_WORKER       Worker API address (as the app uses it)
//	CHATQA_EVAL_SESSION      a signed-in session token of a ChatQASoftware user
//	CHATQA_EVAL_DEVICE_ID    the licensed device id (optional when the Worker does not ask for it)
//	CHATQA_EVAL_DEVICE_HASH  the device hash
//
// None of these values is written to a recording; a recording that contains one is not saved.
//
// Example, from apps/chatqa/desktop:
//
//	go run ./cmd/agenteval -spend -record -only planner-auth-login,triage-app-crash
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"chatqa/internal/agentx/eval"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fs := flag.NewFlagSet("agenteval", flag.ContinueOnError)
	cases := fs.String("cases", "internal/agentx/eval/testdata/cases.json", "scenario file")
	out := fs.String("out", "internal/agentx/eval/testdata/recorded", "folder the recordings are written to")
	only := fs.String("only", "", "comma-separated case names; empty = all")
	record := fs.Bool("record", false, "save the replies as recordings")
	spend := fs.Bool("spend", false, "confirm that the run spends real AI budget on the Worker")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !*spend {
		fmt.Fprintln(os.Stderr, "agenteval calls the real Worker and spends AI budget; add -spend to confirm")
		return 2
	}
	live, err := eval.LiveFromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "agenteval:", err)
		return 2
	}
	source, err := live.Source()
	if err != nil {
		fmt.Fprintln(os.Stderr, "agenteval:", err)
		return 1
	}
	list, err := eval.LoadCases(*cases)
	if err != nil {
		fmt.Fprintln(os.Stderr, "agenteval:", err)
		return 1
	}
	var want []string
	if *only != "" {
		want = strings.Split(*only, ",")
	}
	secrets := []string{live.Session, live.DeviceHash}
	failed := 0
	for _, c := range list {
		if want != nil && !slices.Contains(want, c.Name) {
			continue
		}
		if err := runCase(c, source, *record, *out, secrets); err != nil {
			failed++
			fmt.Fprintf(os.Stderr, "%s: %v\n", c.Name, err)
		}
	}
	if failed > 0 {
		return 1
	}
	return 0
}

func runCase(c eval.Case, source eval.LLMSource, record bool, out string, secrets []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	dir, err := os.MkdirTemp("", "agenteval-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	rec := eval.NewRecorder(c.Name, "worker "+time.Now().Format("2006-01-02"), source)
	o, err := eval.RunCase(ctx, c, rec.LLM, dir)
	if err != nil {
		return fmt.Errorf("run: %w", err)
	}
	s := eval.Grade(c, o)
	fmt.Printf("%-28s correct=%-5v precision=%.2f recall=%.2f %s\n", c.Name, s.Correct, s.Precision, s.Recall, strings.Join(s.Notes, "; "))
	if !record {
		return nil
	}
	r := rec.Recording()
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	for _, v := range secrets {
		if v != "" && strings.Contains(string(raw), v) {
			return errors.New("the recording contains a credential; not saved")
		}
	}
	return r.Save(out)
}
