package cli

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReleaseAssetCandidates(t *testing.T) {
	tests := []struct {
		name          string
		targetVersion string
		goos          string
		goarch        string
		wantAssets    []string
	}{
		{
			name:          "darwin prefers versioned then legacy candidate",
			targetVersion: "v1.2.3",
			goos:          "darwin",
			goarch:        "arm64",
			wantAssets: []string{
				"multica-cli-1.2.3-darwin-arm64.tar.gz",
				"multica_darwin_arm64.tar.gz",
			},
		},
		{
			name:          "linux normalizes missing v in versioned candidate",
			targetVersion: "1.2.3",
			goos:          "linux",
			goarch:        "amd64",
			wantAssets: []string{
				"multica-cli-1.2.3-linux-amd64.tar.gz",
				"multica_linux_amd64.tar.gz",
			},
		},
		{
			name:          "windows uses zip assets",
			targetVersion: "1.2.3",
			goos:          "windows",
			goarch:        "amd64",
			wantAssets: []string{
				"multica-cli-1.2.3-windows-amd64.zip",
				"multica_windows_amd64.zip",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := releaseAssetCandidates(tt.targetVersion, tt.goos, tt.goarch)
			if len(got) != len(tt.wantAssets) {
				t.Fatalf("candidate count mismatch: got %d, want %d", len(got), len(tt.wantAssets))
			}
			for i := range got {
				if got[i] != tt.wantAssets[i] {
					t.Fatalf("candidate[%d] mismatch: got %q, want %q", i, got[i], tt.wantAssets[i])
				}
			}
		})
	}
}

func TestResolveReleaseAsset(t *testing.T) {
	t.Run("prefers the versioned asset when both names are checksummed", func(t *testing.T) {
		manifest := []byte(strings.Join([]string{
			"aaaa1111  multica_linux_amd64.tar.gz",
			"bbbb2222  multica-cli-1.2.3-linux-amd64.tar.gz",
		}, "\n"))

		name, sum, err := resolveReleaseAsset(manifest, "v1.2.3", "linux", "amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if name != "multica-cli-1.2.3-linux-amd64.tar.gz" {
			t.Fatalf("asset mismatch: got %q", name)
		}
		if sum != "bbbb2222" {
			t.Fatalf("checksum mismatch: got %q", sum)
		}
	})

	t.Run("falls back to the legacy asset when only it is checksummed", func(t *testing.T) {
		manifest := []byte("aaaa1111  multica_linux_amd64.tar.gz\n")

		name, sum, err := resolveReleaseAsset(manifest, "1.2.3", "linux", "amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if name != "multica_linux_amd64.tar.gz" {
			t.Fatalf("asset mismatch: got %q", name)
		}
		if sum != "aaaa1111" {
			t.Fatalf("checksum mismatch: got %q", sum)
		}
	})

	t.Run("fails closed when no candidate is checksummed", func(t *testing.T) {
		// An archive missing from checksums.txt must never be downloaded —
		// the manifest is the only thing standing between the release source
		// and an unverified binary swap.
		manifest := []byte("aaaa1111  some-other-archive.tar.gz\n")

		_, _, err := resolveReleaseAsset(manifest, "1.2.3", "linux", "amd64")
		if err == nil {
			t.Fatal("expected error when no candidate is checksummed")
		}
		if !strings.Contains(err.Error(), "multica-cli-1.2.3-linux-amd64.tar.gz") {
			t.Fatalf("error should name the tried candidates: %v", err)
		}
	})
}

func TestFetchLatestVersion(t *testing.T) {
	t.Run("returns the manifest version", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, `{"version":"v0.4.40-labrastro.2","commit":"882ab068c"}`)
		}))
		defer srv.Close()

		prevBase := downloadBase
		downloadBase = srv.URL
		t.Cleanup(func() { downloadBase = prevBase })

		got, err := FetchLatestVersion()
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "v0.4.40-labrastro.2" {
			t.Fatalf("FetchLatestVersion() = %q, want v0.4.40-labrastro.2", got)
		}
	})

	t.Run("fails on a manifest without a version", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, `{"channel":"internal"}`)
		}))
		defer srv.Close()

		prevBase := downloadBase
		downloadBase = srv.URL
		t.Cleanup(func() { downloadBase = prevBase })

		if _, err := FetchLatestVersion(); err == nil {
			t.Fatal("expected error for manifest without version")
		}
	})

	t.Run("fails on a non-200 manifest", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusNotFound)
		}))
		defer srv.Close()

		prevBase := downloadBase
		downloadBase = srv.URL
		t.Cleanup(func() { downloadBase = prevBase })

		if _, err := FetchLatestVersion(); err == nil {
			t.Fatal("expected error for missing manifest")
		}
	})
}

