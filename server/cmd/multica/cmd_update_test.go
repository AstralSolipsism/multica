package main

import (
	"strings"
	"testing"
	"time"
)

func TestRunUpdateRejectsNonPositiveDownloadTimeout(t *testing.T) {
	orig := updateDownloadTimeout
	updateDownloadTimeout = 0
	t.Cleanup(func() { updateDownloadTimeout = orig })

	err := runUpdate(nil, nil)
	if err == nil || !strings.Contains(err.Error(), "download timeout must be greater than zero") {
		t.Fatalf("runUpdate error = %v, want download timeout validation", err)
	}
}

func TestRunUpdateVersionPolicy(t *testing.T) {
	originalVersion, originalFetch, originalDownload := version, fetchUpdateVersion, downloadUpdate
	t.Cleanup(func() { version, fetchUpdateVersion, downloadUpdate = originalVersion, originalFetch, originalDownload })
	for _, tc := range []struct {
		name, current, latest   string
		wantDownload, wantError bool
	}{
		{"revision", "0.4.43-labrastro.9", "v0.4.43-labrastro.10", true, false},
		{"base", "0.4.43-labrastro.99", "v0.4.44-labrastro.1", true, false},
		{"legacy migration", "v0.4.43", "v0.4.43-labrastro.1", true, false},
		{"same", "0.4.43-labrastro.10", "v0.4.43-labrastro.10", false, false},
		{"older", "0.4.43-labrastro.11", "v0.4.43-labrastro.10", false, false},
		{"base rollback", "0.4.44-labrastro.1", "v0.4.43-labrastro.99", false, false},
		{"dirty", "v0.4.43-labrastro.1-dirty", "v0.4.43-labrastro.10", false, true},
		{"describe", "v0.4.43-labrastro.1-2-gabcdef0", "v0.4.43-labrastro.10", false, true},
		{"dev", "dev", "v0.4.43-labrastro.10", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			version = tc.current
			fetches, downloads := 0, 0
			fetchUpdateVersion = func() (string, error) { fetches++; return tc.latest, nil }
			downloadUpdate = func(target string, timeout time.Duration) (string, error) {
				downloads++
				if target != tc.latest || timeout != updateDownloadTimeout {
					t.Fatalf("unexpected download %q, %s", target, timeout)
				}
				return "fixture downloaded", nil
			}
			err := runUpdate(nil, nil)
			if (err != nil) != tc.wantError {
				t.Fatalf("error=%v, wantError=%v", err, tc.wantError)
			}
			if (downloads == 1) != tc.wantDownload {
				t.Fatalf("downloads=%d, wantDownload=%v", downloads, tc.wantDownload)
			}
			if tc.wantError && fetches != 0 {
				t.Fatal("development build reached release source")
			}
		})
	}
}
