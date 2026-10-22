// Package jevsample collects adaptive-thinking decision samples as local
// JSONL files (OL-1013 S1-2). Collection is opt-in via
// MULTICA_JEV_COLLECT_DIR and strictly best-effort: records flow through a
// bounded queue to one writer goroutine, and any failure (queue full, write
// error, size cap) drops the record with a rate-limited warning instead of
// touching the run path.
//
// File layout mirrors terminal_report_queue.go: directory 0700, files 0600,
// and the directory must not be a symlink. One file per daemon per UTC day,
// decisions-<daemon_id>-<YYYYMMDD>.jsonl, so daemons sharing a directory
// never write the same file.
//
// Records carry exactly what was sent to the decision source (state and
// questions, byte-identical to the wire body) plus local provenance. No
// other text is recorded and nothing leaves the machine.
package jevsample

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	// DefaultMaxMB is the default MULTICA_JEV_COLLECT_MAX_MB value.
	DefaultMaxMB = 1024

	dateFormat = "20060102"

	// queueDepth bounds pending records; the enqueue path never blocks,
	// it drops instead.
	queueDepth = 256

	// warnInterval throttles repeated warnings for the same condition.
	warnInterval = time.Minute
)

// Collector writes decision and outcome samples. A nil Collector is the
// disabled state: every method is a no-op, so callers never need a nil
// check. Safe for concurrent use.
type Collector struct {
	dir      string
	daemonID string
	maxBytes int64
	log      *slog.Logger

	queue chan pending
	done  chan struct{}

	now func() time.Time

	sendMu   sync.RWMutex // guards queue sends against Close
	closed   bool
	mu       sync.Mutex
	lastWarn map[string]time.Time
}

type pending struct {
	ts   time.Time
	line []byte
}

type decisionRecord struct {
	V             int                `json:"v"`
	Type          string             `json:"type"`
	ID            string             `json:"id"`
	TS            string             `json:"ts"`
	DaemonID      string             `json:"daemon_id"`
	TaskID        string             `json:"task_id"`
	Scope         string             `json:"scope"`
	Step          *int               `json:"step"`
	Provider      string             `json:"provider"`
	Model         string             `json:"model"`
	State         any                `json:"state"`
	Questions     json.RawMessage    `json:"questions"`
	Source        string             `json:"source"`
	Choice        string             `json:"choice"`
	Confidence    float64            `json:"confidence"`
	Probabilities map[string]float64 `json:"probabilities"`
	LatencyMS     int64              `json:"latency_ms"`
}

type outcomeRecord struct {
	V             int    `json:"v"`
	Type          string `json:"type"`
	DecisionID    string `json:"decision_id"`
	TS            string `json:"ts"`
	Scope         string `json:"scope"`
	Status        string `json:"status"`
	FailureReason string `json:"failure_reason"`
	ToolCalls     int64  `json:"tool_calls"`
	OutcomeOK     bool   `json:"outcome_ok"`
}

// Decision is one successful decision to sample. State and Questions must
// be exactly what was sent to the source; the collector adds no text of its
// own. Step counts from 1 at step scope; zero renders as null (run scope).
type Decision struct {
	TaskID, Scope   string
	Step            int
	Provider, Model string
	State           any
	Questions       json.RawMessage
	Source, Choice  string
	Confidence      float64
	Probabilities   map[string]float64
	LatencyMS       int64
}

// Outcome is the run-level result signal paired with a decision sample via
// DecisionID.
type Outcome struct {
	DecisionID    string
	Status        string
	FailureReason string
	ToolCalls     int64
}

// StepOutcome contains only derived signals, never tool inputs, outputs or
// error text. Nil fields encode unknown observations as JSON null; an empty
// Tools slice and an empty ErrorSig mean observed absence, not missing data.
type StepOutcome struct {
	DecisionID        string   `json:"decision_id"`
	Tools             []string `json:"tools"`
	ActionKind        *string  `json:"action_kind"`
	OutcomeOK         *bool    `json:"outcome_ok"`
	ErrorSig          *string  `json:"error_sig"`
	PrevActionKind    *string  `json:"prev_action_kind"`
	PrevOutcomeOK     *bool    `json:"prev_outcome_ok"`
	NextOutcomeOK     *bool    `json:"next_outcome_ok"`
	RepeatedErrorNext *bool    `json:"repeated_error_next"`
}

