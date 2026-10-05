package lark

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/messagedelivery"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestDeliveryRateLimitsSharedAcrossSendVerifyDiscovery(t *testing.T) {
	for _, code := range []int{230020, 99991400, 99991403} {
		for _, status := range []int{http.StatusOK, http.StatusTooManyRequests} {
			t.Run(fmt.Sprintf("%d/%d", code, status), func(t *testing.T) {
				var err error = &APIError{Code: code, Msg: "limited"}
				if status != http.StatusOK {
					err = &larkAPIStatusError{Code: code, StatusCode: status, Msg: "limited"}
				}
				err = fmt.Errorf("wrapped: %w", err)
				for name, classified := range map[string]error{"send": classifyDeliverySendError(err), "verify": classifyVerifyError(err)} {
					var out *messagedelivery.SendError
					if !errors.As(classified, &out) || out.Class != messagedelivery.ClassTransient {
						t.Errorf("%s: expected transient: %v", name, classified)
					}
				}
				if got := discoveryError(err); !errors.Is(got, ErrDiscoveryRateLimited) {
					t.Errorf("discovery: %v", got)
				}
			})
		}
	}
	// A plain HTTP 429 is still a definitive rate-limit response.
	err := &larkAPIStatusError{StatusCode: http.StatusTooManyRequests}
	var out *messagedelivery.SendError
	if !errors.As(classifyDeliverySendError(err), &out) || out.Class != messagedelivery.ClassTransient {
		t.Fatalf("HTTP 429: %v", out)
	}
}

type installationReadError struct {
	db.DBTX
	err error
}

func (f installationReadError) QueryRow(context.Context, string, ...any) pgx.Row {
	return installationErrorRow{f.err}
}

type installationErrorRow struct{ err error }

func (r installationErrorRow) Scan(...any) error { return r.err }

func TestDeliveryCredentialLookupErrorClassification(t *testing.T) {
	for _, tc := range []struct {
		name  string
		err   error
		class messagedelivery.ErrorClass
	}{
		{"database", errors.New("database unavailable"), messagedelivery.ClassTransient},
		{"cancelled before dialing", context.Canceled, messagedelivery.ClassTransient},
		{"missing installation", pgx.ErrNoRows, messagedelivery.ClassPermanent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			box, err := secretbox.New(make([]byte, secretbox.KeySize))
			if err != nil {
				t.Fatal(err)
			}
			installations, err := NewInstallationService(db.New(installationReadError{err: tc.err}), box)
			if err != nil {
				t.Fatal(err)
			}
			// Any accidental provider call fails: the local server has no routes.
			fake := newLarkFake(t)
			sender := NewDeliverySender(installations, newTestClient(fake, time.Now))
			_, err = sender.Send(context.Background(), messagedelivery.SendRequest{
				WorkspaceID:    "11111111-1111-1111-1111-111111111111",
				InstallationID: "22222222-2222-2222-2222-222222222222",
				Target:         messagedelivery.Target{Type: messagedelivery.TargetMember, OpenID: "ou_test"},
				Message:        messagedelivery.NewMessage("hello", ""), SendUUID: "stable-uuid",
			})
			var classified *messagedelivery.SendError
			if !errors.As(err, &classified) || classified.Class != tc.class {
				t.Fatalf("class=%v want=%v err=%v", classified, tc.class, err)
			}
		})
	}
}

func TestDeliveryDefinitiveVerificationErrors(t *testing.T) {
	for _, code := range []int{230001, 230027, 99991672, 99991676, 99991679, 987654} {
		var out *messagedelivery.SendError
		err := classifyVerifyError(&APIError{Code: code, Msg: "refused"})
		if !errors.As(err, &out) || out.Class != messagedelivery.ClassPermanent {
			t.Errorf("code %d: definitive refusal became retryable: %v", code, err)
		}
	}
	for _, code := range []int{230002, 230011, 230013, 230014, 230019, 230073, 230110, 232006, 232009, 232010, 232011} {
		if err := classifyVerifyError(&APIError{Code: code, Msg: "unavailable"}); !errors.Is(err, messagedelivery.ErrTargetUnreachable) {
			t.Errorf("code %d: missing unreachable verdict: %v", code, err)
		}
	}
}
