package projectfile

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type Beginner interface {
	Begin(context.Context) (pgx.Tx, error)
}

type Service struct {
	queries  *db.Queries
	beginner Beginner
	objects  Objects
	options  Options
}

func New(queries *db.Queries, beginner Beginner, objects Objects, options Options) *Service {
	if options.MaxBytes <= 0 {
		options.MaxBytes = DefaultMaxBytes
	}
	if options.UploadTimeout <= 0 {
		options.UploadTimeout = 5 * time.Minute
	}
	if options.CommitTimeout <= 0 {
		options.CommitTimeout = 5 * time.Second
	}
	return &Service{queries: queries, beginner: beginner, objects: objects, options: options}
}

func (s *Service) Options() Options { return s.options }

func (s *Service) CheckAccess(ctx context.Context, scope Scope) error {
	_, err := s.authorize(ctx, s.queries, scope)
	return err
}

type actor struct {
	kind       string
	id         pgtype.UUID
	authorType string
	authorID   pgtype.UUID
	taskID     pgtype.UUID
	userID     pgtype.UUID
}

func resolveActor(scope Scope) (actor, error) {
	u, err := util.ParseUUID(scope.Identity.UserID)
	if err != nil || !scope.WorkspaceID.Valid || !scope.ProjectID.Valid {
		return actor{}, ErrForbidden
	}
	a := actor{kind: "member", id: u, authorType: "member", authorID: u, userID: u}
	i := scope.Identity
	if auth.IsTemporarilyDisabledUser(i.UserID, "") || (!i.ExpiresAt.IsZero() && !time.Now().Before(i.ExpiresAt)) {
		return actor{}, ErrForbidden
	}
	switch i.CredentialKind {
	case "jwt", "pat", "cloud_pat":
		if i.AgentID != "" || i.TaskID != "" {
			return actor{}, ErrForbidden
		}
	case "task":
		if i.WorkspaceID != util.UUIDToString(scope.WorkspaceID) {
			return actor{}, ErrForbidden
		}
		a.taskID, err = util.ParseUUID(i.TaskID)
		if err != nil {
			return actor{}, ErrForbidden
		}
		a.authorID, err = util.ParseUUID(i.AgentID)
		if err != nil {
			return actor{}, ErrForbidden
		}
		a.kind, a.id, a.authorType = "run", a.taskID, "agent"
	default:
		return actor{}, ErrForbidden
	}
	return a, nil
}

func (s *Service) authorize(ctx context.Context, q *db.Queries, scope Scope) (actor, error) {
	a, err := resolveActor(scope)
	if err != nil {
		return a, err
	}
	_, err = q.AuthorizeProjectFileMember(ctx, db.AuthorizeProjectFileMemberParams{ID: scope.ProjectID, WorkspaceID: scope.WorkspaceID, UserID: a.userID})
	if err == nil && scope.Identity.CredentialKind == "pat" {
		_, err = q.AuthorizeProjectFilePAT(ctx, db.AuthorizeProjectFilePATParams{TokenHash: scope.Identity.CredentialHash, UserID: a.userID})
	}
	if err == nil && a.kind == "run" {
		var run db.AuthorizeProjectFileRunRow
		run, err = q.AuthorizeProjectFileRun(ctx, db.AuthorizeProjectFileRunParams{
			TokenHash: scope.Identity.CredentialHash, UserID: a.userID, WorkspaceID: scope.WorkspaceID, AgentID: a.authorID, TaskID: a.taskID,
		})
		if err == nil {
			switch {
			case run.IssueID.Valid:
				_, err = q.AuthorizeProjectFileIssue(ctx, db.AuthorizeProjectFileIssueParams{ID: run.IssueID, WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID})
			case run.ChatSessionID.Valid:
				_, err = q.AuthorizeProjectFileChat(ctx, db.AuthorizeProjectFileChatParams{ID: run.ChatSessionID, WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID})
			default:
				err = ErrForbidden
			}
		}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = ErrForbidden
	}
	return a, err
}

