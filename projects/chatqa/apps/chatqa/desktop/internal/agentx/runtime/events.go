// Package runtime runs the ADK agent team for the chat pane: sessions in SQLite, streaming, cancel, cost.
package runtime

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"google.golang.org/adk/v2/model/anthropicmodel"
	"google.golang.org/adk/v2/session"
	"google.golang.org/adk/v2/tool/toolconfirmation"
	"google.golang.org/adk/v2/workflow"
	"google.golang.org/genai"

	"chatqa/internal/agentx/agents"
	"chatqa/internal/agentx/models"
	"chatqa/internal/testengine"
)

// Event kinds the UI receives.
const (
	KindText         = "text"
	KindTextDelta    = "text_delta"
	KindProgress     = "progress" // a status line from a non-LLM agent; each one replaces the last
	KindToolCall     = "tool_call"
	KindToolResult   = "tool_result"
	KindConfirmation = "confirmation"
	KindRequestInput = "request_input"
	KindError        = "error"
	KindDone         = "done"
)

const argsPreviewMax = 300

// Event is one thing the chat pane shows. It never carries raw tool arguments: only a redacted, shortened preview.
type Event struct {
	SessionID    string  `json:"sessionId"`
	InvocationID string  `json:"invocationId,omitempty"`
	Author       string  `json:"author,omitempty"` // agent name
	Kind         string  `json:"kind"`
	Text         string  `json:"text,omitempty"`
	ToolName     string  `json:"toolName,omitempty"`
	ToolCallID   string  `json:"toolCallId,omitempty"`
	ArgsPreview  string  `json:"argsPreview,omitempty"`
	ResultKind   string  `json:"resultKind,omitempty"`
	ImageRef     string  `json:"imageRef,omitempty"`
	Partial      bool    `json:"partial,omitempty"`
	TokensIn     int     `json:"tokensIn,omitempty"`
	TokensOut    int     `json:"tokensOut,omitempty"`
	CostUSD      float64 `json:"costUsd,omitempty"` // this event's cost, or the run total on done
	CostVND      float64 `json:"costVnd,omitempty"`
	At           int64   `json:"at,omitempty"` // unix ms
	// Confirmation (kind confirmation): ToolCallID is the id to answer with Approve, ToolName and ArgsPreview are the
	// call waiting for approval, Text says why. Request (kind request_input): ToolCallID is the interrupt id to answer
	// with Respond, Text is the question, Payload the redacted JSON the form is built from.
	Risk        string `json:"risk,omitempty"`
	Consequence string `json:"consequence,omitempty"`
	Payload     string `json:"payload,omitempty"`
	// Resolved marks, in a replayed history, a confirmation or request that was already answered or dropped.
	Resolved bool `json:"resolved,omitempty"`
}

// confirmArgsMax caps the arguments shown in the approval dialog; longer values are cut.
const confirmArgsMax = 2000

// mapper turns ADK events into UI events and keeps the run's running totals.
type mapper struct {
	sessionID string
	redact    func(string) string
	prices    *models.Prices
	modelOf   func(author string) string // model alias an agent runs on, for pricing
	// explain describes a call waiting for approval: its risk, the consequence sentence and why it needs approval.
	explain func(name string, args map[string]any) (risk, consequence string, reasons []string)

	tokensIn, tokensOut int
	costUSD, costVND    float64
}

func (m *mapper) clean(s string) string {
	if m.redact != nil {
		s = m.redact(s)
	}
	return s
}

func preview(m *mapper, v any) string { return previewN(m, v, argsPreviewMax) }

func previewN(m *mapper, v any, max int) string {
	raw, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	s := m.clean(string(raw))
	if utf8.RuneCountInString(s) > max {
		r := []rune(s)
		s = string(r[:max]) + "…"
	}
	return s
}

