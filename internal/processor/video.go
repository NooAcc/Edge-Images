package processor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"time"

	"edge-image/internal/fetcher"
)

const (
	VideoTimeout = 30 * time.Second
)

type VideoMetadata struct {
	Width      int     `json:"width"`
	Height     int     `json:"height"`
	Codec      string  `json:"codec"`
	Duration   float64 `json:"duration"`
	Format     string  `json:"format"`
	SourceSize int64   `json:"sourceSize"`
}

type ffprobeOutput struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
		Duration  string `json:"duration"`
	} `json:"streams"`
	Format struct {
		Duration   string `json:"duration"`
		FormatName string `json:"format_name"`
	} `json:"format"`
}

func ProbeVideoMetadata(url string, fetch *fetcher.Fetcher, log *slog.Logger) (*VideoMetadata, error) {
	log.Info("video.probe.start", "url", url)

	result, err := fetch.FetchVideoRange(url)
	if err != nil {
		return nil, fmt.Errorf("fetch video range: %w", err)
	}

	meta, err := probeVideoBuffer(result.Buffer, log)
	if err != nil {
		log.Info("video.probe.range_fallback", "reason", "partial probe failed")
		fullResult, fullErr := fetch.FetchVideoFull(url)
		if fullErr != nil {
			return nil, fmt.Errorf("fetch video full: %w", fullErr)
		}
		meta, err = probeVideoBuffer(fullResult.Buffer, log)
		if err != nil {
			return nil, fmt.Errorf("probe video: %w", err)
		}
		meta.SourceSize = fullResult.SourceSize
		return meta, nil
	}

	meta.SourceSize = result.SourceSize
	return meta, nil
}

func probeVideoBuffer(buffer []byte, log *slog.Logger) (*VideoMetadata, error) {
	ctx, cancel := context.WithTimeout(context.Background(), VideoTimeout)
	defer cancel()

	ffprobePath := getFfprobePath()
	cmd := exec.CommandContext(ctx, ffprobePath,
		"-v", "quiet",
		"-print_format", "json",
		"-show_streams",
		"-show_format",
		"-",
	)
	cmd.Stdin = bytes.NewReader(buffer)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffprobe failed: %w: %s", err, stderr.String())
	}

	var output ffprobeOutput
	if err := json.Unmarshal(stdout.Bytes(), &output); err != nil {
		return nil, fmt.Errorf("parse ffprobe output: %w", err)
	}

	videoStream := findVideoStream(output)
	if videoStream == nil {
		return nil, fmt.Errorf("no video stream found")
	}

	duration := extractDuration(output, videoStream)

	return &VideoMetadata{
		Width:    videoStream.Width,
		Height:   videoStream.Height,
		Codec:    videoStream.CodecName,
		Duration: duration,
		Format:   output.Format.FormatName,
	}, nil
}

func ExtractVideoFrame(url string, fetch *fetcher.Fetcher, log *slog.Logger) ([]byte, error) {
	log.Info("video.frame.start", "url", url)

	result, err := fetch.FetchVideoRange(url)
	if err != nil {
		return nil, fmt.Errorf("fetch video range: %w", err)
	}

	frame, err := extractFrame(result.Buffer, VideoTimeout, log)
	if err != nil {
		log.Info("video.frame.range_fallback", "reason", "partial decode failed")
		fullResult, fullErr := fetch.FetchVideoFull(url)
		if fullErr != nil {
			return nil, fmt.Errorf("fetch video full: %w", fullErr)
		}
		frame, err = extractFrame(fullResult.Buffer, fetcher.VideoFullTimeout, log)
		if err != nil {
			return nil, fmt.Errorf("extract frame: %w", err)
		}
		return frame, nil
	}

	return frame, nil
}

func extractFrame(buffer []byte, timeout time.Duration, log *slog.Logger) ([]byte, error) {
	// Write buffer to temp file so ffmpeg can seek (critical for MP4 moov atom at end)
	tmpFile, err := os.CreateTemp("", "edge-video-*.tmp")
	if err != nil {
		return nil, fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	if _, err := tmpFile.Write(buffer); err != nil {
		tmpFile.Close()
		return nil, fmt.Errorf("write temp file: %w", err)
	}
	tmpFile.Close()

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	ffmpegPath := getFfmpegPath()
	cmd := exec.CommandContext(ctx, ffmpegPath,
		"-i", tmpPath,
		"-vframes", "1",
		"-f", "image2",
		"-vcodec", "png",
		"-y",
		"pipe:1",
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("ffmpeg frame extraction failed: %w: %s", err, stderr.String())
	}

	if stdout.Len() == 0 {
		return nil, fmt.Errorf("ffmpeg produced no output")
	}

	return stdout.Bytes(), nil
}

func getFfmpegPath() string {
	if p, err := exec.LookPath("ffmpeg"); err == nil {
		return p
	}
	return "ffmpeg"
}

func getFfprobePath() string {
	if p, err := exec.LookPath("ffprobe"); err == nil {
		return p
	}
	return "ffprobe"
}

func findVideoStream(output ffprobeOutput) *struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Duration  string `json:"duration"`
} {
	for i := range output.Streams {
		if output.Streams[i].CodecType == "video" {
			return &output.Streams[i]
		}
	}
	return nil
}

func extractDuration(output ffprobeOutput, stream *struct {
	CodecType string `json:"codec_type"`
	CodecName string `json:"codec_name"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Duration  string `json:"duration"`
}) float64 {
	if output.Format.Duration != "" {
		if d, err := parseDuration(output.Format.Duration); err == nil {
			return d
		}
	}
	if stream.Duration != "" {
		if d, err := parseDuration(stream.Duration); err == nil {
			return d
		}
	}
	return 0
}

func parseDuration(s string) (float64, error) {
	var d float64
	_, err := fmt.Sscanf(s, "%f", &d)
	return d, err
}
