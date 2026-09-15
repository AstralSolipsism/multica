package cli

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
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
		{
			name:          "windows arm64 Labrastro archive",
			targetVersion: "v0.4.43-labrastro.10",
			goos:          "windows",
			goarch:        "arm64",
			wantAssets: []string{
				"multica-cli-0.4.43-labrastro.10-windows-arm64.zip",
				"multica_windows_arm64.zip",
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
			"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  multica_linux_amd64.tar.gz",
			"bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222  multica-cli-1.2.3-linux-amd64.tar.gz",
		}, "\n"))

		name, sum, err := resolveReleaseAsset(manifest, "v1.2.3", "linux", "amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if name != "multica-cli-1.2.3-linux-amd64.tar.gz" {
			t.Fatalf("asset mismatch: got %q", name)
		}
		if sum != "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222" {
			t.Fatalf("checksum mismatch: got %q", sum)
		}
	})

	t.Run("falls back to the legacy asset when only it is checksummed", func(t *testing.T) {
		manifest := []byte("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  multica_linux_amd64.tar.gz\n")

		name, sum, err := resolveReleaseAsset(manifest, "1.2.3", "linux", "amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if name != "multica_linux_amd64.tar.gz" {
			t.Fatalf("asset mismatch: got %q", name)
		}
		if sum != "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" {
			t.Fatalf("checksum mismatch: got %q", sum)
		}
	})

	t.Run("fails closed when no candidate is checksummed", func(t *testing.T) {
		// An archive missing from checksums.txt must never be downloaded —
		// the manifest is the only thing standing between the release source
		// and an unverified binary swap.
		manifest := []byte("aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  some-other-archive.tar.gz\n")

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
		{"Labrastro release", "v0.4.43-labrastro.1", true},
		{"normalized Labrastro release", "0.4.43-labrastro.10", true},
		{"large revision", "0.4.43-labrastro.18446744073709551616", true},
		{"placeholder", "0.0.0", false},
		{"Labrastro placeholder", "v0.0.0-labrastro.1", false},
		{"zero revision", "v0.4.43-labrastro.0", false},
		{"leading zero base", "v0.04.43-labrastro.1", false},
		{"leading zero revision", "v0.4.43-labrastro.01", false},
		{"dirty release", "v0.4.43-labrastro.1-dirty", false},
		{"Labrastro describe", "v0.4.43-labrastro.1-2-gabcdef0", false},
		{"build metadata", "0.4.43-labrastro.1+build", false},
		{"arbitrary prerelease", "0.4.43-beta.1", false},
		{"embedded whitespace", "v 0.4.43-labrastro.1", false},
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
		{"Labrastro revision", "v0.4.43-labrastro.2", "0.4.43-labrastro.1", true},
		{"numeric revision", "0.4.43-labrastro.10", "v0.4.43-labrastro.9", true},
		{"same Labrastro release", "v0.4.43-labrastro.2", "0.4.43-labrastro.2", false},
		{"older revision", "v0.4.43-labrastro.1", "0.4.43-labrastro.2", false},
		{"greater base", "v0.4.44-labrastro.1", "0.4.43-labrastro.99", true},
		{"base rollback", "v0.4.42-labrastro.99", "0.4.43-labrastro.1", false},
		{"legacy migration", "v0.4.43-labrastro.1", "0.4.43", true},
		{"same-base legacy is older", "0.4.43", "0.4.43-labrastro.1", false},
		{"dirty current", "0.4.44-labrastro.1", "0.4.43-labrastro.1-dirty", false},
		{"describe current", "0.4.44-labrastro.1", "v0.4.43-labrastro.1-1-gabcdef0", false},
		{"invalid target", "0.4.43-labrastro.01", "0.4.43-labrastro.1", false},
		{"large numeric revision", "0.4.43-labrastro.18446744073709551616", "0.4.43-labrastro.18446744073709551615", true},
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
		"aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111  multica-cli-1.2.3-darwin-arm64.tar.gz",
		"bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222  multica-cli-1.2.3-darwin-amd64.tar.gz",
		"cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333\tmulti-tab-separator.tar.gz",
		"DDDD4444DDDD4444DDDD4444DDDD4444DDDD4444DDDD4444DDDD4444DDDD4444  multica_linux_amd64.tar.gz",
	}, "\n"))

	t.Run("returns lowercase sha for matched entry", func(t *testing.T) {
		got, err := parseChecksumManifest(manifest, "multica-cli-1.2.3-darwin-arm64.tar.gz")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111" {
			t.Fatalf("sha = %q, want aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111", got)
		}
	})

	t.Run("matches a tab-separated entry", func(t *testing.T) {
		got, err := parseChecksumManifest(manifest, "multi-tab-separator.tar.gz")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333" {
			t.Fatalf("sha = %q, want cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333cccc3333", got)
		}
	})

	t.Run("downcases an uppercase entry", func(t *testing.T) {
		got, err := parseChecksumManifest(manifest, "multica_linux_amd64.tar.gz")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got != "dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444" {
			t.Fatalf("sha = %q, want dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444dddd4444", got)
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

// A copy of this test executable is the downloaded CLI fixture. It works on
// native Windows as well as Unix without executing an installed user CLI.
func TestMain(m *testing.M) {
	if len(os.Args) == 2 && os.Args[1] == "--version" && os.Getenv("MULTICA_UPDATE_TEST_VERSION") != "" {
		fmt.Println("multica " + os.Getenv("MULTICA_UPDATE_TEST_VERSION") + " (commit: fixture)")
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestFetchLatestVersionRejectsInvalidTargets(t *testing.T) {
	for _, body := range []string{
		`not json`, `{"version":42}`, `{"version":"0.4.43-labrastro.1"}`,
		`{"version":" v0.4.43-labrastro.1 "}`,
		`{"version":"v0.4.43"}`, `{"version":"v0.0.0-labrastro.1"}`,
		`{"version":"v0.4.43-labrastro.01"}`, `{"version":"v0.4.43-labrastro.1-dirty"}`,
		`{"version":"v0.4.43-labrastro.1-2-gabcdef0"}`, `{"version":"../../upstream"}`,
	} {
		t.Run(body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/latest.json" {
					t.Errorf("unexpected request %s", r.URL.Path)
				}
				fmt.Fprint(w, body)
			}))
			defer srv.Close()
			previous := downloadBase
			downloadBase = srv.URL
			t.Cleanup(func() { downloadBase = previous })
			if _, err := FetchLatestVersion(); err == nil {
				t.Fatal("invalid target accepted")
			}
		})
	}
}

