package handler

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

func TestLabrastroMarkdownPathSpans(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		want       []string
	}{
		{"inline", "prefix `a.md` and ``b`c.md`` plus `two words`", []string{"a.md", "b`c.md"}},
		{"three backticks", "x ```a.md``` y", []string{"a.md"}},
		{"four backticks", "x ````a```b.md```` y", []string{"a```b.md"}},
		{"longer closer", "prefix ``a.md```b.md`", []string{"a.md", "b.md"}},
		{"escaped opener", "prefix \\`ignored and \\``a.md`", []string{"a.md"}},
		{"escaped closer", "prefix `a.md\\` [b](b.md)", []string{"a.md\\", "b.md"}},
		{"links", "[a](a(b).md#c) [b](<b c.md>) [c](c\\(d\\).md \"title\")", []string{"a(b).md#c", "b c.md", "c\\(d\\).md"}},
		{"definitions", "[a]: <a b.md>\r\n[b]: b.md \"title\"\n[x][a] `c.md`", []string{"a b.md", "b.md", "c.md"}},
		{"overlapping definition", "[a]: `a.md`", []string{"`a.md`", "a.md"}},
		{"containers", "> ```md\n> [no](no.md)\n> ```\n\n- ```md\n  `no.md`\n  ```\n\n[yes](yes.md)", []string{"yes.md"}},
		{"indented", "    [no](no.md)\n\n[yes](yes.md)", []string{"yes.md"}},
		{"definition before setext heading", "[foo]: /url\n===\n    [path](path.md)", []string{"/url", "path.md"}},
		{"empty and unterminated links", "[a]() [b](<>) [c](unterminated", []string{"unterminated"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spans, err := labrastroMarkdownPaths(t.Context(), tc.body)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			last := -1
			for _, span := range spans {
				if span.start < last || span.end <= span.start || span.end > len(tc.body) {
					t.Fatalf("invalid source span: %+v", span)
				}
				got = append(got, tc.body[span.start:span.end])
				last = span.start
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("paths = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestLabrastroMarkdownUnmatchedBackticks(t *testing.T) {
	// The leading non-backtick byte keeps this from being a fenced code block.
	body := "x" + strings.Repeat("`", (1<<20)-1)
	start := time.Now()
	spans, err := labrastroMarkdownPaths(t.Context(), body)
	elapsed := time.Since(start)
	if err != nil {
		t.Fatal(err)
	}
	if len(spans) != 0 {
		t.Fatalf("unmatched backticks produced %d paths", len(spans))
	}
	if elapsed >= 2*time.Second {
		t.Fatalf("1 MiB scan took %s; want less than 2s", elapsed)
	}
	t.Logf("1 MiB unmatched backticks: %s", elapsed)
}

func TestLabrastroMarkdownAdversarialLines(t *testing.T) {
	var differentRuns strings.Builder
	differentRuns.WriteByte('x')
	for n := 1400; n > 0; n-- {
		differentRuns.WriteString(strings.Repeat("`", n))
		differentRuns.WriteByte('x')
	}
	for _, tc := range []struct {
		name, body string
		paths      int
	}{
		{"decreasing backtick runs", differentRuns.String(), 0},
		{"unclosed angle links", strings.Repeat("][x](<", (1<<20)/6), 1},
		{"unclosed nested links", strings.Repeat("](a(", (1<<20)/4), 1},
		{"escaped link destination", "[x](" + strings.Repeat(`\(`, (1<<20)/2-2), 1},
		{"reference label", "[" + strings.Repeat("[", (1<<20)-1), 0},
		{"reference destination", "[x]: " + strings.Repeat("a", (1<<20)-5), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			spans, err := labrastroMarkdownPaths(t.Context(), tc.body)
			elapsed := time.Since(start)
			if err != nil || len(spans) != tc.paths {
				t.Fatalf("paths = %d, error = %v; want %d paths", len(spans), err, tc.paths)
			}
			if elapsed >= 2*time.Second {
				t.Fatalf("scan took %s; want less than 2s", elapsed)
			}
			t.Logf("%d bytes: %s", len(tc.body), elapsed)
		})
	}
}

func TestLabrastroMarkdownContextDeadline(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"long line", "x" + strings.Repeat("`", (1<<20)-1)},
		{"fenced lines", "```\n" + strings.Repeat("[a](a.md)\n", 100000)},
		{"container lines", strings.Repeat("> - [a](a.md)\n\n", 60000)},
	} {
		for _, budget := range []time.Duration{-time.Second, time.Millisecond} {
			t.Run(tc.name+"/"+budget.String(), func(t *testing.T) {
				ctx, cancel := context.WithTimeout(t.Context(), budget)
				defer cancel()
				start := time.Now()
				spans, err := labrastroMarkdownPaths(ctx, tc.body)
				if !errors.Is(err, context.DeadlineExceeded) || spans != nil {
					t.Fatalf("deadline returned %d paths and %v", len(spans), err)
				}
				if elapsed := time.Since(start); elapsed >= 2*time.Second {
					t.Fatalf("deadline returned after %s; want less than 2s", elapsed)
				}
			})
		}
	}
}

func TestLabrastroMarkdownReaderCancellation(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(fmt.Sprintf("LineOffset/canceled=%t", canceled), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			r := &labrastroMarkdownReader{Reader: text.NewReader([]byte("\tx\n")), ctx: ctx}
			r.Advance(1)
			if canceled {
				cancel()
				defer func() {
					abort, ok := recover().(labrastroMarkdownAbort)
					if !ok || !errors.Is(abort.err, context.Canceled) {
						t.Fatalf("LineOffset did not abort with cancellation: %+v", abort)
					}
				}()
				r.LineOffset()
				t.Fatal("canceled LineOffset returned normally")
			}
			if offset := r.LineOffset(); offset != 4 {
				t.Fatalf("LineOffset after tab = %d, want 4", offset)
			}
		})
		t.Run(fmt.Sprintf("AdvanceLine/canceled=%t", canceled), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			r := &labrastroMarkdownReader{Reader: text.NewReader([]byte("first\nsecond\n")), ctx: ctx}
			if canceled {
				cancel()
			}
			r.AdvanceLine()
			line, _ := r.PeekLine()
			if canceled {
				if line != nil {
					t.Fatalf("canceled AdvanceLine left %q readable; want EOF", line)
				}
			} else if string(line) != "second\n" {
				t.Fatalf("AdvanceLine returned %q, want second line", line)
			}
		})
		t.Run(fmt.Sprintf("SkipBlankLines/canceled=%t", canceled), func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			r := &labrastroMarkdownReader{Reader: text.NewReader([]byte("\n \t\nremaining\n")), ctx: ctx}
			if canceled {
				cancel()
			}
			_, skipped, ok := r.SkipBlankLines()
			if canceled {
				if ok {
					t.Fatal("canceled SkipBlankLines reported another line")
				}
			} else {
				line, _ := r.PeekLine()
				if !ok || skipped != 2 || string(line) != "remaining\n" {
					t.Fatalf("SkipBlankLines = (%q, %d, %t), want (remaining, 2, true)", line, skipped, ok)
				}
			}
		})
	}
}

