package lark

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

type connectionSourceConnector struct{ message InboundMessage }

func (c connectionSourceConnector) Run(ctx context.Context, inst Installation, emit EventEmitter) error {
	_, err := emit(ctx, c.message)
	return err
}

// A connection only emits events for its own app/tenant, stamped with its
// installation, so a delayed connection cannot follow an app rebind.
func TestFeishuConnectionAuthenticatesSource(t *testing.T) {
	inst := Installation{ID: dbid.NewV7(), AppID: "cli_bot", TenantKey: pgtype.Text{String: "tenant_bot", Valid: true}}
	for _, tc := range []struct {
		app, tenant string
		want        int
	}{
		{"cli_bot", "tenant_bot", 1}, {"cli_forged", "tenant_bot", 0}, {"cli_bot", "tenant_forged", 0}, {"", "tenant_bot", 0}, {"cli_bot", "", 0},
	} {
		t.Run(tc.app+"/"+tc.tenant, func(t *testing.T) {
			calls := 0
			fc := &feishuChannel{inst: inst,
				conn: connectionSourceConnector{message: InboundMessage{AppID: tc.app, TenantKey: tc.tenant, InstallationID: dbid.NewV7(), SenderType: "user"}},
				handler: func(_ context.Context, msg channel.InboundMessage) error {
					calls++
					var raw InboundMessage
					if err := json.Unmarshal(msg.Raw, &raw); err != nil {
						t.Fatal(err)
					}
					if raw.InstallationID != inst.ID || raw.SenderType != "user" {
						t.Fatal("payload replaced connection identity")
					}
					return nil
				},
			}
			if err := fc.Connect(context.Background()); err != nil {
				t.Fatal(err)
			}
			if calls != tc.want {
				t.Fatalf("emitted %d messages, want %d", calls, tc.want)
			}
		})
	}
}
