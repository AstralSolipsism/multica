package storage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func TestPrivateObjectStorageImmutableAndUncached(t *testing.T) {
	var mu sync.Mutex
	objects := map[string][]byte{}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Path != "/private/project-files/object" {
			t.Errorf("unexpected object location: %s", r.URL.Path)
		}
		switch r.Method {
		case http.MethodPut:
			if r.Header.Get("If-None-Match") != "*" || r.Header.Get("Cache-Control") != "private, no-store" || r.Header.Get("Content-Disposition") != "attachment" {
				t.Errorf("unsafe upload headers: %v", r.Header)
			}
			if _, exists := objects[r.URL.Path]; exists {
				w.WriteHeader(412)
				return
			}
			data, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(500)
				return
			}
			objects[r.URL.Path] = data
		case http.MethodGet:
			_, _ = w.Write(objects[r.URL.Path])
		default:
			w.WriteHeader(405)
		}
	}))
	defer endpoint.Close()
	client := s3.NewFromConfig(aws.Config{Region: "us-east-1", Credentials: credentials.NewStaticCredentialsProvider("test", "test", "")}, func(o *s3.Options) { o.BaseEndpoint = aws.String(endpoint.URL); o.UsePathStyle = true })
	base := &S3Storage{client: client, bucket: "attachments", cdnDomain: "public.invalid"}
	private, err := NewPrivateObjectStorage(base, "private")
	if err != nil {
		t.Fatal(err)
	}
	for _, bucket := range []string{"", "attachments", "https://example.invalid"} {
		if _, err := NewPrivateObjectStorage(base, bucket); err == nil {
			t.Fatalf("accepted unsafe bucket %q", bucket)
		}
	}
	if _, err := NewPrivateObjectStorage(nil, "private"); err == nil {
		t.Fatal("accepted missing storage")
	}
	data := []byte("hello")
	if err := private.Put(context.Background(), "project-files/object", bytes.NewReader(data), int64(len(data)), "text/plain"); err != nil {
		t.Fatal(err)
	}
	if err := private.Put(context.Background(), "project-files/object", bytes.NewReader([]byte("other")), 5, "text/plain"); err == nil {
		t.Fatal("overwrote immutable key")
	}
	reader, err := private.Open(context.Background(), "project-files/object")
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(reader)
	reader.Close()
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("changed bytes %q: %v", got, err)
	}
}
