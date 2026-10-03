package handler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	skillpkg "github.com/multica-ai/multica/server/internal/skill"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

// SkillImportDiagnostic is additive to the existing import/refresh contract.
type SkillImportDiagnostic struct {
	Code      string `json:"code"`
	Path      string `json:"path,omitempty"`
	Target    string `json:"target,omitempty"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}

type labrastroImportError struct {
	Diagnostic SkillImportDiagnostic
	Cause      error
}

func (e *labrastroImportError) Error() string { return e.Diagnostic.Message }
func (e *labrastroImportError) Unwrap() error { return e.Cause }
func labrastroImportFailure(code, file, target string, err error, retry bool) error {
	return &labrastroImportError{SkillImportDiagnostic{code, file, target, err.Error(), retry}, err}
}
func writeSkillFetchError(w http.ResponseWriter, ctx context.Context, err error) {
	status, message := importFetchErrorResponse(ctx, err)
	var detail *labrastroImportError
	diagnostics := []SkillImportDiagnostic{}
	if errors.As(err, &detail) {
		diagnostics = append(diagnostics, detail.Diagnostic)
	}
	code := "source_unavailable"
	if isCapError(err) {
		code = "limit_exceeded"
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
		code = "source_timeout"
	}
	if len(diagnostics) == 0 {
		diagnostics = append(diagnostics, SkillImportDiagnostic{Code: code, Message: message, Retryable: status >= 500})
	}
	writeJSON(w, status, map[string]any{"error": message, "code": diagnostics[0].Code, "diagnostics": diagnostics, "retryable": diagnostics[0].Retryable})
}

func labrastroRegularBlob(e githubTreeEntry) bool {
	return e.Type == "blob" && (e.Mode == "" || e.Mode == "100644" || e.Mode == "100755")
}
func labrastroTextPath(p string) bool {
	b := strings.ToLower(path.Base(p))
	return b != "license" && b != "license.md" && b != "license.txt" && !skillpkg.IsLikelyBinaryFilePath(p)
}
func labrastroInside(p, dir string) bool { return dir == "" || strings.HasPrefix(p, dir+"/") }
func labrastroSafeRepoPath(p string) bool {
	return p != "" && p != "." && !strings.HasPrefix(p, "/") && p != ".." && !strings.HasPrefix(p, "../") && !strings.ContainsAny(p, "\\\x00:") && path.Clean(p) == p
}

type labrastroPathSpan struct{ start, end int }

var labrastroReferenceDefinition = regexp.MustCompile(`^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|[^\s]+)`)

// Use the existing Markdown parser for code-block boundaries, including list
// and blockquote containers. Blanking bytes preserves source offsets without
// treating examples in nested fenced/indented code as real references.
func labrastroMaskMarkdownCode(body string) string {
	source := []byte(body)
	doc := goldmark.New().Parser().Parse(text.NewReader(source))
	mask := func(start, end int) {
		for i := start; i < end; i++ {
			if source[i] != '\n' && source[i] != '\r' {
				source[i] = ' '
			}
		}
	}
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch block := n.(type) {
		case *ast.FencedCodeBlock:
			if block.Info != nil {
				start := bytes.LastIndexByte(source[:block.Info.Segment.Start], '\n') + 1
				mask(start, block.Info.Segment.Stop)
			}
		case *ast.CodeBlock:
		default:
			return ast.WalkContinue, nil
		}
		for i := 0; i < n.Lines().Len(); i++ {
			line := n.Lines().At(i)
			mask(line.Start, line.Stop)
		}
		return ast.WalkSkipChildren, nil
	})
	return string(source)
}

// Keep byte spans instead of reserializing Markdown: examples and formatting
// are left byte-for-byte intact. Fences, indented code and non-path inline code
// are deliberately excluded. Links include reference-style definitions.
func labrastroMarkdownPaths(body string) []labrastroPathSpan {
	var spans []labrastroPathSpan
	offset := 0
	for _, line := range strings.SplitAfter(labrastroMaskMarkdownCode(body), "\n") {
		if m := labrastroReferenceDefinition.FindStringSubmatchIndex(line); m != nil {
			a, b := m[2], m[3]
			if line[a] == '<' {
				a++
				b--
			}
			spans = append(spans, labrastroPathSpan{offset + a, offset + b})
		}
		for i := 0; i < len(line); i++ {
			if line[i] == '\\' {
				i++
				continue
			}
			if line[i] == '`' {
				n := 1
				for i+n < len(line) && line[i+n] == '`' {
					n++
				}
				end := strings.Index(line[i+n:], strings.Repeat("`", n))
				if end >= 0 {
					a, b := i+n, i+n+end
					token := line[a:b]
					if token != "" && !strings.ContainsAny(token, " \t\n\r") {
						spans = append(spans, labrastroPathSpan{offset + a, offset + b})
					}
					i = b + n - 1
				}
				continue
			}
			if line[i] != ']' || i+1 >= len(line) || line[i+1] != '(' {
				continue
			}
			a := i + 2
			for a < len(line) && (line[a] == ' ' || line[a] == '\t') {
				a++
			}
			if a == len(line) {
				continue
			}
			b := a
			if line[a] == '<' {
				a++
				b = a
				for b < len(line) && line[b] != '>' {
					b++
				}
			} else {
				depth := 0
				for b < len(line) {
					c := line[b]
					if c == '\\' && b+1 < len(line) {
						b += 2
						continue
					}
					if c == '(' {
						depth++
					}
					if c == ')' {
						if depth == 0 {
							break
						}
						depth--
					}
					if c == ' ' || c == '\t' || c == '\n' {
						break
					}
					b++
				}
			}
			if b > a {
				spans = append(spans, labrastroPathSpan{offset + a, offset + b})
				i = b - 1
			}
		}
		offset += len(line)
	}
	sort.Slice(spans, func(i, j int) bool { return spans[i].start < spans[j].start })
	return spans
}