type stepOutcomeRecord struct {
	V     int    `json:"v"`
	Type  string `json:"type"`
	TS    string `json:"ts"`
	Scope string `json:"scope"`
	StepOutcome
}

// New returns a collector writing under dir, or nil when dir is empty
// (collection fully disabled: no directory is created, nothing is opened).
// maxBytes <= 0 means no size cap. Callers should pass LoadConfig's value,
// which rejects non-positive MULTICA_JEV_COLLECT_MAX_MB.
func New(dir, daemonID string, maxBytes int64, log *slog.Logger) *Collector {
	if dir == "" {
		return nil
	}
	if log == nil {
		log = slog.Default()
	}
	c := &Collector{
		dir:      dir,
		daemonID: daemonID,
		maxBytes: maxBytes,
		log:      log,
		queue:    make(chan pending, queueDepth),
		done:     make(chan struct{}),
		lastWarn: make(map[string]time.Time),
		now:      time.Now,
	}
	go c.run()
	return c
}

// Decision enqueues one decision sample and returns its id for later
// outcome pairing. The id is returned even if the record is later dropped:
// collection is best-effort and callers must not depend on the write.
func (c *Collector) Decision(d Decision) string {
	if c == nil {
		return ""
	}
	id := uuid.NewString()
	ts := c.now()
	step := (*int)(nil)
	if d.Step > 0 {
		s := d.Step
		step = &s
	}
	if d.Probabilities == nil {
		d.Probabilities = map[string]float64{}
	}
	line, err := json.Marshal(decisionRecord{
		V: 1, Type: "decision", ID: id, TS: ts.UTC().Format(time.RFC3339), DaemonID: c.daemonID,
		TaskID: d.TaskID, Scope: d.Scope, Step: step, Provider: d.Provider, Model: d.Model,
		State: d.State, Questions: d.Questions,
		Source: d.Source, Choice: d.Choice, Confidence: d.Confidence,
		Probabilities: d.Probabilities, LatencyMS: d.LatencyMS,
	})
	if err != nil {
		c.warn("encode decision", err)
		return id
	}
	c.enqueue(pending{ts: ts, line: line})
	return id
}

// Outcome enqueues the run-level outcome paired with a decision sample.
func (c *Collector) Outcome(o Outcome) {
	if c == nil || o.DecisionID == "" {
		return
	}
	line, err := json.Marshal(outcomeRecord{
		V: 1, Type: "outcome", DecisionID: o.DecisionID, TS: c.now().UTC().Format(time.RFC3339),
		Scope: "run", Status: o.Status, FailureReason: o.FailureReason,
		ToolCalls: o.ToolCalls, OutcomeOK: o.Status == "completed",
	})
	if err != nil {
		c.warn("encode outcome", err)
		return
	}
	c.enqueue(pending{ts: c.now(), line: line})
}

// StepOutcome uses the same bounded queue, permissions, rotation and size cap
// as decisions and run outcomes. A missing decision never produces an outcome.
func (c *Collector) StepOutcome(o StepOutcome) {
	if c == nil || o.DecisionID == "" {
		return
	}
	ts := c.now()
	line, err := json.Marshal(stepOutcomeRecord{
		V: 1, Type: "outcome", TS: ts.UTC().Format(time.RFC3339), Scope: "step", StepOutcome: o,
	})
	if err != nil {
		c.warn("encode step outcome", err)
		return
	}
	c.enqueue(pending{ts: ts, line: line})
}