// write holds the project lock only during metadata work. The same lock is
// taken by project deletion. Auth rows stay shared-locked until commit, so a
// concurrent revocation either precedes this commit or waits for it.
func (s *Service) write(ctx context.Context, scope Scope, fn func(context.Context, *db.Queries, actor) error) error {
	ctx, cancel := context.WithTimeout(ctx, s.options.CommitTimeout)
	defer cancel()
	tx, err := s.beginner.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()
	q := s.queries.WithTx(tx)
	if _, err = q.LockProjectFileProject(ctx, db.LockProjectFileProjectParams{ID: scope.ProjectID, WorkspaceID: scope.WorkspaceID}); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		return err
	}
	a, err := s.authorize(ctx, q, scope)
	if err != nil {
		return err
	}
	if err = fn(ctx, q, a); err != nil {
		return err
	}
	// Re-evaluate expiry after all lock waits and metadata work.
	if _, err = s.authorize(ctx, q, scope); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("%w: %w", ErrOutcomeUnknown, err)
	}
	return nil
}

func lookup(ctx context.Context, q *db.Queries, scope Scope, a actor, key string, request Request) (db.ProjectFileOperation, *Result, error) {
	op, err := q.GetProjectFileOperation(ctx, db.GetProjectFileOperationParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ActorType: a.kind, ActorID: a.id, OperationKey: key,
	})
	if err != nil {
		return op, nil, err
	}
	var bound Request
	if err = json.Unmarshal(op.Request, &bound); err != nil {
		return op, nil, err
	}
	if bound != request {
		return op, nil, ErrOpKeyReused
	}
	result, err := replay(op.Result)
	return op, result, err
}

func replay(raw []byte) (*Result, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var result Result
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	result.Replayed = true
	return &result, nil
}

func createOperation(ctx context.Context, q *db.Queries, scope Scope, a actor, key string, request Request) (db.ProjectFileOperation, error) {
	bound, err := json.Marshal(request)
	if err != nil {
		return db.ProjectFileOperation{}, err
	}
	return q.CreateProjectFileOperation(ctx, db.CreateProjectFileOperationParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ActorType: a.kind, ActorID: a.id, OperationKey: key, Request: bound,
	})
}

func complete(ctx context.Context, q *db.Queries, scope Scope, op db.ProjectFileOperation, result Result) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	return changedOne(q.CompleteProjectFileOperation(ctx, db.CompleteProjectFileOperationParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ID: op.ID, Result: raw,
	}))
}

func (s *Service) Save(ctx context.Context, scope Scope, key string, request Request, body io.Reader) (Result, error) {
	if request.Kind != "save" || body == nil {
		return Result{}, ErrInvalid
	}
	if err := request.validate(key, s.options.MaxBytes); err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, s.options.UploadTimeout)
	defer cancel()
	var uploaded db.ProjectFileUpload
	var result *Result
	err := s.write(ctx, scope, func(ctx context.Context, q *db.Queries, a actor) error {
		op, done, err := lookup(ctx, q, scope, a, key, request)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if done != nil {
			result = done
			return nil
		}
		if s.options.ReadOnly {
			return ErrReadOnly
		}
		if errors.Is(err, pgx.ErrNoRows) {
			op, err = createOperation(ctx, q, scope, a, key, request)
			if err != nil {
				return err
			}
		}
		id := uuid.NewString()
		uploaded, err = q.CreateProjectFileUpload(ctx, db.CreateProjectFileUploadParams{
			ID: util.MustParseUUID(id), WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, OperationID: op.ID,
			ObjectKey: "project-files/" + util.UUIDToString(scope.WorkspaceID) + "/" + util.UUIDToString(scope.ProjectID) + "/" + id,
		})
		return err
	})
	if err != nil {
		return Result{}, err
	}
	// Even a replay verifies the supplied bytes; a claimed digest alone is not
	// proof that a repeated request carries identical content.
	if result != nil {
		if err = verifyContent(body, request, nil); err != nil {
			return Result{}, err
		}
		if _, err = s.authorize(ctx, s.queries, scope); err != nil {
			return Result{}, err
		}
		return *result, nil
	}
	err = verifyContent(body, request, func(reader io.Reader) error {
		return s.objects.Put(ctx, uploaded.ObjectKey, reader, request.SizeBytes, request.ContentType)
	})
	if err != nil {
		return Result{}, err
	}
	var out Result
	err = s.write(ctx, scope, func(ctx context.Context, q *db.Queries, a actor) error {
		op, done, err := lookup(ctx, q, scope, a, key, request)
		if err != nil {
			return err
		}
		state := "referenced"
		if done != nil {
			out = *done
			state = "unreferenced"
		} else {
			out, err = saveVersion(ctx, q, scope, a, op, request, uploaded.ObjectKey)
			if err != nil {
				return err
			}
			if err = complete(ctx, q, scope, op, out); err != nil {
				return err
			}
		}
		return changedOne(q.FinishProjectFileUpload(ctx, db.FinishProjectFileUploadParams{
			WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ID: uploaded.ID, State: state,
		}))
	})
	if err != nil {
		return Result{}, err
	}
	return out, nil
}