func TestChecksumManifestRejectsAmbiguousOrMalformedEntry(t *testing.T) {
	const asset = "multica-cli-0.4.43-labrastro.1-linux-amd64.tar.gz"
	hash := strings.Repeat("a", 64)
	for _, manifest := range []string{
		"bad  " + asset, strings.Repeat("z", 64) + "  " + asset,
		hash + "  " + asset + " extra", hash + "  " + asset + "\n" + hash + "  " + asset,
		hash + "  " + asset + ".extra",
	} {
		if _, err := parseChecksumManifest([]byte(manifest), asset); err == nil {
			t.Fatalf("accepted malformed checksum manifest %q", manifest)
		}
	}
	if _, err := parseChecksumManifest([]byte(hash+" *"+asset), asset); err != nil {
		t.Fatalf("standard binary-mode checksum rejected: %v", err)
	}
	manifest := "bad  " + asset + "\n" + hash + "  multica_linux_amd64.tar.gz"
	if _, _, err := resolveReleaseAsset([]byte(manifest), "v0.4.43-labrastro.1", "linux", "amd64"); err == nil {
		t.Fatal("malformed preferred checksum must not fall back to legacy")
	}
}

func updateArchiveFixture(t *testing.T, name string, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	if runtime.GOOS == "windows" {
		zw := zip.NewWriter(&buf)
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := zw.Close(); err != nil {
			t.Fatal(err)
		}
	} else {
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatal(err)
		}
		if err := tw.Close(); err != nil {
			t.Fatal(err)
		}
		if err := gz.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return buf.Bytes()
}

