// Package media defines the native-adapter boundary. Adapters own provider
// invocation; the daemon owns scoped input downloads and output uploads.
package media

import (
	"context"
	"fmt"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

type Input struct{ Role, Path string }
type Artifact struct{ Path string }

type Executor interface {
	Capabilities() []string
	// Submit writes the completed artifact inside dir. Implementations must honor
	// cancellation and must not retry a model invocation after an ambiguous error.
	Submit(ctx context.Context, request protocol.MediaRequest, inputs []Input, dir string) (Artifact, error)
}

type RateLimitError struct{ RetryAfter int64 }

// RequestError contains an adapter-owned validation message, without provider
// diagnostics, credentials, or user-supplied prompt content.
type RequestError struct{ Message string }

func (e *RequestError) Error() string { return e.Message }

func (e *RateLimitError) Error() string {
	return fmt.Sprintf("provider rate limited (retry after %ds)", e.RetryAfter)
}
