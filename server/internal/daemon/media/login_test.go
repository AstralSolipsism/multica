package media

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestMediaLoginOnlyUsesIsolatedNativeOAuth(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fixture")
	}
	root, home := t.TempDir(), t.TempDir()
	p, err := OpenProfile(root, home, "sub", "codex", true)
	if err != nil {
		t.Fatal(err)
	}
	// This script is the only executable in the test; no user-installed CLI is resolved.
	fake := filepath.Join(t.TempDir(), "native-fixture")
	script := `#!/bin/sh
[ "$CODEX_HOME" = "$MEDIA_EXPECTED_NATIVE_HOME" ] || exit 2
[ -z "$OPENAI_API_KEY$CODEX_ACCESS_TOKEN$CODEX_API_KEY" ] || exit 3
[ "$1" = "-c" ] && [ "$2" = 'forced_login_method="chatgpt"' ] || exit 4
[ "$3" = "-c" ] && [ "$4" = 'cli_auth_credentials_store="file"' ] || exit 5
[ "$5" = "login" ] && [ "$6" = "--device-auth" ] || exit 6
`
	if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MEDIA_EXPECTED_NATIVE_HOME", p.NativeDir)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	t.Setenv("CODEX_ACCESS_TOKEN", "fixture-token")
	if err := Login(context.Background(), p, fake, true, strings.NewReader(""), io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
}
