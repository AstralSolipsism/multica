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

func TestErrorFeatureTrackerCountsWindowedRepeats(t *testing.T) {
	t.Parallel()
	const race = "WARNING: DATA RACE\nRead at scheduler.go:178 by goroutine 41"
	const other = "exec: bash: exit status 3"
	type observation struct {
		text    string
		omitted bool
		want    int
	}
	cases := []struct {
		name  string
		steps []observation
	}{
		{
			name: "consecutive and normalized repeats",
			steps: []observation{
				{race, false, 1}, {race, false, 2},
				{other, false, 1}, {other, false, 2}, {"exec: bash: exit status 7", false, 3},
			},
		},
		{
			name: "error-free step returns zero and preserves history",
			steps: []observation{
				{"", false, 0}, {race, false, 1}, {"", false, 0}, {race, false, 2},
			},
		},
		{
			name: "different errors preserve each others history",
			steps: []observation{
				{race, false, 1}, {other, false, 1}, {race, false, 2}, {other, false, 2},
			},
		},
		{
			name: "oldest of six steps is included",
			steps: []observation{
				{race, false, 1}, {"", false, 0}, {"", false, 0},
				{"", false, 0}, {"", false, 0}, {race, false, 2},
			},
		},
		{
			name: "error-free steps expire old errors",
			steps: []observation{
				{race, false, 1}, {"", false, 0}, {"", false, 0},
				{"", false, 0}, {"", false, 0}, {"", false, 0}, {race, false, 1},
			},
		},
		{
			name: "different errors expire old errors",
			steps: []observation{
				{race, false, 1}, {other, false, 1}, {other, false, 2},
				{other, false, 3}, {other, false, 4}, {other, false, 5}, {race, false, 1},
			},
		},
		{
			name: "count never exceeds six steps",
			steps: []observation{
				{race, false, 1}, {race, false, 2}, {race, false, 3}, {race, false, 4},
				{race, false, 5}, {race, false, 6}, {race, false, 6}, {race, false, 6},
			},
		},
		{
			name: "omitted steps preserve the previous count",
			steps: []observation{
				{"", true, 0}, {race, false, 1}, {race, true, 1}, {other, true, 1},
				{race, false, 2}, {"", false, 0}, {"", true, 0}, {race, false, 3},
			},
		},
		{
			name: "omitted steps do not consume window positions",
			steps: []observation{
				{race, false, 1}, {"", false, 0}, {"", false, 0},
				{"", false, 0}, {"", false, 0},
				{"", true, 0}, {"", true, 0}, {"", true, 0},
				{"", true, 0}, {"", true, 0}, {"", true, 0},
				{race, false, 2}, {race, false, 2},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var tracker ErrorFeatureTracker
			for i, step := range tc.steps {
				wantFeature := NormalizedErrorFeature(step.text)
				if step.omitted {
					wantFeature = "[omitted]"
				}
				feature, repeats := tracker.Observe(step.text, step.omitted)
				if feature != wantFeature || repeats != step.want {
					t.Fatalf("observation %d: feature=%q repeats=%d, want %q/%d", i+1, feature, repeats, wantFeature, step.want)
				}
			}
		})
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
