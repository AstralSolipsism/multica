package handler

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/integrations/lark"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type LarkTargetCapabilitiesResponse struct {
	ChatListSupported          bool   `json:"chat_list_supported"`
	MessageAnchorListSupported bool   `json:"message_anchor_list_supported"`
	Region                     string `json:"region"`
	ScopeStatus                string `json:"scope_status"`
	MaxChatPageSize            int    `json:"max_chat_page_size"`
	MaxMessagePageSize         int    `json:"max_message_page_size"`
}

type larkDiscoveryPageResponse[T any] struct {
	Items      []T    `json:"items"`
	HasMore    bool   `json:"has_more"`
	NextCursor string `json:"next_cursor"`
}

// Discovery is an explicit human management read. Bot visibility, automation
// edit access and existing target approval are not group-history read grants.
func (h *Handler) loadLarkDiscoveryInstallation(w http.ResponseWriter, r *http.Request) (lark.Installation, bool) {
	w.Header().Set("Cache-Control", "no-store")
	userID, ok := requireUserID(w, r)
	if !ok {
		return lark.Installation{}, false
	}
	if isMachineCredentialActor(r) {
		writeErrorCode(w, http.StatusForbidden, "lark_discovery_forbidden", "human management access required")
		return lark.Installation{}, false
	}
	ws, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "workspace id")
	if !ok {
		return lark.Installation{}, false
	}
	id, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "installationId"), "installation id")
	if !ok {
		return lark.Installation{}, false
	}
	member, err := h.getWorkspaceMember(r.Context(), userID, uuidToString(ws))
	if err != nil {
		writeErrorCode(w, http.StatusNotFound, "lark_installation_not_found", "installation not found")
		return lark.Installation{}, false
	}
	if h.LarkInstallations == nil {
		writeErrorCode(w, http.StatusServiceUnavailable, "lark_discovery_unsupported", "lark discovery not configured")
		return lark.Installation{}, false
	}
	inst, err := h.LarkInstallations.GetInWorkspace(r.Context(), id, ws)
	if err != nil {
		if errors.Is(err, lark.ErrInstallationNotFound) {
			writeErrorCode(w, http.StatusNotFound, "lark_installation_not_found", "installation not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load installation")
		}
		return lark.Installation{}, false
	}
	agent, err := h.Queries.GetAgentInWorkspace(r.Context(), db.GetAgentInWorkspaceParams{ID: inst.AgentID, WorkspaceID: ws})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErrorCode(w, http.StatusNotFound, "lark_installation_not_found", "installation not found")
		} else {
			writeError(w, http.StatusInternalServerError, "failed to load agent")
		}
		return lark.Installation{}, false
	}
	// Same management policy as canManageAgent, with a stable discovery error.
	if !roleAllowed(member.Role, "owner", "admin") && uuidToString(agent.OwnerID) != userID {
		writeErrorCode(w, http.StatusForbidden, "lark_discovery_forbidden", "agent owner or workspace admin required")
		return lark.Installation{}, false
	}
	if inst.Status != "active" || agent.ArchivedAt.Valid {
		writeErrorCode(w, http.StatusConflict, "lark_installation_inactive", "installation or agent is inactive")
		return lark.Installation{}, false
	}
	return inst, true
}

func (h *Handler) GetLarkTargetCapabilities(w http.ResponseWriter, r *http.Request) {
	inst, ok := h.loadLarkDiscoveryInstallation(w, r)
	if !ok {
		return
	}
	_, supported := h.LarkAPIClient.(lark.TargetDiscoveryClient)
	supported = supported && h.LarkAPIClient.IsConfigured()
	writeJSON(w, http.StatusOK, LarkTargetCapabilitiesResponse{
		ChatListSupported: supported, MessageAnchorListSupported: supported,
		Region: string(lark.RegionOrDefault(inst.Region)), ScopeStatus: "not_checked",
		MaxChatPageSize: 100, MaxMessagePageSize: 50,
	})
}

type larkDiscoveryRequest struct {
	client lark.TargetDiscoveryClient
	creds  lark.InstallationCredentials
	params lark.DiscoveryParams
	query  string
	scope  string
}

func (h *Handler) prepareLarkDiscovery(w http.ResponseWriter, r *http.Request, maxSize int) (larkDiscoveryRequest, bool) {
	d := larkDiscoveryRequest{}
	inst, ok := h.loadLarkDiscoveryInstallation(w, r)
	if !ok {
		return d, false
	}
	d.client, ok = h.LarkAPIClient.(lark.TargetDiscoveryClient)
	if !ok || !h.LarkAPIClient.IsConfigured() {
		writeErrorCode(w, http.StatusServiceUnavailable, "lark_discovery_unsupported", "lark discovery not configured")
		return d, false
	}
	q := r.URL.Query()
	d.params.PageSize = 20
	d.query = strings.ToLower(strings.TrimSpace(q.Get("q")))
	chatID := chi.URLParam(r, "chatId")
	invalid := len(q["page_size"]) > 1 || len(q["cursor"]) > 1 || len(q["q"]) > 1 || utf8.RuneCountInString(d.query) > 100
	if maxSize == 50 && (!lark.ValidDiscoveryChatID(chatID) || d.query != "") {
		invalid = true
	}
	if q.Has("page_size") {
		var err error
		d.params.PageSize, err = strconv.Atoi(q.Get("page_size"))
		invalid = invalid || err != nil || d.params.PageSize < 1 || d.params.PageSize > maxSize
	}
	if invalid {
		writeErrorCode(w, http.StatusBadRequest, "lark_discovery_invalid_request", "invalid page size, query or group id")
		return d, false
	}
	secret, err := h.LarkInstallations.DecryptAppSecret(inst)
	if err != nil {
		writeErrorCode(w, http.StatusServiceUnavailable, "lark_discovery_unavailable", "installation credentials unavailable")
		return d, false
	}
	d.creds = lark.InstallationCredentials{AppID: inst.AppID, AppSecret: secret, Region: lark.RegionOrDefault(inst.Region), TenantKey: inst.TenantKey.String}
	d.scope = strings.Join([]string{"lark-discovery-v1", uuidToString(inst.WorkspaceID), uuidToString(inst.ID), requestUserID(r), chatID, d.query, strconv.Itoa(d.params.PageSize)}, "\x00")
	if cursor := q.Get("cursor"); cursor != "" {
		d.params.PageToken, ok = decodeLarkDiscoveryCursor(cursor, secret, d.scope, time.Now())
		if !ok {
			writeErrorCode(w, http.StatusBadRequest, "lark_discovery_invalid_cursor", "cursor expired or does not match this query; restart from the first page")
			return d, false
		}
	}
	return d, true
}

