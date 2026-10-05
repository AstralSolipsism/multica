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
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
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

// Stop safely at line boundaries. Within a line, abort through a private
// sentinel instead of changing the parser's repeated PeekLine reads to EOF.
type labrastroMarkdownReader struct {
	text.Reader
	ctx context.Context
}

// Goldmark's Reader and ParagraphTransformer interfaces cannot return errors.
// Only this private abort is recovered at the Markdown parsing boundary.
type labrastroMarkdownAbort struct{ err error }

func (r *labrastroMarkdownReader) LineOffset() int {
	// Opening each nested container recalculates the offset from the line head.
	if err := r.ctx.Err(); err != nil {
		panic(labrastroMarkdownAbort{err})
	}
	return r.Reader.LineOffset()
}

func (r *labrastroMarkdownReader) AdvanceLine() {
	if r.ctx.Err() != nil {
		line, _ := r.Position()
		end := len(r.Source())
		r.SetPosition(line, text.NewSegment(end, end))
	}
	r.Reader.AdvanceLine()
}

func (r *labrastroMarkdownReader) SkipBlankLines() (text.Segment, int, bool) {
	if r.ctx.Err() != nil {
		return text.Segment{}, 0, false
	}
	return r.Reader.SkipBlankLines()
}

const labrastroMaxMarkdownParagraphLines = 4096

type labrastroMarkdownParagraphTransformer struct {
	parser.ParagraphTransformer
	ctx context.Context
}

func (t *labrastroMarkdownParagraphTransformer) Transform(node *ast.Paragraph, reader text.Reader, pc parser.Context) {
	if err := t.ctx.Err(); err != nil {
		panic(labrastroMarkdownAbort{err})
	}
	// Goldmark only extracts definitions at the paragraph's start, copying
	// all remaining lines after each one. Use its whitespace/container rules
	// to bound that work without rejecting long prose or tables.
	if node.Lines().Len() > labrastroMaxMarkdownParagraphLines {
		block := text.NewBlockReader(reader.Source(), node.Lines())
		block.SkipSpaces()
		if block.Peek() == '[' {
			line := bytes.Count(reader.Source()[:node.Lines().At(0).Start], []byte{'\n'}) + 1
			panic(labrastroMarkdownAbort{fmt.Errorf("%w: Markdown paragraph starting with a possible reference definition at line %d exceeds %d lines; split it with blank lines", errImportCapExceeded, line, labrastroMaxMarkdownParagraphLines)})
		}
	}
	t.ParagraphTransformer.Transform(node, reader, pc)
}

// Use the existing Markdown parser for code-block boundaries, including list
// and blockquote containers. Blanking bytes preserves source offsets without
// treating examples in nested fenced/indented code as real references.
func labrastroMaskMarkdownCode(ctx context.Context, body string) (masked string, err error) {
	defer func() {
		if value := recover(); value != nil {
			if abort, ok := value.(labrastroMarkdownAbort); ok {
				masked, err = "", abort.err
			} else {
				panic(value)
			}
		}
	}()
	if err := ctx.Err(); err != nil {
		return "", err
	}
	source := []byte(body)
	// Inline parsing does not affect code-block boundaries, and would repeat
	// unbounded searches for unmatched code spans before our own scanner runs.
	transformers := parser.DefaultParagraphTransformers()
	for i := range transformers {
		transformers[i].Value = &labrastroMarkdownParagraphTransformer{
			ParagraphTransformer: transformers[i].Value.(parser.ParagraphTransformer), ctx: ctx,
		}
	}
	p := parser.NewParser(parser.WithBlockParsers(parser.DefaultBlockParsers()...),
		parser.WithParagraphTransformers(transformers...))
	doc := p.Parse(&labrastroMarkdownReader{Reader: text.NewReader(source), ctx: ctx})
	if err := ctx.Err(); err != nil {
		return "", err
	}
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
	return string(source), ctx.Err()
}

// Index the next closing run for every possible opener in linear time. The
// existing scanner accepts a prefix of a longer closing run; a remaining
// suffix (or an escaped first backtick) can then be an opener itself. Indexing
// all suffix lengths preserves that behavior without repeated tail searches.
// Zero means no closer: a closing run must be to the right of its opener and
// therefore cannot start at offset zero.
func labrastroMarkdownBacktickClosers(line string) []int {
	var closers, next []int
	for end := len(line); end > 0; {
		if line[end-1] != '`' {
			end--
			continue
		}
		start := end - 1
		for start > 0 && line[start-1] == '`' {
			start--
		}
		if closers == nil {
			closers = make([]int, len(line))
		}
		n := end - start
		if n >= len(next) {
			next = append(next, make([]int, n+1-len(next))...)
		}
		for length := 1; length <= n; length++ {
			closers[end-length] = next[length]
			next[length] = start
		}
		end = start
	}
	return closers
}

