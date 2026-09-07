package daemon

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/multica-ai/multica/server/internal/cli"
)

// zenmuxQuotaState is the daemon-local memory of which runtime keys this
// daemon has placed a ZenMux-sourced snapshot on. It is what makes "remove
// the association" precise across restarts: a clear marker goes only to a
// runtime this daemon previously reported for (an explicitly removed link),
// never to a runtime that merely exists unlinked — its quota row may belong
// to a BYO reporter or was never written at all (OL-5 S2b).
//
// The file lives in the daemon's profile state dir, is 0600, and is
// fail-soft: a missing/corrupt/unwritable file degrades to an empty state,
// meaning "no memory, no clearing" — the safe direction.
type zenmuxQuotaState struct {
	mu   sync.Mutex
	path string
	keys map[string]struct{}
}

type zenmuxQuotaStateFile struct {
	Keys []string `json:"keys"`
}

const zenmuxQuotaStateFileName = "zenmux-quota-state.json"

func loadZenMuxQuotaState(profile string, logger *slog.Logger) *zenmuxQuotaState {
	dir, err := cli.ProfileDir(profile)
	if err != nil {
		logger.Warn("zenmux quota state: no profile dir; clearing memory disabled", "error", err)
		return &zenmuxQuotaState{keys: map[string]struct{}{}}
	}
	s := &zenmuxQuotaState{path: filepath.Join(dir, zenmuxQuotaStateFileName), keys: map[string]struct{}{}}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return s // no state yet
	}
	var doc zenmuxQuotaStateFile
	if err := json.Unmarshal(raw, &doc); err != nil {
		logger.Warn("zenmux quota state: corrupt file ignored (no clears this run)", "path", s.path, "error", err)
		return s
	}
	for _, key := range doc.Keys {
		s.keys[key] = struct{}{}
	}
	return s
}

func (s *zenmuxQuotaState) has(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.keys[key]
	return ok
}

// add records a reported key and persists when the set changed. Best-effort:
// a failed save only means the next restart clears less precisely.
func (s *zenmuxQuotaState) add(key string, logger *slog.Logger) {
	s.mu.Lock()
	if _, ok := s.keys[key]; ok {
		s.mu.Unlock()
		return
	}
	s.keys[key] = struct{}{}
	keys := make([]string, 0, len(s.keys))
	for k := range s.keys {
		keys = append(keys, k)
	}
	path := s.path
	s.mu.Unlock()

	if path == "" {
		return
	}
	raw, err := json.Marshal(zenmuxQuotaStateFile{Keys: keys})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		logger.Warn("zenmux quota state: mkdir failed", "error", err)
		return
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		logger.Warn("zenmux quota state: save failed", "path", path, "error", err)
	}
}
