package handler

import (
	"fmt"
	"testing"

	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/testutil"
)

// Exercise the real Feishu resolver, both ingress branches and the task service.
// In particular, a member denied by the new upstream gate must not borrow the
// valid external grant that exists on the same installation.
func TestChannelInvocationAuthorityAcrossMemberAndConversationPaths(t *testing.T) {
	for _, tc := range []struct {
		name           string
		bound          bool
		senderIsMember bool
		ownerIsGrantor bool
		publicTarget   string
		allow          bool
	}{
		{"member cannot borrow installer or conversation authority", true, true, true, "", false},
		{"member explicit target", true, true, true, "sender", true},
		{"member outside target list", true, true, true, "grantor", false},
		{"unbound speaker uses private agent grantor", false, false, true, "", true},
		{"notification binding is not execution authority", true, false, true, "", true},
		{"external grantor lost private agent ownership", false, false, false, "", false},
		{"external grantor explicit target", false, false, false, "grantor", true},
		{"external grantor outside target list", false, false, false, "sender", false},
	} {
		for _, chatType := range []channel.ChatType{channel.ChatTypeP2P, channel.ChatTypeGroup} {
			for _, input := range []string{"hello", "/new hello", "/new", "/clear", "/issue private work"} {
				t.Run(fmt.Sprintf("%s/%s/%s", tc.name, chatType, input), func(t *testing.T) {
					f := newConversationFixture(t)
					sender := dbfx.User(t, "Channel sender", f.install+"-sender@example.invalid")
					if tc.senderIsMember {
						// Administration must not bypass private-agent invocation.
						dbfx.Member(t, testWorkspaceID, sender, "admin")
					}
					if tc.bound {
						dbfx.Exec(t, `UPDATE channel_user_binding SET multica_user_id=$2 WHERE id=$1`, f.binding, sender)
						f.msg.Source.SenderID = "ou_bound_member"
					}
					if !tc.ownerIsGrantor {
						dbfx.Exec(t, `UPDATE agent SET owner_id=$2 WHERE id=$1`, f.agent, sender)
					}
					dbfx.Exec(t, `UPDATE agent SET permission_mode='private' WHERE id=$1`, f.agent)
					if tc.publicTarget != "" {
						dbfx.Exec(t, `UPDATE agent SET permission_mode='public_to' WHERE id=$1`, f.agent)
						target := testUserID
						if tc.publicTarget == "sender" {
							target = sender
						}
						dbfx.Insert(t, "agent_invocation_target", testutil.Cols{
							"agent_id": f.agent, "target_type": "member", "target_id": target,
						})
					}
					f.msg.Source.ChatType = chatType
					f.msg.Text, f.msg.CommandText = input, input
					f.msg.ReplyTo = nil
					// Fixture inserts choose numbers directly; the real /issue path
					// allocates from the workspace counter.
					dbfx.Exec(t, `UPDATE workspace SET issue_counter=GREATEST(issue_counter,
					 (SELECT COALESCE(max(number),0) FROM issue WHERE workspace_id=$1)) WHERE id=$1`, testWorkspaceID)
					dbfx.Cleanup(t, `DELETE FROM issue WHERE assignee_id=$1 AND id<>$2`, f.agent, f.issue)
					f.ingest(t)
					f.ingest(t) // A redelivery cannot create an extra run or session.
					inputs, runs, _ := f.counts(t)
					sessions := dbfx.Count(t, `SELECT count(*) FROM chat_session WHERE agent_id=$1`, f.agent)
					issues := dbfx.Count(t, `SELECT count(*) FROM issue WHERE assignee_id=$1 AND id<>$2`, f.agent, f.issue)
					if !tc.allow {
						if inputs != 0 || runs != 0 || sessions != 0 || issues != 0 {
							t.Fatalf("denied turn persisted input/run/session/issue = %d/%d/%d/%d", inputs, runs, sessions, issues)
						}
						return
					}
					if sessions != 1 {
						t.Fatalf("authorized turn has %d sessions, want 1", sessions)
					}
					if input == "/new" || input == "/clear" {
						if runs != 0 {
							t.Fatalf("bare control command enqueued %d runs", runs)
						}
						return
					}
					memberPath := tc.bound && tc.senderIsMember
					if memberPath && input == "/issue private work" {
						if issues != 1 {
							t.Fatalf("member /issue created %d issues, want 1", issues)
						}
						return
					}
					if inputs != 1 || runs != 1 || issues != 0 {
						t.Fatalf("authorized input/run/issue = %d/%d/%d, want 1/1/0", inputs, runs, issues)
					}
					task := f.task(t)
					wantUser, wantOrigin := testUserID, channel.ConversationOrigin
					if memberPath {
						wantUser, wantOrigin = sender, "direct_human"
					}
					if task.OriginatorUserID != parseUUID(wantUser) || task.OriginatorSource.String != wantOrigin {
						t.Fatalf("wrong execution authority: user=%s source=%s", uuidToString(task.OriginatorUserID), task.OriginatorSource.String)
					}
				})
			}
		}
	}
}
