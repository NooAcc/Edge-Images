// Package onnx implements the nsfw.Classifier interface on top of ONNX
// Runtime. It requires cgo and the ONNX Runtime shared library.
package onnx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"math"
	"os"
	"sync"

	ort "github.com/yalue/onnxruntime_go"

	"edge-image/internal/nsfw"
)

// Config configures the ONNX-backed classifier.
type Config struct {
	ModelPath   string
	ORTLibPath  string
	Threshold   float32
	Concurrency int
}

// expectedORTVersion is the ONNX Runtime version the Go module is pinned to.
const expectedORTVersion = "1.31.0"

// validateInputDims accepts the NCHW [N,3,380,380] input contract. The batch
// dimension may be dynamic.
func validateInputDims(dims ort.Shape) error {
	if len(dims) != 4 || dims[1] != 3 ||
		dims[2] != nsfw.ModelInputSize || dims[3] != nsfw.ModelInputSize {
		return fmt.Errorf("nsfw: expected NCHW input [N,3,%d,%d], got %v",
			nsfw.ModelInputSize, nsfw.ModelInputSize, dims)
	}
	if dims[0] != 1 && dims[0] != -1 {
		return fmt.Errorf("nsfw: unsupported batch dimension %v", dims)
	}
	return nil
}

// Classifier runs the nsfw-detection-2-mini ONNX model.
type Classifier struct {
	mu        sync.RWMutex
	session   *ort.DynamicAdvancedSession
	modelID   string
	threshold float32
	sem       chan struct{}
}

// New loads the model and initializes ONNX Runtime. The caller must call
// Shutdown once the process is done with ONNX Runtime.
func New(cfg Config, log *slog.Logger) (*Classifier, error) {
	if log == nil {
		log = slog.Default()
	}
	if cfg.ModelPath == "" {
		return nil, fmt.Errorf("nsfw: model path is empty")
	}
	threshold := cfg.Threshold
	if math.IsNaN(float64(threshold)) || math.IsInf(float64(threshold), 0) ||
		threshold < 0 || threshold > 1 {
		return nil, fmt.Errorf("nsfw: invalid threshold %v", threshold)
	}
	if cfg.Concurrency < 1 {
		return nil, fmt.Errorf("nsfw: concurrency must be >= 1, got %d", cfg.Concurrency)
	}
	if _, err := os.Stat(cfg.ModelPath); err != nil {
		return nil, fmt.Errorf("nsfw: model file %q is not readable: %w (upload it to /data/models or set NSFW_MODEL_PATH)", cfg.ModelPath, err)
	}

	initializedHere := false
	if !ort.IsInitialized() {
		if cfg.ORTLibPath != "" {
			ort.SetSharedLibraryPath(cfg.ORTLibPath)
		}
		if err := ort.InitializeEnvironment(); err != nil {
			return nil, fmt.Errorf("nsfw: initialize onnxruntime: %w", err)
		}
		initializedHere = true
	}
	fail := func(err error) (*Classifier, error) {
		if initializedHere {
			_ = ort.DestroyEnvironment()
		}
		return nil, err
	}

	inputs, outputs, err := ort.GetInputOutputInfo(cfg.ModelPath)
	if err != nil {
		return fail(fmt.Errorf("nsfw: read model info: %w", err))
	}
	if len(inputs) != 1 || len(outputs) != 1 {
		return fail(fmt.Errorf("nsfw: expected 1 input and 1 output, got %d and %d",
			len(inputs), len(outputs)))
	}
	if inputs[0].DataType != ort.TensorElementDataTypeFloat {
		return fail(fmt.Errorf("nsfw: input %q has unexpected type %v",
			inputs[0].Name, inputs[0].DataType))
	}
	if outputs[0].DataType != ort.TensorElementDataTypeFloat {
		return fail(fmt.Errorf("nsfw: output %q has unexpected type %v",
			outputs[0].Name, outputs[0].DataType))
	}
	outDims := outputs[0].Dimensions
	if len(outDims) != 2 || outDims[len(outDims)-1] != 5 {
		return fail(fmt.Errorf("nsfw: output %q has unexpected shape %v",
			outputs[0].Name, outDims))
	}
	if err := validateInputDims(inputs[0].Dimensions); err != nil {
		return fail(err)
	}

	modelID, err := hashModel(cfg.ModelPath)
	if err != nil {
		return fail(fmt.Errorf("nsfw: hash model: %w", err))
	}

	session, err := ort.NewDynamicAdvancedSession(
		cfg.ModelPath,
		[]string{inputs[0].Name},
		[]string{outputs[0].Name},
		nil,
	)
	if err != nil {
		return fail(fmt.Errorf("nsfw: create session: %w", err))
	}

	version := ort.GetVersion()
	if version != expectedORTVersion {
		log.Warn("nsfw: onnxruntime version mismatch",
			"got", version, "want", expectedORTVersion)
	}
	log.Info("nsfw: onnxruntime ready",
		"version", version,
		"modelId", modelID,
		"input", inputs[0].Name,
		"output", outputs[0].Name,
		"threshold", threshold,
		"concurrency", cfg.Concurrency,
	)

	return &Classifier{
		session:   session,
		modelID:   modelID,
		threshold: threshold,
		sem:       make(chan struct{}, cfg.Concurrency),
	}, nil
}

// Classify preprocesses the packed RGB source and runs a single inference.
func (c *Classifier) Classify(ctx context.Context, rgb []byte, width, height int) (*nsfw.Predictions, error) {
	select {
	case c.sem <- struct{}{}:
		defer func() { <-c.sem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.session == nil {
		return nil, fmt.Errorf("classifier is closed")
	}

	input, err := nsfw.PreprocessRGB(rgb, width, height)
	if err != nil {
		return nil, err
	}

	shape := ort.NewShape(1, 3, nsfw.ModelInputSize, nsfw.ModelInputSize)

	inputTensor, err := ort.NewTensor(shape, input)
	if err != nil {
		return nil, fmt.Errorf("create input tensor: %w", err)
	}
	defer inputTensor.Destroy()

	outputTensor, err := ort.NewEmptyTensor[float32](ort.NewShape(1, 5))
	if err != nil {
		return nil, fmt.Errorf("create output tensor: %w", err)
	}
	defer outputTensor.Destroy()

	if err := c.session.Run([]ort.Value{inputTensor}, []ort.Value{outputTensor}); err != nil {
		return nil, fmt.Errorf("run inference: %w", err)
	}

	return nsfw.PredictionsFromOutput(outputTensor.GetData(), c.threshold)
}

// ModelID returns the first 16 hex characters of the model file's SHA-256.
func (c *Classifier) ModelID() string {
	return c.modelID
}

// Threshold returns the isNsfw decision threshold.
func (c *Classifier) Threshold() float32 {
	return c.threshold
}

// Close destroys the ONNX session. It is safe to call more than once.
func (c *Classifier) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session == nil {
		return nil
	}
	err := c.session.Destroy()
	c.session = nil
	return err
}

// Shutdown releases the global ONNX Runtime environment.
func Shutdown() error {
	if !ort.IsInitialized() {
		return nil
	}
	return ort.DestroyEnvironment()
}

func hashModel(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:16], nil
}

var _ nsfw.Classifier = (*Classifier)(nil)
