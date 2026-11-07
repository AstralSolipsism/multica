package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/spf13/cobra"
)

// Carrier-issue annotation access (design 5.2/5.3/9.3): pull exactly one batch
// on demand; failures never echo annotation or response bodies.

type baselineBatchSummary struct {
	ID      string `json:"id"`
	Chapter string `json:"chapter"`
	State   string `json:"state"`
	Carrier struct {
		Kind       string `json:"kind"`
		IssueID    string `json:"issue_id"`
		Identifier string `json:"identifier"`
	} `json:"carrier"`
	Working *struct {
		RevisionID     string `json:"revision_id"`
		RevisionNumber int32  `json:"revision_number"`
		Status         string `json:"status"`
	} `json:"working"`
	Counts struct {
		Open     int `json:"open"`
		Resolved int `json:"resolved"`
	} `json:"counts"`
}

type baselineAnnotationItem struct {
	ID                   string  `json:"id"`
	Ordinal              int32   `json:"ordinal"`
	ParentAnnotationID   *string `json:"parent_annotation_id"`
	AnchorKind           string  `json:"anchor_kind"`
	SectionAnchor        string  `json:"section_anchor"`
	SectionTitle         string  `json:"section_title"`
	TargetRevisionID     string  `json:"target_revision_id"`
	TargetRevisionNumber int32   `json:"target_revision_number"`
	Side                 string  `json:"side"`
	LineStart            *int32  `json:"line_start"`
	LineEnd              *int32  `json:"line_end"`
	Quote                string  `json:"quote"`
	Note                 string  `json:"note"`
	Response             *string `json:"response"`
	State                string  `json:"state"`
	Location             string  `json:"location"`
	Located              *struct {
		RevisionNumber int32 `json:"revision_number"`
		LineStart      *int  `json:"line_start"`
		LineEnd        *int  `json:"line_end"`
	} `json:"located"`
	CreatedByID string `json:"created_by_id"`
}

type baselineAnnotationsPayload struct {
	Batch   baselineBatchSummary `json:"batch"`
	Reviews []struct {
		ID      string `json:"id"`
		Summary string `json:"summary"`
	} `json:"reviews"`
	Annotations []baselineAnnotationItem `json:"annotations"`
	Sections    []struct {
		Chapter         string `json:"chapter"`
		Anchor          string `json:"anchor"`
		ContentMarkdown string `json:"content_markdown"`
	} `json:"sections"`
}

// A batch UUID is usable directly; an issue identifier resolves through the
// chapter's single active batch (I3), so no listing of all batches is exposed.
func baselineResolveBatch(ctx context.Context, client *cli.APIClient, project, input string) (string, error) {
	trimmed := strings.TrimSpace(input)
	if uuidRegexp.MatchString(trimmed) {
		return trimmed, nil
	}
	issue := trimmed
	if looksLikeIssueIdentifier(trimmed) {
		ref, err := fetchIssueRef(ctx, client, trimmed)
		if err != nil {
			return "", baselineRequestError(err, false)
		}
		issue = ref.ID
	}
	if !uuidRegexp.MatchString(issue) {
		return "", baselineFailure(2, "--batch must be the batch UUID or the carrier issue identifier")
	}
	var listed struct {
		Batches []baselineBatchSummary `json:"batches"`
	}
	path := "/api/projects/" + project + "/baseline/annotation-batches?" +
		url.Values{"issue_id": {issue}, "state": {"active"}}.Encode()
	if err := client.GetJSON(ctx, path, &listed); err != nil {
		return "", baselineRequestError(err, false)
	}
	matches := []string{}
	chapters := []string{}
	for _, b := range listed.Batches {
		if b.Carrier.IssueID == issue && b.State == "active" {
			matches = append(matches, b.ID)
			chapters = append(chapters, fmt.Sprintf("%s (%s…)", b.Chapter, baselineShortID(b.ID)))
		}
	}
	// One carrier issue can hold the active batch of several chapters (I3 is
	// per chapter); refuse to silently pick one of them.
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) > 1 {
		return "", baselineFailure(2, "carrier %s has %d open annotation batches: %s; pass the batch UUID", trimmed, len(matches), strings.Join(chapters, ", "))
	}
	return "", baselineFailure(2, "no open annotation batch on carrier %s", trimmed)
}

