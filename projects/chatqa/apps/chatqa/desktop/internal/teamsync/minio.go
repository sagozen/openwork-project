package teamsync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strings"

	"deskcore/apperr"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// MinioConfig: cấu hình kết nối kho S3-compatible. Khoá chỉ đi vào đây (không vào Syncer, state, log); String che khoá.
type MinioConfig struct {
	Endpoint  string // host[:port], không scheme, không đường dẫn
	Bucket    string
	Region    string
	AccessKey string
	SecretKey string
	UseTLS    bool
	PathStyle bool
}

// String: dạng in an toàn, không bao giờ có khoá.
func (c MinioConfig) String() string {
	return fmt.Sprintf("s3{endpoint=%s bucket=%s region=%s tls=%t pathStyle=%t}", c.Endpoint, c.Bucket, c.Region, c.UseTLS, c.PathStyle)
}

// GoString: %#v cũng không lộ khoá.
func (c MinioConfig) GoString() string { return c.String() }

var bucketRe = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)

type minioStore struct {
	c      *minio.Client
	bucket string
}

// NewMinioStore dựng ObjectStore bằng minio-go. Không gọi mạng; lỗi không chứa khoá.
func NewMinioStore(cfg MinioConfig) (ObjectStore, error) {
	ep := strings.TrimSpace(cfg.Endpoint)
	if ep == "" || strings.Contains(ep, "://") || strings.ContainsAny(ep, "/?#@ ") {
		return nil, apperr.New(apperr.CodeInvalid, "endpoint S3 chỉ gồm host[:port], không scheme hay đường dẫn")
	}
	if host, _, err := net.SplitHostPort(ep); err == nil && host == "" {
		return nil, apperr.New(apperr.CodeInvalid, "endpoint S3 thiếu host")
	}
	if !bucketRe.MatchString(cfg.Bucket) {
		return nil, apperr.New(apperr.CodeInvalid, "tên bucket không hợp lệ")
	}
	if cfg.AccessKey == "" || cfg.SecretKey == "" {
		return nil, apperr.New(apperr.CodeInvalid, "chưa đặt khoá S3")
	}
	lookup := minio.BucketLookupAuto
	if cfg.PathStyle {
		lookup = minio.BucketLookupPath
	}
	c, err := minio.New(ep, &minio.Options{
		Creds:        credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure:       cfg.UseTLS,
		Region:       cfg.Region,
		BucketLookup: lookup,
	})
	if err != nil {
		// Thông điệp của minio.New chỉ nói về endpoint; vẫn không gói err gốc để chắc không kéo theo cấu hình.
		return nil, apperr.New(apperr.CodeInvalid, "endpoint S3 không hợp lệ")
	}
	return &minioStore{c: c, bucket: cfg.Bucket}, nil
}

// mapErr: lỗi minio ⇒ lỗi của gói. Chỉ giữ mã, mã HTTP và thông điệp của máy chủ (không có khoá).
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	r := minio.ToErrorResponse(err)
	switch {
	case r.StatusCode == http.StatusPreconditionFailed || r.Code == minio.PreconditionFailed:
		return ErrPrecondition
	case r.StatusCode == http.StatusNotFound && (r.Code == minio.NoSuchKey || r.Code == "" || r.Code == "NotFound"):
		return ErrNotFound
	case r.Code != "":
		return apperr.New("network", fmt.Sprintf("kho S3 trả %d %s: %s", r.StatusCode, r.Code, r.Message))
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return apperr.New("network", "không kết nối được kho S3")
	}
	return apperr.New("network", "lỗi kho S3: "+err.Error())
}

func (s *minioStore) List(ctx context.Context, prefix string, limit int) ([]Object, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // dừng phân trang khi thoát sớm
	var out []Object
	for o := range s.c.ListObjects(ctx, s.bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
		if o.Err != nil {
			return nil, mapErr(o.Err)
		}
		if len(out) == limit {
			return nil, ErrTooManyKeys
		}
		out = append(out, Object{Key: o.Key, ETag: strings.Trim(o.ETag, `"`), Size: o.Size})
	}
	return out, ctx.Err()
}

func objectFrom(key string, info minio.ObjectInfo) Object {
	meta := map[string]string{}
	for k, v := range info.UserMetadata {
		k = strings.ToLower(k)
		k = strings.TrimPrefix(k, "x-amz-meta-")
		meta[k] = v
	}
	return Object{Key: key, ETag: strings.Trim(info.ETag, `"`), Size: info.Size, Meta: meta}
}

func (s *minioStore) Get(ctx context.Context, key string) (io.ReadCloser, Object, error) {
	obj, err := s.c.GetObject(ctx, s.bucket, key, minio.GetObjectOptions{})
	if err != nil {
		return nil, Object{}, mapErr(err)
	}
	info, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, Object{}, mapErr(err)
	}
	return obj, objectFrom(key, info), nil
}

func (s *minioStore) Head(ctx context.Context, key string) (Object, error) {
	info, err := s.c.StatObject(ctx, s.bucket, key, minio.StatObjectOptions{})
	if err != nil {
		return Object{}, mapErr(err)
	}
	return objectFrom(key, info), nil
}

// Put: If-Match / If-None-Match đi theo header của PutObject (minio-go gửi cả ở bước mở và hoàn tất multipart).
func (s *minioStore) Put(ctx context.Context, key string, body io.Reader, size int64, cond PutCond, meta map[string]string) (string, error) {
	opts := minio.PutObjectOptions{UserMetadata: meta, ContentType: "application/octet-stream"}
	if cond.IfMatch != "" {
		opts.SetMatchETag(cond.IfMatch)
	}
	if cond.IfNoneMatch != "" {
		opts.SetMatchETagExcept(cond.IfNoneMatch)
	}
	info, err := s.c.PutObject(ctx, s.bucket, key, body, size, opts)
	if err != nil {
		return "", mapErr(err)
	}
	return strings.Trim(info.ETag, `"`), nil
}

// Delete: minio-go không gửi If-Match khi xoá, nên điều kiện là HEAD rồi xoá (cửa sổ đua nhỏ giữa hai lệnh).
func (s *minioStore) Delete(ctx context.Context, key, ifMatch string) error {
	if ifMatch != "" {
		o, err := s.Head(ctx, key)
		if err != nil {
			return err
		}
		if o.ETag != ifMatch {
			return ErrPrecondition
		}
	}
	return mapErr(s.c.RemoveObject(ctx, s.bucket, key, minio.RemoveObjectOptions{}))
}
