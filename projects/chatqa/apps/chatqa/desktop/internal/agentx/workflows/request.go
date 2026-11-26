package workflows

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"unicode"
)

// Triggers say who started a pipeline run.
const (
	TriggerUI   = "ui"
	TriggerHTTP = "http"
	TriggerCLI  = "cli"
)

var triggers = []string{TriggerUI, TriggerHTTP, TriggerCLI}

// Request starts a pipeline run: the diff between From (old) and To (new, empty = HEAD) of the git repo at Repo.
type Request struct {
	Repo      string `json:"repo"`
	From      string `json:"from"`
	To        string `json:"to,omitempty"`
	MergeBase bool   `json:"mergeBase,omitempty"` // compare from the fork point, like a pull request (a...b)
	Trigger   string `json:"trigger,omitempty"`   // ui | http | cli; empty = ui
}

const maxRefLen = 200

// Normalize trims the fields, fills the default trigger and checks every field. It is the boundary check for
// requests from the UI, HTTP and the chat.
func (r Request) Normalize() (Request, error) {
	r.Repo, r.From, r.To, r.Trigger = strings.TrimSpace(r.Repo), strings.TrimSpace(r.From), strings.TrimSpace(r.To), strings.TrimSpace(r.Trigger)
	if r.Trigger == "" {
		r.Trigger = TriggerUI
	}
	if !slices.Contains(triggers, r.Trigger) {
		return r, fmt.Errorf("nguồn chạy pipeline %q không hợp lệ (ui, http hoặc cli)", r.Trigger)
	}
	if r.Repo == "" {
		return r, errors.New("cần đường dẫn repo git trên máy này (vd /Users/me/code/receiving)")
	}
	if !filepath.IsAbs(r.Repo) {
		return r, fmt.Errorf("đường dẫn repo %q phải là đường dẫn đầy đủ", r.Repo)
	}
	if r.From == "" {
		return r, errors.New("cần commit cũ (from), vd v1.2.0 hoặc 8 ký tự đầu của mã commit")
	}
	for _, ref := range []string{r.From, r.To} {
		if len(ref) > maxRefLen || strings.HasPrefix(ref, "-") || strings.ContainsFunc(ref, func(c rune) bool { return unicode.IsSpace(c) || unicode.IsControl(c) }) {
			return r, fmt.Errorf("commit %q không hợp lệ", ref)
		}
	}
	return r, nil
}

var (
	repoRe  = regexp.MustCompile(`(?:^|\s)((?:/|[A-Za-z]:\\)\S+)`)
	rangeRe = regexp.MustCompile(`([0-9A-Za-z][\w./-]*?)(\.\.\.?)([0-9A-Za-z][\w./-]*)`)
)

// ParseRequest reads the pipeline's input: the JSON of a Request (UI, HTTP, CLI), or a chat sentence such as
// "chạy pipeline cho commit abc..def" or "... /Users/me/code/app v1.2...HEAD". A sentence without a repo path uses
// lastRepo, the repo of this user's previous pipeline run.
func ParseRequest(text, lastRepo string) (Request, error) {
	s := strings.TrimSpace(text)
	var r Request
	if strings.HasPrefix(s, "{") {
		dec := json.NewDecoder(strings.NewReader(s))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&r); err != nil {
			return Request{}, fmt.Errorf("yêu cầu chạy pipeline không đọc được: %w", err)
		}
	} else {
		if m := repoRe.FindStringSubmatch(s); m != nil {
			r.Repo = m[1]
			s = strings.Replace(s, m[1], " ", 1)
		}
		m := rangeRe.FindStringSubmatch(s)
		if m == nil {
			return Request{Repo: r.Repo}, errors.New("chưa rõ khoảng commit: ghi dạng cũ..mới, vd abc1234..def5678 (hoặc cũ...mới để so kiểu pull request)")
		}
		r.From, r.To, r.MergeBase = m[1], m[3], m[2] == "..."
	}
	if strings.TrimSpace(r.Repo) == "" {
		r.Repo = lastRepo
	}
	return r.Normalize()
}