type labrastroRepoLookup func(context.Context, string) (githubTreeEntry, bool, error)
type labrastroRepoFetch func(context.Context, string) ([]byte, error)

func labrastroCompleteReferences(ctx context.Context, result *importedSkill, skillDir string, lookup labrastroRepoLookup, fetch labrastroRepoFetch) error {
	primary := path.Join(skillDir, "SKILL.md")
	if entry, ok, err := lookup(ctx, primary); err != nil {
		return err
	} else if ok && !labrastroRegularBlob(entry) {
		return labrastroImportFailure("filtered_reference", primary, primary, fmt.Errorf("SKILL.md must be a regular file"), false)
	}
	bodies := map[string]string{primary: result.content}
	outputs := map[string]string{primary: "SKILL.md"}
	owners := map[string]string{"SKILL.md": primary}
	queue := []string{primary}
	for _, f := range result.files {
		p := path.Join(skillDir, f.path)
		bodies[p] = f.content
		outputs[p] = f.path
		owners[f.path] = p
		queue = append(queue, p)
	}
	diagnostic := func(code, src, target, msg string) {
		result.diagnostics = append(result.diagnostics, SkillImportDiagnostic{Code: code, Path: src, Target: target, Message: msg})
	}
	for cursor := 0; cursor < len(queue); cursor++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		src := queue[cursor]
		ext := strings.ToLower(path.Ext(src))
		if ext != ".md" && ext != ".mdx" {
			continue
		}
		body := bodies[src]
		spans := labrastroMarkdownPaths(body)
		var out strings.Builder
		last := 0
		for _, span := range spans {
			if span.start < last {
				continue
			}
			raw := body[span.start:span.end]
			targetPart, anchor, _ := strings.Cut(raw, "#")
			if targetPart == "" || strings.ContainsAny(targetPart, ":?\n\r") || strings.HasPrefix(targetPart, "//") {
				continue
			}
			decoded, err := url.PathUnescape(targetPart)
			if err != nil {
				continue
			}
			decoded = strings.NewReplacer(`\(`, "(", `\)`, ")", `\ `, " ").Replace(decoded)
			if strings.HasPrefix(decoded, "/") || strings.Contains(decoded, "\\") {
				continue
			}
			target := path.Clean(path.Join(path.Dir(src), decoded))
			if !labrastroSafeRepoPath(target) {
				diagnostic("path_outside_repository", src, target, "reference leaves the repository; left unchanged")
				continue
			}
			entry, exists, err := lookup(ctx, target)
			if err != nil {
				return labrastroImportFailure("tree_unavailable", src, target, err, true)
			}
			if !exists {
				continue
			}
			if !labrastroRegularBlob(entry) || !labrastroTextPath(target) {
				diagnostic("filtered_reference", src, target, "symlink, submodule, directory or filtered asset; left unchanged")
				continue
			}
			if strings.EqualFold(path.Base(target), "SKILL.md") && target != primary {
				diagnostic("cross_skill_reference", src, target, "another skill is not copied; left unchanged")
				continue
			}
			dest := strings.TrimPrefix(target, skillDir+"/")
			if skillDir == "" {
				dest = target
			}
			if !labrastroInside(target, skillDir) {
				dest = path.Join("_shared", target)
			}
			if _, ok := bodies[target]; !ok {
				if len(bodies)-1 >= maxImportFileCount || entry.size() > maxImportFileSize {
					return labrastroImportFailure("limit_exceeded", src, target, fmt.Errorf("%w: reference exceeds bundle limits", errImportCapExceeded), false)
				}
				data, err := fetch(ctx, target)
				if err != nil {
					return labrastroImportFailure("required_reference_unavailable", src, target, fmt.Errorf("required reference %s: %w", target, err), !isCapError(err))
				}
				if !utf8.Valid(data) || strings.ContainsRune(string(data), '\x00') {
					diagnostic("filtered_reference", src, target, "binary content is not copied; left unchanged")
					continue
				}
				if old, ok := owners[dest]; ok && bodies[old] != string(data) {
					return labrastroImportFailure("shared_path_conflict", src, dest, fmt.Errorf("shared file conflicts with existing output %s", dest), false)
				}
				bodies[target] = string(data)
				outputs[target] = dest
				owners[dest] = target
				queue = append(queue, target)
			}
			// Recalculate even for a back-reference to the original skill.
			rel, err := filepath.Rel(path.Dir(outputs[src]), dest)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if outputs[src] == strings.TrimPrefix(src, skillDir+"/") && labrastroInside(target, skillDir) {
				continue
			}
			if strings.ContainsAny(targetPart, "%\\") {
				rel = strings.ReplaceAll((&url.URL{Path: rel}).EscapedPath(), "+", "%20")
			}
			if strings.Contains(raw, "#") {
				rel += "#" + anchor
			}
			out.WriteString(body[last:span.start])
			out.WriteString(rel)
			last = span.end
		}
		if last > 0 {
			out.WriteString(body[last:])
			bodies[src] = out.String()
		}
		// Enforce the final rewritten budget while expanding the closure.
		var size int
		for p, b := range bodies {
			if len(b) > maxImportFileSize {
				return fmt.Errorf("%w: rewritten %s exceeds file limit", errImportCapExceeded, p)
			}
			if p != primary {
				size += len(b)
			}
		}
		if size > maxImportTotalSize {
			return fmt.Errorf("%w: completed bundle exceeds byte limit", errImportCapExceeded)
		}
	}
	files := map[string]string{}
	for src, body := range bodies {
		if src == primary {
			continue
		}
		dest := outputs[src]
		if old, ok := files[dest]; ok && old != body {
			return labrastroImportFailure("shared_path_conflict", src, dest, fmt.Errorf("rewritten shared file conflicts at %s", dest), false)
		}
		files[dest] = body
	}
	result.content = bodies[primary]
	result.files = nil
	result.bundleSize = 0
	keys := make([]string, 0, len(files))
	for p := range files {
		keys = append(keys, p)
	}
	sort.Strings(keys)
	for _, p := range keys {
		if !validateFilePath(p) {
			return fmt.Errorf("unsafe output path %s", p)
		}
		if err := result.addFile(p, files[p]); err != nil {
			return err
		}
	}
	return nil
}

func labrastroCompleteFromTree(ctx context.Context, client *http.Client, result *importedSkill, tree []githubTreeEntry, rawPrefix, skillDir string) error {
	entries := make(map[string]githubTreeEntry, len(tree))
	for _, e := range tree {
		entries[e.Path] = e
	}
	return labrastroCompleteReferences(ctx, result, skillDir, func(_ context.Context, p string) (githubTreeEntry, bool, error) {
		e, ok := entries[p]
		return e, ok, nil
	}, func(ctx context.Context, p string) ([]byte, error) {
		return fetchRawFile(ctx, client, buildRawGitHubURL(rawPrefix, p))
	})
}
