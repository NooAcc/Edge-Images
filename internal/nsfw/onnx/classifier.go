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

type layout int

const (
	layoutNHWC layout = iota
	layoutNCHW
)

func (l layout) String() string {
	if l == layoutNCHW {
		return "NCHW"
	}
	return "NHWC"
}

// layoutForDims identifies the tensor layout from the model's input shape.
// The batch dimension may be dynamic.
func layoutForDims(dims ort.Shape) (layout, error) {
	if len(dims) != 4 {
		return 0, fmt.Errorf("nsfw: expected a 4-dimensional input, got %v", dims)
	}
	if dims[3] == 3 {
		if dims[1] != nsfw.ModelInputSize || dims[2] != nsfw.ModelInputSize {
			return 0, fmt.Errorf("nsfw: unsupported NHWC input shape %v", dims)
		}
		return layoutNHWC, nil
	}
	if dims[1] == 3 {
		if dims[2] != nsfw.ModelInputSize || dims[3] != nsfw.ModelInputSize {
			return 0, fmt.Errorf("nsfw: unsupported NCHW input shape %v", dims)
		}
		return layoutNCHW, nil
	}
	return 0, fmt.Errorf("nsfw: unsupported input shape %v", dims)
}

// Classifier runs the nsfwjs ONNX model.
type Classifier struct {
	mu         sync.RWMutex
	session    *ort.DynamicAdvancedSession
	inputName  string
	outputName string
	layout     layout
	modelID    string
	threshold  float32
	sem        chan struct{}
	log        *slog.Logger
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
	inputLayout, err := layoutForDims(inputs[0].Dimensions)
	if err != nil {
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

	log.Info("nsfw: onnxruntime ready",
		"version", ort.GetVersion(),
		"modelId", modelID,
		"input", inputs[0].Name,
		"output", outputs[0].Name,
		"layout", inputLayout.String(),
		"threshold", threshold,
		"concurrency", cfg.Concurrency,
	)

	return &Classifier{
		session:    session,
		inputName:  inputs[0].Name,
		outputName: outputs[0].Name,
		layout:     inputLayout,
		modelID:    modelID,
		threshold:  threshold,
		sem:        make(chan struct{}, cfg.Concurrency),
		log:        log,
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
		return nil, fmt.Errorf("nsfw: classifier is closed")
	}

	input, err := nsfw.PreprocessRGB(rgb, width, height)
	if err != nil {
		return nil, err
	}

	shape := ort.NewShape(1, nsfw.ModelInputSize, nsfw.ModelInputSize, 3)
	if c.layout == layoutNCHW {
		input = nhwcToNCHW(input)
		shape = ort.NewShape(1, 3, nsfw.ModelInputSize, nsfw.ModelInputSize)
	}

	inputTensor, err := ort.NewTensor(shape, input)
	if err != nil {
		return nil, fmt.Errorf("nsfw: create input tensor: %w", err)
	}
	defer inputTensor.Destroy()

	outputTensor, err := ort.NewEmptyTensor[float32](ort.NewShape(1, 5))
	if err != nil {
		return nil, fmt.Errorf("nsfw: create output tensor: %w", err)
	}
	defer outputTensor.Destroy()

	if err := c.session.Run([]ort.Value{inputTensor}, []ort.Value{outputTensor}); err != nil {
		return nil, fmt.Errorf("nsfw: run inference: %w", err)
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

// nhwcToNCHW converts a flattened NHWC tensor to NCHW.
func nhwcToNCHW(in []float32) []float32 {
	const spatial = nsfw.ModelInputSize * nsfw.ModelInputSize
	out := make([]float32, len(in))
	for i := 0; i < spatial; i++ {
		out[i] = in[i*3]
		out[spatial+i] = in[i*3+1]
		out[2*spatial+i] = in[i*3+2]
	}
	return out
}

var _ nsfw.Classifier = (*Classifier)(nil)
