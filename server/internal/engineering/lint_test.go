package engineering

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func lintFixture(t *testing.T) []LintPage {
	t.Helper()
	var pages []LintPage
	for _, slug := range []string{"architecture", "order-service", "domain_rules"} {
		raw, err := os.ReadFile("testdata/lint/valid/" + slug + ".md")
		if err != nil {
			t.Fatal(err)
		}
		_, body, _ := strings.Cut(string(raw)[4:], "\n---\n\n")
		p := LintPage{WikiPageContent: WikiPageContent{Slug: slug, Title: slug, Content: body}}
		if slug == "order-service" {
			p.Parent = "architecture"
		}
		pages = append(pages, p)
	}
	return pages
}

func lintHas(result LintResult, code string) bool {
	for _, d := range result.Diagnostics {
		if d.Code == code {
			return true
		}
	}
	return false
}

func TestLintCleanBaseline(t *testing.T) {
	pages := lintFixture(t)
	result := Lint(pages, "")
	if !result.OK || result.ErrorCount != 0 || result.WarningCount != 0 {
		t.Fatalf("clean baseline: %+v", result)
	}
	// Normalization and multiple internal edges to the same external peer are sets.
	pages[1].Content = strings.ReplaceAll(pages[1].Content, "order_service", "order-service")
	if got := Lint(pages, ""); !got.OK {
		t.Fatalf("hyphen normalization: %+v", got)
	}
}

func TestLintViolations(t *testing.T) {
	tests := []struct {
		name                string
		page                int
		before, after, code string
	}{
		{"missing page", 0, "[[order-service]]", "[[gone]]", "wiki_link_missing"},
		{"missing anchor", 0, "domain_rules#ORD-1", "domain_rules#ORD-99", "wiki_link_missing"},
		{"fenced link", 0, "order_service[订单服务]", "order_service[订单服务] %% [[order-service]]", "wiki_link_in_fence"},
		{"too many nodes", 0, "flowchart LR", "flowchart LR\n a --> b --> c --> d", "mermaid_node_limit"},
		{"requirement ID", 0, "订单服务]", "REQ-12]", "mermaid_implementation_detail"},
		{"SQL field", 0, "订单服务]", "orders.status]", "mermaid_implementation_detail"},
		{"SQL column", 0, "订单服务]", "order_id BIGINT]", "mermaid_implementation_detail"},
		{"code line", 0, "订单服务]", "main.go#L123]", "mermaid_implementation_detail"},
		{"step", 0, "订单服务]", "第一步创建订单]", "mermaid_implementation_detail"},
		{"line width", 0, "订单服务]", strings.Repeat("订", 23) + "]", "mermaid_label_length"},
		{"total width", 0, "订单服务]", strings.Repeat("订", 20) + "<br/>" + strings.Repeat("单", 17) + "]", "mermaid_label_length"},
		{"hard color", 0, "flowchart LR", "flowchart LR\nstyle order_service fill:#fff,stroke:#000", "mermaid_color"},
		{"class color", 0, "flowchart LR", "flowchart LR\nclassDef ext color:#123abc", "mermaid_color"},
		{"edge ellipsis", 0, "|回调|", "|[...]|", "mermaid_edge_ellipsis"},
		{"navigation", 0, "[[order-service]]", "订单服务", "child_navigation"},
		{"missing callback", 1, "payment -->|回调| worker", "", "boundary_conservation"},
		{"private edge", 1, "api --> inventory", "api --> inventory\nworker --> backdoor", "boundary_conservation"},
		{"missing field", 1, "- **唯一记忆事实**：订单状态和已处理支付凭据。", "", "gate_missing_field"},
		{"no example", 1, "  - **反例**：取消后收到旧支付回调，订单又变成已成交。", "", "gate_counterexample"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pages := lintFixture(t)
			pages[tt.page].Content = strings.Replace(pages[tt.page].Content, tt.before, tt.after, 1)
			result := Lint(pages, "")
			if !lintHas(result, tt.code) {
				t.Fatalf("missing %s: %+v", tt.code, result)
			}
			if tt.code != "wiki_link_in_fence" && result.OK {
				t.Fatalf("violation accepted: %+v", result)
			}
			for _, d := range result.Diagnostics {
				if d.Line < 1 || d.Page == "" {
					t.Fatalf("missing location: %+v", d)
				}
			}
		})
	}
}

