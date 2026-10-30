package service

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestMediaRouting(t *testing.T) {
	user := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	now := time.Now()
	runtime := func(provider string, used float64) db.AgentRuntime {
		quota, _ := json.Marshal(protocol.RuntimePlanQuota{Status: "ok", Windows: []protocol.RuntimePlanQuotaWindow{{Name: "primary", UsedPercent: &used}}})
		capability := "image-generate"
		if provider == "flow" {
			capability = "video-generate"
		}
		if provider == "whisk" {
			capability = "image-remix"
		}
		metadata, _ := json.Marshal(map[string]any{"capabilities": []string{protocol.MediaCapabilityTag(protocol.MediaProvider(provider), capability)}})
		return db.AgentRuntime{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, OwnerID: user, Provider: provider, Status: "online", Metadata: metadata, PlanQuota: quota}
	}
	req := protocol.MediaRequest{Provider: "auto", Capability: "image-generate"}
	if SelectMediaRuntime(nil, user, req, now) != nil {
		t.Fatal("empty candidates")
	}
	one := runtime("codex", 0)
	if got := SelectMediaRuntime([]db.AgentRuntime{one}, user, req, now); got == nil || got.ID != one.ID {
		t.Fatal("one available runtime")
	}
	many := make([]db.AgentRuntime, 10)
	for i := range many {
		many[i] = runtime("codex", float64(99-i))
	}
	if got := SelectMediaRuntime(many, user, req, now); got == nil || got.ID != many[9].ID {
		t.Fatal("ten runtime ranking")
	}
	exhausted := runtime("codex", 100)
	agy := runtime("antigravity", 50)
	if got := SelectMediaRuntime([]db.AgentRuntime{exhausted, agy}, user, req, now); got == nil || got.ID != agy.ID {
		t.Fatal("auto must cross providers")
	}
	req.Provider = "codex"
	if SelectMediaRuntime([]db.AgentRuntime{exhausted, agy}, user, req, now) != nil {
		t.Fatal("explicit provider must not cross providers")
	}
	req.Provider = "auto"
	for _, mode := range []string{"unowned", "private", "offline", "cooldown", "wrong capability", "worst window"} {
		t.Run(mode, func(t *testing.T) {
			bad := one
			switch mode {
			case "unowned":
				bad.OwnerID = pgtype.UUID{}
			case "private":
				bad.OwnerID = pgtype.UUID{Bytes: uuid.New(), Valid: true}
				bad.Visibility = "private"
			case "offline":
				bad.Status = "offline"
			case "cooldown":
				bad.Metadata = []byte(fmt.Sprintf(`{"capabilities":["media-image-codex-v1"],"media_cooldowns":{"media-image-codex-v1":%d}}`, now.Add(time.Minute).Unix()))
			case "wrong capability":
				bad.Metadata = []byte(`{"capabilities":["media-video-flow-v1"]}`)
			case "worst window":
				bad.PlanQuota = []byte(`{"windows":[{"name":"primary","used_percent":0},{"name":"weekly","used_percent":100}]}`)
			}
			if SelectMediaRuntime([]db.AgentRuntime{bad}, user, req, now) != nil {
				t.Fatal("ineligible candidate selected")
			}
		})
	}
	agy.PlanQuota = []byte(`{"windows":[{"name":"gemini","group":"gemini","used_percent":0},{"name":"claude","group":"claude_gpt","used_percent":100}]}`)
	if SelectMediaRuntime([]db.AgentRuntime{agy}, user, req, now) == nil {
		t.Fatal("unrelated agy pool blocked image")
	}
	if until := MediaCooldown(agy, "media-image-agy-v1", 90, now); !until.Equal(now.Add(90 * time.Second)) {
		t.Fatal("Retry-After not honored")
	}
	reset := now.Add(2 * time.Hour).Unix()
	agy.PlanQuota = []byte(fmt.Sprintf(`{"windows":[{"group":"gemini","resets_at":%d}]}`, reset))
	if MediaCooldown(agy, "media-image-agy-v1", 0, now).Unix() != reset {
		t.Fatal("quota reset not used")
	}
	if MediaCooldown(one, "media-image-codex-v1", 0, now).Sub(now) != time.Minute {
		t.Fatal("fallback cooldown")
	}
}
