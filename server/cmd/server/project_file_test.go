package main

import (
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/projectfile"
)

func TestProjectFileConfiguration(t *testing.T) {
	for _, name := range []string{"MULTICA_PROJECT_FILES_READ_ONLY", "MULTICA_PROJECT_FILES_MAX_BYTES", "MULTICA_PROJECT_FILES_UPLOAD_TIMEOUT"} {
		t.Setenv(name, "")
	}
	options, err := projectFileOptionsFromEnv()
	if err != nil || options.MaxBytes != projectfile.DefaultMaxBytes || options.ReadOnly || options.UploadTimeout != 5*time.Minute {
		t.Fatalf("defaults: %+v %v", options, err)
	}
	for _, test := range []struct{ name, value string }{
		{"MULTICA_PROJECT_FILES_READ_ONLY", "maybe"},
		{"MULTICA_PROJECT_FILES_MAX_BYTES", "0"},
		{"MULTICA_PROJECT_FILES_MAX_BYTES", "1073741825"},
		{"MULTICA_PROJECT_FILES_UPLOAD_TIMEOUT", "31m"},
		{"MULTICA_PROJECT_FILES_UPLOAD_TIMEOUT", "10ms"},
	} {
		t.Run(test.name+test.value, func(t *testing.T) {
			t.Setenv(test.name, test.value)
			if _, err := projectFileOptionsFromEnv(); err == nil {
				t.Fatal("accepted invalid configuration")
			}
		})
	}
	t.Setenv("MULTICA_PROJECT_FILES_READ_ONLY", "true")
	options, err = projectFileOptionsFromEnv()
	if err != nil || !options.ReadOnly {
		t.Fatalf("read-only: %+v %v", options, err)
	}
}
