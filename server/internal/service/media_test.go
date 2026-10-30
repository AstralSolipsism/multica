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

func TestMediaBrowserSourcesIgnoreHostQuota(t *testing.T) {
	now := time.Unix(1800000000, 0)
	user := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	for _, source := range []string{"flow", "whisk"} {
		capability := "video-generate"
		if source == "whisk" {
			capability = "image-remix"
		}
		tag := protocol.MediaCapabilityTag(source, capability)
		metadata, _ := json.Marshal(map[string]any{"capabilities": []string{tag}})
		for _, snapshot := range []struct{ name, quota string }{
			{"claude full", `{"status":"limited","windows":[{"group":"claude_gpt","used_percent":100,"resets_at":1800018000},{"group":"gemini","used_percent":25,"resets_at":1800018000}]}`},
			{"gemini full", `{"status":"limited","windows":[{"group":"gemini","used_percent":100,"resets_at":1800018000},{"group":"claude_gpt","used_percent":25,"resets_at":1800018000}]}`},
			{"host quota available", `{"status":"ok","windows":[{"group":"gemini","used_percent":0,"resets_at":1800018000}]}`},
			{"limited without windows", `{"status":"limited","windows":[]}`},
		} {
			t.Run(source+"/"+snapshot.name, func(t *testing.T) {
				rt := db.AgentRuntime{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, OwnerID: user, Provider: "antigravity", Status: "online", Metadata: metadata, PlanQuota: []byte(snapshot.quota)}
				var quota protocol.RuntimePlanQuota
				if err := json.Unmarshal(rt.PlanQuota, &quota); err != nil {
					t.Fatal(err)
				}
				if score, usable := mediaQuotaScore(quota, source, now); score != -1 || !usable {
					t.Errorf("host quota must be unknown for %s: score=%v usable=%v", source, score, usable)
				}
				for _, provider := range []string{source, "auto"} {
					selected := SelectMediaRuntime([]db.AgentRuntime{rt}, user, protocol.MediaRequest{Provider: provider, Capability: capability}, now)
					if selected == nil || selected.ID != rt.ID || selected.Tag != tag {
						t.Errorf("%s/%s rejected because of host model quota", provider, capability)
					}
				}
				if until := MediaCooldown(rt, tag, 0, now); !until.Equal(now.Add(time.Minute)) {
					t.Errorf("host reset leaked into cooldown: %v", until.Sub(now))
				}
				if until := MediaCooldown(rt, tag, 90, now); !until.Equal(now.Add(90 * time.Second)) {
					t.Errorf("Retry-After ignored: %v", until.Sub(now))
				}
				rt.Metadata = []byte(fmt.Sprintf(`{"capabilities":[%q],"media_cooldowns":{%q:%d}}`, tag, tag, now.Add(time.Minute).Unix()))
				if SelectMediaRuntime([]db.AgentRuntime{rt}, user, protocol.MediaRequest{Provider: source, Capability: capability}, now) != nil {
					t.Fatal("unknown quota bypassed explicit media cooldown")
				}
			})
		}
	}
}

func TestMediaQuotaUsesOnlySourceWindows(t *testing.T) {
	now := time.Unix(1800000000, 0)
	for _, tc := range []struct {
		name, source, quota string
		score               float64
		usable              bool
		cooldown            time.Duration
	}{
		{"codex all groups", "codex", `{"windows":[{"group":"other","used_percent":75,"resets_at":1800007200}]}`, 25, true, 2 * time.Hour},
		{"codex full", "codex", `{"windows":[{"used_percent":100,"resets_at":1800007200}]}`, 0, false, 2 * time.Hour},
		{"codex account limited", "codex", `{"status":"limited"}`, 0, false, time.Minute},
		{"agy ignores exhausted claude and aggregate status", "agy", `{"status":"limited","windows":[{"group":"claude_gpt","used_percent":100,"resets_at":1800003600},{"group":"gemini","used_percent":25,"resets_at":1800007200}]}`, 75, true, 2 * time.Hour},
		{"agy gemini full", "agy", `{"windows":[{"group":"gemini","used_percent":100,"resets_at":1800007200}]}`, 0, false, 2 * time.Hour},
		{"agy ignores ungrouped window", "agy", `{"windows":[{"used_percent":100,"resets_at":1800007200}]}`, -1, true, time.Minute},
		{"agy no applicable window", "agy", `{"status":"limited","windows":[{"group":"claude_gpt","used_percent":100,"resets_at":1800003600}]}`, -1, true, time.Minute},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var quota protocol.RuntimePlanQuota
			if err := json.Unmarshal([]byte(tc.quota), &quota); err != nil {
				t.Fatal(err)
			}
			if score, usable := mediaQuotaScore(quota, tc.source, now); score != tc.score || usable != tc.usable {
				t.Errorf("score=%v usable=%v; want %v, %v", score, usable, tc.score, tc.usable)
			}
			rt := db.AgentRuntime{PlanQuota: []byte(tc.quota)}
			if until := MediaCooldown(rt, protocol.MediaCapabilityTag(tc.source, "image-generate"), 0, now); !until.Equal(now.Add(tc.cooldown)) {
				t.Errorf("cooldown=%v; want %v", until.Sub(now), tc.cooldown)
			}
		})
	}
}

func TestMediaMeasuredQuotaRanksAheadOfUnknown(t *testing.T) {
	user := pgtype.UUID{Bytes: uuid.New(), Valid: true}
	unknown := db.AgentRuntime{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, OwnerID: user, Provider: "antigravity", Status: "online", Metadata: []byte(`{"capabilities":["media-image-agy-v1"]}`), PlanQuota: []byte(`{"windows":[{"group":"claude_gpt","used_percent":0}]}`)}
	measured := db.AgentRuntime{ID: pgtype.UUID{Bytes: uuid.New(), Valid: true}, OwnerID: user, Provider: "codex", Status: "online", Metadata: []byte(`{"capabilities":["media-image-codex-v1"]}`), PlanQuota: []byte(`{"windows":[{"used_percent":99}]}`)}
	for _, candidates := range [][]db.AgentRuntime{{unknown, measured}, {measured, unknown}} {
		selected := SelectMediaRuntime(candidates, user, protocol.MediaRequest{Provider: "auto", Capability: "image-generate"}, time.Now())
		if selected == nil || selected.ID != measured.ID {
			t.Fatal("unknown capacity ranked ahead of measured remaining quota")
		}
	}
}