// hitlEvent maps the function call of an approval request or an input request to its UI event. ok is false for an
// ordinary tool call.
func (m *mapper) hitlEvent(base Event, fc *genai.FunctionCall) (Event, bool) {
	e := base
	e.ToolCallID = fc.ID
	switch fc.Name {
	case toolconfirmation.FunctionCallName:
		e.Kind = KindConfirmation
		orig, err := toolconfirmation.OriginalCallFrom(fc)
		if err != nil {
			e.Text = "Agent xin duyệt một thao tác nhưng yêu cầu không đọc được; hãy từ chối."
			return e, true
		}
		e.ToolName, e.ArgsPreview = orig.Name, previewN(m, orig.Args, confirmArgsMax)
		hint := ""
		if tc, ok := fc.Args["toolConfirmation"].(map[string]any); ok {
			hint, _ = tc["hint"].(string)
		}
		var reasons []string
		if m.explain != nil {
			e.Risk, e.Consequence, reasons = m.explain(orig.Name, orig.Args)
		}
		// ADK's own hint for function tools is an English instruction for API clients; show the reasons instead.
		if hint == "" || strings.HasPrefix(hint, "Please approve or reject") {
			hint = "Agent muốn chạy " + orig.Name
			if len(reasons) > 0 {
				hint += ": " + strings.Join(reasons, "; ")
			}
			hint += "."
		}
		e.Text = m.clean(hint)
		return e, true
	case workflow.WorkflowInputFunctionCallName:
		e.Kind, e.ToolName = KindRequestInput, fc.Name
		if id, ok := fc.Args["interruptId"].(string); ok && id != "" {
			e.ToolCallID = id
		}
		msg, _ := fc.Args["message"].(string)
		e.Text = m.clean(msg)
		if p, ok := fc.Args["payload"]; ok && p != nil {
			if raw, err := json.Marshal(p); err == nil {
				e.Payload = m.clean(string(raw))
			}
		}
		return e, true
	}
	return e, false
}

// events maps one ADK event to zero or more UI events.
func (m *mapper) events(ev *session.Event) []Event {
	base := Event{SessionID: m.sessionID, InvocationID: ev.InvocationID, Author: ev.Author, Partial: ev.Partial, At: ev.Timestamp.UnixMilli()}
	var out []Event
	// An event with only a code (no message) says nothing the user can act on, and the run error that follows carries
	// the detail: showing both made an empty second error card.
	if strings.TrimSpace(ev.ErrorMessage) != "" {
		e := base
		e.Kind, e.Text = KindError, m.clean(strings.TrimSpace(ev.ErrorCode+" "+ev.ErrorMessage))
		out = append(out, e)
	}
	if ev.Content != nil {
		for _, p := range ev.Content.Parts {
			switch {
			case p.FunctionCall != nil:
				if h, ok := m.hitlEvent(base, p.FunctionCall); ok {
					if !ev.Partial {
						out = append(out, h)
					}
					continue
				}
				e := base
				e.Kind, e.ToolName, e.ToolCallID, e.ArgsPreview = KindToolCall, p.FunctionCall.Name, p.FunctionCall.ID, preview(m, p.FunctionCall.Args)
				out = append(out, e)
			case p.FunctionResponse != nil:
				e := base
				e.Kind, e.ToolName, e.ToolCallID = KindToolResult, p.FunctionResponse.Name, p.FunctionResponse.ID
				if k, ok := p.FunctionResponse.Response["kind"].(string); ok {
					e.ResultKind = k
				}
				if d, ok := p.FunctionResponse.Response["data"].(map[string]any); ok {
					if ref, ok := d["image"].(string); ok {
						e.ImageRef = ref
					}
				}
				out = append(out, e)
			case p.Text != "" && !p.Thought:
				e := base
				e.Kind, e.Text = KindText, m.clean(p.Text)
				if ev.Partial {
					e.Kind = KindTextDelta
					if ev.Author == agents.RunnerName {
						e.Kind = KindProgress
					}
				}
				out = append(out, e)
			}
		}
	}
	if u := ev.UsageMetadata; u != nil && !ev.Partial {
		in, outTok := int(u.PromptTokenCount), int(u.CandidatesTokenCount)+int(u.ThoughtsTokenCount)
		m.tokensIn += in
		m.tokensOut += outTok
		var write int64
		if v, ok := ev.CustomMetadata[anthropicmodel.CacheCreationInputTokensMetadataKey].(int64); ok {
			write = v
		}
		if m.prices != nil && m.modelOf != nil {
			if c, err := m.prices.Cost(m.modelOf(ev.Author), u, write); err == nil {
				m.costUSD += c.USD
				m.costVND += c.VND
				if len(out) > 0 {
					last := &out[len(out)-1]
					last.TokensIn, last.TokensOut, last.CostUSD, last.CostVND = in, outTok, c.USD, c.VND
				}
			}
		}
	}
	return out
}

// redactor builds the secret-masking function from the registry's secret source.
func redactor(secrets func() []string) func(string) string {
	if secrets == nil {
		return nil
	}
	return func(s string) string { return testengine.Redact(s, secrets()) }
}

func (m *mapper) done() Event {
	return Event{SessionID: m.sessionID, Kind: KindDone, TokensIn: m.tokensIn, TokensOut: m.tokensOut, CostUSD: m.costUSD, CostVND: m.costVND}
}

func errorEvent(sessionID string, err error) Event {
	return Event{SessionID: sessionID, Kind: KindError, Text: fmt.Sprint(err)}
}
