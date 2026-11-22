// Package nsfw contains the pure-Go parts of the optional NSFW classification
// feature: the classifier interface, the nsfwjs output mapping, and the
// alignCorners preprocessing used by nsfwjs.
package nsfw

import (
	"context"
	"fmt"
	"math"
)

// ModelInputSize is the fixed spatial input size expected by the nsfwjs
// MobileNetV2 model (224x224).
const ModelInputSize = 224

// Predictions holds the five nsfwjs class scores.
type Predictions struct {
	Drawing float32 `json:"drawing"`
	Hentai  float32 `json:"hentai"`
	Neutral float32 `json:"neutral"`
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
// The nsfwjs ONNX model already ends in a softmax layer, but a different
// conversion could emit logits; if the values do not look like probabilities
// a softmax is applied first.
func PredictionsFromOutput(probs []float32, threshold float32) (*Predictions, error) {
	if len(probs) != 5 {
		return nil, fmt.Errorf("expected 5 output values, got %d", len(probs))
	}

	var sum float64
	needsSoftmax := false
	for _, v := range probs {
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("output contains a non-finite value")
		}
		if v < 0 || v > 1 {
			needsSoftmax = true
		}
		sum += f
	}
	if math.Abs(sum-1) > 1e-3 {
		needsSoftmax = true
	}

	values := probs
	if needsSoftmax {
		values = ApplySoftmax(probs)
	}

	p := &Predictions{
		Drawing: values[0],
		Hentai:  values[1],
		Neutral: values[2],
		Porn:    values[3],
		Sexy:    values[4],
	}
	p.IsNsfw = p.Hentai+p.Porn+p.Sexy >= threshold
	return p, nil
}