func TestLintLinksUseWikiResolutionAndOffsets(t *testing.T) {
	pages := []LintPage{
		{WikiPageContent: WikiPageContent{Slug: "source", Title: "Source", Content: "## [S-1] Source\n`[[gone]]`\n```text\n[[gone]]\n```\n[[gone]] [[Shared]] [[target#K-1|name]] [[#S-1]] [[stage:2]]\n"}},
		{WikiPageContent: WikiPageContent{Slug: "target", Title: "Shared", Content: "## [K-1] One\nOK"}},
		{WikiPageContent: WikiPageContent{Slug: "other", Title: "Shared"}},
	}
	result := Lint(pages, "")
	if result.ErrorCount != 2 || result.WarningCount != 1 {
		t.Fatalf("%+v", result)
	}
	for _, d := range result.Diagnostics {
		if d.Section != "S-1" || d.Severity == "error" && d.Line != 6 || d.Severity == "warning" && d.Line != 4 {
			t.Fatalf("wrong location: %+v", d)
		}
	}
}

func TestLintBoundaryFilterAndDirections(t *testing.T) {
	pages := lintFixture(t)
	pages[1].Content = strings.Replace(pages[1].Content, "payment -->|回调| worker", "worker --> backdoor", 1)
	pages[2].Content += "\n[[missing]]"
	for _, page := range []string{"architecture", "order-service"} {
		result := Lint(pages, page)
		if result.ErrorCount != 2 {
			t.Fatalf("filter %s: %+v", page, result)
		}
		messages := result.Diagnostics[0].Message + result.Diagnostics[1].Message
		if !strings.Contains(messages, "incoming peers: missing [payment]; extra []") || !strings.Contains(messages, "outgoing peers: missing []; extra [backdoor]") {
			t.Fatal(messages)
		}
	}
	// No matching container expansion means no conservation assertion.
	pages[1].Content = strings.Replace(pages[1].Content, "subgraph order_service", "subgraph different", 1)
	if lintHas(Lint(pages, "architecture"), "boundary_conservation") {
		t.Fatal("unrelated group treated as container")
	}
	pages = lintFixture(t)
	pages[1].Content = strings.Replace(pages[1].Content, "  subgraph order_service[订单服务]\n", "", 1)
	pages[1].Content = strings.Replace(pages[1].Content, "  end\n", "", 1)
	if result := Lint(pages, ""); !result.OK {
		t.Fatalf("unexpanded child: %+v", result)
	}
}

func TestLintMermaidSyntax(t *testing.T) {
	cases := []struct {
		name, diagram    string
		errors, warnings int
	}{
		{"nested state color", "stateDiagram-v2\nstate Outer {\nclassDef bad fill:#abc\nA --> B\n}", 1, 0},
		{"state only color", "stateDiagram-v2\n A --> B\n B --> C\n C --> D\n D --> E\n E --> F\n F --> G\n G --> H\n classDef bad fill:#abc", 1, 0},
		{"comments quotes shapes", "flowchart LR; A[\"a --> b; c\"] --> B[[组件]]; B --> C((数据库))\n%% X --> Y\nC --> D{决策}\nD --> E[/输入/]\nE --> F([结束])\nF --> G>事件]", 0, 0},
		{"ampersand chain", "graph TD\na & b --> c & d --> e", 0, 0},
		{"label edge", "graph LR\n a -- [...] --> b", 1, 0},
		{"dotted thick reverse", "graph LR\na -.-> b ==> c <--> d", 0, 0},
		{"unsupported", "flowchart LR\na@{ shape: rect, label: test }", 0, 1},
		{"frontmatter", "---\ntitle: Diagram\n---\nflowchart LR\na --> b --> c --> d --> e --> f --> g --> h", 1, 0},
		{"last displayed text", "graph LR\nREQ-42[REQ-42]\nREQ-42[订单]\nREQ-42 --> b", 0, 0},
		{"distinct hyphen nodes", "graph LR\na-b --> a_b --> c --> d --> e --> f --> g --> h", 1, 0},
		{"ordinary graph no directives", "sequenceDiagram\n A->>B: REQ-999", 0, 0},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			result := Lint([]LintPage{{WikiPageContent: WikiPageContent{Slug: "diagram", Content: "```mermaid\n" + tt.diagram + "\n```"}}}, "")
			if result.ErrorCount != tt.errors || result.WarningCount != tt.warnings {
				t.Fatalf("%+v", result)
			}
		})
	}
}

