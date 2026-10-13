package execenv

import (
	"encoding/json"
	"fmt"
	"path/filepath"
)

// RunNotesForEnv preserves the server's complete handoff/wakeup instructions,
// including event evidence and check-in commands. Their authorship is unknown,
// so they must arrive as tool results rather than user-authored runtime input.
type RunNotesForEnv struct {
	Handoff       string `json:"handoff,omitempty"`
	JoinedWakeups string `json:"joined_wakeups,omitempty"`
}

// RunNotesRelPath is per dispatch: overlapping local-directory chat turns must
// not overwrite each other's notes. The sidecar manifest owns its cleanup.
func RunNotesRelPath(taskID string) string {
	return filepath.ToSlash(filepath.Join(".multica", "run-notes", sanitizeSkillName(taskID)+".json"))
}

func writeRunNotes(workDir string, ctx TaskContextForEnv, manifest *sidecarManifest) error {
	if ctx.RunNotes == (RunNotesForEnv{}) {
		return nil
	}
	path := filepath.Join(workDir, RunNotesRelPath(ctx.TaskID))
	if err := recordMkdirAll(filepath.Dir(path), 0700, manifest); err != nil {
		return err
	}
	data, err := json.MarshalIndent(ctx.RunNotes, "", "  ")
	if err != nil {
		return err
	}
	if err := recordWriteFile(path, data, 0600, manifest); err != nil {
		return fmt.Errorf("write run notes: %w", err)
	}
	return nil
}
