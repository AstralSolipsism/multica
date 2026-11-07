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
	for _, b := range listed.Batches {
		if b.Carrier.IssueID == issue && b.State == "active" {
			return b.ID, nil
		}
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
	if a.Located != nil && a.Located.LineStart != nil {
		end := *a.Located.LineStart
		if a.Located.LineEnd != nil {
			end = *a.Located.LineEnd
		}
		return *a.Located.LineStart, end
	}
	if a.LineStart != nil {
		end := *a.LineStart
		if a.LineEnd != nil {
			end = *a.LineEnd
		}
		return int(*a.LineStart), int(end)
	}
	return 0, 0
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
	if len(p.Reviews) > 0 && strings.TrimSpace(p.Reviews[0].Summary) != "" {
		fmt.Fprintf(w, "总体说明：%s\n", p.Reviews[0].Summary)
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
		switch a.AnchorKind {
		case "lines":
			start, end := baselineAnnotationLines(a)
			side := "改动前"
			if b.Working != nil && a.TargetRevisionID == b.Working.RevisionID {
				side = "改动后"
			}
			if end > start {
				fmt.Fprintf(&head, " · %s v%d 第 %d–%d 行", side, a.TargetRevisionNumber, start, end)
			} else {
				fmt.Fprintf(&head, " · %s v%d 第 %d 行", side, a.TargetRevisionNumber, start)
			}
			head.WriteString(" · 定位 " + a.Location)
			if a.Location == "moved" && a.Located != nil && a.Located.LineStart != nil {
				end := *a.Located.LineStart
				if a.Located.LineEnd != nil {
					end = *a.Located.LineEnd
				}
				if end > *a.Located.LineStart {
					fmt.Fprintf(&head, "（已在 v%d 第 %d–%d 行重新定位）", a.Located.RevisionNumber, *a.Located.LineStart, end)
				} else {
					fmt.Fprintf(&head, "（已在 v%d 第 %d 行重新定位）", a.Located.RevisionNumber, *a.Located.LineStart)
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
	needOrdinals := false
	for _, e := range entries {
		target := strings.TrimSpace(e.Annotation)
		if !uuidRegexp.MatchString(target) {
			n, ok := baselineAnnotationOrdinal(target)
			if !ok {
				return baselineFailure(2, "annotation reference must be \"A<ordinal>\" or a UUID")
			}
			ordinals[n] = ""
			needOrdinals = true
		}
		n := utf8.RuneCountInString(e.Response)
		if !utf8.ValidString(e.Response) || strings.ContainsRune(e.Response, 0) || n < 1 || n > 1000 {
			return baselineFailure(2, "each response must contain 1–1000 characters of UTF-8 text")
		}
	}
	batch := strings.TrimSpace(mustString(cmd, "batch"))
	if needOrdinals {
		var raw json.RawMessage
		path := "/api/projects/" + project + "/baseline/annotation-batches/" + batch + "?state=all"
		if err := client.GetJSON(ctx, path, &raw); err != nil {
			return baselineRequestError(err, false)
		}
		var payload baselineAnnotationsPayload
		if err := json.Unmarshal(raw, &payload); err != nil || payload.Batch.ID != batch {
			return baselineFailure(1, "invalid annotation batch response")
		}
		for _, a := range payload.Annotations {
			if _, wanted := ordinals[a.Ordinal]; wanted {
				ordinals[a.Ordinal] = a.ID
			}
		}
	}
	responses := make([]map[string]string, 0, len(entries))
	for _, e := range entries {
		id := strings.TrimSpace(e.Annotation)
		if !uuidRegexp.MatchString(id) {
			n, _ := baselineAnnotationOrdinal(id)
			id = ordinals[n]
			if id == "" {
				return baselineFailure(2, "annotation \"A%d\" is not part of batch %s", n, baselineShortID(batch))
			}
		}
		if seen[id] {
			return baselineFailure(2, "duplicate annotation reference")
		}
		seen[id] = true
		responses = append(responses, map[string]string{"annotation_id": id, "response": e.Response})
	}
	var raw json.RawMessage
	if err := client.PostJSON(ctx, "/api/projects/"+project+"/baseline/annotations/responses", map[string]any{"responses": responses}, &raw); err != nil {
		return baselineRequestError(err, true)
	}
	if mustString(cmd, "output") == "json" {
		return cli.PrintJSON(cmd.OutOrStdout(), raw)
	}
	var result struct {
		Updated int `json:"updated"`
	}
	if json.Unmarshal(raw, &result) != nil {
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