type labrastroPanickingContext struct {
	context.Context
	value any
}

func (c labrastroPanickingContext) Err() error { panic(c.value) }

func TestLabrastroMarkdownUnexpectedPanic(t *testing.T) {
	unexpected := errors.New("unexpected parser failure")
	defer func() {
		if got := recover(); got != unexpected {
			t.Fatalf("unexpected panic = %v, want original panic %v", got, unexpected)
		}
	}()
	_, _ = labrastroMarkdownPaths(labrastroPanickingContext{t.Context(), unexpected}, "text")
	t.Fatal("unexpected panic was swallowed")
}

type labrastroTestParagraphTransformer func(*ast.Paragraph, text.Reader, parser.Context)

func (f labrastroTestParagraphTransformer) Transform(node *ast.Paragraph, reader text.Reader, pc parser.Context) {
	f(node, reader, pc)
}

func TestLabrastroMarkdownParagraphCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	paragraph := ast.NewParagraph()
	for range 4097 {
		paragraph.Lines().Append(text.NewSegment(0, 6))
	}
	transformer := &labrastroMarkdownParagraphTransformer{
		ctx: ctx,
		ParagraphTransformer: labrastroTestParagraphTransformer(func(*ast.Paragraph, text.Reader, parser.Context) {
			t.Fatal("canceled paragraph reached reference extraction")
		}),
	}
	defer func() {
		abort, ok := recover().(labrastroMarkdownAbort)
		if !ok || !errors.Is(abort.err, context.Canceled) {
			t.Fatalf("paragraph did not abort with cancellation: %+v", abort)
		}
	}()
	transformer.Transform(paragraph, text.NewReader([]byte("[x]:a\n")), parser.NewContext())
	t.Fatal("canceled paragraph returned normally")
}

