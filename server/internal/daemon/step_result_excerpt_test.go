package daemon

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// TestStepResultExcerptBudgetTiers pins the excerpt split across budget
// tiers (contract §4): the tail takes min(1000, budget-200) bytes — errors
// sit at the end — and the head gets the rest; below a 400-byte budget the
// remainder splits evenly. Cuts fall on rune boundaries; budget <= 0
// yields "".
func TestStepResultExcerptBudgetTiers(t *testing.T) {
	t.Parallel()
	var body strings.Builder
	for body.Len() < 4096 {
		body.WriteString("0123456789abcdefghijklmnopqrstuvwxyz")
	}
	result := body.String()
	split := func(excerpt string) (head, tail int) {
		i := strings.Index(excerpt, "\n[... ")
		if i < 0 {
			return -1, -1
		}
		markerEnd := strings.Index(excerpt[i:], "]\n") + i + 2
		return i, len(excerpt) - markerEnd
	}
	for _, tc := range []struct {
		budget             int
		wantHead, wantTail int
	}{
		{0, 0, 0},
		{50, 25, 25},
		{150, 75, 75},
		{300, 150, 150},
		{400, 200, 200},
		{900, 200, 700},
		{1418, 418, 1000},
		{2500, 1500, 1000},
	} {
		excerpt := stepResultExcerpt(result, tc.budget)
		if tc.budget <= 0 {
			if excerpt != "" {
				t.Fatalf("budget %d: want empty excerpt, got %d bytes", tc.budget, len(excerpt))
			}
			continue
		}
		head, tail := split(excerpt)
		if head != tc.wantHead || tail != tc.wantTail {
			t.Fatalf("budget %d: head=%d tail=%d, want %d/%d", tc.budget, head, tail, tc.wantHead, tc.wantTail)
		}
		if !utf8.ValidString(excerpt) {
			t.Fatalf("budget %d: excerpt not valid UTF-8", tc.budget)
		}
	}
	// CJK body: cuts fall back to rune boundaries (3 bytes each); the tail
	// keeps its full ~1000-byte allocation within boundary rounding.
	cjk := strings.Repeat("汉", 2048) // 6144 bytes
	head, tail := split(stepResultExcerpt(cjk, 1418))
	if head%3 != 0 || tail%3 != 0 {
		t.Fatalf("cjk budget 1418: head=%d tail=%d not on rune boundaries", head, tail)
	}
	if tail < 900 || head < 380 {
		t.Fatalf("cjk budget 1418: head=%d tail=%d", head, tail)
	}
}
