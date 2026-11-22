package nsfw

import (
	"math"
	"testing"
)

func TestPredictionsFromOutputMapping(t *testing.T) {
	p, err := PredictionsFromOutput([]float32{1, 2, 3, 4, 5}, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	// Class order is safe, hentai, porn, sexy, drawing (spec 8.1 id2label).
	want := []float32{0.01165623, 0.03168492, 0.08612854, 0.23412165, 0.63640865}
	got := []float32{p.Safe, p.Hentai, p.Porn, p.Sexy, p.Drawing}
	for i := range want {
		if math.Abs(float64(got[i]-want[i])) > 1e-6 {
			t.Fatalf("class %d = %v, want %v", i, got[i], want[i])
		}
	}
	if p.IsNsfw {
		t.Fatalf("IsNsfw = true, want false (hentai+porn+sexy = 0.3519 < 0.5)")
	}

	p2, err := PredictionsFromOutput([]float32{1, 2, 3, 4, 5}, 0.35)
	if err != nil {
		t.Fatal(err)
	}
	if !p2.IsNsfw {
		t.Fatalf("IsNsfw = false, want true at threshold 0.35")
	}

	p3, err := PredictionsFromOutput([]float32{0, 5, 4, 4, 0}, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if !p3.IsNsfw {
		t.Fatalf("IsNsfw = false, want true for nsfw-dominant logits")
	}
}

func TestPredictionsFromOutputRejectsBadInput(t *testing.T) {
	if _, err := PredictionsFromOutput([]float32{0.1, 0.2, 0.3, 0.4}, 0.5); err == nil {
		t.Fatal("expected error for 4 classes")
	}
	if _, err := PredictionsFromOutput([]float32{0.1, float32(math.NaN()), 0.3, 0.3, 0.3}, 0.5); err == nil {
		t.Fatal("expected error for NaN")
	}
	if _, err := PredictionsFromOutput([]float32{0.1, float32(math.Inf(1)), 0.3, 0.3, 0.3}, 0.5); err == nil {
		t.Fatal("expected error for Inf")
	}
}

func TestApplySoftmaxZeroAndEmpty(t *testing.T) {
	if got := ApplySoftmax(nil); len(got) != 0 {
		t.Fatalf("empty softmax = %v", got)
	}

	got := ApplySoftmax([]float32{0, 0, 0, 0, 0})
	for _, v := range got {
		if math.Abs(float64(v)-0.2) > 1e-6 {
			t.Fatalf("uniform softmax = %v", got)
		}
	}
}
