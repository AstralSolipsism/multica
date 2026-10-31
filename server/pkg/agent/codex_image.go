package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// CodexImageResult is a native imageGeneration receipt, never assistant prose.
type CodexImageResult struct {
	Path        string
	RateLimited bool
	RetryAfter  int64
}

type codexImageTurnError struct {
	Info json.RawMessage `json:"codexErrorInfo"`
}

func (e codexImageTurnError) rateLimited() bool {
	var code string
	return json.Unmarshal(e.Info, &code) == nil && (code == "usageLimitExceeded" || code == "rateLimitExceeded")
}

// withCodexImageClient reuses the runtime's RPC and owned-process boundaries.
// There are no launch/turn retries: an interrupted generation is ambiguous.
func withCodexImageClient(ctx context.Context, command Command, cwd, home string, observe func(string, json.RawMessage), fn func(*codexClient) error) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := command.exec(runCtx, "--no-daemon", "app-server", "--listen", "stdio://")
	cmd.Dir = cwd
	if home != "" {
		cmd.Env = append(os.Environ(), "CODEX_HOME="+home)
	}
	cmd.Stderr = io.Discard // Provider diagnostics may contain prompts/account data.
	cmd.WaitDelay = 2 * time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	defer stdout.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	c := &codexClient{cfg: Config{Logger: logger}, stdin: stdin, pending: make(map[int]*pendingRPC), processDone: make(chan struct{}), handshakeTimeout: 10 * time.Second, threadHandshakeTimeout: 60 * time.Second}
	if err := startOwnedProcessTree(cmd, logger); err != nil {
		return err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		scanner := newAgentStreamScanner(stdout)
		for scanner.Scan() {
			var raw map[string]json.RawMessage
			if json.Unmarshal(scanner.Bytes(), &raw) != nil {
				continue
			}
			if _, hasID := raw["id"]; hasID {
				if _, request := raw["method"]; request {
					var id int
					if json.Unmarshal(raw["id"], &id) == nil {
						c.respondError(id, -32601, "interactive tools are unavailable for media jobs")
					}
				} else {
					c.handleResponse(raw)
				}
				continue
			}
			var method string
			_ = json.Unmarshal(raw["method"], &method)
			if observe != nil {
				observe(method, raw["params"])
			}
		}
		if scanner.Err() != nil {
			cancel()
		}
		waitErr := cmd.Wait()
		if waitErr == nil {
			waitErr = io.EOF
		}
		c.markProcessExited(waitErr)
	}()
	defer func() {
		stdin.Close()
		cancel()
		signalProcessGroup(cmd, syscall.SIGKILL)
		<-done
		releaseProcessGroup(cmd)
	}()
	if _, err := c.request(ctx, "initialize", map[string]any{
		"clientInfo":   map[string]string{"name": "multica-media", "version": "1"},
		"capabilities": map[string]bool{"experimentalApi": true},
	}); err != nil {
		return fmt.Errorf("initialize native image client: %w", err)
	}
	c.notify("initialized")
	return fn(c)
}

// ProbeCodexImages reads the installed CLI's effective feature and provider
// capabilities. A ChatGPT login is required; API-key runtimes do not share the
// subscription quota used by the media scheduler.
func ProbeCodexImages(ctx context.Context, command Command, home string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	return withCodexImageClient(ctx, command, "", home, nil, func(c *codexClient) error {
		account, err := c.request(ctx, "account/read", map[string]bool{"refreshToken": false})
		if err != nil {
			return err
		}
		var auth struct {
			Account *struct {
				Type string `json:"type"`
			} `json:"account"`
		}
		if json.Unmarshal(account, &auth) != nil || auth.Account == nil || auth.Account.Type != "chatgpt" {
			return errors.New("native images require a ChatGPT login")
		}
		raw, err := c.request(ctx, "modelProvider/capabilities/read", map[string]any{})
		if err != nil {
			return err
		}
		var capabilities struct {
			ImageGeneration bool `json:"imageGeneration"`
		}
		if json.Unmarshal(raw, &capabilities) != nil || !capabilities.ImageGeneration {
			return errors.New("provider does not support native images")
		}
		raw, err = c.request(ctx, "experimentalFeature/list", map[string]any{"limit": 1000})
		if err != nil {
			return err
		}
		var features struct {
			Data []struct {
				Name    string `json:"name"`
				Enabled bool   `json:"enabled"`
			} `json:"data"`
		}
		if json.Unmarshal(raw, &features) == nil {
			for _, feature := range features.Data {
				if feature.Name == "image_generation" && feature.Enabled {
					return nil
				}
			}
		}
		return errors.New("native image generation is disabled or unavailable")
	})
}

