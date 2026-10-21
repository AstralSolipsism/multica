package agent

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Labrastro "You should know" (OL-187): the Claude side of the tips the
// labrastro-ysk mod writes. The daemon installs the mod; this file gates it on
// the CLI version and takes its output out of the stream-json transcript.

const (
	// ClaudeYouShouldKnowMinVersion is the first Claude Code release whose mod
	// API has everything labrastro-ysk calls ($.model.fork, turn.step).
	ClaudeYouShouldKnowMinVersion = "2.1.287"
	// ClaudeYouShouldKnowPlugin is the mod's manifest name. Claude Code stamps
	// it on every ui_log line the mod writes.
	ClaudeYouShouldKnowPlugin = "labrastro-ysk"
	// ClaudePerTurnEffortMinVersion is the first Claude Code release whose
	// turn.step rewrites effort end-to-end (OL-1000 verified 2.1.304; builds
	// since 2.1.269 can rewrite but were never verified in between).
	ClaudePerTurnEffortMinVersion = "2.1.304"
	// ClaudeEffortPlugin is the labrastro-effort mod's manifest name. Claude
	// Code stamps it on every ui_log line the mod writes.
	ClaudeEffortPlugin = "labrastro-effort"

	// youShouldKnowMaxBatchBytes bounds one batch. A version-1 batch holds a
	// handful of short tips; anything near this size is not one.
	youShouldKnowMaxBatchBytes = 64 << 10
)

// SupportsClaudeYouShouldKnow reports whether this Claude Code version can run
// the labrastro-ysk mod. An unreadable version is treated as unsupported.
func SupportsClaudeYouShouldKnow(version string) bool {
	detected, err := parseSemver(version)
	floor, _ := parseSemver(ClaudeYouShouldKnowMinVersion)
	return err == nil && !detected.lessThan(floor)
}

// SupportsClaudePerTurnEffort reports whether this Claude Code version's
// turn.step can rewrite per-step effort. An unreadable version is treated as
// unsupported.
func SupportsClaudePerTurnEffort(version string) bool {
	detected, err := parseSemver(version)
	floor, _ := parseSemver(ClaudePerTurnEffortMinVersion)
	return err == nil && !detected.lessThan(floor)
}

// claudeUILog is the part of a `system/ui_log` stream-json line that names
// the plugin and carries its text.
type claudeUILog struct {
	Plugin string `json:"plugin"`
	Text   string `json:"text"`
}

// consumeYouShouldKnowLog reports whether line is a ui_log the labrastro-ysk
// mod wrote. Such a line is never a task message: a well-formed batch goes to
// opts.OnYouShouldKnow and anything else is dropped with a log line. Every
// other line is left to the caller.
func (b *claudeBackend) consumeYouShouldKnowLog(msg claudeSDKMessage, line string, opts ExecOptions) bool {
	if msg.Type != "system" || msg.Subtype != "ui_log" {
		return false
	}
	var uiLog claudeUILog
	if err := json.Unmarshal([]byte(line), &uiLog); err != nil || uiLog.Plugin != ClaudeYouShouldKnowPlugin {
		return false
	}
	batch, err := youShouldKnowBatch(uiLog.Text)
	if err != nil {
		b.cfg.Logger.Warn("you-should-know: dropping an unreadable batch from the mod", "error", err)
		return true
	}
	if opts.OnYouShouldKnow != nil {
		opts.OnYouShouldKnow(batch)
	}
	return true
}

// youShouldKnowBatch checks a batch's envelope (OL-187 section 13 D, version
// 1) and returns its text unchanged. The tips themselves are the server's to
// validate.
func youShouldKnowBatch(text string) (json.RawMessage, error) {
	if len(text) > youShouldKnowMaxBatchBytes {
		return nil, fmt.Errorf("batch of %d bytes exceeds %d", len(text), youShouldKnowMaxBatchBytes)
	}
	var envelope struct {
		YSK  int    `json:"ysk"`
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		return nil, fmt.Errorf("batch is not a JSON object: %w", err)
	}
	if envelope.YSK != 1 {
		return nil, fmt.Errorf("unsupported batch version %d", envelope.YSK)
	}
	if envelope.Kind != "light" && envelope.Kind != "heads_up" {
		return nil, errors.New("batch kind is neither light nor heads_up")
	}
	return json.RawMessage(text), nil
}