func baselineAnnotations(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, project string) error {
	batch, err := baselineResolveBatch(ctx, client, project, mustString(cmd, "batch"))
	if err != nil {
		return err
	}
	query := url.Values{"state": {mustString(cmd, "state")}}
	if withSections, _ := cmd.Flags().GetBool("with-sections"); withSections {
		query.Set("with_sections", "true")
	}
	var raw json.RawMessage
	path := "/api/projects/" + project + "/baseline/annotation-batches/" + batch + "?" + query.Encode()
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return baselineRequestError(err, false)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var payload baselineAnnotationsPayload
	if err := json.Unmarshal(raw, &payload); err != nil || !uuidRegexp.MatchString(payload.Batch.ID) {
		return baselineFailure(1, "invalid annotation batch response")
	}
	baselinePrintAnnotations(ctx, cmd, client, payload)
	return nil
}

func baselineShortID(id string) string {
	short := strings.ReplaceAll(id, "-", "")
	if len(short) > 8 {
		return short[:8]
	}
	return short
}

func baselineAnnotationLines(a baselineAnnotationItem) (int, int) {
	// Target-version line numbers (line_start/line_end); relocated lines from
	// `located` are only for the parenthetical note, never the header.
	if a.LineStart != nil {
		end := *a.LineStart
		if a.LineEnd != nil {
			end = *a.LineEnd
		}
		return int(*a.LineStart), int(end)
	}
	return 0, 0
}

func baselineLocatedLines(a baselineAnnotationItem) (int, int, bool) {
	if a.Located == nil || a.Located.LineStart == nil {
		return 0, 0, false
	}
	end := *a.Located.LineStart
	if a.Located.LineEnd != nil {
		end = *a.Located.LineEnd
	}
	return *a.Located.LineStart, end, true
}