func verifyContent(body io.Reader, request Request, upload func(io.Reader) error) error {
	hash := sha256.New()
	limited := &io.LimitedReader{R: body, N: request.SizeBytes + 1}
	reader := io.TeeReader(limited, hash)
	if upload != nil {
		if err := upload(reader); err != nil {
			return fmt.Errorf("%w: %w", ErrStorage, err)
		}
		if request.SizeBytes+1-limited.N != request.SizeBytes {
			return ErrContentMismatch
		}
	}
	// Consume at most the remaining declared length plus one byte, including
	// the empty-file case. Detect truncation and extra data without buffering.
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return fmt.Errorf("%w: %w", ErrContentMismatch, err)
	}
	if request.SizeBytes+1-limited.N != request.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != request.SHA256 {
		return ErrContentMismatch
	}
	return nil
}

func saveVersion(ctx context.Context, q *db.Queries, scope Scope, a actor, op db.ProjectFileOperation, request Request, objectKey string) (Result, error) {
	file, err := q.GetProjectFile(ctx, db.GetProjectFileParams{WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Path: request.Path})
	if errors.Is(err, pgx.ErrNoRows) {
		if request.BaseRevision != 0 {
			return Result{}, ErrNotFound
		}
		var ancestors []string
		for i, r := range request.Path {
			if r == '/' {
				ancestors = append(ancestors, request.Path[:i])
			}
		}
		_, collision := q.FindProjectFilePathCollision(ctx, db.FindProjectFilePathCollisionParams{
			WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Ancestors: ancestors, DescendantPrefix: request.Path + "/",
		})
		if collision == nil {
			return Result{}, ErrPathCollision
		}
		if !errors.Is(collision, pgx.ErrNoRows) {
			return Result{}, collision
		}
		file, err = q.CreateProjectFile(ctx, db.CreateProjectFileParams{WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Path: request.Path})
	}
	if err != nil {
		return Result{}, err
	}
	if file.Revision > MaxRevision {
		return Result{}, ErrInvalid
	}
	versionRevision := pgtype.Int8{}
	if file.Revision == request.BaseRevision {
		versionRevision = pgtype.Int8{Int64: file.Revision + 1, Valid: true}
	}
	version, err := q.CreateProjectFileVersion(ctx, db.CreateProjectFileVersionParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, FileID: file.ID, Revision: versionRevision, BaseRevision: request.BaseRevision,
		ObjectKey: objectKey, SizeBytes: request.SizeBytes, Sha256: request.SHA256, ContentType: request.ContentType,
		AuthorType: a.authorType, AuthorID: a.authorID, SourceTaskID: a.taskID, OperationID: op.ID,
	})
	if err != nil {
		return Result{}, err
	}
	result := Result{OperationID: op.OperationKey, Status: StatusSaved, FileID: util.UUIDToString(file.ID), Path: file.Path,
		BaseRevision: request.BaseRevision, Revision: file.Revision, VersionID: util.UUIDToString(version.ID)}
	if versionRevision.Valid {
		result.Revision++
		err = changedOne(q.AdvanceProjectFile(ctx, db.AdvanceProjectFileParams{
			WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ID: file.ID, Revision: file.Revision, CurrentVersionID: version.ID,
		}))
	} else {
		var candidate db.ProjectFileCandidate
		candidate, err = q.CreateProjectFileCandidate(ctx, db.CreateProjectFileCandidateParams{WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, FileID: file.ID, VersionID: version.ID})
		result.Status, result.CandidateID, result.ConflictCurrent = StatusConflict, util.UUIDToString(candidate.ID), file.Revision
	}
	return result, err
}