func TestIsReleaseVersion(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"bare release", "0.1.13", true},
		{"v-prefixed release", "v0.1.13", true},
		{"surrounding whitespace", "  v0.1.13  ", true},
		{"dev describe", "v0.2.15-235-gdaf0e935", false},
		{"dirty dev describe", "v0.2.15-235-gdaf0e935-dirty", false},
		{"empty", "", false},
		{"two components", "0.1", false},
		{"four components", "0.1.2.3", false},
		{"non-numeric", "1.0.x", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsReleaseVersion(tt.in); got != tt.want {
				t.Fatalf("IsReleaseVersion(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		name            string
		latest, current string
		want            bool
	}{
		{"patch bump", "v0.1.14", "v0.1.13", true},
		{"minor bump", "v0.2.0", "v0.1.99", true},
		{"major bump", "v1.0.0", "v0.99.99", true},
		{"same version", "v0.1.13", "v0.1.13", false},
		{"older latest", "v0.1.12", "v0.1.13", false},
		{"mixed v prefix", "0.1.14", "v0.1.13", true},
		{"current is dev describe → unparseable → false", "v0.1.14", "v0.1.13-5-gabcdef0", false},
		{"latest is dev describe → unparseable → false", "v0.1.14-1-gabcdef0", "v0.1.13", false},
		{"latest unparseable → false", "garbage", "v0.1.13", false},
		{"current unparseable → false", "v0.1.14", "garbage", false},
		{"empty latest", "", "v0.1.13", false},
		{"empty current", "v0.1.14", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsNewerVersion(tt.latest, tt.current); got != tt.want {
				t.Fatalf("IsNewerVersion(%q, %q) = %v, want %v", tt.latest, tt.current, got, tt.want)
			}
		})
	}
}

func TestParseChecksumManifest(t *testing.T) {
	manifest := []byte(strings.Join([]string{
		"# generated by GoReleaser",
		"",
		"aaaa1111  multica-cli-1.2.3-darwin-arm64.tar.gz",
		"bbbb2222  multica-cli-1.2.3-darwin-amd64.tar.gz",
		"cccc3333\tmulti-tab-separator.tar.gz",
		"DDDD4444  multica_linux_amd64.tar.gz",
	}, "\n"))

	t.Run("returns lowercase sha for matched entry", func(t *testing.T) {
		got, err := parseChecksumManifest(manifest, "multica-cli-1.2.3-darwin-arm64.tar.gz")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "aaaa1111" {
			t.Fatalf("sha = %q, want aaaa1111", got)
		}
	})

	t.Run("matches a tab-separated entry", func(t *testing.T) {
		got, err := parseChecksumManifest(manifest, "multi-tab-separator.tar.gz")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "cccc3333" {
			t.Fatalf("sha = %q, want cccc3333", got)
		}
	})

	t.Run("downcases an uppercase entry", func(t *testing.T) {
		got, err := parseChecksumManifest(manifest, "multica_linux_amd64.tar.gz")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "dddd4444" {
			t.Fatalf("sha = %q, want dddd4444", got)
		}
	})

	t.Run("returns error when asset is absent", func(t *testing.T) {
		_, err := parseChecksumManifest(manifest, "not-in-manifest.tar.gz")
		if err == nil {
			t.Fatal("expected error for missing asset")
		}
	})

	t.Run("skips blank lines and comments", func(t *testing.T) {
		// If parsing broke on blank/comment lines we'd never reach the
		// matching entry below them.
		if _, err := parseChecksumManifest(manifest, "multica-cli-1.2.3-darwin-arm64.tar.gz"); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestVerifyAssetSHA256(t *testing.T) {
	data := []byte("hello multica")
	sum := sha256.Sum256(data)
	good := hex.EncodeToString(sum[:])

	t.Run("accepts matching sha", func(t *testing.T) {
		if err := verifyAssetSHA256(data, good, "asset.tar.gz"); err != nil {
			t.Fatalf("expected ok, got %v", err)
		}
	})

	t.Run("accepts uppercase expected hex", func(t *testing.T) {
		if err := verifyAssetSHA256(data, strings.ToUpper(good), "asset.tar.gz"); err != nil {
			t.Fatalf("expected ok with uppercase expected, got %v", err)
		}
	})

	t.Run("rejects mismatched sha", func(t *testing.T) {
		err := verifyAssetSHA256([]byte("tampered"), good, "asset.tar.gz")
		if err == nil {
			t.Fatal("expected mismatch error")
		}
		if !strings.Contains(err.Error(), "asset.tar.gz") {
			t.Fatalf("error should name the asset: %v", err)
		}
	})

	t.Run("rejects empty expected", func(t *testing.T) {
		if err := verifyAssetSHA256(data, "", "asset.tar.gz"); err == nil {
			t.Fatal("expected error for empty expected sha")
		}
	})
}

func TestUpdateDownloadTimeoutOrDefault(t *testing.T) {
	tests := []struct {
		name    string
		timeout time.Duration
		want    time.Duration
	}{
		{
			name:    "uses default for zero",
			timeout: 0,
			want:    DefaultUpdateDownloadTimeout,
		},
		{
			name:    "uses default for negative",
			timeout: -1 * time.Second,
			want:    DefaultUpdateDownloadTimeout,
		},
		{
			name:    "keeps explicit timeout",
			timeout: 10 * time.Minute,
			want:    10 * time.Minute,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := updateDownloadTimeoutOrDefault(tt.timeout)
			if got != tt.want {
				t.Fatalf("timeout = %s, want %s", got, tt.want)
			}
		})
	}
}
