package main

import (
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/multica-ai/multica/server/internal/projectfile"
	"github.com/multica-ai/multica/server/internal/storage"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// Invalid opt-in configuration disables all file endpoints, with no fallback
// to public attachments or local storage. Logs deliberately exclude values.
func configureProjectFiles(queries *db.Queries, beginner projectfile.Beginner, base *storage.S3Storage) *projectfile.Service {
	if os.Getenv("MULTICA_PROJECT_FILES_ENABLED") != "true" {
		return nil
	}
	options, err := projectFileOptionsFromEnv()
	if err != nil {
		slog.Error("project files disabled: invalid limits or read-only configuration")
		return nil
	}
	objects, err := storage.NewPrivateObjectStorage(base, os.Getenv("MULTICA_PROJECT_FILES_BUCKET"))
	if err != nil {
		slog.Error("project files disabled: configure S3 and a distinct private bucket")
		return nil
	}
	return projectfile.New(queries, beginner, objects, options)
}

func projectFileOptionsFromEnv() (projectfile.Options, error) {
	options := projectfile.Options{MaxBytes: projectfile.DefaultMaxBytes, UploadTimeout: 5 * time.Minute, CommitTimeout: 5 * time.Second}
	var err error
	if raw := os.Getenv("MULTICA_PROJECT_FILES_READ_ONLY"); raw != "" {
		options.ReadOnly, err = strconv.ParseBool(raw)
		if err != nil {
			return options, err
		}
	}
	if raw := os.Getenv("MULTICA_PROJECT_FILES_MAX_BYTES"); raw != "" {
		options.MaxBytes, err = strconv.ParseInt(raw, 10, 64)
		if err != nil {
			return options, err
		}
		if options.MaxBytes < 1 || options.MaxBytes > 1<<30 {
			return options, projectfile.ErrInvalid
		}
	}
	if raw := os.Getenv("MULTICA_PROJECT_FILES_UPLOAD_TIMEOUT"); raw != "" {
		options.UploadTimeout, err = time.ParseDuration(raw)
		if err != nil {
			return options, err
		}
		if options.UploadTimeout < time.Second || options.UploadTimeout > 30*time.Minute {
			return options, projectfile.ErrInvalid
		}
	}
	return options, nil
}
