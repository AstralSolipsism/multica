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
			result["thread"] = map[string]string{"id": "native-thread"}
		case "turn/start":
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
