package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/channel"
	"github.com/multica-ai/multica/server/internal/integrations/channel/engine"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

const (
	maxLarkPrivateChatCandidates = 50
	larkPrivateChatCandidateTTL  = 7 * 24 * time.Hour
)

// Observations are not consent. No body, message ID, tenant key, contact name,
// or platform-member mapping is stored in this bounded installation metadata.
type larkPrivateChatCandidate struct {
	ID           string    `json:"id"`
	ChatID       string    `json:"chat_id"`
	SenderOpenID string    `json:"sender_open_id"`
	FirstSeenAt  time.Time `json:"first_seen_at"`
	LastSeenAt   time.Time `json:"last_seen_at"`
}

type larkPrivateChatCandidateResponse struct {
	ID                  string            `json:"id"`
	ChatID              string            `json:"chat_id"`
	ChatType            string            `json:"chat_type"`
	Sender              lark.AnchorSender `json:"sender"`
	DisplayName         string            `json:"display_name"`
	IdentityStatus      string            `json:"identity_status"`
	AuthorizationStatus string            `json:"authorization_status"`
	FirstSeenAt         time.Time         `json:"first_seen_at"`
	LastSeenAt          time.Time         `json:"last_seen_at"`
	ExpiresAt           time.Time         `json:"expires_at"`
}

func activeLarkPrivateChatCandidates(config []byte, now time.Time) ([]larkPrivateChatCandidate, bool, error) {
	var cfg struct {
		Candidates []larkPrivateChatCandidate `json:"private_chat_candidates"`
	}
	if err := json.Unmarshal(config, &cfg); err != nil {
		return nil, false, err
	}
	active := make([]larkPrivateChatCandidate, 0, len(cfg.Candidates))
	for _, candidate := range cfg.Candidates {
		if candidate.LastSeenAt.Add(larkPrivateChatCandidateTTL).After(now) {
			active = append(active, candidate)
		}
	}
	slices.SortFunc(active, func(a, b larkPrivateChatCandidate) int {
		if order := b.LastSeenAt.Compare(a.LastSeenAt); order != 0 {
			return order
		}
		return strings.Compare(a.ID, b.ID)
	})
	if len(active) > maxLarkPrivateChatCandidates {
		active = active[:maxLarkPrivateChatCandidates]
	}
	return active, len(active) != len(cfg.Candidates), nil
}

func (h *Handler) lockLarkConversationInstallation(ctx context.Context, id, ws pgtype.UUID) (pgx.Tx, *db.Queries, db.ChannelInstallation, error) {
	tx, err := h.TxStarter.Begin(ctx)
	if err != nil {
		return nil, nil, db.ChannelInstallation{}, err
	}
	q := h.Queries.WithTx(tx)
	inst, err := q.LockConversationInstallationForUpdate(ctx, db.LockConversationInstallationForUpdateParams{ID: id, WorkspaceID: ws})
	if err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return nil, nil, db.ChannelInstallation{}, err
	}
	return tx, q, inst, nil
}

func saveLarkPrivateChatCandidates(ctx context.Context, q *db.Queries, inst db.ChannelInstallation, candidates []larkPrivateChatCandidate) error {
	raw, err := json.Marshal(candidates)
	if err != nil {
		return err
	}
	return q.SetLarkPrivateChatCandidates(ctx, db.SetLarkPrivateChatCandidatesParams{ID: inst.ID, WorkspaceID: inst.WorkspaceID, Candidates: raw})
}

