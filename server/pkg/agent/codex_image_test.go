package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pelletier/go-toml/v2"
)

func imageTestCommand(t *testing.T, mode string) Command {
	t.Helper()
	t.Setenv("MULTICA_TEST_CODEX_IMAGE", mode)
	path, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return NewCommand(path, []string{"-test.run=^TestCodexImageProcess$", "--"})
}

// TestCodexImageProcess is an isolated CLI fixture, never an installed provider.
func TestCodexImageProcess(t *testing.T) {
	mode := os.Getenv("MULTICA_TEST_CODEX_IMAGE")
	if mode == "" {
		return
	}
	write := func(v any) { b, _ := json.Marshal(v); _, _ = os.Stdout.Write(append(b, '\n')) }
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req struct {
			ID     int            `json:"id"`
			Method string         `json:"method"`
			Params map[string]any `json:"params"`
		}
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			os.Exit(2)
		}
		result := map[string]any{}
		switch req.Method {
		case "initialized":
			continue
		case "account/read":
			typ := "chatgpt"
			if mode == "apikey" {
				typ = "apiKey"
			}
			result["account"] = map[string]string{"type": typ}
		case "modelProvider/capabilities/read":
			result["imageGeneration"] = mode != "unsupported"
		case "experimentalFeature/list":
			result["data"] = []map[string]any{{"name": "image_generation", "enabled": mode != "disabled"}}
		case "thread/start":
			if req.Params["approvalPolicy"] != "never" || req.Params["ephemeral"] != true {
				os.Exit(3)
			}
			config, err := os.ReadFile(filepath.Join(os.Getenv("CODEX_HOME"), "config.toml"))
			var settings struct {
				Features map[string]bool `toml:"features"`
			}
			if err != nil || toml.Unmarshal(config, &settings) != nil || !settings.Features["image_generation"] {
				os.Exit(7)
			}
			for _, feature := range []string{"shell_tool", "plugins", "apps", "view_image", "multi_agent"} {
				if enabled, exists := settings.Features[feature]; !exists || enabled {
					os.Exit(8)
				}
			}
			result["thread"] = map[string]string{"id": "native-thread"}
		case "turn/start":
			if mode == "events" {
				var events []json.RawMessage
				if json.Unmarshal([]byte(os.Getenv("MULTICA_TEST_CODEX_IMAGE_EVENTS")), &events) != nil {
					os.Exit(6)
				}
				for _, event := range events {
					write(event)
				}
				write(map[string]any{"id": req.ID, "result": result})
				continue
			}
			if mode == "cancel" {
				for {
					time.Sleep(time.Second)
				}
			}
			if mode == "edit" {
				inputs, ok := req.Params["input"].([]any)
				if !ok || len(inputs) != 2 || inputs[1].(map[string]any)["type"] != "localImage" {
					os.Exit(4)
				}
			}
			if mode == "eof" {
				os.Exit(0)
			}
			item := map[string]any{"id": "image-1", "type": "imageGeneration", "status": "completed"}
			if mode == "quota" {
				item["status"] = "failed"
				item["failure"] = map[string]any{"type": "usageLimitExceeded", "resetsAt": time.Now().Add(time.Minute).Unix()}
			} else {
				p := filepath.Join(os.Getenv("CODEX_HOME"), "generated_images", "native-thread", "image.png")
				_ = os.MkdirAll(filepath.Dir(p), 0700)
				f, err := os.Create(p)
				if err != nil {
					os.Exit(5)
				}
				_ = png.Encode(f, image.NewRGBA(image.Rect(0, 0, 2, 2)))
				_ = f.Close()
				item["savedPath"] = p
			}
			// A different thread must not affect the current receipt count.
			write(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "other-thread", "item": item}})
			if mode != "prose" {
				write(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "native-thread", "item": item}})
			}
			if mode == "multiple" || mode == "duplicate" {
				if mode == "multiple" {
					item["id"] = "image-2"
				}
				write(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "native-thread", "item": item}})
			}
			write(map[string]any{"method": "item/completed", "params": map[string]any{"threadId": "native-thread", "item": map[string]string{"type": "agentMessage", "text": "/private/pretend.png"}}})
			write(map[string]any{"method": "turn/completed", "params": map[string]any{"threadId": "native-thread", "turn": map[string]string{"status": "completed"}}})
		}
		write(map[string]any{"id": req.ID, "result": result})
	}
	os.Exit(0)
}