func TestLabrastroMarkdownCancellationBetweenNestedLines(t *testing.T) {
	// Parsing the whole document exceeds the budget, so a check only after
	// Parse returns cannot satisfy the deadline. The reader must interrupt it.
	body := strings.Repeat(strings.Repeat(">", 8192)+"\n", 96)
	ctx, cancel := context.WithTimeout(t.Context(), time.Millisecond)
	defer cancel()
	start := time.Now()
	spans, err := labrastroMarkdownPaths(ctx, body)
	elapsed := time.Since(start)
	if !errors.Is(err, context.DeadlineExceeded) || spans != nil {
		t.Fatalf("deadline returned %d paths and %v", len(spans), err)
	}
	if elapsed >= 2*time.Second {
		t.Fatalf("deadline returned after %s; want less than 2s", elapsed)
	}
	t.Logf("canceled nested lines: %s", elapsed)
}

func TestLabrastroMarkdownNestedContainersDeadline(t *testing.T) {
	for _, size := range []int{1 << 16, 1 << 20} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			body := strings.Repeat(">", size)
			ctx, cancel := context.WithTimeout(t.Context(), time.Millisecond)
			defer cancel()
			start := time.Now()
			spans, err := labrastroMarkdownPaths(ctx, body)
			elapsed := time.Since(start)
			if !errors.Is(err, context.DeadlineExceeded) || spans != nil {
				t.Fatalf("deadline returned %d paths and %v", len(spans), err)
			}
			if elapsed >= 2*time.Second {
				t.Fatalf("deadline returned after %s; want less than 2s", elapsed)
			}
			t.Logf("%d nested containers canceled in %s", size, elapsed)
		})
	}
}

func TestLabrastroMarkdownParagraphLimit(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		paths      int
		limited    bool
	}{
		{"at limit", strings.Repeat("[x]:a\n", 4096), 4096, false},
		{"over limit", strings.Repeat("[x]:a\n", 4097), 0, true},
		{"one MiB", strings.Repeat("[x]:a\n", (1<<20)/6), 0, true},
		{"blockquote", strings.Repeat("> [x]:a\n", 4097), 0, true},
		{"list", "- [x]:a\n" + strings.Repeat("  [x]:a\n", 4096), 0, true},
		{"plain prose", strings.Repeat("text\n", 4097), 0, true},
		{"multiline definitions", strings.Repeat("[x]:\na\n", 2049), 0, true},
		{"separate paragraphs", strings.Repeat("[x]:a\n", 4096) + "\n" + strings.Repeat("[x]:a\n", 4096), 8192, false},
		{"fenced code", "```\n" + strings.Repeat("[x]:a\n", 4097) + "```\n", 0, false},
		{"indented code", strings.Repeat("    [x]:a\n", 4097), 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			start := time.Now()
			spans, err := labrastroMarkdownPaths(t.Context(), tc.body)
			elapsed := time.Since(start)
			if tc.limited {
				if !isCapError(err) || spans != nil {
					t.Fatalf("paragraph limit returned %d paths and %v", len(spans), err)
				}
			} else if err != nil || len(spans) != tc.paths {
				t.Fatalf("paths = %d, error = %v; want %d paths", len(spans), err, tc.paths)
			}
			if elapsed >= 2*time.Second {
				t.Fatalf("paragraph scan took %s; want less than 2s", elapsed)
			}
			t.Logf("%d bytes scanned in %s", len(tc.body), elapsed)
		})
	}
}

