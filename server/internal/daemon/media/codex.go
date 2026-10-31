package media

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/multica-ai/multica/server/pkg/agent"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type Codex struct {
	Command agent.Command
	Home    string
}

func (e *Codex) Probe(ctx context.Context) error {
	info, err := os.Stat(filepath.Join(e.Home, "auth.json"))
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("file-backed Codex login unavailable")
	}
	return agent.ProbeCodexImages(ctx, e.Command, e.Home)
}

func (e *Codex) Capabilities() []string { return []string{"media-image-codex-v1"} }

func (e *Codex) Submit(ctx context.Context, request protocol.MediaRequest, inputs []Input, dir string) (Artifact, error) {
	if request.Capability != "image-generate" && request.Capability != "image-edit" {
		return Artifact{}, &RequestError{Message: "unsupported Codex image operation"}
	}
	if request.Model != "" || request.Duration != 0 {
		return Artifact{}, &RequestError{Message: "Codex native image tools do not expose model or duration selection"}
	}
	if request.Capability == "image-edit" && len(inputs) == 0 {
		return Artifact{}, &RequestError{Message: "image editing requires a reference image"}
	}
	var prompt strings.Builder
	prompt.WriteString("Generate exactly one final image.\n")
	if request.Capability == "image-edit" {
		prompt.WriteString("Edit the supplied reference images.\n")
	}
	if request.Size != "" {
		fmt.Fprintf(&prompt, "Requested image size: %s.\n", request.Size)
	}
	if request.Aspect != "" {
		fmt.Fprintf(&prompt, "Requested aspect ratio: %s.\n", request.Aspect)
	}
	paths := make([]string, 0, len(inputs))
	for i, input := range inputs {
		paths = append(paths, input.Path)
		fmt.Fprintf(&prompt, "Reference image %d role: %s.\n", i+1, input.Role)
	}
	prompt.WriteString("Image description:\n")
	prompt.WriteString(request.Prompt)
	result, err := agent.GenerateCodexImage(ctx, e.Command, e.Home, dir, prompt.String(), paths)
	if err != nil {
		return Artifact{}, err
	}
	if result.RateLimited {
		return Artifact{}, &RateLimitError{RetryAfter: result.RetryAfter}
	}
	return Artifact{Path: result.Path}, nil
}