func TestCodexNativeImageTurnFailures(t *testing.T) {
	turn := func(info any) map[string]any {
		return map[string]any{"method": "turn/completed", "params": map[string]any{
			"threadId": "native-thread", "turn": map[string]any{"status": "failed", "error": map[string]any{"codexErrorInfo": info}},
		}}
	}
	notification := func(thread string, retry any, info any) map[string]any {
		return map[string]any{"method": "error", "params": map[string]any{
			"threadId": thread, "willRetry": retry, "error": map[string]any{"codexErrorInfo": info},
		}}
	}
	image := map[string]any{"method": "item/completed", "params": map[string]any{
		"threadId": "native-thread", "item": map[string]string{"id": "one", "type": "imageGeneration", "status": "completed", "savedPath": "/fixture.png"},
	}}
	for _, tc := range []struct {
		name    string
		events  []any
		limited bool
	}{
		{"turn usage", []any{turn("usageLimitExceeded")}, true},
		{"turn rate", []any{turn("rateLimitExceeded")}, true},
		{"terminal usage", []any{notification("native-thread", false, "usageLimitExceeded")}, true},
		{"terminal rate", []any{notification("native-thread", false, "rateLimitExceeded")}, true},
		{"retry usage", []any{notification("native-thread", true, "usageLimitExceeded"), turn("other")}, false},
		{"retry rate", []any{notification("native-thread", true, "rateLimitExceeded"), turn("other")}, false},
		{"missing retry flag", []any{notification("native-thread", nil, "usageLimitExceeded"), turn("other")}, false},
		{"other thread", []any{notification("other-thread", false, "usageLimitExceeded"), turn("other")}, false},
		{"unknown error", []any{turn("unauthorized")}, false},
		{"transport error", []any{turn(map[string]any{"responseStreamDisconnected": map[string]int{"httpStatusCode": 429}})}, false},
		{"artifact before turn quota", []any{image, turn("usageLimitExceeded")}, false},
		{"artifact before error quota", []any{image, notification("native-thread", false, "rateLimitExceeded")}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			events, err := json.Marshal(tc.events)
			if err != nil {
				t.Fatal(err)
			}
			t.Setenv("MULTICA_TEST_CODEX_IMAGE_EVENTS", string(events))
			command := imageTestCommand(t, "events")
			home := t.TempDir()
			if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"fixture":true}`), 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			result, err := GenerateCodexImage(ctx, command, home, t.TempDir(), "test image", nil)
			if result.RateLimited != tc.limited || (err == nil) != tc.limited || result.Path != "" {
				t.Fatalf("result=%+v err=%v, want rate limited=%v", result, err, tc.limited)
			}
			if ctx.Err() != nil {
				t.Fatal("terminal notification did not finish promptly")
			}
		})
	}
}

func TestProbeCodexNativeImages(t *testing.T) {
	for _, mode := range []string{"ready", "apikey", "unsupported", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			err := ProbeCodexImages(t.Context(), imageTestCommand(t, mode), t.TempDir())
			if (err == nil) != (mode == "ready") {
				t.Fatalf("probe %s: %v", mode, err)
			}
		})
	}
}

func TestCodexNativeImageReceipts(t *testing.T) {
	for _, mode := range []string{"generate", "edit", "duplicate", "quota", "prose", "multiple", "eof", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			command := imageTestCommand(t, mode)
			home, dir := t.TempDir(), t.TempDir()
			if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"fixture":true}`), 0600); err != nil {
				t.Fatal(err)
			}
			var inputs []string
			if mode == "edit" {
				inputs = []string{filepath.Join(dir, "input.png")}
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if mode == "cancel" {
				time.AfterFunc(150*time.Millisecond, cancel)
			}
			result, err := GenerateCodexImage(ctx, command, home, dir, "test image", inputs)
			switch mode {
			case "generate", "edit", "duplicate":
				if err != nil || !strings.HasPrefix(result.Path, dir+string(filepath.Separator)) || result.RateLimited {
					t.Fatalf("receipt=%+v err=%v", result, err)
				}
				if _, err := os.Stat(result.Path); err != nil {
					t.Fatal(err)
				}
			case "quota":
				if err != nil || !result.RateLimited || result.RetryAfter < 55 || result.RetryAfter > 60 {
					t.Fatalf("quota=%+v err=%v", result, err)
				}
			default:
				if err == nil || result.Path != "" || result.RateLimited {
					t.Fatalf("accepted ambiguous result: %+v %v", result, err)
				}
			}
		})
	}
}