// Keep byte spans instead of reserializing Markdown: examples and formatting
// are left byte-for-byte intact. Fences, indented code and non-path inline code
// are deliberately excluded. Links include reference-style definitions.
func labrastroMarkdownPaths(ctx context.Context, body string) ([]labrastroPathSpan, error) {
	masked, err := labrastroMaskMarkdownCode(ctx, body)
	if err != nil {
		return nil, err
	}
	var spans []labrastroPathSpan
	offset := 0
	for line := range strings.SplitAfterSeq(masked, "\n") {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if m := labrastroReferenceDefinition.FindStringSubmatchIndex(line); m != nil {
			a, b := m[2], m[3]
			if line[a] == '<' {
				a++
				b--
			}
			spans = append(spans, labrastroPathSpan{offset + a, offset + b})
		}
		closers := labrastroMarkdownBacktickClosers(line)
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
				if b := closers[i]; b > 0 {
					a := i + n
					token := line[a:b]
					if token != "" && !strings.ContainsAny(token, " \t\n\r") {
						spans = append(spans, labrastroPathSpan{offset + a, offset + b})
					}
					i = b + n - 1
				} else {
					i += n - 1
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
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return spans, nil
}

type labrastroRepoLookup func(context.Context, string) (githubTreeEntry, bool, error)
type labrastroRepoFetch func(context.Context, string) ([]byte, error)

type labrastroReferenceCompletion struct {
	result                  *importedSkill
	skillDir, primary       string
	lookup                  labrastroRepoLookup
	fetch                   labrastroRepoFetch
	bodies, outputs, owners map[string]string
	queue                   []string
}

func labrastroCompleteReferences(ctx context.Context, result *importedSkill, skillDir string, lookup labrastroRepoLookup, fetch labrastroRepoFetch) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	primary := path.Join(skillDir, "SKILL.md")
	if entry, ok, err := lookup(ctx, primary); err != nil {
		return err
	} else if ok && !labrastroRegularBlob(entry) {
		return labrastroImportFailure("filtered_reference", primary, primary, fmt.Errorf("SKILL.md must be a regular file"), false)
	}
	r := &labrastroReferenceCompletion{
		result: result, skillDir: skillDir, primary: primary, lookup: lookup, fetch: fetch,
		bodies: map[string]string{primary: result.content}, outputs: map[string]string{primary: "SKILL.md"},
		owners: map[string]string{"SKILL.md": primary}, queue: []string{primary},
	}
	for _, f := range result.files {
		p := path.Join(skillDir, f.path)
		r.bodies[p], r.outputs[p], r.owners[f.path] = f.content, f.path, p
		r.queue = append(r.queue, p)
	}
	for cursor := 0; cursor < len(r.queue); cursor++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := r.rewrite(ctx, r.queue[cursor]); err != nil {
			return err
		}
	}
	return r.finish(ctx)
}

func (r *labrastroReferenceCompletion) diagnostic(code, src, target, msg string) {
	r.result.diagnostics = append(r.result.diagnostics, SkillImportDiagnostic{Code: code, Path: src, Target: target, Message: msg})
}

func (r *labrastroReferenceCompletion) rewrite(ctx context.Context, src string) error {
	ext := strings.ToLower(path.Ext(src))
	if ext != ".md" && ext != ".mdx" {
		return nil
	}
	body := r.bodies[src]
	spans, err := labrastroMarkdownPaths(ctx, body)
	if err != nil {
		if isCapError(err) {
			return labrastroImportFailure("limit_exceeded", src, "", err, false)
		}
		return err
	}
	var out strings.Builder
	last := 0
	for _, span := range spans {
		if err := ctx.Err(); err != nil {
			return err
		}
		if span.start < last {
			continue
		}
		replacement, replace, err := r.reference(ctx, src, body[span.start:span.end])
		if err != nil {
			return err
		}
		if !replace {
			continue
		}
		out.WriteString(body[last:span.start])
		out.WriteString(replacement)
		last = span.end
	}
	if last > 0 {
		out.WriteString(body[last:])
		r.bodies[src] = out.String()
	}
	return r.checkBudget()
}

func (r *labrastroReferenceCompletion) resolve(ctx context.Context, src, targetPart string) (string, githubTreeEntry, bool, error) {
	var entry githubTreeEntry
	if targetPart == "" || strings.ContainsAny(targetPart, ":?\n\r") || strings.HasPrefix(targetPart, "//") {
		return "", entry, false, nil
	}
	decoded, err := url.PathUnescape(targetPart)
	if err != nil {
		return "", entry, false, nil
	}
	decoded = strings.NewReplacer(`\(`, "(", `\)`, ")", `\ `, " ").Replace(decoded)
	if strings.HasPrefix(decoded, "/") || strings.Contains(decoded, "\\") {
		return "", entry, false, nil
	}
	target := path.Clean(path.Join(path.Dir(src), decoded))
	if !labrastroSafeRepoPath(target) {
		r.diagnostic("path_outside_repository", src, target, "reference leaves the repository; left unchanged")
		return target, entry, false, nil
	}
	entry, exists, err := r.lookup(ctx, target)
	if err != nil {
		return target, entry, false, labrastroImportFailure("tree_unavailable", src, target, err, true)
	}
	if !exists {
		return target, entry, false, nil
	}
	// Local directories already retain their layout and support files.
	if entry.Type == "tree" && labrastroInside(src, r.skillDir) && (target == r.skillDir || labrastroInside(target, r.skillDir)) {
		return target, entry, false, nil
	}
	if !labrastroRegularBlob(entry) || !labrastroTextPath(target) {
		r.diagnostic("filtered_reference", src, target, "symlink, submodule, directory or filtered asset; left unchanged")
		return target, entry, false, nil
	}
	if strings.EqualFold(path.Base(target), "SKILL.md") && target != r.primary {
		r.diagnostic("cross_skill_reference", src, target, "another skill is not copied; left unchanged")
		return target, entry, false, nil
	}
	return target, entry, true, nil
}

