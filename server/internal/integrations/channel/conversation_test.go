package channel

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestIsConversationTask(t *testing.T) {
	root := pgtype.UUID{Bytes: [16]byte{1}, Valid: true}
	for _, tc := range []struct {
		name, source string
		root         pgtype.UUID
		want         bool
	}{
		{"ordinary", "direct_human", pgtype.UUID{}, false},
		{"ordinary delegation", "delegation", pgtype.UUID{}, false},
		{"root", ConversationOrigin, root, true},
		{"delegation", "delegation", root, true},
		{"retry", "direct_human", root, true},
		{"missing origin", "", root, true},
		{"malformed root", ConversationOrigin, pgtype.UUID{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := db.AgentTaskQueue{ConversationRootTaskID: tc.root, OriginatorSource: pgtype.Text{String: tc.source, Valid: true}}
			if got := IsConversationTask(task); got != tc.want {
				t.Fatalf("IsConversationTask = %t, want %t", got, tc.want)
			}
			_, external := ConversationTaskFromContext(WithConversationTask(context.Background(), task))
			if external != tc.want {
				t.Fatalf("request attribution lost classification: %t", external)
			}
			if !tc.root.Valid {
				_, err := AuthorizeConversationTask(context.Background(), nil, task, pgtype.UUID{})
				if tc.want && !errors.Is(err, ErrConversationDenied) || !tc.want && err != nil {
					t.Fatalf("rootless authorization = %v", err)
				}
			}
		})
	}
}
