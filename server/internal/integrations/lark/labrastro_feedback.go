package lark

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/util"
)

const feedbackFragment = "#labrastro-feedback="

func feedbackMAC(secret, installationID, reference string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("labrastro-feedback-v1\n" + installationID + "\n" + reference))
	return hex.EncodeToString(m.Sum(nil))
}

func signedFeedbackLink(req messagedelivery.SendRequest, secret, agentID string) string {
	if req.DeliveryID == "" {
		return ""
	}
	ref := req.DeliveryID + "." + req.SendUUID + "." + strconv.Itoa(req.ShardIndex)
	return "\n\n来源：" + req.SourceURL + feedbackFragment + ref + "." + feedbackMAC(secret, req.InstallationID+"\n"+agentID, ref)
}

func (s *DeliverySender) ReadFeedbackMessage(ctx context.Context, workspaceID, installationID, messageID string) (messagedelivery.FeedbackMessage, error) {
	creds, inst, err := s.resolveInstallation(ctx, workspaceID, installationID)
	if err != nil {
		var sendErr *messagedelivery.SendError
		if errors.Is(err, ErrInstallationNotFound) || errors.Is(err, ErrInstallationRevoked) || (errors.As(err, &sendErr) && sendErr.Class == messagedelivery.ClassPermanent) {
			return messagedelivery.FeedbackMessage{}, messagedelivery.ErrFeedbackSource
		}
		return messagedelivery.FeedbackMessage{}, err
	}
	reader, ok := s.client.(interface {
		GetMessage(context.Context, InstallationCredentials, string) ([]LarkMessage, error)
	})
	if !ok {
		return messagedelivery.FeedbackMessage{}, errors.New("feedback message reader unavailable")
	}
	items, err := reader.GetMessage(ctx, creds, messageID)
	if err != nil {
		var sendErr *messagedelivery.SendError
		if errors.As(classifyDeliverySendError(err), &sendErr) && sendErr.Class == messagedelivery.ClassPermanent {
			return messagedelivery.FeedbackMessage{}, messagedelivery.ErrFeedbackSource
		}
		return messagedelivery.FeedbackMessage{}, err
	}
	for _, item := range items {
		if item.MessageID != messageID || item.Deleted {
			continue
		}
		proof := messagedelivery.FeedbackMessage{MessageID: item.MessageID, ChatID: item.ChatID,
			Bot: item.SenderType == "app" && item.SenderID == inst.AppID}
		var body struct {
			Text string `json:"text"`
		}
		if item.MessageType != "text" || json.Unmarshal([]byte(item.Content), &body) != nil {
			return proof, nil
		}
		idx := strings.LastIndex(body.Text, feedbackFragment)
		if idx < 0 {
			return proof, nil
		}
		proof.HasReference = true
		parts := strings.Split(strings.TrimSpace(body.Text[idx+len(feedbackFragment):]), ".")
		if len(parts) != 4 {
			return proof, nil
		}
		shard, err := strconv.ParseInt(parts[2], 10, 32)
		if err != nil || shard < 0 {
			return proof, nil
		}
		mac, err := hex.DecodeString(parts[3])
		if err != nil {
			return proof, nil
		}
		want, _ := hex.DecodeString(feedbackMAC(creds.AppSecret, installationID+"\n"+util.UUIDToString(inst.AgentID), strings.Join(parts[:3], ".")))
		proof.DeliveryID, proof.SendUUID, proof.ShardIndex = parts[0], parts[1], int32(shard)
		proof.Signed = hmac.Equal(mac, want)
		return proof, nil
	}
	return messagedelivery.FeedbackMessage{}, messagedelivery.ErrFeedbackSource
}