// Close drains the queue and stops the writer goroutine. Safe to call
// concurrently with in-flight Decision/Outcome calls (they drop after close).
func (c *Collector) Close() {
	if c == nil {
		return
	}
	c.sendMu.Lock()
	c.closed = true
	c.sendMu.Unlock()
	close(c.queue)
	<-c.done
}

func (c *Collector) enqueue(p pending) {
	c.sendMu.RLock()
	defer c.sendMu.RUnlock()
	if c.closed {
		return
	}
	select {
	case c.queue <- p:
	default:
		c.warn("queue full", nil)
	}
}

// warn is rate-limited per reason so a persistent failure (unwritable
// directory, stuck disk) cannot flood the log on every record.
func (c *Collector) warn(reason string, err error) {
	c.mu.Lock()
	if time.Since(c.lastWarn[reason]) < warnInterval {
		c.mu.Unlock()
		return
	}
	c.lastWarn[reason] = time.Now()
	c.mu.Unlock()
	if err != nil {
		c.log.Warn("jev sample collection: "+reason+"; dropping record", "dir", c.dir, "error", err)
		return
	}
	c.log.Warn("jev sample collection: "+reason+"; dropping record", "dir", c.dir)
}

// run is the single writer goroutine. Files rotate per UTC date taken from
// each record's timestamp, so a record is always appended to the file of
// the day it was decided on.
func (c *Collector) run() {
	defer close(c.done)
	var (
		openDay   string
		file      *os.File
		stoppedOn string // UTC day that hit the cap; all further records that day are refused
		warned    bool
	)
	for p := range c.queue {
		day := p.ts.UTC().Format(dateFormat)
		if file != nil && day != openDay {
			_ = file.Close()
			file = nil
		}
		// Sticky per UTC day: once a day's writes cross the cap, every
		// further record that day is refused regardless of size — letting an
		// outcome through after its decision was dropped would leave half
		// pairs for training. The next day's first record re-checks
		// sizeOnDisk(), so deleting files resumes collection.
		if day == stoppedOn {
			continue
		}
		if c.maxBytes > 0 && c.sizeOnDisk()+int64(len(p.line))+1 > c.maxBytes {
			stoppedOn = day
			if !warned {
				// Warn once per collector lifetime (§10.3: 停止写入并告警一次),
				// not once per day — day rotation must not turn one cap
				// event into a daily warning.
				warned = true
				c.log.Warn("jev sample collection: size cap reached; stopping writes",
					"dir", c.dir, "max_bytes", c.maxBytes)
			}
			continue
		}
		if file == nil {
			file = c.open(day)
			if file == nil {
				continue
			}
			openDay = day
		}
		if _, err := file.Write(append(p.line, '\n')); err != nil {
			c.warn("write", err)
			_ = file.Close()
			file = nil
		}
	}
	if file != nil {
		_ = file.Close()
	}
}

// sizeOnDisk sums this daemon's existing sample files against the cap.
func (c *Collector) sizeOnDisk() int64 {
	var used int64
	if matches, err := filepath.Glob(filepath.Join(c.dir, "decisions-"+c.daemonID+"-*.jsonl")); err == nil {
		for _, match := range matches {
			if info, err := os.Stat(match); err == nil && !info.IsDir() {
				used += info.Size()
			}
		}
	}
	return used
}

// open ensures the directory and opens (creating if needed) today's file.
// Callers have already checked the size cap.
func (c *Collector) open(day string) *os.File {
	if err := c.ensureDir(); err != nil {
		c.warn("prepare directory", err)
		return nil
	}
	path := filepath.Join(c.dir, fmt.Sprintf("decisions-%s-%s.jsonl", c.daemonID, day))
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		c.warn("open file", err)
		return nil
	}
	// Tighten a pre-existing file as well.
	_ = file.Chmod(0o600)
	return file
}

func (c *Collector) ensureDir() error {
	if err := os.MkdirAll(c.dir, 0o700); err != nil {
		return err
	}
	info, err := os.Lstat(c.dir)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return fmt.Errorf("sample directory is not a real directory: %s", c.dir)
	}
	return os.Chmod(c.dir, 0o700)
}
