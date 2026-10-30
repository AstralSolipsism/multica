package protocol

// Media manifests travel over authenticated HTTP. Control frames contain only
// identities, fencing tokens and bounded status metadata, never media bytes.
const (
	DaemonCapabilityMediaJobsV1 = "media-jobs-v1"
	MediaImageCodexV1           = "media-image-codex-v1"
	MediaImageAGYV1             = "media-image-agy-v1"
	MediaVideoFlowV1            = "media-video-flow-v1"
	MediaImageWhiskV1           = "media-image-whisk-v1"
	MediaDescriptorVersion      = 1
	MediaControlMaxBytes        = 4096
	MediaMaxExecutors           = 16
	MediaConnectionLeaseSeconds = 90
)

type MediaReadiness string

const (
	MediaReady       MediaReadiness = "ready"
	MediaNeedsAuth   MediaReadiness = "needs_auth"
	MediaUnsupported MediaReadiness = "unsupported"
	MediaUnhealthy   MediaReadiness = "unhealthy"
)

// MediaQuotaRef names only verified applicable windows. An empty Windows list
// means unknown; it must not inherit coding quota simply by provider name.
// ScopeID is a random local resource identity, never an account identifier.
type MediaQuotaRef struct {
	ScopeID   string                `json:"scope_id"`
	RuntimeID string                `json:"runtime_id,omitempty"`
	Windows   []MediaQuotaWindowRef `json:"windows,omitempty"`
}
type MediaQuotaWindowRef struct {
	Name  string `json:"name"`
	Group string `json:"group,omitempty"`
}

type MediaExecutorDescriptor struct {
	ExecutorID        string            `json:"executor_id"`
	CredentialScopeID string            `json:"credential_scope_id"`
	Provider          string            `json:"provider"`
	ResolvedProvider  string            `json:"resolved_provider"`
	Capability        string            `json:"capability"`
	DescriptorVersion int               `json:"descriptor_version"`
	Readiness         MediaReadiness    `json:"readiness"`
	ReasonCode        string            `json:"reason_code,omitempty"`
	ObservedAt        int64             `json:"observed_at"`
	MaxConcurrency    int               `json:"max_concurrency"`
	Models            []string          `json:"models,omitempty"`
	InputRoles        []string          `json:"input_roles,omitempty"`
	OutputFormats     []string          `json:"output_formats,omitempty"`
	QuotaRef          MediaQuotaRef     `json:"quota_ref"`
	PlanQuota         *RuntimePlanQuota `json:"plan_quota,omitempty"`
}

// A report is the complete inventory owned by one live daemon process for one
// runtime. Empty Executors revokes only this connection's instances. Other
// profiles on the same machine retain their own leases and observations.
type MediaExecutorReport struct {
	ConnectionID string                    `json:"connection_id"`
	Executors    []MediaExecutorDescriptor `json:"executors"`
}

type MediaJobState string

const (
	MediaJobQueued     MediaJobState = "queued"
	MediaJobGenerating MediaJobState = "generating"
	MediaJobUploading  MediaJobState = "uploading"
	MediaJobCompleted  MediaJobState = "completed"
	MediaJobFailed     MediaJobState = "failed"
	MediaJobCancelled  MediaJobState = "cancelled"
)

type MediaSubmissionState string

const (
	MediaNotSubmitted   MediaSubmissionState = "not_submitted"
	MediaAccepted       MediaSubmissionState = "accepted"
	MediaOutcomeUnknown MediaSubmissionState = "unknown"
)

type MediaInput struct {
	AttachmentID string `json:"attachment_id"`
	SHA256       string `json:"sha256"`
	Role         string `json:"role"`
}
type MediaParameters struct {
	Size            string   `json:"size,omitempty"`
	AspectRatio     string   `json:"aspect_ratio,omitempty"`
	Quality         string   `json:"quality,omitempty"`
	Format          string   `json:"format,omitempty"`
	DurationSeconds *float64 `json:"duration_seconds,omitempty"`
	Resolution      string   `json:"resolution,omitempty"`
}
type MediaJobRequest struct {
	Version        int             `json:"version"`
	Capability     string          `json:"capability"`
	Provider       string          `json:"provider"`
	Model          string          `json:"model,omitempty"`
	Prompt         string          `json:"prompt"`
	Inputs         []MediaInput    `json:"inputs,omitempty"`
	Parameters     MediaParameters `json:"parameters"`
	TaskID         string          `json:"task_id,omitempty"`
	IdempotencyKey string          `json:"idempotency_key"`
	DeadlineAt     int64           `json:"deadline_at,omitempty"`
}
type MediaOutput struct {
	OutputIndex  int    `json:"output_index"`
	AttachmentID string `json:"attachment_id"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type"`
	SizeBytes    int64  `json:"size_bytes"`
	SHA256       string `json:"sha256"`
	MarkdownURL  string `json:"markdown_url"`
	Markdown     string `json:"markdown"`
}
type MediaJobResponse struct {
	MediaJobID        string                `json:"media_job_id"`
	State             MediaJobState         `json:"state"`
	Revision          int64                 `json:"revision"`
	RequestedProvider string                `json:"requested_provider"`
	ResolvedProvider  string                `json:"resolved_provider,omitempty"`
	ResolvedModel     string                `json:"resolved_model,omitempty"`
	Attempts          []MediaAttemptSummary `json:"attempts"`
	Outputs           []MediaOutput         `json:"outputs"`
	FailureCode       string                `json:"failure_code,omitempty"`
	NextEligibleAt    *int64                `json:"next_eligible_at,omitempty"`
}
type MediaAttemptSummary struct {
	AttemptID       string               `json:"attempt_id"`
	RuntimeID       string               `json:"runtime_id"`
	ExecutorID      string               `json:"executor_id"`
	SubmissionState MediaSubmissionState `json:"submission_state"`
	FailureCode     string               `json:"failure_code,omitempty"`
}

