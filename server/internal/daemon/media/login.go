package media

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// Login uses the native OAuth flow and explicit file storage for isolated
// profiles. No default credentials are imported and no API key is substituted.
func Login(ctx context.Context, p *Profile, command string, deviceAuth bool, stdin io.Reader, stdout, stderr io.Writer) error {
	if p.Provider != "codex" {
		return fmt.Errorf("%s: %w (native login/profile mapping required)", p.Provider, ErrContractUnverified)
	}
	lock, err := p.Lock()
	if err != nil {
		return err
	}
	defer lock.Close()
	args := []string{"-c", `forced_login_method="chatgpt"`}
	if p.Named {
		args = append(args, "-c", `cli_auth_credentials_store="file"`)
	}
	args = append(args, "login")
	if deviceAuth {
		args = append(args, "--device-auth")
	}
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = CodexEnvironment(os.Environ(), p.NativeDir)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	return cmd.Run()
}
func CodexEnvironment(env []string, nativeDir string) []string {
	out := make([]string, 0, len(env)+1)
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		// A named media profile must not silently authenticate through credentials
		// injected for an enclosing coding task or CI process.
		switch key {
		case "CODEX_HOME", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL":
			continue
		}
		out = append(out, entry)
	}
	return append(out, "CODEX_HOME="+nativeDir)
}
