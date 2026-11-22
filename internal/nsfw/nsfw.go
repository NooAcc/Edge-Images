// Package nsfw contains the pure-Go parts of the optional NSFW classification
// feature: the classifier interface, output mapping, and EfficientNet-B4
// preprocessing.
package nsfw

import (
	"context"
	"fmt"
	"math"
)

// ModelInputSize is the fixed spatial input size expected by the
// nsfw-detection-2-mini EfficientNet-B4 model (380x380).
const ModelInputSize = 380

// Predictions holds the five class scores in the model's id2label order:
// safe, hentai, porn, sexy, drawing.
type Predictions struct {
	Drawing float32 `json:"drawing"`
	Hentai  float32 `json:"hentai"`
	Safe    float32 `json:"safe"`
	Porn    float32 `json:"porn"`
	Sexy    float32 `json:"sexy"`
	IsNsfw  bool    `json:"isNsfw"`
}

// Classifier is implemented by the ONNX-backed classifier and by test fakes.
type Classifier interface {
	Classify(ctx context.Context, rgb []byte, width, height int) (*Predictions, error)
	ModelID() string
	Threshold() float32
	Close() error
}

// ApplySoftmax returns a numerically stable softmax of logits.
func ApplySoftmax(logits []float32) []float32 {
	if len(logits) == 0 {
		return nil
	}

	max := logits[0]
	for _, v := range logits[1:] {
		if v > max {
			max = v
		}
	}

	out := make([]float32, len(logits))
	var sum float64
	for i, v := range logits {
		e := math.Exp(float64(v - max))
		out[i] = float32(e)
		sum += e
	}
	if sum == 0 {
		return out
	}

	inv := 1 / sum
	for i := range out {
		out[i] = float32(float64(out[i]) * inv)
	}
	return out
}

// PredictionsFromOutput maps the 5-element model output to Predictions.
//
// The ONNX export emits raw logits, so a numerically stable softmax is always
// applied before mapping.
func PredictionsFromOutput(logits []float32, threshold float32) (*Predictions, error) {
	if len(logits) != 5 {
		return nil, fmt.Errorf("expected 5 output values, got %d", len(logits))
	}

	for _, v := range logits {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil, fmt.Errorf("output contains a non-finite value")
		}
	}

	values := ApplySoftmax(logits)

	p := &Predictions{
		Safe:    values[0],
		Hentai:  values[1],
		Porn:    values[2],
		Sexy:    values[3],
		Drawing: values[4],
	}
	p.IsNsfw = p.Hentai+p.Porn+p.Sexy >= threshold
	return p, nil
}