func (s *Service) Adopt(ctx context.Context, scope Scope, key string, request Request) (Result, error) {
	if request.Kind != "adopt" {
		return Result{}, ErrInvalid
	}
	if err := request.validate(key, s.options.MaxBytes); err != nil {
		return Result{}, err
	}
	var out Result
	err := s.write(ctx, scope, func(ctx context.Context, q *db.Queries, a actor) error {
		op, done, err := lookup(ctx, q, scope, a, key, request)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if done != nil {
			out = *done
			return nil
		}
		if s.options.ReadOnly {
			return ErrReadOnly
		}
		if errors.Is(err, pgx.ErrNoRows) {
			op, err = createOperation(ctx, q, scope, a, key, request)
			if err != nil {
				return err
			}
		}
		candidate, err := q.GetProjectFileCandidate(ctx, db.GetProjectFileCandidateParams{
			WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ID: util.MustParseUUID(request.CandidateID),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if candidate.Path != request.Path || candidate.ResolvedAt.Valid {
			return ErrNotFound
		}
		file, err := q.GetProjectFile(ctx, db.GetProjectFileParams{WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, Path: request.Path})
		if err != nil {
			return err
		}
		if file.Revision != request.BaseRevision {
			out = Result{OperationID: key, Status: StatusConflict, FileID: util.UUIDToString(file.ID), Path: file.Path,
				BaseRevision: request.BaseRevision, Revision: file.Revision, VersionID: util.UUIDToString(candidate.ID), CandidateID: request.CandidateID, ConflictCurrent: file.Revision}
		} else {
			// Adopt references verified immutable bytes. No object I/O occurs
			// while holding the transaction, and the original version survives.
			content := request
			content.SHA256, content.SizeBytes, content.ContentType = candidate.Sha256, candidate.SizeBytes, candidate.ContentType
			out, err = saveVersion(ctx, q, scope, a, op, content, candidate.ObjectKey)
			if err != nil {
				return err
			}
			if err = changedOne(q.ResolveProjectFileCandidate(ctx, db.ResolveProjectFileCandidateParams{
				WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ID: candidate.CandidateID, ResolvedByOperationID: op.ID,
			})); err != nil {
				return err
			}
		}
		return complete(ctx, q, scope, op, out)
	})
	if err != nil {
		return Result{}, err
	}
	return out, nil
}

func (s *Service) Operation(ctx context.Context, scope Scope, key string) (Operation, error) {
	if !ValidOperationKey(key) {
		return Operation{}, ErrInvalid
	}
	a, err := s.authorize(ctx, s.queries, scope)
	if err != nil {
		return Operation{}, err
	}
	op, err := s.queries.GetProjectFileOperation(ctx, db.GetProjectFileOperationParams{
		WorkspaceID: scope.WorkspaceID, ProjectID: scope.ProjectID, ActorType: a.kind, ActorID: a.id, OperationKey: key,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return Operation{}, ErrNotFound
	}
	if err != nil {
		return Operation{}, err
	}
	result, err := replay(op.Result)
	state := "PENDING"
	if result != nil {
		state = "COMPLETED"
	}
	return Operation{State: state, OperationID: key, Result: result}, err
}

func validPrefix(prefix string) bool {
	return prefix == "" || ValidatePath(strings.TrimSuffix(prefix, "/")) == nil
}
