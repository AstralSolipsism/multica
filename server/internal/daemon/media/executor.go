// Package media owns host-local native execution. Provider credentials and local
// artifact paths never form part of a protocol descriptor or control frame.
package media

import (
	"context"
	"errors"

	"github.com/multica-ai/multica/server/pkg/protocol"
)

var ErrContractUnverified = errors.New("native media calling contract has not been verified on this host")

// Executor implementations must use the native primitive directly. In
// particular, Submit must not start an outer conversational agent. Recovery
// never repeats Submit when acceptance is unknown or artifacts already exist.
type Executor interface {
	Probe(context.Context) (ProbeResult, error)
	Describe() Description
	Submit(context.Context, Submission) (SubmissionResult, error)
	Recover(context.Context, Recovery) (SubmissionResult, error)
	CollectArtifacts(context.Context, Recovery) ([]Artifact, error)
	Cancel(context.Context, Recovery) error
	ObserveQuota(context.Context) (*protocol.RuntimePlanQuota, error)
}
type Description struct {
	Provider         string
	ResolvedProvider string
	Models           []string
	InputRoles       []string
	OutputFormats    []string
	MaxConcurrency   int
	QuotaWindows     []protocol.MediaQuotaWindowRef
}
type ProbeResult struct {
	Readiness  protocol.MediaReadiness
	ReasonCode string
}
type LocalInput struct {
	Input protocol.MediaInput
	Path  string
}
type Submission struct {
	Identity    protocol.MediaAttemptIdentity
	Request     protocol.MediaJobRequest
	Inputs      []LocalInput
	OutboxDir   string
	RequestHash string
}
type SubmissionResult struct {
	State            protocol.MediaSubmissionState
	OperationRef     string
	ResolvedProvider string
	ResolvedModel    string
}
type Recovery struct {
	Identity     protocol.MediaAttemptIdentity
	RequestHash  string
	State        protocol.MediaSubmissionState
	OperationRef string
	OutboxDir    string
}
type Artifact struct {
	OutputIndex int
	Path        string
	Filename    string
	ContentType string
	SizeBytes   int64
	SHA256      string
}