func TestLintGateOptIn(t *testing.T) {
	cases := []struct {
		name, content string
		errors        int
	}{
		{"BDD", "## 取消订单\n- 假如尚未发货\n- 当取消\n- 那么不再成交", 0},
		{"one bold marker", "## 普通约定\n- **对外开口**：API", 0},
		{"two bold markers", "## 普通约定\n- **对外开口**：API\n- **唯一记忆事实**：状态", 2},
		{"explicit heading", "## 门规\n- 普通说明", 4},
		{"prose no list", "## 门规\n这是对门规的介绍。", 0},
		{"fenced list", "## 门规\n```md\n- **对外开口**：API\n- **唯一记忆事实**：状态\n```", 0},
		{"wrong item's example", "## 门规\n- **对外开口**：反例：请求失败。\n- **唯一记忆事实**：状态\n- **死守底线**：不丢数据\n- **外部默认前提**：重试", 1},
		{"empty example", "## 门规\n- 对外开口：API\n- 唯一记忆事实：状态\n- 死守底线：不丢数据，反例：\n- 外部默认前提：重试", 1},
		{"explicit violation", "## 门规\n- 对外开口：API\n- 唯一记忆事实：状态\n- 死守底线：若取消后又成交，则判为违规\n- 外部默认前提：重试", 0},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			result := Lint([]LintPage{{WikiPageContent: WikiPageContent{Slug: "rules", Content: tt.content}}}, "")
			if result.ErrorCount != tt.errors {
				t.Fatalf("%+v", result)
			}
		})
	}
}

func TestLintDeterministic(t *testing.T) {
	pages := lintFixture(t)
	pages[0].Content += "\n[[missing]]"
	pages[1].Content = strings.Replace(pages[1].Content, "payment -->|回调| worker", "worker --> backdoor", 1)
	want := Lint(pages, "")
	pages[0], pages[2] = pages[2], pages[0]
	if got := Lint(pages, ""); !reflect.DeepEqual(want, got) {
		t.Fatalf("order changes diagnostics:\n%+v\n%+v", want, got)
	}
}

func TestLintNestedSubgraphAndBidirectionalEdges(t *testing.T) {
	pages := lintFixture(t)
	pages[0].Content = strings.Replace(pages[0].Content, "order_service --> payment[支付服务]\n  payment -->|回调| order_service", "order_service <--> payment[支付服务]", 1)
	pages[1].Content = strings.Replace(pages[1].Content, "    api[订单入口] --> worker[履约处理]", "    subgraph components[内部组件]\n      api[订单入口] --> worker[履约处理]\n    end", 1)
	result := Lint(pages, "")
	if !result.OK || result.WarningCount != 0 {
		t.Fatalf("%+v", result)
	}
}

func TestLintAcceptsC4SourceFences(t *testing.T) {
	content := "```likec4\nmodel {\n  api = system 'API'\n}\n```\n\n```c4\nviews {\n  view index {\n    include *\n  }\n}\n```\n"
	result := Lint([]LintPage{{WikiPageContent: WikiPageContent{Slug: "architecture", Content: content}}}, "")
	if !result.OK || len(result.Diagnostics) != 0 {
		t.Fatalf("c4 fences: %+v", result)
	}
}

func TestLintRejectsEmptyC4SourceFence(t *testing.T) {
	for _, language := range []string{"likec4", "c4"} {
		t.Run(language, func(t *testing.T) {
			result := Lint([]LintPage{{WikiPageContent: WikiPageContent{Slug: "architecture", Content: "```" + language + "\n\n```\n"}}}, "")
			if !lintHas(result, "c4_source_empty") || result.ErrorCount != 1 {
				t.Fatalf("%+v", result)
			}
		})
	}
}

func TestLintHtmlAttachmentFence(t *testing.T) {
	hint := "Interactive canvas follows."
	cases := []struct {
		name        string
		info        string
		attachments []string
		code        string
	}{
		{"bound", `html src="architecture.html" title="架构画布"`, []string{"architecture.html"}, ""},
		{"single quotes", `html src='architecture.htm'`, []string{"architecture.htm"}, ""},
		{"unquoted", `html src=architecture.html`, []string{"architecture.html"}, ""},
		{"missing", `html src="architecture.html"`, []string{"other.html"}, "html_attachment_missing"},
		{"not loaded offline", `html src="architecture.html"`, nil, ""},
		{"path", `html src="views/architecture.html"`, []string{"architecture.html"}, "html_attachment_src"},
		{"url", `html src="https://example.com/architecture.html"`, []string{"architecture.html"}, "html_attachment_src"},
		{"not html", `html src="architecture.png"`, []string{"architecture.png"}, "html_attachment_src"},
		{"inline html has no reference", `html`, []string{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			page := LintPage{
				WikiPageContent: WikiPageContent{Slug: "architecture", Content: "```" + tc.info + "\n" + hint + "\n```\n"},
				Attachments:     tc.attachments,
			}
			if tc.attachments == nil {
				page.Attachments = nil
			}
			result := Lint([]LintPage{page}, "")
			if tc.code == "" {
				if len(result.Diagnostics) != 0 {
					t.Fatalf("unexpected diagnostics: %+v", result)
				}
				return
			}
			if !lintHas(result, tc.code) || result.ErrorCount != 1 {
				t.Fatalf("%+v", result)
			}
		})
	}
}