// Called only after the engine has claimed a message and authorization denied
// it. Raw carries the authenticated connection's installation and provider IDs;
// neither an arbitrary normalized Source nor an audit row proves a private chat.
func (h *Handler) recordLarkPrivateChatCandidate(ctx context.Context, resolved engine.ResolvedInstallation, msg channel.InboundMessage) error {
	var source lark.InboundMessage
	if json.Unmarshal(msg.Raw, &source) != nil || source.InstallationID != resolved.ID ||
		!source.InstallationID.Valid || source.EventType != "im.message.receive_v1" || source.SenderType != "user" ||
		source.EventID == "" || source.EventID != msg.EventID || source.MessageID != msg.MessageID ||
		!validLarkPrivateSourceID(source.MessageID, "om_") || !validLarkPrivateSourceID(string(source.SenderOpenID), "ou_") ||
		!lark.ValidDiscoveryChatID(string(source.ChatID)) || string(source.ChatID) != msg.Source.ChatID ||
		string(source.SenderOpenID) != msg.Source.SenderID || source.ChatType != lark.ChatTypeP2P || msg.Source.ChatType != channel.ChatTypeP2P {
		return nil
	}
	created, err := strconv.ParseInt(source.CreateTime, 10, 64)
	now := time.Now().UTC()
	seenAt := time.UnixMilli(created).UTC()
	if err != nil || created <= 0 || !seenAt.Add(larkPrivateChatCandidateTTL).After(now) || seenAt.After(now.Add(5*time.Minute)) {
		return nil
	}
	tx, q, inst, err := h.lockLarkConversationInstallation(ctx, resolved.ID, resolved.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	var config struct {
		AppID        string                     `json:"app_id"`
		Conversation *channel.ConversationGrant `json:"conversation"`
	}
	if err := json.Unmarshal(inst.Config, &config); err != nil {
		return err
	}
	if inst.Status != "active" || inst.AgentID != resolved.AgentID || config.AppID != source.AppID {
		return nil
	}
	agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{ID: inst.AgentID, WorkspaceID: inst.WorkspaceID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && agent.ArchivedAt.Valid) {
		return nil
	}
	if err != nil {
		return err
	}
	if config.Conversation != nil && slices.Contains(config.Conversation.Chats, channel.ConversationTarget{ChatID: msg.Source.ChatID, ChatType: "p2p"}) {
		return nil
	}
	candidates, _, err := activeLarkPrivateChatCandidates(inst.Config, now)
	if err != nil {
		return err
	}
	index := slices.IndexFunc(candidates, func(c larkPrivateChatCandidate) bool { return c.ChatID == msg.Source.ChatID })
	if index >= 0 {
		// Retries (including a lost commit acknowledgement) cannot renew TTL.
		if candidates[index].SenderOpenID != msg.Source.SenderID || !seenAt.After(candidates[index].LastSeenAt) {
			return nil
		}
		candidates[index].LastSeenAt = seenAt
	} else {
		candidates = append(candidates, larkPrivateChatCandidate{ID: uuidToString(dbid.NewV7()), ChatID: msg.Source.ChatID,
			SenderOpenID: msg.Source.SenderID, FirstSeenAt: seenAt, LastSeenAt: seenAt})
	}
	// ponytail: at most 51 observations are sorted under one installation lock;
	// move metadata to a table only if measured per-bot write contention needs it.
	slices.SortFunc(candidates, func(a, b larkPrivateChatCandidate) int { return b.LastSeenAt.Compare(a.LastSeenAt) })
	if len(candidates) > maxLarkPrivateChatCandidates {
		candidates = candidates[:maxLarkPrivateChatCandidates]
	}
	if err := saveLarkPrivateChatCandidates(ctx, q, inst, candidates); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func validLarkPrivateSourceID(id, prefix string) bool {
	return strings.HasPrefix(id, prefix) && lark.ValidDiscoveryChatID("oc_"+strings.TrimPrefix(id, prefix))
}

func (h *Handler) ListLarkPrivateChatCandidates(w http.ResponseWriter, r *http.Request) {
	discovered, ok := h.loadLarkDiscoveryInstallation(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, q, inst, err := h.lockLarkConversationInstallation(ctx, discovered.ID, discovered.WorkspaceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load private chat candidates")
		return
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if inst.Status != "active" || inst.AgentID != discovered.AgentID || inst.InstalledAt != discovered.InstalledAt {
		writeErrorCode(w, http.StatusConflict, "lark_installation_inactive", "installation changed; refresh the list")
		return
	}
	candidates, pruned, err := activeLarkPrivateChatCandidates(inst.Config, time.Now())
	if err == nil && pruned {
		err = saveLarkPrivateChatCandidates(ctx, q, inst, candidates)
	}
	cfg, configErr := channel.ParseConversationConfig(inst.Config)
	if err != nil || configErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to load private chat candidates")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load private chat candidates")
		return
	}
	// Names are optional enrichment after the management gate. The provider's
	// contact scope/range may omit even a user who can send this bot a message.
	names := map[string]string{}
	if len(candidates) > 0 && h.LarkAPIClient != nil && h.LarkAPIClient.IsConfigured() {
		if secret, err := h.LarkInstallations.DecryptAppSecret(discovered); err == nil {
			ids := make([]string, 0, len(candidates))
			for _, c := range candidates {
				ids = append(ids, c.SenderOpenID)
			}
			lookupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			names, _ = h.LarkAPIClient.BatchGetUsers(lookupCtx, lark.InstallationCredentials{AppID: discovered.AppID, AppSecret: secret,
				Region: lark.RegionOrDefault(discovered.Region), TenantKey: discovered.TenantKey.String}, ids)
			cancel()
		}
	}
	items := make([]larkPrivateChatCandidateResponse, 0, len(candidates))
	for _, c := range candidates {
		name := strings.Join(strings.FieldsFunc(names[c.SenderOpenID], func(r rune) bool {
			return unicode.IsSpace(r) || unicode.IsControl(r) || unicode.Is(unicode.Cf, r)
		}), " ")
		if runes := []rune(name); len(runes) > 100 {
			name = string(runes[:100])
		}
		identity, authorization := "id_only", "pending"
		if name != "" {
			identity = "name_available"
		}
		if cfg.Grant != nil && slices.Contains(cfg.Grant.Chats, channel.ConversationTarget{ChatID: c.ChatID, ChatType: "p2p"}) {
			authorization = "authorized"
		}
		items = append(items, larkPrivateChatCandidateResponse{ID: c.ID, ChatID: c.ChatID, ChatType: "p2p",
			Sender: lark.AnchorSender{Type: "user", ID: c.SenderOpenID, IDType: "open_id"}, DisplayName: name,
			IdentityStatus: identity, AuthorizationStatus: authorization, FirstSeenAt: c.FirstSeenAt,
			LastSeenAt: c.LastSeenAt, ExpiresAt: c.LastSeenAt.Add(larkPrivateChatCandidateTTL)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "max_candidates": maxLarkPrivateChatCandidates, "retention_seconds": int(larkPrivateChatCandidateTTL.Seconds())})
}

// Confirmation uses the existing human consent writer and only appends targets.
func (h *Handler) ConfirmLarkPrivateChatCandidates(w http.ResponseWriter, r *http.Request) {
	h.setLarkConversationGrant(w, r, true)
}
