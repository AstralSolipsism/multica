package messagedelivery

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/testutil"
)

// Exercise the persisted comment -> decision -> shard -> Sender boundary. A
// transport receives literal source fragments and one separately typed link,
// including when mention/Markdown/JSON syntax straddles shard boundaries.
func TestCommentDeliveryKeepsUntrustedFragmentsLiteral(t *testing.T) {
	const injection = `<at user_id="all"></at> [x](https://evil.example)`
	for _, long := range []bool{false, true} {
		t.Run(fmt.Sprintf("long=%v", long), func(t *testing.T) {
			ctx := context.Background()
			fx := newSourceFixture(t, "literal-comment")
			resetSourceScanCursors(t)
			fx.approveTeam(t, RouteSourceComment, "oc_literal")
			fx.teamRoute(t, "comment", RouteSourceComment, "oc_literal", nil)
			testFx.Exec(t, `UPDATE issue SET title=$1 WHERE id=$2`, injection, fx.issue)
			testFx.Exec(t, `UPDATE "user" SET name=$1 WHERE id=$2`, injection, fx.memberB)
			body := injection + " " + `"}],[{"tag":"at","user_id":"all"}]`
			if long {
				body = strings.Repeat(body+"多🙂<&\\", 160)
			}
			comment := testFx.Comment(t, fx.issue, body, testutil.Cols{"author_id": fx.memberB})
			sender := &fakeSender{fn: func(req SendRequest) (SendResult, error) {
				return SendResult{ExternalMessageID: "om_literal_" + req.SendUUID}, nil
			}}
			s := newTestService(sender, nil)
			if errs := s.decideSourcesErr(ctx); len(errs) != 0 {
				t.Fatal(errs)
			}
			delivery := sourceRecord(t, s, comment)
			var snapshot contentSnapshot
			if err := json.Unmarshal(delivery.ContentSnapshot, &snapshot); err != nil {
				t.Fatal(err)
			}
			if snapshot.IssueTitle != injection || snapshot.ActorName != injection || snapshot.Body != body {
				t.Fatalf("source fragments lost: %+v", snapshot)
			}
			if ok, err := s.ProcessNext(ctx); err != nil || !ok {
				t.Fatalf("send: processed=%v err=%v", ok, err)
			}
			requests := sender.requests()
			if len(requests) != int(delivery.ShardTotal) || len(requests) == 0 || (long && len(requests) < 2) {
				t.Fatalf("shards sent=%d, frozen total=%d", len(requests), delivery.ShardTotal)
			}
			var slug string
			testFx.QueryRow(t, `SELECT slug FROM workspace WHERE id=$1`, testWSID).Scan(&slug)
			wantSource := s.AppURL + "/" + slug + "/issues/" + snapshot.IssueIdentifier
			var reconstructed strings.Builder
			for i, req := range requests {
				if req.Message.Source != SourceLink(wantSource) || req.ShardIndex != i {
					t.Fatalf("shard %d has wrong source/index: %+v", i, req)
				}
				if !utf8.ValidString(string(req.Message.Body)) || strings.Contains(string(req.Message.Body), wantSource) {
					t.Fatalf("shard %d corrupted text or mixed in a source link", i)
				}
				reconstructed.WriteString(string(req.Message.Body))
			}
			if reconstructed.String() != snapshot.Text || !strings.Contains(reconstructed.String(), injection) {
				t.Fatal("sender did not receive the literal frozen comment")
			}
			if got := sourceRecord(t, s, comment); got.Status != DeliveryStatusSent {
				t.Fatalf("final status=%s", got.Status)
			}
			if count := testFx.Count(t, `SELECT count(*) FROM labrastro_message_receipt WHERE delivery_id=$1 AND external_message_id IS NOT NULL`, delivery.ID); count != len(requests) {
				t.Fatalf("receipts=%d, sent=%d", count, len(requests))
			}
		})
	}
}

func TestMessageShardsSplitBeforeEncoding(t *testing.T) {
	// Splitting just after a backslash or inside <at is harmless: these are
	// literal characters, and each shard gets encoded as its own JSON string.
	for _, suffix := range []string{`\"<&多🙂`, `<at user_id="all"></at>`, `[x](https://evil.example)`} {
		body := strings.Repeat("x", shardRunes-1) + suffix
		message := NewMessage(body, "https://app.example.test/ws/issues/MD-1")
		shards := splitShards(message)
		if len(shards) != 2 || len(string(shards[0].Body)) != shardRunes {
			t.Fatalf("changed frozen shard boundaries: %+v", shards)
		}
		var rebuilt strings.Builder
		for _, shard := range shards {
			if shard.Source != message.Source || !utf8.ValidString(string(shard.Body)) {
				t.Fatalf("source link or UTF-8 split: %+v", shard)
			}
			rebuilt.WriteString(string(shard.Body))
		}
		if rebuilt.String() != body {
			t.Fatal("literal characters changed across shard boundaries")
		}
	}
}
