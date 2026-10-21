package daemon

import (
	"strings"
	"testing"
)

func TestNormalizedErrorFeature(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"compile error keeps its shape", "scheduler.go:4:2: fmt imported and not used", "scheduler_go_0_ fmt imported and not used"},
		{"line numbers collapse across lines", "main.go:12: undefined: Foo\nsecond line", "main_go_0_ undefined_ foo"},
		{"addresses collapse", "dial tcp 127.0.0.1:5432: connect: connection refused", "dial tcp 0_ connect_ connection refused"},
		{"quotes dropped", `exec: "bash": exit status 127`, "exec_ bash_ exit status 0"},
		{"empty stays empty", "", ""},
		{"whitespace only stays empty", "\n \n", ""},
	}
	for _, tc := range cases {
		if got := NormalizedErrorFeature(tc.in); got != tc.want {
			t.Errorf("%s: NormalizedErrorFeature(%q) = %q, want %q", tc.name, tc.in, got, tc.want)
		}
	}
}

func TestErrorFeatureTrackerCountsConsecutiveRepeats(t *testing.T) {
	t.Parallel()
	var tracker ErrorFeatureTracker
	const race = "WARNING: DATA RACE\nRead at scheduler.go:178 by goroutine 41"
	const other = "exec: bash: exit status 3"

	if feature, repeats := tracker.Observe(race); feature == "" || repeats != 1 {
		t.Fatalf("first race observation: feature=%q repeats=%d, want feature!=\"\" repeats=1", feature, repeats)
	}
	if _, repeats := tracker.Observe(race); repeats != 2 {
		t.Fatalf("second identical race: repeats=%d, want 2", repeats)
	}
	// A different error starts a new run.
	if _, repeats := tracker.Observe(other); repeats != 1 {
		t.Fatalf("different error: repeats=%d, want 1", repeats)
	}
	if _, repeats := tracker.Observe(other); repeats != 2 {
		t.Fatalf("second identical other: repeats=%d, want 2", repeats)
	}
	// Same error modulo a number still counts as the same feature.
	if _, repeats := tracker.Observe("exec: bash: exit status 7"); repeats != 3 {
		t.Fatalf("noise-varied same error: repeats=%d, want 3", repeats)
	}
	// An error-free step resets.
	if feature, repeats := tracker.Observe(""); feature != "" || repeats != 0 {
		t.Fatalf("error-free step: feature=%q repeats=%d, want \"\"/0", feature, repeats)
	}
	if _, repeats := tracker.Observe(other); repeats != 1 {
		t.Fatalf("post-reset error: repeats=%d, want 1", repeats)
	}
}

func TestNormalizedErrorFeatureSkipsGoPackageHeaders(t *testing.T) {
	t.Parallel()
	// Real `go build` shape: package header, then the error.
	build := "# example.com/app/internal/app\n./main.go:12:5: undefined: Foo"
	if got := NormalizedErrorFeature(build); got != "main_go_0_ undefined_ foo" {
		t.Fatalf("go build: %q", got)
	}
	// Two different compile errors in the same package keep distinct features.
	first := NormalizedErrorFeature("# example.com/app/internal/app\n./main.go:12:5: undefined: Foo")
	second := NormalizedErrorFeature("# example.com/app/internal/app\n./main.go:20:2: declared and not used: x")
	if first == second {
		t.Fatalf("distinct compile errors share a feature: %q", first)
	}
	// `go test` failure shape: the test name line names the failure.
	test := "--- FAIL: TestX (0.00s)\n    x_test.go:9: assertion failed"
	if got := NormalizedErrorFeature(test); !strings.Contains(got, "testx") {
		t.Fatalf("go test: %q", got)
	}
	if got := NormalizedErrorFeature("FAIL\texample.com/app/pkg [build failed]\n./a.go:1:1: expected ';', found '}'"); !strings.Contains(got, "expected") {
		t.Fatalf("FAIL trailer: %q", got)
	}
}
