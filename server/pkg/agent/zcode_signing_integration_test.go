//go:build agentintegration

package agent

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestZcodeRealDesktopProviderSigning uses the installed CLI with synthetic
// credentials and a local HTTPS provider. No account credentials are needed.
func TestZcodeRealDesktopProviderSigning(t *testing.T) {
	requireRealAgentSmoke(t)
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need extra privileges on Windows")
	}
	path, err := exec.LookPath("zcode")
	if err != nil {
		t.Fatal(err)
	}
	script := resolveZcodeScript(path)
	if !isNodeScriptPath(script) || zcodeBuiltinProviderConfig(script) == "" {
		t.Fatal("this smoke test requires an installed ZCode Node bundle")
	}
	if version, err := exec.Command(path, "--version").CombinedOutput(); err == nil {
		t.Logf("zcode version: %s", strings.TrimSpace(string(version)))
	}
	for _, sourceID := range []string{"builtin:bigmodel-coding-plan", "builtin:zai-coding-plan", "custom"} {
		t.Run(sourceID, func(t *testing.T) {
			root := t.TempDir()
			link := filepath.Join(root, "zcode")
			if err := os.Symlink(script, link); err != nil {
				t.Fatal(err)
			}
			const apiKey = "smoke-id.smoke-secret"
			publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			privateCipher := zcodeSmokePrivateCipher(t, privateKey)
			handshakeKey, err := hkdf.Key(sha256.New, []byte("smoke-secret"), []byte("WD_CLIENT_SIGN_KDF_SALT"), "getSignKey_hmac", 32)
			if err != nil {
				t.Fatal(err)
			}
			wantSigning := sourceID != "custom"
			var handshakes, requests atomic.Int32
			provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/paas/c1f3a7e2/v2/client" {
					handshakes.Add(1)
					var body struct{ APIKey, Nonce, Sig, Ts string }
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						http.Error(w, "bad handshake", http.StatusBadRequest)
						return
					}
					mac := hmac.New(sha256.New, handshakeKey)
					fmt.Fprintf(mac, "get_sign_key\nsmoke-id\n%s\n%s", body.Ts, body.Nonce)
					if body.APIKey != apiKey || r.Header.Get("Authorization") != apiKey || body.Sig != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
						t.Error("invalid signing handshake credentials or HMAC")
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprintf(w, `{"code":200,"data":{"privateCipher":%q}}`, privateCipher)
					return
				}
				if r.URL.Path != "/v1/messages" {
					t.Errorf("unexpected provider path %s", r.URL.Path)
					http.NotFound(w, r)
					return
				}
				requests.Add(1)
				sig := r.Header.Get("X-Client-Sig")
				if wantSigning {
					message := strings.Join([]string{"smoke-id", r.Header.Get("X-Client-Ts"), r.Header.Get("X-Client-Version"), r.Header.Get("X-Session-Id"), r.Header.Get("X-Client-Nonce")}, "\n")
					decoded, err := base64.StdEncoding.DecodeString(sig)
					if err != nil || !ed25519.Verify(publicKey, []byte(message), decoded) {
						t.Error("model request has no valid Ed25519 client signature")
					}
					if r.Header.Get("X-Client-Pow") == "" || r.Header.Get("X-App-Id") != "zcode" {
						t.Error("model request has no proof of work or app identity")
					}
				} else if sig != "" {
					t.Error("ordinary custom API connection unexpectedly signed")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_smoke\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"GLM-5.3\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n"+
					"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"+
					"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"done\"}}\n\n"+
					"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n"+
					"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n"+
					"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			}))
			defer provider.Close()
			ca := filepath.Join(root, "ca.pem")
			writeZcodeFixture(t, ca, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: provider.Certificate().Raw})))
			t.Setenv("NODE_EXTRA_CA_CERTS", ca)
			t.Setenv("NO_PROXY", "127.0.0.1,localhost")
			t.Setenv("ZCODE_DATA_BASE_DIR", root)
			t.Setenv(zcodePersonalConfigEnv, "")
			t.Setenv("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", zcodeBuiltinProviderConfig(script))
			writeZcodeFixture(t, filepath.Join(root, ".zcode", "v2", "config.json"), fmt.Sprintf(`{"provider":{%q:{"enabled":true,"kind":"anthropic","options":{"apiKey":%q,"baseURL":%q},"models":{"GLM-5.3":{}}}}}`, sourceID, apiKey, provider.URL))
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			catalog, err := discoverZcodeModels(ctx, NewCommand(link, nil))
			if err != nil {
				t.Fatal(err)
			}
			modelID := "multica-desktop:" + sourceID + "/GLM-5.3"
			var selected *Model
			for i := range catalog.Models {
				if catalog.Models[i].ID == modelID {
					selected = &catalog.Models[i]
				}
			}
			if selected == nil {
				t.Fatalf("imported model %s absent from catalog: %+v", modelID, catalog.Models)
			}
			opts := ExecOptions{Cwd: root, Model: modelID, Timeout: 50 * time.Second}
			if selected.Thinking != nil {
				opts.ThinkingLevel = selected.Thinking.DefaultLevel
				if opts.ThinkingLevel == "" && len(selected.Thinking.SupportedLevels) > 0 {
					opts.ThinkingLevel = selected.Thinking.SupportedLevels[0].Value
				}
			}
			session, err := newZcodeTestBackend(t, link).Execute(ctx, "Reply with done.", opts)
			if err != nil {
				t.Fatal(err)
			}
			_, result := collectZcodeSession(t, session)
			if result.Status != "completed" || result.SessionID == "" {
				t.Fatalf("turn did not complete: %+v", result)
			}
			if requests.Load() == 0 || (handshakes.Load() > 0) != wantSigning {
				t.Fatalf("handshakes=%d requests=%d, want signing=%v", handshakes.Load(), requests.Load(), wantSigning)
			}
			t.Logf("symlink model=%s; handshakes=%d; model requests=%d; signed=%v; turn=%s", modelID, handshakes.Load(), requests.Load(), wantSigning, result.Status)
		})
	}
}

func zcodeSmokePrivateCipher(t *testing.T, key ed25519.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	derived, err := hkdf.Key(sha256.New, []byte("smoke-secret"), []byte("WD_CLIENT_SIGN_KDF_SALT"), "ed25519_priv", 32)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(derived)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	sealed := gcm.Seal(nonce, nonce, []byte(base64.StdEncoding.EncodeToString(der)), []byte("smoke-id"))
	return base64.StdEncoding.EncodeToString(sealed)
}
