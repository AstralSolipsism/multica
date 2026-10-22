package agent

import (
	"encoding/json"
	"fmt"
)

// Labrastro per-step effort (OL-992 S3-1, contract §6/§7): the Claude side of
// the labrastro-effort mod's output. The daemon installs the mod; this file
// takes its ui_log effect records out of the stream-json transcript, reports
// system/init's per-turn effort state, and turns each record into the step
// metadata that tags the messages that follow it.

// EffortEffect is one effect record: the level that took effect at a step,
// with the decision that chose it or the fallback reason. Level is the level
// actually in effect (the previous step's level on a fallback, "" when no
// level was ever injected and none arrived).
type EffortEffect struct {
	Step          int                `json:"step"`
	Level         string             `json:"level"`
	Confidence    float64            `json:"confidence,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
	LatencyMS     int64              `json:"latency_ms,omitempty"`
	Source        string             `json:"source,omitempty"`
	Fallback      string             `json:"fallback,omitempty"`
}

const effortEffectMaxBytes = 16 << 10

// claudeSystemExtra carries the effort-related fields of system/init and
// system/per_turn_effort_changed frames.
type claudeSystemExtra struct {
	PerTurnEffortActive *bool `json:"per_turn_effort_active"`
}

// parseEffortEffect checks an effect record's envelope (version 1) and
// returns it. Anything else is an error the caller logs and drops.
func parseEffortEffect(text string) (EffortEffect, error) {
	if len(text) > effortEffectMaxBytes {
		return EffortEffect{}, fmt.Errorf("effect record of %d bytes exceeds %d", len(text), effortEffectMaxBytes)
	}
	var envelope struct {
		Effort int `json:"effort"`
		EffortEffect
	}
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		return EffortEffect{}, fmt.Errorf("effect record is not a JSON object: %w", err)
	}
	if envelope.Effort != 1 {
		return EffortEffect{}, fmt.Errorf("unsupported effect record version %d", envelope.Effort)
	}
	if envelope.Step < 1 {
		return EffortEffect{}, fmt.Errorf("effect record step %d is not 1-based", envelope.Step)
	}
	return envelope.EffortEffect, nil
}

// consumeEffortLog reports whether line is a ui_log the labrastro-effort mod
// wrote. Such a line is never a task message: a well-formed effect record
// goes to opts.OnEffortEffect and anything else is dropped with a log line.
// Every other line is left to the caller.
func (b *claudeBackend) consumeEffortLog(msg claudeSDKMessage, line string, opts ExecOptions) bool {
	if msg.Type != "system" || msg.Subtype != "ui_log" {
		return false
	}
	var uiLog claudeUILog
	if err := json.Unmarshal([]byte(line), &uiLog); err != nil || uiLog.Plugin != ClaudeEffortPlugin {
		return false
	}
	effect, err := parseEffortEffect(uiLog.Text)
	if err != nil {
		b.cfg.Logger.Warn("effort: dropping an unreadable effect record from the mod", "error", err)
		return true
	}
	if opts.OnEffortEffect != nil {
		opts.OnEffortEffect(effect)
	}
	return true
}
