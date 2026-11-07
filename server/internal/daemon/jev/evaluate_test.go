package jev

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const evaluationFixture = `{"state":{"reader":"new reader","dialog":"product background"},"questions":{"need":{"type":"score","instructions":"judge clarity","criteria":["clear","minor","heavy","opaque"]}}}`

func evaluationInput(t *testing.T) EvaluationRequest {
	t.Helper()
	r, err := DecodeEvaluation(strings.NewReader(evaluationFixture))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDecodeEvaluation(t *testing.T) {
	for _, input := range []string{
		`null`, `{}`, evaluationFixture + `{}`, strings.Repeat(" ", MaxEvaluationBytes) + evaluationFixture,
		strings.Replace(evaluationFixture, `"state":`, `"model":"caller-model","state":`, 1),
		strings.Replace(evaluationFixture, `"state":`, `"url":"https://example.com","state":`, 1),
		strings.Replace(evaluationFixture, `"type":"score"`, `"type":"score","api_key":"secret"`, 1),
		strings.Replace(evaluationFixture, `"type":"score"`, `"type":"choice"`, 1),
		strings.Replace(evaluationFixture, `"judge clarity"`, `" "`, 1),
		strings.Replace(evaluationFixture, `"opaque"`, `""`, 1),
		`{"state":null,"questions":{}}`, `{"state":[],"questions":{}}`,
		`{"state":{},"questions":{"n":{"type":"score","instructions":"x","criteria":["x"]}}}`,
	} {
		if _, err := DecodeEvaluation(strings.NewReader(input)); err == nil {
			t.Errorf("accepted invalid input: %.120s", input)
		}
	}
	if _, err := DecodeEvaluation(strings.NewReader(evaluationFixture)); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateManagedWireAndFallback(t *testing.T) {
	var order []string
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "bad")
		http.Error(w, "private provider error", 503)
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "good")
		var body struct {
			Model     string
			State     json.RawMessage
			Questions map[string]ScoreQuestion
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Model != "managed-model" || r.Header.Get("Authorization") != "Bearer managed-key" || r.Header.Get("Content-Encoding") != "" {
			t.Error("configuration or plain JSON wire contract changed")
		}
		if body.Questions["need"].Criteria[3] != "opaque" || !strings.Contains(string(body.State), "product background") {
			t.Error("business payload changed")
		}
		io.WriteString(w, `{"answers":{"need":{"score":2,"reason":"private echoed data"}},"secret":"managed-key"}`)
	}))
	defer good.Close()
	c := New(Options{Sources: []Source{{Name: "bad", BaseURL: bad.URL}, {Name: "good", BaseURL: good.URL, Model: "managed-model", BearerToken: "managed-key"}}})
	result := c.Evaluate(context.Background(), evaluationInput(t))
	if !result.OK || result.Answers["need"].Score != 2 || strings.Join(order, ",") != "bad,good" {
		t.Fatalf("result=%+v order=%v", result, order)
	}
	raw, _ := json.Marshal(result)
	for _, private := range []string{"managed-key", "managed-model", good.URL, "private"} {
		if strings.Contains(string(raw), private) {
			t.Fatal("provider details escaped")
		}
	}
	if c.Snapshot().DecisionsOK != 1 {
		t.Fatal("shared accounting not updated")
	}
}

func TestEvaluateInvalidResponses(t *testing.T) {
	for _, body := range []string{`{}`, `{"answers":{"need":{}}}`, `{"answers":{"need":{"score":null}}}`, `{"answers":{"need":{"score":"2"}}}`, `{"answers":{"need":{"score":-1}}}`, `{"answers":{"need":{"score":4}}}`, `{"answers":{"need":{"score":2}}}{}`, strings.Repeat("x", maxResponseBytes+1)} {
		t.Run(body[:min(len(body), 50)], func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
			defer srv.Close()
			c := New(Options{Sources: []Source{{Name: "test", BaseURL: srv.URL}}})
			result := c.Evaluate(context.Background(), evaluationInput(t))
			if result.OK || result.Reason != ReasonInvalid || len(result.Answers) != 0 {
				t.Fatalf("%+v", result)
			}
		})
	}
}

func TestEvaluateDisabledTimeoutBreakerCancellation(t *testing.T) {
	req := evaluationInput(t)
	if got := New(Options{Disabled: true}).Evaluate(context.Background(), req); got.Reason != ReasonDisabled {
		t.Fatal(got)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(time.Second):
		}
	}))
	defer srv.Close()
	c := New(Options{Timeout: 10 * time.Millisecond, Sources: []Source{{Name: "slow", BaseURL: srv.URL}}})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got := c.Evaluate(ctx, req); got.OK {
		t.Fatal(got)
	}
	if c.Snapshot().DecisionsFallback != 0 {
		t.Fatal("caller cancellation opened breaker")
	}
	for range 3 {
		if got := c.Evaluate(context.Background(), req); got.Reason != ReasonTimeout {
			t.Fatal(got)
		}
	}
	if got := c.Evaluate(context.Background(), req); got.Reason != ReasonBreaker {
		t.Fatal(got)
	}
}