// GenerateCodexImage runs one fresh native turn with host-local auth and a
// private CODEX_HOME so the native tool writes its images inside the job dir.
func GenerateCodexImage(ctx context.Context, command Command, sourceHome, dir, prompt string, inputs []string) (CodexImageResult, error) {
	home := filepath.Join(dir, "codex-home")
	if err := os.Mkdir(home, 0700); err != nil {
		return CodexImageResult{}, err
	}
	// Do not copy subscription credentials or reimplement token refresh.
	auth, err := filepath.EvalSymlinks(filepath.Join(sourceHome, "auth.json"))
	if err != nil {
		return CodexImageResult{}, errors.New("native images require file-backed host Codex authentication")
	}
	if err := os.Symlink(auth, filepath.Join(home, "auth.json")); err != nil {
		return CodexImageResult{}, err
	}
	if err := os.WriteFile(filepath.Join(home, "config.toml"), []byte("[features]\nimage_generation = true\nshell_tool = false\nplugins = false\napps = false\nview_image = false\nmulti_agent = false\n"), 0600); err != nil {
		return CodexImageResult{}, err
	}
	var mu sync.Mutex
	var result CodexImageResult
	var images int
	seen := map[string]bool{}
	var threadID string
	completed := make(chan bool, 1)
	observe := func(method string, raw json.RawMessage) {
		var event struct {
			ThreadID  string              `json:"threadId"`
			Error     codexImageTurnError `json:"error"`
			WillRetry *bool               `json:"willRetry"`
			Item      struct {
				ID        string `json:"id"`
				Type      string `json:"type"`
				Status    string `json:"status"`
				SavedPath string `json:"savedPath"`
				Failure   *struct {
					Type     string `json:"type"`
					ResetsAt *int64 `json:"resetsAt"`
				} `json:"failure"`
			} `json:"item"`
			Turn struct {
				Status string              `json:"status"`
				Error  codexImageTurnError `json:"error"`
			} `json:"turn"`
		}
		if json.Unmarshal(raw, &event) != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if threadID == "" || event.ThreadID != threadID {
			return
		}
		if method == "item/completed" && event.Item.Type == "imageGeneration" {
			if event.Item.ID == "" || seen[event.Item.ID] {
				return
			}
			seen[event.Item.ID] = true
			if event.Item.Status == "completed" && event.Item.SavedPath != "" {
				images++
				result.Path = event.Item.SavedPath
			} else if failure := event.Item.Failure; failure != nil && failure.Type == "usageLimitExceeded" {
				result.RateLimited = true
				if failure.ResetsAt != nil {
					result.RetryAfter = max(0, *failure.ResetsAt-time.Now().Unix())
				}
			}
		}
		// Retrying notifications are not final quota decisions. Only a typed
		// terminal error can allow the scheduler to retry on another runtime.
		terminalError := method == "error" && event.WillRetry != nil && !*event.WillRetry
		if terminalError && event.Error.rateLimited() || method == "turn/completed" && event.Turn.Status == "failed" && event.Turn.Error.rateLimited() {
			result.RateLimited = true
		}
		if method == "turn/completed" || terminalError {
			select {
			case completed <- !terminalError && event.Turn.Status == "completed":
			default:
			}
		}
	}
	err = withCodexImageClient(ctx, command, dir, home, observe, func(c *codexClient) error {
		raw, err := c.request(ctx, "thread/start", map[string]any{
			"cwd": dir, "approvalPolicy": "never", "sandbox": "workspace-write", "ephemeral": true,
			"developerInstructions": "Use the native image generation tool exactly once for this image request. Use the supplied reference images for edits. Do not use shell commands, external services, or other tools. Do not retry image generation.",
		})
		if err != nil {
			return err
		}
		id := extractThreadID(raw)
		if id == "" {
			return errors.New("native image thread missing")
		}
		mu.Lock()
		threadID = id
		mu.Unlock()
		input := []map[string]any{{"type": "text", "text": prompt}}
		for _, path := range inputs {
			input = append(input, map[string]any{"type": "localImage", "path": path})
		}
		if _, err := c.request(ctx, "turn/start", map[string]any{"threadId": id, "input": input}); err != nil {
			return err
		}
		select {
		case ok := <-completed:
			if !ok {
				return errors.New("native image turn failed")
			}
			return nil
		case <-ctx.Done():
			return ctx.Err()
		case <-c.processDone:
			return errors.New("native image process exited before completion")
		}
	})
	mu.Lock()
	defer mu.Unlock()
	if ctx.Err() != nil {
		return CodexImageResult{}, ctx.Err()
	}
	// A completed artifact takes precedence over a later quota error: replaying
	// a model that already generated an image could charge the account twice.
	if images == 1 && err == nil {
		result.RateLimited = false
		return result, nil
	}
	if images == 0 && result.RateLimited {
		return result, nil
	}
	if err != nil {
		return CodexImageResult{}, err
	}
	return CodexImageResult{}, fmt.Errorf("expected one native image receipt, got %d", images)
}
