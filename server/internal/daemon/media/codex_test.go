package media

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestCodexRejectsUnsupportedSelectionBeforeInvocation(t *testing.T) {
	adapter := &Codex{Command: agent.NewCommand(filepath.Join(t.TempDir(), "missing-codex"), nil), Home: t.TempDir()}
	for _, request := range []protocol.MediaRequest{
		{Capability: "image-generate", Model: "gpt-image-2.5"},
		{Capability: "image-generate", Duration: 1},
		{Capability: "image-edit"},
		{Capability: "video-generate"},
	} {
		_, err := adapter.Submit(t.Context(), request, nil, t.TempDir())
		var invalid *RequestError
		if !errors.As(err, &invalid) {
			t.Fatalf("invalid native request reached process launch: %v", err)
		}
	}
}
