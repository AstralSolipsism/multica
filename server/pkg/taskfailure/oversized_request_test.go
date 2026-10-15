package taskfailure

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func oversizedRequestCases() map[string]bool {
	return map[string]bool{
		`FAILED_PRECONDITION (code 400): The message size (31402142 bytes) exceeds 30.000MB limit.`:                                                                                true,
		`AGY_ERROR: {"short_error":"The message size (31641339 bytes) exceeds 30.000MB limit.","status":"INVALID_ARGUMENT","error_code":400,"code_kind":"http","retryable":false}`: true,
		`HTTP 400: Request payload size exceeds the limit`:                                                                                                                         true,
		`invalid_argument: MESSAGE SIZE (31638569 bytes) EXCEEDS 30.000MB LIMIT`:                                                                                                   true,
		"FAILED_PRECONDITION: request size\nexceeds the limit":                                                                                                                     true,
		`The message size (31402142 bytes) exceeds 30.000MB limit.`:                                                                                                                false,
		`file size (52428800 bytes) exceeds 50MB limit (HTTP 400)`:                                                                                                                 false,
		`HTTP 429: quota exceeded`:                                                            false,
		`429: message size (31400142 bytes) exceeds 30.000MB limit`:                           false,
		`message size exceeds the limit; code 1400`:                                           false,
		`message size exceeds the limit; code 4000`:                                           false,
		`API Error: 400 [1210][图片输入格式/解析错误]`:                                                  false,
		`API Error: 400 {"type":"invalid_request_error","message":"Could not process image"}`: false,
		`400 message size` + strings.Repeat("x", 81) + `exceeds limit`:                        false,
		`400 message size exceeds` + strings.Repeat("x", 41) + `limit`:                        false,
		"": false,
	}
}

func TestOversizedRequest(t *testing.T) {
	for raw, want := range oversizedRequestCases() {
		if got := OversizedRequest(raw); got != want {
			t.Errorf("OversizedRequest(%q) = %v, want %v", raw, got, want)
		}
	}
}

func TestNormalizeDaemonReasonOversizedRequest(t *testing.T) {
	for raw, oversized := range oversizedRequestCases() {
		for _, reason := range []string{"agent_error.unknown", "agent_error", "api_invalid_request", "agent_error.process_failure"} {
			want := Reason(reason)
			if oversized && (reason == "agent_error.unknown" || reason == "agent_error") {
				want = ReasonAPIInvalidRequest
			}
			if got := NormalizeDaemonReason(reason, raw); got != want {
				t.Errorf("NormalizeDaemonReason(%q, %q) = %q, want %q", reason, raw, got, want)
			}
		}
	}
}

func TestOversizedRequestMatchesResumeQueryGuards(t *testing.T) {
	// Read the actual SQL guard, not a second hand-written copy of the pattern.
	guard := regexp.MustCompile(`(?s)AND NOT \(COALESCE\(error, ''\) ~\* '([^']*\(message\|request\|payload\)[^']*)'\s+AND COALESCE\(error, ''\) ~\* '([^']*)'\)`)
	for _, file := range []string{"../db/queries/agent.sql", "../db/queries/chat.sql"} {
		sql, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		match := guard.FindStringSubmatch(string(sql))
		if len(match) != 3 {
			t.Fatalf("missing oversized-request guard in %s", file)
		}
		size := regexp.MustCompile("(?is)" + match[1])
		rejection := regexp.MustCompile("(?i)" + match[2])
		if "(?is)"+match[1] != oversizedRequestSizeRe.String() || "(?i)"+match[2] != oversizedRequestRejectionRe.String() {
			t.Fatalf("Go/SQL pattern drift in %s", file)
		}
		for raw, want := range oversizedRequestCases() {
			if got := size.MatchString(raw) && rejection.MatchString(raw); got != want {
				t.Errorf("%s: SQL guard for %q = %v, want %v", file, raw, got, want)
			}
		}
	}
}
