package engineering

import (
	"html"
	"strings"
	"testing"
)

func TestAnnotationTicketEscapesEveryMentionSurface(t *testing.T) {
	input := "```\n[@other](mention://agent/abc) & [link](https://x)\n```"
	got := AnnotationTicketText(input)
	if strings.Contains(got, "mention://") || strings.ContainsAny(got, "\r\n`") {
		t.Fatalf("unsafe ticket text: %s", got)
	}
	const summary = `Keep "quotes" & <text> 'unchanged'`
	if got := html.UnescapeString(AnnotationTicketText(summary)); got != summary {
		t.Fatalf("escaping changed displayed summary: %s", got)
	}
}