func TestUpdateViaDownloadPreservesInstallationOnFailure(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	binary, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	binaryName := "multica"
	if runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	goodArchive := updateArchiveFixture(t, "release/"+binaryName, binary)
	missingBinaryArchive := updateArchiveFixture(t, "README", []byte("missing CLI"))
	const tag = "v0.4.43-labrastro.10"
	for _, mode := range []string{"versioned", "legacy", "missing-checksum", "missing-entry", "duplicate-entry", "missing-archive", "corrupt-download", "invalid-archive", "missing-binary", "wrong-version", "unrunnable"} {
		t.Run(mode, func(t *testing.T) {
			archive := goodArchive
			if mode == "invalid-archive" {
				archive = []byte("not an archive")
			}
			if mode == "missing-binary" {
				archive = missingBinaryArchive
			}
			if mode == "unrunnable" {
				archive = updateArchiveFixture(t, binaryName, []byte("not executable"))
			}
			sum := sha256.Sum256(archive)
			hash := hex.EncodeToString(sum[:])
			candidates := releaseAssetCandidates(tag, runtime.GOOS, runtime.GOARCH)
			asset := candidates[0]
			if mode == "legacy" {
				asset = candidates[1]
			}
			manifest := hash + "  " + asset + "\n"
			if mode == "missing-entry" {
				manifest = hash + "  another-archive.zip\n"
			}
			if mode == "duplicate-entry" {
				manifest += manifest
			}
			var requests []string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests = append(requests, r.URL.Path)
				switch r.URL.Path {
				case "/latest.json":
					fmt.Fprintf(w, `{"version":%q}`, tag)
				case "/cli/" + tag + "/checksums.txt":
					if mode == "missing-checksum" {
						w.WriteHeader(404)
						return
					}
					fmt.Fprint(w, manifest)
				case "/cli/" + tag + "/" + asset:
					if mode == "missing-archive" {
						w.WriteHeader(404)
						return
					}
					if mode == "corrupt-download" {
						fmt.Fprint(w, "tampered")
						return
					}
					_, _ = w.Write(archive)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer srv.Close()
			previous := downloadBase
			downloadBase = srv.URL
			t.Cleanup(func() { downloadBase = previous })
			reportedVersion := strings.TrimPrefix(tag, "v")
			if mode == "wrong-version" {
				reportedVersion = "0.4.43-labrastro.9"
			}
			t.Setenv("MULTICA_UPDATE_TEST_VERSION", reportedVersion)
			dir := t.TempDir()
			target := filepath.Join(dir, binaryName)
			old := []byte("working installation")
			if err := os.WriteFile(target, old, 0755); err != nil {
				t.Fatal(err)
			}
			latest, err := FetchLatestVersion()
			if err != nil {
				t.Fatal(err)
			}
			_, err = updateViaDownload(latest, time.Second*20, target)
			success := mode == "versioned" || mode == "legacy"
			if (err == nil) != success {
				t.Fatalf("success=%v, error=%v", success, err)
			}
			got, readErr := os.ReadFile(target)
			if readErr != nil {
				t.Fatal(readErr)
			}
			want := old
			if success {
				want = binary
			}
			if !bytes.Equal(got, want) {
				t.Fatal("installation has incorrect bytes")
			}
			wantRequests := []string{"/latest.json", "/cli/" + tag + "/checksums.txt"}
			if mode != "missing-checksum" && mode != "missing-entry" && mode != "duplicate-entry" {
				wantRequests = append(wantRequests, "/cli/"+tag+"/"+asset)
			}
			if strings.Join(requests, "\n") != strings.Join(wantRequests, "\n") {
				t.Fatalf("requests = %v, want %v", requests, wantRequests)
			}
			temporary, _ := filepath.Glob(filepath.Join(dir, "multica-update-*"))
			if len(temporary) != 0 {
				t.Fatalf("staged files left behind: %v", temporary)
			}
		})
	}
}

func TestUpdateViaDownloadRejectsInvalidTargetBeforeFetching(t *testing.T) {
	for _, target := range []string{"", "../bad", "v0.4.43", "v0.4.43-labrastro.1-dirty", "v0.4.43-labrastro.01"} {
		if _, err := UpdateViaDownload(target); err == nil || !strings.Contains(err.Error(), "update target") {
			t.Fatalf("target %q: expected validation error, got %v", target, err)
		}
	}
}