func (h *Handler) ListLarkTargetChats(w http.ResponseWriter, r *http.Request) {
	d, ok := h.prepareLarkDiscovery(w, r, 100)
	if !ok {
		return
	}
	page, err := d.client.ListJoinedChats(r.Context(), d.creds, d.params, d.query)
	if err != nil {
		writeLarkDiscoveryError(w, err, d.params.PageToken != "")
		return
	}
	writeLarkDiscoveryPage(w, d, page)
}

func (h *Handler) ListLarkMessageAnchors(w http.ResponseWriter, r *http.Request) {
	d, ok := h.prepareLarkDiscovery(w, r, 50)
	if !ok {
		return
	}
	page, err := d.client.ListMessageAnchors(r.Context(), d.creds, d.params, chi.URLParam(r, "chatId"))
	if err != nil {
		writeLarkDiscoveryError(w, err, d.params.PageToken != "")
		return
	}
	writeLarkDiscoveryPage(w, d, page)
}

func writeLarkDiscoveryPage[T any](w http.ResponseWriter, d larkDiscoveryRequest, page lark.DiscoveryPage[T]) {
	cursor := ""
	if page.HasMore {
		cursor = encodeLarkDiscoveryCursor(page.PageToken, d.creds.AppSecret, d.scope, time.Now())
	}
	writeJSON(w, http.StatusOK, larkDiscoveryPageResponse[T]{Items: page.Items, HasMore: page.HasMore, NextCursor: cursor})
}

func writeLarkDiscoveryError(w http.ResponseWriter, err error, hasCursor bool) {
	status, code, message := http.StatusServiceUnavailable, "lark_discovery_unavailable", "lark discovery temporarily unavailable"
	switch {
	case errors.Is(err, lark.ErrDiscoveryInvalidRequest):
		status, code, message = http.StatusBadRequest, "lark_discovery_invalid_request", "provider rejected the query"
		if hasCursor {
			code, message = "lark_discovery_invalid_cursor", "provider rejected the cursor; restart from the first page"
		}
	case errors.Is(err, lark.ErrDiscoveryPermission):
		status, code, message = http.StatusForbidden, "lark_discovery_permission_denied", "check bot scopes and external group access"
	case errors.Is(err, lark.ErrDiscoveryChat):
		status, code, message = http.StatusNotFound, "lark_discovery_chat_unavailable", "group unavailable or bot is not a member"
	case errors.Is(err, lark.ErrDiscoveryMessage):
		status, code, message = http.StatusGone, "lark_discovery_message_unavailable", "message no longer available; refresh the list"
	case errors.Is(err, lark.ErrDiscoveryRateLimited):
		status, code, message = http.StatusTooManyRequests, "lark_discovery_rate_limited", "too many provider requests; retry later"
	case errors.Is(err, lark.ErrDiscoveryResponse):
		status, code, message = http.StatusBadGateway, "lark_discovery_invalid_response", "invalid provider response"
	}
	writeErrorCode(w, status, code, message)
}

type larkDiscoveryCursor struct {
	Token   string `json:"token"`
	Expires int64  `json:"expires"`
}

func encodeLarkDiscoveryCursor(token, secret, scope string, now time.Time) string {
	data, _ := json.Marshal(larkDiscoveryCursor{Token: token, Expires: now.Add(30 * time.Minute).Unix()})
	payload := base64.RawURLEncoding.EncodeToString(data)
	return payload + "." + base64.RawURLEncoding.EncodeToString(larkDiscoveryMAC(payload, secret, scope))
}

func decodeLarkDiscoveryCursor(cursor, secret, scope string, now time.Time) (string, bool) {
	if len(cursor) > 8192 {
		return "", false
	}
	payload, signature, ok := strings.Cut(cursor, ".")
	if !ok {
		return "", false
	}
	mac, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(mac, larkDiscoveryMAC(payload, secret, scope)) {
		return "", false
	}
	data, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return "", false
	}
	var c larkDiscoveryCursor
	if json.Unmarshal(data, &c) != nil || c.Expires <= now.Unix() || c.Token == "" || len(c.Token) > 4096 {
		return "", false
	}
	return c.Token, true
}

func larkDiscoveryMAC(payload, secret, scope string) []byte {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(scope + "\x00" + payload))
	return mac.Sum(nil)
}
