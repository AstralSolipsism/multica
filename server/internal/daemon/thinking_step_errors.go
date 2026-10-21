package daemon

import (
	"strings"
	"unicode"
)

// Step error material for adaptive thinking (contract §4, §6): the mod uploads
// raw tool material; this file owns the single normalization and repeat-count
// the daemon's step decisions and sample collection (OL-1019) share.

// NormalizedErrorFeature reduces one step's error text to a stable feature
// key: the first error-looking line with numbers, paths and quoting noise
// collapsed, so the same failure reads the same across steps. Exported for
// OL-1019's sample collection.
func NormalizedErrorFeature(errorText string) string {
	for _, rawLine := range strings.Split(errorText, "\n") {
		if feature := normalizeErrorLine(rawLine); feature != "" {
			return feature
		}
	}
	return ""
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

// Observe folds one step's error text into the repeat count: the count is how
// many consecutive observations, including this one, reported the same
// normalized feature. An error-free step resets it. The returned feature is
// this step's normalized error text ("" when none).
func (t *ErrorFeatureTracker) Observe(errorText string) (feature string, repeats int) {
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
