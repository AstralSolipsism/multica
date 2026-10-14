package protocol

// ChatMessageKindHiddenContext is product-authored input adopted by the first
// user turn. It is never a member-visible message or a queue/draft preview.
const ChatMessageKindHiddenContext = "hidden_context"

func IsHiddenChatMessageKind(kind string) bool {
	return kind == ChatMessageKindHiddenContext || kind == ChatMessageKindOnboardingKickoff
}
