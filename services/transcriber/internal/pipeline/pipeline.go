// Package pipeline turns one leased job into one completed job: probe, download, normalise,
// transcribe, group, upload, complete. Failures are mapped to the typed codes the UI coaches on.
package pipeline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/templatedesign/transcriber/internal/captions"
	"github.com/templatedesign/transcriber/internal/client"
	"github.com/templatedesign/transcriber/internal/config"
	"github.com/templatedesign/transcriber/internal/disk"
	"github.com/templatedesign/transcriber/internal/formats"
	"github.com/templatedesign/transcriber/internal/media"
	"github.com/templatedesign/transcriber/internal/runtimecfg"
	"github.com/templatedesign/transcriber/internal/sources"
	"github.com/templatedesign/transcriber/internal/whisper"
)

type Pipeline struct {
	Config   config.Config
	Client   *client.Client
	Resolver *sources.Resolver
	Captions *captions.Fetcher
	Logger   *log.Logger
	// Runtime carries settings that may change remotely (currently the free-disk guard).
	Runtime *runtimecfg.Store
}

func New(cfg config.Config, api *client.Client, resolver *sources.Resolver, logger *log.Logger) *Pipeline {
	return &Pipeline{
		Config:   cfg,
		Client:   api,
		Resolver: resolver,
		Captions: captions.New(resolver.HTTP, cfg.YtDlpBin, cfg.TempRoot),
		Logger:   logger,
	}
}

func (p *Pipeline) log(event string, job *client.Job, extra map[string]any) {
	fields := map[string]any{"evt": event, "job": job.ID, "stage": job.Stage, "source": job.SourceKind}
	for key, value := range extra {
		fields[key] = value
	}
	encoded, _ := json.Marshal(fields)
	p.Logger.Println(string(encoded))
}

// Process runs one job. A returned error has already been reported to the Worker, so the
// caller only logs it.
func (p *Pipeline) Process(ctx context.Context, job *client.Job) error {
	started := time.Now()
	if job.Stage == "probe" {
		err := p.probe(ctx, job)
		p.log("job_probe_done", job, map[string]any{"ms": time.Since(started).Milliseconds(), "ok": err == nil})
		return err
	}
	err := p.transcribe(ctx, job)
	p.log("job_transcribe_done", job, map[string]any{"ms": time.Since(started).Milliseconds(), "ok": err == nil})
	return err
}

func (p *Pipeline) probe(ctx context.Context, job *client.Job) error {
	if job.SourceMeta.Multi == "playlist" {
		items, err := p.Resolver.ProbePlaylist(ctx, job.SourceRef, 50)
		if err != nil {
			return p.fail(ctx, job, err)
		}
		return p.completeProbe(ctx, job, client.Probe{Items: items, Title: job.SourceMeta.Title})
	}
	if job.SourceKind == "gdrive" && job.SourceMeta.Multi == "folder" {
		items, err := p.Resolver.ProbeDriveFolder(ctx, job.SourceRef, 50)
		if err != nil {
			return p.fail(ctx, job, err)
		}
		return p.completeProbe(ctx, job, client.Probe{Items: items, Title: job.SourceMeta.Title})
	}
	probe, err := p.Resolver.Probe(ctx, job)
	if err != nil {
		return p.fail(ctx, job, err)
	}
	if p.wantsCaptions(job) {
		// The price depends on whether captions can really be fetched, so check now.
		_, captionErr := p.Captions.Fetch(ctx, job.SourceRef, job.Options.Language)
		probe.HasCreatorCaptions = captionErr == nil
	}
	return p.completeProbe(ctx, job, probe)
}

func (p *Pipeline) completeProbe(ctx context.Context, job *client.Job, probe client.Probe) error {
	if probe.DurationSeconds <= 0 && len(probe.Items) == 0 {
		return p.fail(ctx, job, fmt.Errorf("no_media"))
	}
	if err := p.Client.CompleteProbe(ctx, job.ID, job.LeaseToken, probe); err != nil {
		p.log("probe_complete_failed", job, map[string]any{"error": err.Error()})
		return err
	}
	return nil
}

