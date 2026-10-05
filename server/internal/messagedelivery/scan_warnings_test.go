package messagedelivery

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestSourceHorizonWarningIsRateLimitedPerScanner(t *testing.T) {
	var logs bytes.Buffer
	s := New(nil)
	s.Log = slog.New(slog.NewTextHandler(&logs, nil))
	now := time.Unix(3600, 0)
	s.warnSourceHorizon(scannerInboxSource, now, now.Add(-time.Minute))
	if logs.Len() != 0 {
		t.Fatal("healthy horizon warned")
	}
	stable := now.Add(-time.Hour)
	for range 100 {
		s.warnSourceHorizon(scannerInboxSource, now, stable)
	}
	s.warnSourceHorizon(scannerInboxSource, now.Add(sourceHorizonWarningInterval-time.Second), stable)
	if count := strings.Count(logs.String(), "horizon is lagging"); count != 1 {
		t.Fatalf("repeated pinned horizon emitted %d warnings", count)
	}
	s.warnSourceHorizon(scannerCommentSource, now, stable)
	s.warnSourceHorizon(scannerInboxSource, now.Add(sourceHorizonWarningInterval), stable)
	if count := strings.Count(logs.String(), "horizon is lagging"); count != 3 {
		t.Fatalf("independent scanner or next interval lost warning: %d", count)
	}
	if !strings.Contains(logs.String(), "scanner="+scannerInboxSource) || !strings.Contains(logs.String(), "stable_at=") {
		t.Fatalf("warning lacks scan diagnosis: %s", logs.String())
	}
}
