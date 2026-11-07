package jev

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
)

const MaxEvaluationBytes = 64 << 10

// EvaluationRequest contains business input only. Infrastructure configuration
// is deliberately absent from both the task endpoint and the CLI contract.
type EvaluationRequest struct {
	State     json.RawMessage          `json:"state"`
	Questions map[string]ScoreQuestion `json:"questions"`
}

type ScoreQuestion struct {
	Type         string   `json:"type"`
	Instructions string   `json:"instructions"`
	Criteria     []string `json:"criteria"`
}

type ScoreAnswer struct {
	Score float64 `json:"score"`
}

type EvaluationResult struct {
	OK            bool                   `json:"ok"`
	Answers       map[string]ScoreAnswer `json:"answers,omitempty"`
	Reason        FallbackReason         `json:"reason,omitempty"`
	LatencyMS     int64                  `json:"latency_ms"`
	DaemonVersion string                 `json:"daemon_version,omitempty"`
}

// DecodeEvaluation rejects unknown transport fields, trailing JSON, oversized
// input and incomplete score questions before contacting any provider.
func DecodeEvaluation(r io.Reader) (EvaluationRequest, error) {
	var req EvaluationRequest
	raw, err := io.ReadAll(io.LimitReader(r, MaxEvaluationBytes+1))
	if err != nil || len(raw) > MaxEvaluationBytes {
		return req, errors.New("evaluation input must be at most 64 KiB")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&req); err != nil {
		return req, errors.New("evaluation input must contain only state and score questions")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return req, errors.New("evaluation input must be one JSON object")
	}
	return req, req.Validate()
}

func (r EvaluationRequest) Validate() error {
	state := bytes.TrimSpace(r.State)
	if len(state) == 0 || !json.Valid(state) || (state[0] != '{' && state[0] != '"') {
		return errors.New("state must be an object or string")
	}
	if len(r.Questions) < 1 || len(r.Questions) > 16 {
		return errors.New("questions must contain 1 to 16 score questions")
	}
	for name, q := range r.Questions {
		if strings.TrimSpace(name) == "" || len(name) > 64 || q.Type != "score" || strings.TrimSpace(q.Instructions) == "" || len(q.Criteria) < 2 || len(q.Criteria) > 32 {
			return errors.New("each question requires a name, type score, instructions and 2 to 32 ordered criteria")
		}
		for _, criterion := range q.Criteria {
			if strings.TrimSpace(criterion) == "" {
				return errors.New("criteria must contain non-empty strings")
			}
		}
	}
	return nil
}

// Evaluate returns only validated numeric scores, never raw provider output or
// configuration. Errors are typed and contain no caller or provider text.
func (c *Client) Evaluate(ctx context.Context, req EvaluationRequest) EvaluationResult {
	started := c.now()
	if req.Validate() != nil {
		return EvaluationResult{Reason: ReasonInvalid}
	}
	questions, _ := json.Marshal(req.Questions)
	answers, _, err := runSources(c, ctx, func(ctx context.Context, src Source) (map[string]ScoreAnswer, FallbackReason, error) {
		raw, reason, err := c.callSource(ctx, src, req.State, questions)
		if err != nil {
			return nil, reason, err
		}
		answers, err := readScores(raw, req.Questions)
		return answers, ReasonInvalid, err
	})
	result := EvaluationResult{OK: err == nil, Answers: answers, LatencyMS: c.now().Sub(started).Milliseconds()}
	if err != nil {
		var fallback *FallbackError
		if errors.As(err, &fallback) {
			result.Reason = fallback.Reason
		} else {
			result.Reason = ReasonError
		}
	}
	return result
}

func readScores(raw []byte, questions map[string]ScoreQuestion) (map[string]ScoreAnswer, error) {
	var out struct {
		Answers map[string]struct {
			Score *float64 `json:"score"`
		} `json:"answers"`
	}
	if json.Unmarshal(raw, &out) != nil {
		return nil, errors.New("invalid score response")
	}
	answers := make(map[string]ScoreAnswer, len(questions))
	for name, q := range questions {
		score := out.Answers[name].Score
		if score == nil || math.IsNaN(*score) || math.IsInf(*score, 0) || *score < 0 || *score > float64(len(q.Criteria)-1) {
			return nil, errors.New("score outside criteria range")
		}
		answers[name] = ScoreAnswer{Score: *score}
	}
	return answers, nil
}