func baselinePrintAnnotations(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, p baselineAnnotationsPayload) {
	w := cmd.OutOrStdout()
	b := p.Batch
	working := "无"
	if b.Working != nil {
		working = fmt.Sprintf("%s v%d", b.Working.Status, b.Working.RevisionNumber)
	}
	carrier := b.Carrier.Identifier
	if carrier == "" && b.Carrier.IssueID != "" {
		carrier = baselineShortID(b.Carrier.IssueID)
	}
	if carrier != "" {
		fmt.Fprintf(w, "批注批次 %s…（承载 %s）· %s · 工作版本 %s · 未解决 %d/%d\n",
			baselineShortID(b.ID), carrier, b.Chapter, working, b.Counts.Open, b.Counts.Open+b.Counts.Resolved)
	} else {
		fmt.Fprintf(w, "批注批次 %s… · %s · 工作版本 %s · 未解决 %d/%d\n",
			baselineShortID(b.ID), b.Chapter, working, b.Counts.Open, b.Counts.Open+b.Counts.Resolved)
	}
	// Reviews arrive oldest-first; append reviews carry their own summaries
	// (the wake comment itself does not), so list every non-empty one.
	for i, review := range p.Reviews {
		if strings.TrimSpace(review.Summary) == "" {
			continue
		}
		if i == 0 {
			fmt.Fprintf(w, "总体说明：%s\n", review.Summary)
		} else {
			fmt.Fprintf(w, "总体说明（第 %d 次审阅）：%s\n", i+1, review.Summary)
		}
	}
	if len(p.Annotations) == 0 {
		fmt.Fprintln(w, "（无未解决批注）")
		return
	}
	fmt.Fprintln(w)
	replies := map[string][]baselineAnnotationItem{}
	authors := map[string]bool{}
	for _, a := range p.Annotations {
		if a.ParentAnnotationID == nil {
			continue
		}
		replies[*a.ParentAnnotationID] = append(replies[*a.ParentAnnotationID], a)
		authors[a.CreatedByID] = true
	}
	names := map[string]string{}
	if len(authors) > 0 {
		lookup := loadActorDisplayLookup(ctx, client)
		for id := range authors {
			names[id] = strings.TrimPrefix(lookup.actor("member", id), "member:")
		}
	}
	for _, a := range p.Annotations {
		if a.ParentAnnotationID != nil {
			continue
		}
		var head strings.Builder
		fmt.Fprintf(&head, "[A%d]", a.Ordinal)
		if a.SectionAnchor != "" {
			head.WriteString(" " + a.SectionAnchor)
		}
		if a.SectionTitle != "" && a.SectionTitle != a.SectionAnchor {
			head.WriteString(" " + a.SectionTitle)
		}
		// The server derives side from the target revision; a working-version
		// match is not the criterion (design 5.3).
		side := "改动后"
		if a.Side == "before" {
			side = "改动前"
		}
		switch a.AnchorKind {
		case "lines":
			start, end := baselineAnnotationLines(a)
			if end > start {
				fmt.Fprintf(&head, " · %s v%d 第 %d–%d 行", side, a.TargetRevisionNumber, start, end)
			} else {
				fmt.Fprintf(&head, " · %s v%d 第 %d 行", side, a.TargetRevisionNumber, start)
			}
			head.WriteString(" · 定位 " + a.Location)
			// The server also returns located lines for exact same-version
			// annotations; only moved ones carry the relocation note (5.2).
			if a.Location == "moved" {
				if relocatedStart, relocatedEnd, ok := baselineLocatedLines(a); ok {
					if relocatedEnd > relocatedStart {
						fmt.Fprintf(&head, "（已在 v%d 第 %d–%d 行重新定位）", a.Located.RevisionNumber, relocatedStart, relocatedEnd)
					} else {
						fmt.Fprintf(&head, "（已在 v%d 第 %d 行重新定位）", a.Located.RevisionNumber, relocatedStart)
					}
				}
			}
		case "text":
			// Text selections are created in reading mode on the base version.
			fmt.Fprintf(&head, " · 正本 v%d 选中文字 · 定位 %s", a.TargetRevisionNumber, a.Location)
			if a.Location == "moved" && a.Located != nil {
				fmt.Fprintf(&head, "（已在 v%d 重新定位）", a.Located.RevisionNumber)
			}
		case "section":
			head.WriteString(" · 整节")
			if a.Location != "exact" {
				head.WriteString(" · 定位 " + a.Location)
			}
		}
		if a.State != "open" {
			if a.State == "archived" {
				head.WriteString(" · 已归档")
			} else {
				head.WriteString(" · 已解决")
			}
		}
		fmt.Fprintln(w, head.String())
		if a.Quote != "" {
			fmt.Fprintf(w, "  原文：%s\n", a.Quote)
		}
		fmt.Fprintf(w, "  批注：%s\n", a.Note)
		for _, reply := range replies[a.ID] {
			fmt.Fprintf(w, "  ↳ 回复（%s）：%s\n", names[reply.CreatedByID], reply.Note)
		}
		if a.Response != nil {
			fmt.Fprintf(w, "  ↳ 智能体回应（上轮）：%s\n", *a.Response)
		}
	}
	if len(p.Sections) > 0 {
		fmt.Fprintln(w, "\n--with-sections：以下为被批注小节子树（来自工作版本，已去重）")
		for _, s := range p.Sections {
			fmt.Fprintf(w, "<!-- %s [%s] -->\n", s.Chapter, s.Anchor)
			fmt.Fprintln(w, strings.TrimRight(s.ContentMarkdown, "\n"))
		}
	}
}

type baselineResponseEntry struct {
	Annotation string
	Response   string
}

