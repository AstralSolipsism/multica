package lark

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
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
		{"credential lookup cancelled", context.Canceled, messagedelivery.ClassTransient},
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
			if tc.name == "database" && strings.Contains(err.Error(), tc.err.Error()) {
				t.Fatalf("raw database error exposed to delivery records: %v", err)
			}
		})
	}
}

func TestDeliveryBusinessRefusalsRemainPermanent(t *testing.T) {
	for _, code := range []int{230006, 232004, 232025, 232034} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			err := &APIError{Code: code, Msg: "application unavailable"}
			for name, classified := range map[string]error{"send": classifyDeliverySendError(err), "verify": classifyVerifyError(err)} {
				var out *messagedelivery.SendError
				if !errors.As(classified, &out) || out.Class != messagedelivery.ClassPermanent {
					t.Fatalf("%s: expected definitive refusal, got %v", name, classified)
				}
				if name == "send" && out.Code != fmt.Sprint(code) {
					t.Errorf("send lost provider code: %q", out.Code)
				}
			}
			if got := discoveryError(err); !errors.Is(got, ErrDiscoveryUnavailable) {
				t.Errorf("discovery changed unavailable verdict: %v", got)
			}
		})
	}
}

// Return a healthy installation regardless of cancellation, so tests can reach
// the adapter's pre-dial check instead of failing earlier in the database read.
type healthyInstallationRead struct {
	db.DBTX
	config []byte
	reads  int
}

func (f *healthyInstallationRead) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	if !strings.HasPrefix(sql, "-- name: GetChannelInstallationInWorkspace ") {
		return installationErrorRow{errors.New("unexpected query")}
	}
	f.reads++
	return healthyInstallationRow{config: f.config}
}

type healthyInstallationRow struct{ config []byte }

func (r healthyInstallationRow) Scan(dest ...any) error {
	// GetChannelInstallationInWorkspace's config and status columns. Other
	// columns are immaterial to resolving valid, decrypted credentials.
	*dest[4].(*[]byte) = r.config
	*dest[5].(*string) = "active"
	return nil
}

func healthyDeliveryInstallations(t *testing.T) (*InstallationService, *healthyInstallationRead) {
	t.Helper()
	box, err := secretbox.New(make([]byte, secretbox.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := box.Seal([]byte("test-secret"))
	if err != nil {
		t.Fatal(err)
	}
	config, err := encodeInstallConfig(Installation{AppID: "cli_test", AppSecretEncrypted: sealed})
	if err != nil {
		t.Fatal(err)
	}
	read := &healthyInstallationRead{config: config}
	installations, err := NewInstallationService(db.New(read), box)
	if err != nil {
		t.Fatal(err)
	}
	return installations, read
}

type recordingDeliveryClient struct {
	DeliveryAPIClient
	sends int
}

func (c *recordingDeliveryClient) SendDeliveryMessage(context.Context, InstallationCredentials, DeliveryMessageParams) (string, error) {
	c.sends++
	return "om_unexpected", nil
}

func TestDeliveryCancellationBeforeDialWithHealthyCredentials(t *testing.T) {
	installations, read := healthyDeliveryInstallations(t)
	client := &recordingDeliveryClient{}
	sender := NewDeliverySender(installations, client)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := sender.Send(ctx, messagedelivery.SendRequest{
		WorkspaceID:    "11111111-1111-1111-1111-111111111111",
		InstallationID: "22222222-2222-2222-2222-222222222222",
		Target:         messagedelivery.Target{Type: messagedelivery.TargetMember, OpenID: "ou_test"},
		Message:        messagedelivery.NewMessage("hello", ""), SendUUID: "stable-uuid",
	})
	var out *messagedelivery.SendError
	if read.reads != 1 || client.sends != 0 || !errors.As(err, &out) || out.Class != messagedelivery.ClassTransient || !errors.Is(err, context.Canceled) {
		t.Fatalf("pre-dial cancellation: reads=%d sends=%d err=%v", read.reads, client.sends, err)
	}
}

func TestDeliveryGroupVerificationClassifiesOnce(t *testing.T) {
	installations, _ := healthyDeliveryInstallations(t)
	fake := newLarkFake(t)
	fake.stubToken("test-token", 3600)
	fake.mux.HandleFunc("/open-apis/im/v1/chats/oc_test", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{"code": 99991400, "msg": "rate limited"})
	})
	sender := NewDeliverySender(installations, newTestClient(fake, time.Now))
	err := sender.VerifyGroupTarget(context.Background(), messagedelivery.VerifyTargetRequest{
		WorkspaceID:    "11111111-1111-1111-1111-111111111111",
		InstallationID: "22222222-2222-2222-2222-222222222222", ChatID: "oc_test",
	})
	var out, nested *messagedelivery.SendError
	if !errors.As(err, &out) || out.Class != messagedelivery.ClassTransient {
		t.Fatalf("expected transient verification failure: %v", err)
	}
	if errors.As(out.Err, &nested) {
		t.Fatalf("verification error classified twice: %v", err)
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
