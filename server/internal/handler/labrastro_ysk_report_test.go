package handler

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestLabrastroYSKParseReportEnvelope(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		valid      bool
	}{
		{"light", `{"ysk":1,"kind":"light","step":1}`, true},
		{"heads up", `{"ysk":1,"kind":"heads_up","step":6}`, true},
		{"trailing whitespace", "{\"ysk\":1,\"kind\":\"light\",\"step\":1}\n", true},
		{"empty", "", false},
		{"null", "null", false},
		{"malformed", "{", false},
		{"wrong version", `{"ysk":2,"kind":"light","step":1}`, false},
		{"missing version", `{"kind":"light","step":1}`, false},
		{"wrong kind", `{"ysk":1,"kind":"other","step":1}`, false},
		{"missing kind", `{"ysk":1,"step":1}`, false},
		{"missing step", `{"ysk":1,"kind":"light"}`, false},
		{"zero step", `{"ysk":1,"kind":"light","step":0}`, false},
		{"negative step", `{"ysk":1,"kind":"light","step":-1}`, false},
		{"fractional step", `{"ysk":1,"kind":"light","step":1.5}`, false},
		{"extra value", `{"ysk":1,"kind":"light","step":1} {}`, false},
		{"trailing garbage", `{"ysk":1,"kind":"light","step":1} x`, false},
		{"invalid tips type", `{"ysk":1,"kind":"light","step":1,"tips":{}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			report, rejected := labrastroYSKParseReport(strings.NewReader(tc.body))
			if (report != nil) != tc.valid || (len(rejected) == 0) != tc.valid {
				t.Fatalf("valid=%v report=%+v rejected=%v", tc.valid, report, rejected)
			}
		})
	}
}

func TestLabrastroYSKParseReportFiltersTips(t *testing.T) {
	type tipCase struct {
		name, kind string
		tip        labrastroYSKInputTip
		valid      bool
	}
	cases := []tipCase{
		{"light", "light", yskInput("valid"), true},
		{"heads up", "heads_up", labrastroYSKInputTip{Tag: "heads_up", Line: "check", Title: "title", Explanation: "explain"}, true},
		{"unknown tag", "light", labrastroYSKInputTip{Tag: "other", Line: "check", Title: "title", Explanation: "explain"}, false},
		{"light tag in heads up", "heads_up", yskInput("wrong kind"), false},
		{"heads up tag in light", "light", labrastroYSKInputTip{Tag: "heads_up", Line: "check", Title: "title", Explanation: "explain"}, false},
	}
	for _, field := range []string{"line", "title", "explanation"} {
		limit := map[string]int{"line": 40, "title": 12, "explanation": 200}[field]
		for _, value := range []struct {
			name, text string
			valid      bool
		}{
			{"empty", "", false}, {"whitespace", " \t\u3000", false},
			{"at limit", strings.Repeat("中", limit), true}, {"over limit", strings.Repeat("中", limit+1), false},
			{"NUL", "before\x00after", false},
			{"LF", "before\nafter", field == "explanation"}, {"CR", "before\rafter", field == "explanation"},
		} {
			tip := yskInput("valid")
			switch field {
			case "line":
				tip.Line = value.text
			case "title":
				tip.Title = value.text
			case "explanation":
				tip.Explanation = value.text
			}
			cases = append(cases, tipCase{field + "/" + value.name, "light", tip, value.valid})
		}
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			first, last := yskInput("first"), yskInput("last")
			if tc.kind == "heads_up" {
				first.Tag, last.Tag = "heads_up", "heads_up"
			}
			body, err := json.Marshal(labrastroYSKReport{Version: 1, Kind: tc.kind, Step: 1, Tips: []labrastroYSKInputTip{first, tc.tip, last}})
			if err != nil {
				t.Fatal(err)
			}
			report, rejected := labrastroYSKParseReport(strings.NewReader(string(body)))
			want := 2
			if tc.valid {
				want++
			}
			if report == nil || len(report.Tips) != want || len(rejected) != 3-want {
				t.Fatalf("valid=%v report=%+v rejected=%v", tc.valid, report, rejected)
			}
			if report.Tips[0] != first || report.Tips[want-1] != last || (tc.valid && report.Tips[1] != tc.tip) {
				t.Fatalf("changed valid entries: %+v", report.Tips)
			}
		})
	}
}

func TestLabrastroYSKParseReportFiltersOverturns(t *testing.T) {
	id := uuid.NewString()
	for _, tc := range []struct {
		name, kind, id, reason string
		valid                  bool
	}{
		{"light", "light", id, "new decision", true},
		{"heads up cannot overturn", "heads_up", id, "new decision", false},
		{"bad UUID", "light", "invalid", "new decision", false},
		{"missing reason", "light", id, "", false},
		{"whitespace reason", "light", id, " \t\n\u3000", false},
		{"NUL reason", "light", id, "before\x00after", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			item := labrastroYSKInputOverturn{TipID: tc.id, Reason: tc.reason}
			body, err := json.Marshal(labrastroYSKReport{Version: 1, Kind: tc.kind, Step: 1, Overturned: []labrastroYSKInputOverturn{item}})
			if err != nil {
				t.Fatal(err)
			}
			report, rejected := labrastroYSKParseReport(strings.NewReader(string(body)))
			if report == nil || (len(report.Overturned) == 1) != tc.valid || (len(rejected) == 0) != tc.valid {
				t.Fatalf("valid=%v report=%+v rejected=%v", tc.valid, report, rejected)
			}
			if tc.valid && report.Overturned[0] != item {
				t.Fatalf("changed valid overturn: %+v", report.Overturned[0])
			}
		})
	}
}