const (
	MediaAvailable = "media.available"
	MediaClaim     = "media.claim"
	MediaStart     = "media.start"
	MediaProgress  = "media.progress"
	MediaProduced  = "media.produced"
	MediaFail      = "media.fail"
	MediaReconcile = "media.reconcile"
)

type MediaAvailablePayload struct {
	RuntimeID  string `json:"runtime_id"`
	ExecutorID string `json:"executor_id"`
}
type MediaClaimRequest struct {
	MediaAvailablePayload
	ConnectionID string `json:"connection_id"`
	OperationID  string `json:"operation_id"`
	FreeSlots    int    `json:"free_slots"`
}
type MediaAttemptIdentity struct {
	JobID     string `json:"job_id"`
	AttemptID string `json:"attempt_id"`
	Fence     int64  `json:"fence"`
}
type MediaClaimResponse struct {
	Attempt         *MediaAttemptIdentity `json:"attempt"`
	LeaseExpiresAt  int64                 `json:"lease_expires_at,omitempty"`
	ManifestVersion int                   `json:"manifest_version,omitempty"`
	ManifestPath    string                `json:"manifest_path,omitempty"`
}
type MediaStartRequest struct {
	MediaAttemptIdentity
	OperationID string `json:"operation_id"`
}
type MediaProgressRequest struct {
	MediaAttemptIdentity
	EventSeq     int64    `json:"event_seq"`
	Phase        string   `json:"phase"`
	Progress     *float64 `json:"progress,omitempty"`
	LeaseRenewal bool     `json:"lease_renewal"`
}
type MediaProducedRequest struct {
	MediaAttemptIdentity
	EventSeq       int64  `json:"event_seq"`
	ManifestID     string `json:"manifest_id"`
	ManifestSHA256 string `json:"manifest_sha256"`
}
type MediaFailRequest struct {
	MediaAttemptIdentity
	EventSeq        int64                `json:"event_seq"`
	FailureCode     string               `json:"failure_code"`
	ErrorOrigin     string               `json:"error_origin"`
	SubmissionState MediaSubmissionState `json:"submission_state"`
	RetryAfter      *int64               `json:"retry_after,omitempty"`
	ResetsAt        *int64               `json:"resets_at,omitempty"`
}
type MediaReconcileEntry struct {
	MediaAttemptIdentity
	EventSeq int64 `json:"event_seq"`
}
type MediaReconcileRequest struct {
	ExecutorID   string                `json:"executor_id"`
	ConnectionID string                `json:"connection_id"`
	Entries      []MediaReconcileEntry `json:"entries"`
	Cursor       string                `json:"cursor,omitempty"`
}
type MediaAttemptReceipt struct {
	MediaAttemptIdentity
	State              MediaJobState `json:"state"`
	Phase              string        `json:"phase,omitempty"`
	EventSeq           int64         `json:"event_seq"`
	LeaseExpiresAt     *int64        `json:"lease_expires_at,omitempty"`
	CancelRequested    bool          `json:"cancel_requested"`
	OutputManifestPath string        `json:"output_manifest_path,omitempty"`
}
type MediaReconcileResponse struct {
	Entries    []MediaAttemptReceipt `json:"entries"`
	NextCursor string                `json:"next_cursor,omitempty"`
}

// Parts use raw HTTP bodies with Content-Length, Content-Range and
// X-Part-SHA256. All indices are zero based. Completion is asynchronous.
type AttachmentUploadRequest struct {
	Purpose        string                `json:"purpose"`
	Filename       string                `json:"filename"`
	ContentType    string                `json:"content_type"`
	SizeBytes      int64                 `json:"size_bytes"`
	SHA256         string                `json:"sha256"`
	IdempotencyKey string                `json:"idempotency_key"`
	Attempt        *MediaAttemptIdentity `json:"attempt,omitempty"`
	OutputIndex    *int                  `json:"output_index,omitempty"`
}
type AttachmentUploadPart struct {
	Index     int    `json:"index"`
	SizeBytes int64  `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}
type AttachmentUploadResponse struct {
	UploadID     string                 `json:"upload_id"`
	State        string                 `json:"state"`
	PartSize     int64                  `json:"part_size"`
	ExpiresAt    int64                  `json:"expires_at"`
	Parts        []AttachmentUploadPart `json:"parts"`
	MissingParts []int                  `json:"missing_parts"`
	NextCursor   string                 `json:"next_cursor,omitempty"`
	AttachmentID string                 `json:"attachment_id,omitempty"`
}
type AttachmentUploadCompleteRequest struct {
	SizeBytes int64  `json:"size_bytes"`
	SHA256    string `json:"sha256"`
}

// MediaJobManifest is fetched by the current executor using attempt-scoped
// platform authorization. Authorization is never a provider credential.
type MediaJobManifest struct {
	Version int `json:"version"`
	MediaAttemptIdentity
	RequestHash string          `json:"request_hash"`
	Request     MediaJobRequest `json:"request"`
}
type MediaArtifactManifest struct {
	Version int `json:"version"`
	MediaAttemptIdentity
	ResolvedProvider string                  `json:"resolved_provider"`
	ResolvedModel    string                  `json:"resolved_model"`
	Outputs          []MediaArtifactMetadata `json:"outputs"`
}
type MediaArtifactMetadata struct {
	OutputIndex int    `json:"output_index"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
	SHA256      string `json:"sha256"`
}
