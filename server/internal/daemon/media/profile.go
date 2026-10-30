package media

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

var profileName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`)
var ErrLocked = errors.New("native credential resource is locked by another process")

type Profile struct {
	Named             bool
	Dir               string
	NativeDir         string
	Provider          string
	ExecutorID        string
	CredentialScopeID string
}

// OpenProfile never copies credentials. A named profile starts with empty
// native storage. Flow and the Whisk compatibility entry share one browser
// resource, quota scope and lock. Default profiles reuse the native location.
func OpenProfile(multicaRoot, nativeHome, profile, provider string, create bool) (*Profile, error) {
	if profile != "" && !profileName.MatchString(profile) {
		return nil, fmt.Errorf("invalid media profile name")
	}
	if protocol.MediaCapability(provider) == "" {
		return nil, fmt.Errorf("unknown media provider")
	}
	root := multicaRoot
	if profile != "" {
		root = filepath.Join(root, "profiles", profile)
	}
	resource := provider
	if provider == "whisk" || provider == "flow" {
		resource = "google-browser"
	}
	nativeDir := filepath.Join(root, "media", "native", resource)
	if profile == "" {
		switch provider {
		case "codex":
			nativeDir = filepath.Join(nativeHome, ".codex")
			if override := os.Getenv("CODEX_HOME"); override != "" {
				nativeDir = override
			}
		case "agy":
			return nil, ErrContractUnverified
		}
	}
	if create {
		if err := os.MkdirAll(nativeDir, 0o700); err != nil {
			return nil, err
		}
	}
	canonical, err := filepath.EvalSymlinks(nativeDir)
	if err != nil {
		return nil, err
	}
	canonical, err = filepath.Abs(canonical)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("native credential location is not a directory")
	}
	// The scope identity lives at the canonical resource, so symlink aliases
	// cannot mint an independent quota account or bypass the resource lock.
	scope, err := ensureID(filepath.Join(canonical, ".multica-media-scope"))
	if err != nil {
		return nil, err
	}
	executorDir := filepath.Join(root, "media", "executors")
	if err := os.MkdirAll(executorDir, 0o700); err != nil {
		return nil, err
	}
	executor, err := ensureID(filepath.Join(executorDir, provider+".id"))
	if err != nil {
		return nil, err
	}
	return &Profile{Named: profile != "", Dir: root, NativeDir: canonical, Provider: provider, ExecutorID: executor, CredentialScopeID: scope}, nil
}

func readID(path string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	parsed, err := uuid.Parse(strings.TrimSpace(string(body)))
	if err != nil || parsed == uuid.Nil {
		return "", fmt.Errorf("invalid persisted media identity")
	}
	return parsed.String(), nil
}
func ensureID(path string) (string, error) {
	if id, err := readID(path); err == nil {
		return id, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	lock, err := lockFile(path + ".lock")
	if err != nil {
		return "", err
	}
	defer lock.Close()
	if id, err := readID(path); err == nil {
		return id, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	id := uuid.NewString()
	f, err := os.CreateTemp(filepath.Dir(path), ".media-identity-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(id + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return id, nil
}

func (p *Profile) Lock() (*os.File, error) {
	return lockFile(filepath.Join(p.NativeDir, ".multica-media.lock"))
}
