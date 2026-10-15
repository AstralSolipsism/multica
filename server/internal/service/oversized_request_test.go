package service

import "testing"

func TestResumeUnsafeFailureOversizedRequest(t *testing.T) {
	for raw, want := range map[string]bool{
		`FAILED_PRECONDITION (code 400): The message size (31402142 bytes) exceeds 30.000MB limit.`:       true,
		`AGY_ERROR: {"short_error":"Request payload size exceeds the limit","status":"INVALID_ARGUMENT"}`: true,
		`message size (31400142 bytes) exceeds 30.000MB limit`:                                            false,
		`HTTP 429 quota exceeded`:                                  false,
		`file size (52428800 bytes) exceeds 50MB limit (HTTP 400)`: false,
		`API Error: 400 [1210][图片输入格式/解析错误]`:                       false,
	} {
		if got := ResumeUnsafeFailure("agent_error.unknown", raw); got != want {
			t.Errorf("ResumeUnsafeFailure(%q) = %v, want %v", raw, got, want)
		}
	}
}
