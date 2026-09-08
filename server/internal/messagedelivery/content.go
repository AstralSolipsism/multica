package messagedelivery

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// Content normalization is the module's redaction boundary. A run_only
// task's terminal result JSONB is the daemon's FULL completion callback
// (output, session id, work dir, branch name, ...). Only the final
// `output` string is ever read here; everything else in the payload stays
// unread and unsent (OL-25 acceptance: logs and APIs must not expose
// directories or credentials from TaskResult).

const (
	// noReportBodyText is the placeholder sent when a run_only run
	// completed without an output body ("空 output 显示'无报告正文'").
	noReportBodyText = "(no report body)"

	// runFailureText is the generic public failure line when the run
	// carries no curated reason code. Raw failure_reason strings can
	// embed command output or paths, so only the curated code is shown.
	runFailureText = "The automation run failed."

	// maxOutputRunes caps how much of the final output a delivery
	// carries, bounding the shard plan.
	maxOutputRunes = 40_000

	// shardRunes is the maximum body length of one outgoing message
	// shard. Splits happen on rune boundaries only.
	shardRunes = 3_500

	// maxShards bounds the shard plan; content beyond it is truncated
	// with a marker so one giant report cannot become an unbounded send.
	maxShards = 12
)

// truncatedMarker is appended when the output exceeded the shard budget.
const truncatedMarker = "\n\n…(truncated)"

// extractRunOnlyOutput reads ONLY the final output string from a task
// completion result payload. Everything else the daemon reports (session
// ids, work dirs, branch names) is deliberately not even decoded into a
// named field.
func extractRunOnlyOutput(result []byte) (string, bool) {
	if len(result) == 0 {
		return "", false
	}
	var payload struct {
		Output string `json:"output"`
	}
	if err := json.Unmarshal(result, &payload); err != nil {
		return "", false
	}
	out := strings.TrimSpace(payload.Output)
	if out == "" {
		return "", false
	}
	return truncateRunes(out, maxOutputRunes), true
}

// publicFailureReason reduces a failed run to a publishable reason. The
// curated reason_code (a stable enum from the task failure classifier) is
// safe to show; the raw failure_reason text is not — it can quote agent
// output, paths or commands, none of which belong in an IM message.
func publicFailureReason(reasonCode, failureReason string) string {
	if code := strings.TrimSpace(reasonCode); code != "" {
		return "reason: " + code
	}
	return runFailureText
}

// buildRunOnlyContent renders a run_only result message.
func buildRunOnlyContent(autopilotTitle, runStatus, reasonCode, failureReason, output string, hasOutput, withOutput bool) contentSnapshot {
	snap := contentSnapshot{RunStatus: runStatus}
	var b strings.Builder
	b.WriteString(autopilotTitle)
	switch runStatus {
	case "completed":
		b.WriteString(" — run completed")
	case "failed":
		b.WriteString(" — run failed")
	default:
		b.WriteString(" — run " + runStatus)
	}
	snap.Summary = b.String()

	if runStatus == "failed" {
		b.WriteString("\n")
		b.WriteString(publicFailureReason(reasonCode, failureReason))
		snap.Text = b.String()
		return snap
	}

	// 'with_output' includes the final report; 'summary' stays a digest.
	// Either way an empty output renders the explicit placeholder rather
	// than an empty message.
	if withOutput {
		b.WriteString("\n\n")
		if hasOutput {
			b.WriteString(output)
			snap.HasOutput = true
		} else {
			b.WriteString(noReportBodyText)
		}
	}
	snap.Text = b.String()
	return snap
}

// buildCreateIssueContent renders a create_issue status card. The first
// terminal state ships the status and the task link; the report body is
// never attached because this module has no verified delivery-comment
// anchor for the issue yet (OL-23: "只有明确的交付评论锚点才能附正文").
func buildCreateIssueContent(autopilotTitle, runStatus, issueIdent, issueStatus, appURL string) contentSnapshot {
	snap := contentSnapshot{RunStatus: runStatus}
	var b strings.Builder
	b.WriteString(autopilotTitle)
	switch runStatus {
	case "completed":
		b.WriteString(" — task " + issueIdent + " is " + issueStatus)
	case "failed":
		b.WriteString(" — task " + issueIdent + " was moved to " + issueStatus)
	default:
		b.WriteString(" — task " + issueIdent + " (" + issueStatus + ")")
	}
	snap.Summary = b.String()
	if appURL != "" && issueIdent != "" {
		snap.Link = strings.TrimRight(appURL, "/") + "/issues/" + issueIdent
		b.WriteString("\n")
		b.WriteString(snap.Link)
	}
	snap.Text = b.String()
	return snap
}

// splitShards splits the frozen text into the stable shard plan. Pure
// function of the input: the same text always yields the same shard count
// and boundaries, so a retry cannot renumber or re-split a message. Splits
// fall on rune boundaries; UTF-8 sequences are never cut.
func splitShards(text string) []string {
	if text == "" {
		return []string{""}
	}
	if utf8.RuneCountInString(text) <= shardRunes {
		return []string{text}
	}

	shards := make([]string, 0, maxShards)
	remaining := text
	for runeCount := utf8.RuneCountInString(remaining); runeCount > 0; runeCount = utf8.RuneCountInString(remaining) {
		if len(shards) == maxShards-1 {
			// Last allowed shard: take everything left, truncated to fit.
			shards = append(shards, truncateRunes(remaining, shardRunes)+truncatedMarker)
			return shards
		}
		cut := shardAtRune(remaining, shardRunes)
		shards = append(shards, strings.TrimRight(remaining[:cut], "\n"))
		remaining = remaining[cut:]
	}
	return shards
}

// shardAtRune returns the byte offset of the n-th rune boundary.
func shardAtRune(s string, n int) int {
	count := 0
	for idx := range s {
		if count == n {
			return idx
		}
		count++
	}
	return len(s)
}

// truncateRunes cuts s to at most n runes without splitting a UTF-8
// sequence.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return s[:shardAtRune(s, n)]
}