func TestLabrastroReferenceCancellationWithinFile(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	r := &importedSkill{content: "[a](missing.md) [b](also-missing.md)"}
	lookups := 0
	err := labrastroCompleteReferences(ctx, r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		lookups++
		if strings.HasSuffix(p, "/missing.md") {
			cancel()
		}
		return githubTreeEntry{}, false, nil
	}, func(context.Context, string) ([]byte, error) {
		t.Fatal("missing reference must not be fetched")
		return nil, nil
	})
	if !errors.Is(err, context.Canceled) || lookups != 2 {
		t.Fatalf("cancellation returned %v after %d lookups; want cancellation after 2", err, lookups)
	}
}

func TestLabrastroReferenceClosure(t *testing.T) {
	files := map[string]string{
		"skills/demo/SKILL.md":  "---\nname: demo\n---\n[guide](../../references/guide.md#start)\n`../../references/guide.md`\n`../project-feature-a`\n[remote](https://example.com/file.md)\n```md\n`../../references/example.md`\n```\n",
		"skills/demo/local.md":  "local text",
		"references/guide.md":   "[back](../skills/demo/local.md) [again](nested.md#next)\n[defs][x]\n[x]: nested.md#next\n",
		"references/nested.md":  "[cycle](guide.md) [main](../skills/demo/SKILL.md)\n[other](../skills/other/SKILL.md) `../secret` `../LICENSE`",
		"references/example.md": "fenced example must not be fetched",
		"skills/other/SKILL.md": "other skill",
		"secret":                "symlink target",
		"LICENSE":               "license",
	}
	r := &importedSkill{content: files["skills/demo/SKILL.md"], files: []importedFile{{"local.md", files["skills/demo/local.md"]}}}
	counts := map[string]int{}
	lookup := func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		_, ok := files[p]
		mode := "100644"
		if p == "secret" {
			mode = "120000"
		}
		return githubTreeEntry{Path: p, Type: "blob", Mode: mode}, ok, nil
	}
	err := labrastroCompleteReferences(t.Context(), r, "skills/demo", lookup, func(_ context.Context, p string) ([]byte, error) { counts[p]++; return []byte(files[p]), nil })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.content, "[guide](_shared/references/guide.md#start)") || !strings.Contains(r.content, "`../project-feature-a`") || !strings.Contains(r.content, "`../../references/example.md`") {
		t.Fatalf("unexpected primary rewrite: %s", r.content)
	}
	got := map[string]string{}
	for _, f := range r.files {
		got[f.path] = f.content
	}
	if !strings.Contains(got["_shared/references/guide.md"], "[back](../../local.md)") || !strings.Contains(got["_shared/references/nested.md"], "[main](../../SKILL.md)") {
		t.Fatalf("back references are wrong: %#v", got)
	}
	if len(got) != 3 || counts["references/guide.md"] != 1 || counts["references/nested.md"] != 1 || counts["references/example.md"] != 0 {
		t.Fatalf("closure was not bounded/deduplicated: files=%v fetches=%v", got, counts)
	}
	codes := map[string]bool{}
	for _, d := range r.diagnostics {
		codes[d.Code] = true
	}
	if !codes["cross_skill_reference"] || !codes["filtered_reference"] {
		t.Fatalf("missing diagnostics: %+v", r.diagnostics)
	}
}

