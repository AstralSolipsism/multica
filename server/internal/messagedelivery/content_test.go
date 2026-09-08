package messagedelivery

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

// The redaction boundary is the module's security contract: a task
// completion payload carries the daemon's FULL callback (output, session
// id, work dir, branch, ...), and only the output string may ever cross
// into message content.
func TestExtractRunOnlyOutput_DropsEverythingButOutput(t *testing.T) {
	payload := map[string]any{
		"output":      "the report",
		"session_id":  "sess_abc123",
		"work_dir":    "/home/agent/secret-dir",
		"branch_name": "feat/secret",
		"pr_url":      "https://git.example/private/pr/1",
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	out, ok := extractRunOnlyOutput(raw)
	if !ok || out != "the report" {
		t.Fatalf("extractRunOnlyOutput = %q, %v; want %q", out, ok, "the report")
	}
	rendered := buildRunOnlyContent("Title", "completed", "", "", out, true, true)
	if strings.Contains(rendered.Text, "sess_abc") ||
		strings.Contains(rendered.Text, "secret-dir") ||
		strings.Contains(rendered.Text, "feat/secret") ||
		strings.Contains(rendered.Text, "private/pr") {
		t.Fatalf("rendered content leaked non-output fields: %q", rendered.Text)
	}
}

func TestExtractRunOnlyOutput_EmptyAndCorrupt(t *testing.T) {
	if _, ok := extractRunOnlyOutput(nil); ok {
		t.Fatal("nil result must not yield output")
	}
	if _, ok := extractRunOnlyOutput([]byte(`{"output":"   "}`)); ok {
		t.Fatal("blank output must not yield output")
	}
	if _, ok := extractRunOnlyOutput([]byte("not json")); ok {
		t.Fatal("corrupt result must not yield output")
	}
}

func TestBuildRunOnlyContent(t *testing.T) {
	completed := buildRunOnlyContent("Daily report", "completed", "", "", "line one\nline two", true, true)
	if completed.Text != "Daily report — run completed\n\nline one\nline two" {
		t.Fatalf("with_output text = %q", completed.Text)
	}
	if !completed.HasOutput {
		t.Fatal("with_output must mark HasOutput")
	}

	digest := buildRunOnlyContent("Daily report", "completed", "", "", "secret body", true, false)
	if strings.Contains(digest.Text, "secret body") {
		t.Fatalf("summary mode must not include output: %q", digest.Text)
	}

	empty := buildRunOnlyContent("Daily report", "completed", "", "", "", false, true)
	if !strings.Contains(empty.Text, noReportBodyText) {
		t.Fatalf("empty output must render the placeholder: %q", empty.Text)
	}

	failed := buildRunOnlyContent("Daily report", "failed", "agent_context_overflow", "raw error text", "", false, true)
	if !strings.Contains(failed.Text, "reason: agent_context_overflow") {
		t.Fatalf("failed run should carry the curated code: %q", failed.Text)
	}
	if strings.Contains(failed.Text, "raw error text") {
		t.Fatalf("failed run must not carry the raw error: %q", failed.Text)
	}
	noCode := buildRunOnlyContent("Daily report", "failed", "", "", "", false, true)
	if !strings.Contains(noCode.Text, runFailureText) {
		t.Fatalf("failed run without a code should use the generic line: %q", noCode.Text)
	}
}

func TestBuildCreateIssueContent(t *testing.T) {
	done := buildCreateIssueContent("Fix bugs", "completed", "ENG-12", "in_review", "https://app.example.com", "eng")
	want := "Fix bugs — task ENG-12 reached its first terminal state as in_review\nhttps://app.example.com/eng/issues/ENG-12"
	if done.Text != want {
		t.Fatalf("text = %q, want %q", done.Text, want)
	}
	if done.Link != "https://app.example.com/eng/issues/ENG-12" {
		t.Fatalf("link = %q, want the workspace-scoped path", done.Link)
	}
	// A known status is never dropped silently, but an unrecoverable
	// first-terminal status degrades instead of presenting a later one.
	degraded := buildCreateIssueContent("Fix bugs", "completed", "ENG-12", "", "https://app.example.com", "eng")
	if strings.Contains(degraded.Text, " as ") {
		t.Fatalf("degraded card must not name a status: %q", degraded.Text)
	}
	if !strings.Contains(degraded.Text, "ENG-12") || !strings.Contains(degraded.Text, "see the task page") {
		t.Fatalf("degraded card = %q", degraded.Text)
	}
	failed := buildCreateIssueContent("Fix bugs", "failed", "ENG-12", "cancelled", "https://app.example.com", "eng")
	if !strings.Contains(failed.Text, "task ENG-12") {
		t.Fatalf("failed create_issue text = %q", failed.Text)
	}
	if failed.Link != "https://app.example.com/eng/issues/ENG-12" {
		t.Fatalf("failed link = %q", failed.Link)
	}
	noSlug := buildCreateIssueContent("Fix bugs", "completed", "ENG-12", "done", "https://app.example.com", "")
	if noSlug.Link != "" {
		t.Fatalf("unknown slug must omit the link, got %q", noSlug.Link)
	}
}

func TestIssueIdentifier(t *testing.T) {
	if got := issueIdentifier("ENG", 42); got != "ENG-42" {
		t.Fatalf("issueIdentifier = %q", got)
	}
	if got := issueIdentifier("", 42); got != "#42" {
		t.Fatalf("issueIdentifier without prefix = %q", got)
	}
}

func TestSplitShards_DeterministicAndRuneSafe(t *testing.T) {
	// Build a body with multi-byte runes so a byte-boundary split would
	// corrupt UTF-8.
	long := strings.Repeat("多字节文本—", 3000) // 15000 runes
	shards := splitShards(long)
	if len(shards) < 2 {
		t.Fatalf("long body must split, got %d shard(s)", len(shards))
	}
	var rebuilt strings.Builder
	for i, shard := range shards {
		if !utf8.ValidString(shard) {
			t.Fatalf("shard %d is not valid UTF-8", i)
		}
		if utf8.RuneCountInString(shard) > shardRunes {
			t.Fatalf("shard %d exceeds the shard size", i)
		}
		rebuilt.WriteString(shard)
	}
	if !strings.HasPrefix(long, rebuilt.String()) && rebuilt.Len() > 0 {
		// The last shard may carry the truncation marker; everything up
		// to it must be a faithful prefix.
		if !strings.HasPrefix(rebuilt.String(), long[:100]) {
			t.Fatal("shards lost body content")
		}
	}
	// Deterministic: same input, same plan.
	again := splitShards(long)
	if len(again) != len(shards) {
		t.Fatalf("shard count drifted: %d vs %d", len(again), len(shards))
	}
	for i := range shards {
		if again[i] != shards[i] {
			t.Fatalf("shard %d differs across splits", i)
		}
	}
}

func TestSplitShards_TruncatesBeyondBudget(t *testing.T) {
	huge := strings.Repeat("x", shardRunes*maxShards*2)
	shards := splitShards(huge)
	if len(shards) != maxShards {
		t.Fatalf("shard count = %d, want the cap %d", len(shards), maxShards)
	}
	if !strings.HasSuffix(shards[len(shards)-1], truncatedMarker) {
		t.Fatal("overflowed content must carry the truncation marker")
	}
}

func TestSplitShards_ShortBodyStaysWhole(t *testing.T) {
	shards := splitShards("short")
	if len(shards) != 1 || shards[0] != "short" {
		t.Fatalf("short body = %v", shards)
	}
}

func TestRouteMatchesRun(t *testing.T) {
	cases := []struct {
		conditions, status string
		want               bool
	}{
		{ConditionSuccess, "completed", true},
		{ConditionSuccess, "failed", false},
		{ConditionFailure, "completed", false},
		{ConditionFailure, "failed", true},
		{ConditionAll, "completed", true},
		{ConditionAll, "failed", true},
		// Skipped runs match nothing: 跳过默认关闭.
		{ConditionAll, "skipped", false},
		{ConditionSuccess, "skipped", false},
	}
	for _, tc := range cases {
		if got := routeMatchesRun(tc.conditions, tc.status); got != tc.want {
			t.Fatalf("routeMatchesRun(%q, %q) = %v, want %v", tc.conditions, tc.status, got, tc.want)
		}
	}
}

func TestTargetAndDedupKeys(t *testing.T) {
	if got := TargetKey(TargetMember, "u1", "", ""); got != "member:u1" {
		t.Fatalf("member key = %q", got)
	}
	if got := TargetKey(TargetGroup, "", "oc_1", ""); got != "group:oc_1" {
		t.Fatalf("group key = %q", got)
	}
	if got := TargetKey(TargetTopic, "", "oc_1", "om_9"); got != "topic:oc_1:om_9" {
		t.Fatalf("topic key = %q", got)
	}
	key := TargetKey(TargetGroup, "", "oc_1", "")
	want := "run:run_1:inst_1:group:oc_1"
	if got := DeliveryDedupKey("run_1", "inst_1", key); got != want {
		t.Fatalf("dedup key = %q, want %q", got, want)
	}
	if got := TestDeliveryDedupKey("x"); got != "test:x" {
		t.Fatalf("test dedup key = %q", got)
	}
}
