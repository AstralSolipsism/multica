package messagedelivery

// PlainText must be rendered literally, never parsed as mentions, Markdown or
// HTML. Both fixed templates and all source-controlled fragments use this type.
type PlainText string

// SourceLink is an application-generated source URL, never a link extracted
// from a comment, title, actor name or agent output.
type SourceLink string

// Message is the delivery module's closed content model. There are deliberately
// no mention, Markdown or arbitrary provider-node variants. Channel adapters
// must preserve the distinction between the literal body and the source link.
type Message struct {
	Body   PlainText
	Source SourceLink
}

// NewMessage keeps source-controlled text separate from the trusted source URL.
// Run IDs stay in the internal delivery/receipt records, not the external body.
func NewMessage(body, sourceURL string) Message {
	return Message{Body: PlainText(body), Source: SourceLink(sourceURL)}
}
