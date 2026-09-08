package projectfile

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *Service) List(ctx context.Context, scope Scope, prefix, after string, limit int32) (Page, error) {
	if !validPrefix(prefix) || (after != "" && ValidatePath(after) != nil) || limit < 1 || limit > 200 {
		return Page{}, ErrInvalid
	}
	if _, err := s.authorize(ctx, s.queries, scope); err != nil {
		return Page{}, err
	}
	rows, err := s.queries.ListProjectFiles(ctx, db.ListProjectFilesParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Prefix: prefix, AfterPath: after, PageLimit: limit + 1,
	})
	if err != nil {
		return Page{}, err
	}
	page := Page{Files: make([]File, 0, min(len(rows), int(limit)))}
	if len(rows) > int(limit) {
		rows = rows[:limit]
		page.NextCursor = rows[len(rows)-1].Path
	}
	for _, row := range rows {
		page.Files = append(page.Files, File{
			FileID: util.UUIDToString(row.ID), Path: row.Path, Revision: row.Revision, BaseRevision: row.BaseRevision, VersionID: util.UUIDToString(row.VersionID),
			SizeBytes: row.SizeBytes, SHA256: row.Sha256, ContentType: row.ContentType, AuthorType: row.AuthorType,
			AuthorID: util.UUIDToString(row.AuthorID), SourceTaskID: util.UUIDToString(row.SourceTaskID), UpdatedAt: row.UpdatedAt.Time,
		})
	}
	return page, nil
}

func (s *Service) Candidates(ctx context.Context, scope Scope, path, after string, limit int32) (Page, error) {
	if ValidatePath(path) != nil || limit < 1 || limit > 200 {
		return Page{}, ErrInvalid
	}
	if after == "" {
		after = "00000000-0000-0000-0000-000000000000"
	}
	afterID, err := util.ParseUUID(after)
	if err != nil {
		return Page{}, ErrInvalid
	}
	if _, err = s.authorize(ctx, s.queries, scope); err != nil {
		return Page{}, err
	}
	rows, err := s.queries.ListProjectFileCandidates(ctx, db.ListProjectFileCandidatesParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Path: path, AfterID: afterID, PageLimit: limit + 1,
	})
	if err != nil {
		return Page{}, err
	}
	page := Page{Files: make([]File, 0, min(len(rows), int(limit)))}
	if len(rows) > int(limit) {
		rows = rows[:limit]
		page.NextCursor = util.UUIDToString(rows[len(rows)-1].CandidateID)
	}
	for _, row := range rows {
		page.Files = append(page.Files, File{
			FileID: util.UUIDToString(row.FileID), Path: row.Path, BaseRevision: row.BaseRevision, VersionID: util.UUIDToString(row.VersionID),
			CandidateID: util.UUIDToString(row.CandidateID), SizeBytes: row.SizeBytes, SHA256: row.Sha256, ContentType: row.ContentType,
			AuthorType: row.AuthorType, AuthorID: util.UUIDToString(row.AuthorID), SourceTaskID: util.UUIDToString(row.SourceTaskID), UpdatedAt: row.CreatedAt.Time,
		})
	}
	return page, nil
}

func (s *Service) Read(ctx context.Context, scope Scope, path string, revision *int64) (File, io.ReadCloser, error) {
	if ValidatePath(path) != nil || (revision != nil && (*revision < 1 || *revision > MaxRevision+1)) {
		return File{}, nil, ErrInvalid
	}
	if _, err := s.authorize(ctx, s.queries, scope); err != nil {
		return File{}, nil, err
	}
	rev := pgtype.Int8{}
	if revision != nil {
		rev = pgtype.Int8{Int64: *revision, Valid: true}
	}
	row, err := s.queries.ReadProjectFile(ctx, db.ReadProjectFileParams{WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Path: path, Revision: rev})
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, nil, ErrNotFound
	}
	if err != nil {
		return File{}, nil, err
	}
	file := File{FileID: util.UUIDToString(row.FileID), Path: row.Path, Revision: row.Revision.Int64, BaseRevision: row.BaseRevision,
		VersionID: util.UUIDToString(row.ID), SizeBytes: row.SizeBytes, SHA256: row.Sha256, ContentType: row.ContentType,
		AuthorType: row.AuthorType, AuthorID: util.UUIDToString(row.AuthorID), SourceTaskID: util.UUIDToString(row.SourceTaskID), UpdatedAt: row.CreatedAt.Time}
	return s.open(ctx, scope, file, row.ObjectKey)
}

func (s *Service) ReadCandidate(ctx context.Context, scope Scope, id pgtype.UUID) (File, io.ReadCloser, error) {
	if !id.Valid {
		return File{}, nil, ErrInvalid
	}
	if _, err := s.authorize(ctx, s.queries, scope); err != nil {
		return File{}, nil, err
	}
	row, err := s.queries.GetProjectFileCandidate(ctx, db.GetProjectFileCandidateParams{WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ID: id})
	if errors.Is(err, pgx.ErrNoRows) {
		return File{}, nil, ErrNotFound
	}
	if err != nil {
		return File{}, nil, err
	}
	file := File{FileID: util.UUIDToString(row.FileID), Path: row.Path, BaseRevision: row.BaseRevision, VersionID: util.UUIDToString(row.ID),
		CandidateID: util.UUIDToString(row.CandidateID), SizeBytes: row.SizeBytes, SHA256: row.Sha256, ContentType: row.ContentType,
		AuthorType: row.AuthorType, AuthorID: util.UUIDToString(row.AuthorID), SourceTaskID: util.UUIDToString(row.SourceTaskID), UpdatedAt: row.CreatedAt.Time}
	return s.open(ctx, scope, file, row.ObjectKey)
}

func (s *Service) open(ctx context.Context, scope Scope, file File, key string) (File, io.ReadCloser, error) {
	ctx, cancel := context.WithTimeout(ctx, s.options.UploadTimeout)
	reader, err := s.objects.Open(ctx, key)
	if err != nil {
		cancel()
		return File{}, nil, fmt.Errorf("%w: %w", ErrStorage, err)
	}
	// Storage may have stalled; enforce revocation before returning bytes.
	if _, err = s.authorize(ctx, s.queries, scope); err != nil {
		_ = reader.Close()
		cancel()
		return File{}, nil, err
	}
	return file, cancelReader{ReadCloser: reader, cancel: cancel}, nil
}

type cancelReader struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (r cancelReader) Close() error {
	r.cancel()
	return r.ReadCloser.Close()
}