func (p *Pipeline) transcribe(ctx context.Context, job *client.Job) error {
	if free, err := disk.FreeBytes(p.tempRoot()); err == nil {
		minimum := int64(p.minFreeDiskGB() * float64(int64(1)<<30))
		if free < minimum {
			return p.failCode(ctx, job, "disk_full", true)
		}
	}

	if p.wantsCaptions(job) {
		if transcript, err := p.Captions.Fetch(ctx, job.SourceRef, job.Options.Language); err == nil {
			p.log("captions_used", job, map[string]any{"segments": len(transcript.Segments)})
			return p.deliver(ctx, job, transcript)
		}
		// No captions after all: transcribe the audio like any other source.
		p.log("captions_unavailable", job, nil)
	}

	workDir, err := os.MkdirTemp(p.tempRoot(), "job-")
	if err != nil {
		return p.failCode(ctx, job, "disk_full", true)
	}
	defer os.RemoveAll(workDir)

	sourcePath, err := p.Resolver.Fetch(ctx, job, workDir)
	if err != nil {
		return p.fail(ctx, job, err)
	}

	wavPath := filepath.Join(workDir, "audio.wav")
	if err := media.ExtractWav(ctx, p.Config.FFmpegBin, sourcePath, wavPath); err != nil {
		p.log("ffmpeg_failed", job, map[string]any{"error": err.Error()})
		return p.failCode(ctx, job, "no_media", false)
	}

	options := whisper.Options{
		Bin:            p.Config.WhisperBin,
		Model:          p.Config.WhisperModel,
		Threads:        p.Config.WhisperThreads,
		Language:       job.Options.Language,
		WordTimestamps: job.Options.WordTimestamps && !job.Options.UseCreatorCaptions,
	}
	raw, err := whisper.Run(ctx, options, wavPath, filepath.Join(workDir, "out"))
	if err != nil {
		if ctx.Err() != nil {
			return p.failCode(ctx, job, "worker_lost", true)
		}
		p.log("whisper_failed", job, map[string]any{"error": err.Error()})
		return p.failCode(ctx, job, "dependency_unavailable", true)
	}

	return p.deliver(ctx, job, formats.Normalize(raw, options.WordTimestamps))
}

// wantsCaptions is true for YouTube jobs whose options ask for the creator's captions.
func (p *Pipeline) wantsCaptions(job *client.Job) bool {
	return job.SourceKind == "youtube" && job.Options.UseCreatorCaptions
}

// deliver uploads the normalised transcript and completes the job.
func (p *Pipeline) deliver(ctx context.Context, job *client.Job, transcript formats.Transcript) error {
	payload, err := json.Marshal(transcript)
	if err != nil {
		return p.failCode(ctx, job, "dependency_unavailable", true)
	}
	key, uploadURL, err := p.Client.UploadURL(ctx, job.ID, "transcript.json")
	if err != nil {
		return p.failCode(ctx, job, "dependency_unavailable", true)
	}
	if err := p.Client.PutFile(ctx, uploadURL, "application/json; charset=utf-8", bytes.NewReader(payload), int64(len(payload))); err != nil {
		p.log("result_upload_failed", job, map[string]any{"error": err.Error()})
		return p.failCode(ctx, job, "dependency_unavailable", true)
	}

	formatsList := []string{"json", "txt", "srt", "vtt"}
	if err := p.Client.CompleteTranscript(ctx, job.ID, job.LeaseToken, key, formatsList, transcript.Language, transcript.Model); err != nil {
		p.log("complete_failed", job, map[string]any{"error": err.Error()})
		return err
	}
	p.log("transcript_delivered", job, map[string]any{
		"segments": len(transcript.Segments),
		"language": transcript.Language,
		"model":    transcript.Model,
	})
	return nil
}

func (p *Pipeline) minFreeDiskGB() float64 {
	if p.Runtime != nil {
		snapshot, _ := p.Runtime.Get()
		return snapshot.MinFreeDiskGB
	}
	return p.Config.MinFreeDiskGB
}

func (p *Pipeline) tempRoot() string {
	if p.Config.TempRoot != "" {
		return p.Config.TempRoot
	}
	return os.TempDir()
}

// fail maps a resolver/ffmpeg error to a code the UI can coach on. Only transient causes retry.
func (p *Pipeline) fail(ctx context.Context, job *client.Job, err error) error {
	code := classify(err)
	retryable := code == "source_unavailable"
	var detailed *sources.DetailedError
	if errors.As(err, &detailed) && detailed.Detail != "" {
		p.log("job_fail_detail", job, map[string]any{"code": code, "detail": detailed.Detail})
	}
	return p.failCode(ctx, job, code, retryable)
}

func (p *Pipeline) failCode(ctx context.Context, job *client.Job, code string, retryable bool) error {
	if err := p.Client.Fail(ctx, job.ID, job.LeaseToken, code, retryable); err != nil {
		p.log("fail_report_failed", job, map[string]any{"code": code, "error": err.Error()})
		return err
	}
	p.log("job_failed", job, map[string]any{"code": code, "retryable": retryable})
	return errors.New(code)
}

func classify(err error) string {
	message := strings.ToLower(err.Error())
	for _, code := range []string{
		"not_public", "login_required", "removed", "geo_blocked", "no_media", "unsupported",
		"private_address", "insecure_url", "malformed_url", "source_unavailable", "disk_full",
		"media_too_large", "too_long",
	} {
		if strings.Contains(message, code) {
			if code == "media_too_large" {
				return "too_long"
			}
			return code
		}
	}
	return "source_unavailable"
}
