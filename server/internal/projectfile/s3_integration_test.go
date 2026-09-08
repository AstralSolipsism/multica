package projectfile

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"testing"

	"github.com/multica-ai/multica/server/internal/storage"
)

// Run only in an operator-provisioned isolated database and disposable private
// bucket. Fixture metadata is cleaned; objects remain for operator inspection.
func TestProjectFileS3Integration(t *testing.T) {
	if os.Getenv("PROJECT_FILE_TEST_S3") != "1" {
		t.Skip("PROJECT_FILE_TEST_S3=1 requires an explicitly provisioned private S3 test bucket")
	}
	h := newHarness(t)
	objects, err := storage.NewPrivateObjectStorage(storage.NewS3StorageFromEnv(), os.Getenv("MULTICA_PROJECT_FILES_BUCKET"))
	if err != nil {
		t.Fatal(err)
	}
	h.s.objects = objects
	for round := range 100 {
		path := fmt.Sprintf("integration/%03d.bin", round)
		data := []byte(fmt.Sprintf("round %d\x00\xff", round))
		saved, err := h.s.Save(context.Background(), h.scope, fmt.Sprintf("save-%d", round), requestFor(path, 0, data), bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		candidate := h.save(t, path, 0, "candidate")
		if saved.Status != StatusSaved || candidate.Status != StatusConflict {
			t.Fatalf("save/conflict: %+v %+v", saved, candidate)
		}
		adopt, err := h.s.Adopt(context.Background(), h.scope, fmt.Sprintf("adopt-%d", round), adoptRequest(candidate, 1))
		if err != nil {
			t.Fatal(err)
		}
		replay, err := h.s.Adopt(context.Background(), h.scope, fmt.Sprintf("adopt-%d", round), adoptRequest(candidate, 1))
		adopt.Replayed = true
		if err != nil || replay != adopt {
			t.Fatalf("adopt replay: %+v %+v %v", adopt, replay, err)
		}
		for _, revision := range []int64{1, 2} {
			file, reader, err := h.s.Read(context.Background(), h.scope, path, &revision)
			if err != nil {
				t.Fatal(err)
			}
			got, err := io.ReadAll(reader)
			reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			want := data
			if revision == 2 {
				want = []byte("candidate")
			}
			if !bytes.Equal(got, want) || file.SHA256 != requestFor(path, 0, want).SHA256 {
				t.Fatalf("round %d revision %d content mismatch", round, revision)
			}
		}
	}
}