func baselineRespond(ctx context.Context, cmd *cobra.Command, client *cli.APIClient, project string) error {
	content, err := readProjectInputFile(mustString(cmd, "responses-file"), "responses-file", 1<<20)
	if err != nil {
		return err
	}
	var entries []baselineResponseEntry
	if err := json.Unmarshal([]byte(content), &entries); err != nil || len(entries) < 1 || len(entries) > 50 {
		return baselineFailure(2, "--responses-file must be a JSON array of 1–50 {\"annotation\", \"response\"} objects")
	}
	seen := map[string]bool{}
	ordinals := map[int32]string{}
	for _, e := range entries {
		target := strings.TrimSpace(e.Annotation)
		if !uuidRegexp.MatchString(target) {
			n, ok := baselineAnnotationOrdinal(target)
			if !ok {
				return baselineFailure(2, "annotation reference must be \"A<ordinal>\" or a UUID")
			}
			ordinals[n] = ""
		}
		n := utf8.RuneCountInString(e.Response)
		if !utf8.ValidString(e.Response) || strings.ContainsRune(e.Response, 0) || n < 1 || n > 1000 {
			return baselineFailure(2, "each response must contain 1–1000 characters of UTF-8 text")
		}
	}
	batch := strings.ToLower(strings.TrimSpace(mustString(cmd, "batch")))
	// Always read the batch once: ordinal resolution needs it, and UUID
	// references must be checked against this batch so a cross-batch UUID
	// fails locally instead of being written blind. The regexp accepts
	// uppercase; the server returns lowercase.
	var raw json.RawMessage
	path := "/api/projects/" + project + "/baseline/annotation-batches/" + batch + "?state=all"
	if err := client.GetJSON(ctx, path, &raw); err != nil {
		return baselineRequestError(err, false)
	}
	var payload baselineAnnotationsPayload
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Batch.ID != batch {
		return baselineFailure(1, "invalid annotation batch response")
	}
	known := map[string]bool{}
	for _, a := range payload.Annotations {
		known[a.ID] = true
		if _, wanted := ordinals[a.Ordinal]; wanted {
			ordinals[a.Ordinal] = a.ID
		}
	}
	responses := make([]map[string]string, 0, len(entries))
	for _, e := range entries {
		id := strings.ToLower(strings.TrimSpace(e.Annotation))
		if !uuidRegexp.MatchString(id) {
			n, _ := baselineAnnotationOrdinal(id)
			id = ordinals[n]
			if id == "" {
				return baselineFailure(2, "annotation \"A%d\" is not part of batch %s", n, baselineShortID(batch))
			}
		}
		if !known[id] {
			return baselineFailure(2, "annotation %s is not part of batch %s", baselineShortID(id), baselineShortID(batch))
		}
		if seen[id] {
			return baselineFailure(2, "duplicate annotation reference")
		}
		seen[id] = true
		responses = append(responses, map[string]string{"annotation_id": id, "response": e.Response})
	}
	var posted json.RawMessage
	if err := client.PostJSON(ctx, "/api/projects/"+project+"/baseline/annotations/responses", map[string]any{"responses": responses}, &posted); err != nil {
		return baselineRequestError(err, true)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), posted)
	}
	var result struct {
		Updated int `json:"updated"`
	}
	if json.Unmarshal(posted, &result) != nil {
		return baselineFailure(1, "invalid annotation responses result")
	}
	fmt.Fprintf(cmd.OutOrStdout(), "已提交 %d 条智能体回应（不唤醒任何人）。\n", result.Updated)
	return nil
}

func baselineAnnotationOrdinal(s string) (int32, bool) {
	if len(s) < 2 || s[0] != 'A' && s[0] != 'a' {
		return 0, false
	}
	var n int32
	for _, c := range s[1:] {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int32(c-'0')
		if n > 1<<30 {
			return 0, false
		}
	}
	return n, n >= 1
}