func TestLabrastroReferenceFailures(t *testing.T) {
	for _, tc := range []struct {
		name, code  string
		size        int64
		files       []importedFile
		downloadErr error
	}{
		{"required download", "required_reference_unavailable", 1, nil, errors.New("HTTP 503")},
		{"shared collision", "shared_path_conflict", 1, []importedFile{{"_shared/references/a.md", "different"}}, nil},
		{"file limit", "limit_exceeded", maxImportFileSize + 1, nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &importedSkill{content: "[a](../../references/a.md)", files: tc.files}
			err := labrastroCompleteReferences(t.Context(), r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
				return githubTreeEntry{Path: p, Type: "blob", Mode: "100644", Size: tc.size}, true, nil
			}, func(context.Context, string) ([]byte, error) { return []byte("shared"), tc.downloadErr })
			var detail *labrastroImportError
			if !errors.As(err, &detail) || detail.Diagnostic.Code != tc.code {
				t.Fatalf("got %v, want %s", err, tc.code)
			}
		})
	}
}

func TestLabrastroReferenceFinalByteBudget(t *testing.T) {
	r := &importedSkill{content: "[a](../../references/a.md)"}
	for i := 0; i < 8; i++ {
		r.files = append(r.files, importedFile{fmt.Sprintf("%d.txt", i), strings.Repeat("a", maxImportFileSize)})
	}
	err := labrastroCompleteReferences(t.Context(), r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		return githubTreeEntry{Path: p, Type: "blob", Size: 1}, true, nil
	}, func(context.Context, string) ([]byte, error) { return []byte("a"), nil })
	if !isCapError(err) {
		t.Fatalf("want aggregate cap error, got %v", err)
	}
}

func TestLabrastroPreviewSignatures(t *testing.T) {
	token := labrastroSignPreview("one", time.Now().Unix()+100)
	if !labrastroValidatePreview(token, "one") || labrastroValidatePreview(token, "two") || labrastroValidatePreview(labrastroSignPreview("one", 1), "one") || labrastroValidatePreview(token+"x", "one") {
		t.Fatal("preview signature or expiry validation failed")
	}
}

func TestLabrastroReferenceCodeContainersAndEscapedPaths(t *testing.T) {
	body := "> ```md\n> [example](../../references/example.md)\n> ```\n\n- ```md\n  [example](../../references/example.md)\n  ```\n\n[space](../../references/a\\ b.md#anchor)\n"
	r := &importedSkill{content: body}
	fetched := []string{}
	err := labrastroCompleteReferences(t.Context(), r, "skills/demo", func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		return githubTreeEntry{Path: p, Type: "blob", Mode: "100644"}, true, nil
	}, func(_ context.Context, p string) ([]byte, error) {
		fetched = append(fetched, p)
		return []byte("text"), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fetched) != 1 || fetched[0] != "references/a b.md" || !strings.Contains(r.content, "[space](_shared/references/a%20b.md#anchor)") || strings.Count(r.content, "../../references/example.md") != 2 {
		t.Fatalf("code examples or escaped path were rewritten incorrectly: fetches=%v body=%s", fetched, r.content)
	}
}

func TestLabrastroReferencePlusAndLocalDirectories(t *testing.T) {
	f := labrastroTestFixture(map[string]string{
		"skills/demo/SKILL.md":            "[encoded](../../references/c%2B%2B.md#anchor) [literal](../../references/c++.md) `scripts/` [dir](references/) [external](../../references/)",
		"skills/demo/scripts/run.sh":      "echo ok",
		"skills/demo/references/local.md": "local",
		"references/c++.md":               "shared",
	})
	src, err := newLabrastroSkillSource(t.Context(), f.client(), f.url(), t.Name())
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := src.bundle(t.Context(), "skills/demo")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(bundle.content, "[encoded](_shared/references/c++.md#anchor)") || !strings.Contains(bundle.content, "[literal](_shared/references/c++.md)") || !strings.Contains(bundle.content, "`scripts/` [dir](references/)") {
		t.Fatalf("paths corrupted: %s", bundle.content)
	}
	if len(bundle.files) != 3 || len(bundle.diagnostics) != 1 || bundle.diagnostics[0].Target != "references" {
		t.Fatalf("local directory diagnosed as missing: files=%+v diagnostics=%+v", bundle.files, bundle.diagnostics)
	}
}
