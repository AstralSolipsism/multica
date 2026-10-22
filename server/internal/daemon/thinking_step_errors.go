package daemon

import (
	"strconv"
	"strings"
	"unicode"

	"github.com/multica-ai/multica/server/pkg/redact"
)

// Step error material for adaptive thinking (contract §4, §6): the mod uploads
// raw tool material; this file owns the single normalization and repeat-count
// the daemon's step decisions and sample collection (OL-1019) share.

// NormalizedErrorFeature reduces one step's error text to a stable feature
// key: the first error-looking line with numbers, paths and quoting noise
// collapsed, so the same failure reads the same across steps. Two kinds of
// lines name no failure and are skipped: Claude Code's Bash header
// "Exit code N" (ParseExitCode reads it) and Go compiler package headers
// "# pkg/path" (the actual error follows on the next line). Exported for
// OL-1019's sample collection. The input is redacted here, before
// normalization: rewriting URLs and colons first would break the redactor's
// pattern match and leak the credential into the feature (#31).
func NormalizedErrorFeature(errorText string) string {
	errorText = redact.Text(errorText)
	for _, rawLine := range strings.Split(errorText, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || isExitCodeLine(line) || isPackageHeaderLine(line) {
			continue
		}
		if feature := normalizeErrorLine(line); feature != "" {
			return feature
		}
	}
	return ""
}

// isPackageHeaderLine matches Go compiler/test package headers, the line a
// tool prints before the actual errors of that package ("# ./internal/app",
// "FAIL\tgithub.com/x/y [build failed]"). Such a line is a group name, not a
// failure: two different compile errors in one package would otherwise share
// one feature and count as repeats of the same error. A "--- FAIL:" test
// line does not start with FAIL, so it still names its failure.
func isPackageHeaderLine(line string) bool {
	return strings.HasPrefix(line, "# ") || strings.HasPrefix(line, "FAIL\t") || strings.HasPrefix(line, "FAIL ")
}

// exitCodePrefix is Claude Code's Bash failure header ("Exit code 127").
const exitCodePrefix = "Exit code "

// ParseExitCode reads the exit code a "Exit code N" line carries, or -1 when
// the error text carries none.
func ParseExitCode(errorText string) int {
	for _, rawLine := range strings.Split(errorText, "\n") {
		line := strings.TrimSpace(rawLine)
		if !isExitCodeLine(line) {
			continue
		}
		if code, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, exitCodePrefix))); err == nil {
			return code
		}
	}
	return -1
}

func isExitCodeLine(line string) bool {
	if !strings.HasPrefix(line, exitCodePrefix) {
		return false
	}
	_, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, exitCodePrefix)))
	return err == nil
}

// normalizeErrorLine keeps letters and words, collapses digit runs (line
// numbers, exit codes, addresses) to one "0" and path-like separators to "_",
// drops quoting noise and collapses whitespace.
func normalizeErrorLine(line string) string {
	var b strings.Builder
	inDigits := false
	for _, r := range line {
		switch {
		case unicode.IsDigit(r):
			if !inDigits {
				b.WriteByte('0')
				inDigits = true
			}
		case r == '/' || r == '\\' || r == '.' || r == ':':
			if b.Len() > 0 && !strings.HasSuffix(b.String(), "_") {
				b.WriteByte('_')
			}
		case r == '"' || r == '\'' || r == '`':
			// Quoting noise.
		case unicode.IsSpace(r):
			inDigits = false
			if b.Len() > 0 && !strings.HasSuffix(b.String(), " ") {
				b.WriteByte(' ')
			}
		default:
			b.WriteRune(unicode.ToLower(r))
			inDigits = false
		}
	}
	return strings.TrimSpace(strings.Trim(b.String(), "_ "))
}

// ErrorFeatureTracker keeps a run's latest normalized error feature and how
// many consecutive steps reported it. One per run; requests for one run
// arrive serialized (one per main-thread step).
type ErrorFeatureTracker struct {
	feature string
	repeats int
}

// omittedErrorFeature is the feature recorded when the mod omitted the
// error text whole (over the byte limit): no partial body ever ships (#32).
const omittedErrorFeature = "[omitted]"

// Observe folds one step's error text into the repeat count: the count is how
// many consecutive observations, including this one, reported the same
// normalized feature. An error-free step resets it. The returned feature is
// this step's normalized error text ("" when none). An omitted error text
// (mod-side whole-field omission) records the "[omitted]" feature and
// neither advances nor resets the repeat count: there is no raw text to
// normalize (#32).
func (t *ErrorFeatureTracker) Observe(errorText string, omitted bool) (feature string, repeats int) {
	if omitted {
		return omittedErrorFeature, t.repeats
	}
	feature = NormalizedErrorFeature(errorText)
	switch {
	case feature == "":
		t.feature = ""
		t.repeats = 0
	case feature == t.feature:
		t.repeats++
	default:
		t.feature = feature
		t.repeats = 1
	}
	return feature, t.repeats
}
