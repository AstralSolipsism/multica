package storage

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// PrivateObjectStorage shares the configured S3 client, but cannot mint public
// URLs or write into the attachment bucket. Operators must provision its bucket
// without anonymous/CDN access before enabling project files.
type PrivateObjectStorage struct {
	client *s3.Client
	bucket string
}

func NewPrivateObjectStorage(base *S3Storage, bucket string) (*PrivateObjectStorage, error) {
	if base == nil || strings.TrimSpace(bucket) == "" || bucket != strings.TrimSpace(bucket) {
		return nil, errors.New("project files require configured S3 storage and a private bucket")
	}
	if bucket == base.bucket || strings.ContainsAny(bucket, "/\\:") {
		return nil, errors.New("project files require a distinct private bucket name")
	}
	return &PrivateObjectStorage{client: base.client, bucket: bucket}, nil
}

func (s *PrivateObjectStorage) Put(ctx context.Context, key string, body io.Reader, size int64, contentType string) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), Body: body,
		ContentLength: aws.Int64(size), ContentType: aws.String(contentType),
		ContentDisposition: aws.String("attachment"), CacheControl: aws.String("private, no-store"),
		IfNoneMatch: aws.String("*"),
	}, func(o *s3.Options) {
		o.APIOptions = append(o.APIOptions, v4.SwapComputePayloadSHA256ForUnsignedPayloadMiddleware)
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
	})
	return err
}

func (s *PrivateObjectStorage) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	obj, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	return obj.Body, nil
}