func (r *labrastroReferenceCompletion) reference(ctx context.Context, src, raw string) (string, bool, error) {
	targetPart, anchor, hasAnchor := strings.Cut(raw, "#")
	target, entry, exists, err := r.resolve(ctx, src, targetPart)
	if err != nil || !exists {
		return "", false, err
	}
	dest := target
	if r.skillDir != "" {
		dest = strings.TrimPrefix(target, r.skillDir+"/")
	}
	if !labrastroInside(target, r.skillDir) {
		dest = path.Join("_shared", target)
	}
	if copied, err := r.copyReference(ctx, src, target, dest, entry); err != nil || !copied {
		return "", false, err
	}
	// Recalculate even for a back-reference to the original skill.
	rel, err := filepath.Rel(path.Dir(r.outputs[src]), dest)
	if err != nil {
		return "", false, err
	}
	rel = filepath.ToSlash(rel)
	if r.outputs[src] == strings.TrimPrefix(src, r.skillDir+"/") && labrastroInside(target, r.skillDir) {
		return "", false, nil
	}
	if strings.ContainsAny(targetPart, "%\\") {
		rel = (&url.URL{Path: rel}).EscapedPath()
	}
	if hasAnchor {
		rel += "#" + anchor
	}
	return rel, true, nil
}

func (r *labrastroReferenceCompletion) copyReference(ctx context.Context, src, target, dest string, entry githubTreeEntry) (bool, error) {
	if _, ok := r.bodies[target]; ok {
		return true, nil
	}
	if len(r.bodies)-1 >= maxImportFileCount || entry.size() > maxImportFileSize {
		return false, labrastroImportFailure("limit_exceeded", src, target, fmt.Errorf("%w: reference exceeds bundle limits", errImportCapExceeded), false)
	}
	data, err := r.fetch(ctx, target)
	if err != nil {
		return false, labrastroImportFailure("required_reference_unavailable", src, target, fmt.Errorf("required reference %s: %w", target, err), !isCapError(err))
	}
	if !utf8.Valid(data) || strings.ContainsRune(string(data), '\x00') {
		r.diagnostic("filtered_reference", src, target, "binary content is not copied; left unchanged")
		return false, nil
	}
	if old, ok := r.owners[dest]; ok && r.bodies[old] != string(data) {
		return false, labrastroImportFailure("shared_path_conflict", src, dest, fmt.Errorf("shared file conflicts with existing output %s", dest), false)
	}
	r.bodies[target], r.outputs[target], r.owners[dest] = string(data), dest, target
	r.queue = append(r.queue, target)
	return true, nil
}

func (r *labrastroReferenceCompletion) checkBudget() error {
	// Enforce the final rewritten budget while expanding the closure.
	var size int
	for p, b := range r.bodies {
		if len(b) > maxImportFileSize {
			return fmt.Errorf("%w: rewritten %s exceeds file limit", errImportCapExceeded, p)
		}
		if p != r.primary {
			size += len(b)
		}
	}
	if size > maxImportTotalSize {
		return fmt.Errorf("%w: completed bundle exceeds byte limit", errImportCapExceeded)
	}
	return nil
}

func (r *labrastroReferenceCompletion) finish(ctx context.Context) error {
	files := map[string]string{}
	for src, body := range r.bodies {
		if src == r.primary {
			continue
		}
		dest := r.outputs[src]
		if old, ok := files[dest]; ok && old != body {
			return labrastroImportFailure("shared_path_conflict", src, dest, fmt.Errorf("rewritten shared file conflicts at %s", dest), false)
		}
		files[dest] = body
	}
	r.result.content, r.result.files, r.result.bundleSize = r.bodies[r.primary], nil, 0
	keys := make([]string, 0, len(files))
	for p := range files {
		keys = append(keys, p)
	}
	sort.Strings(keys)
	for _, p := range keys {
		if !validateFilePath(p) {
			return fmt.Errorf("unsafe output path %s", p)
		}
		if err := r.result.addFile(p, files[p]); err != nil {
			return err
		}
	}
	return ctx.Err()
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
