package daemon

import (
	"github.com/multica-ai/multica/server/pkg/agent"
	"testing"
)

func TestOversizedRequestPoisonAndRetry(t *testing.T) {
	for _, raw := range []string{
		`FAILED_PRECONDITION (code 400): The message size (31402142 bytes) exceeds 30.000MB limit.`,
		`AGY_ERROR: {"short_error":"The message size (31402142 bytes) exceeds 30.000MB limit.","status":"INVALID_ARGUMENT","error_code":400}`,
	} {
		if reason, ok := classifyPoisonedError(raw); !ok || reason != FailureReasonAPIInvalidRequest {
			t.Fatalf("classifyPoisonedError(%q) = %q, %v", raw, reason, ok)
		}
		for _, provider := range agent.SupportedTypes {
			result := agent.Result{Status: "failed", SessionID: "oversized", Error: raw}
			if !shouldRetryWithFreshSession(result, "oversized", 0, provider) {
				t.Errorf("%s: should retry despite nonempty session ID", provider)
			}
			if shouldRetryWithFreshSession(result, "oversized", 1, provider) {
				t.Errorf("%s: must not repeat tool side effects", provider)
			}
			if shouldRetryWithFreshSession(result, "", 0, provider) {
				t.Errorf("%s: must not retry a fresh run", provider)
			}
			result.Status = "completed"
			if shouldRetryWithFreshSession(result, "oversized", 0, provider) {
				t.Errorf("%s: must not retry a completed run", provider)
			}
		}
	}
	for _, raw := range []string{
		`message size (31400142 bytes) exceeds 30.000MB limit`,
		`file size (52428800 bytes) exceeds 50MB limit (HTTP 400)`,
		`API Error: 400 [1210][图片输入格式/解析错误]`,
	} {
		if reason, ok := classifyPoisonedError(raw); ok {
			t.Errorf("unexpected poisoning: %q => %s", raw, reason)
		}
	}
	// Anthropic's image rejection must remain on its pre-existing branch.
	if reason, ok := classifyPoisonedError(`API Error: 400 invalid_request_error: Could not process image`); !ok || reason != FailureReasonAPIInvalidRequest {
		t.Fatal("Anthropic regression")
	}
}
