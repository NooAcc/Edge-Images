package nsfw

import (
	"math"
	"testing"
)

func TestPredictionsFromOutputMapping(t *testing.T) {
	p, err := PredictionsFromOutput([]float32{0.1, 0.2, 0.3, 0.25, 0.15}, 0.5)
	if err != nil {
		t.Fatal(err)
	}
	if p.Drawing != 0.1 || p.Hentai != 0.2 || p.Neutral != 0.3 || p.Porn != 0.25 || p.Sexy != 0.15 {
		t.Fatalf("unexpected mapping: %+v", p)
	}
	if !p.IsNsfw {
		t.Fatalf("IsNsfw = false, want true (hentai+porn+sexy = 0.6)")
	}

	p2, err := PredictionsFromOutput([]float32{0.1, 0.2, 0.3, 0.25, 0.15}, 0.61)
	if err != nil {
		t.Fatal(err)
	}
	if p2.IsNsfw {
		t.Fatalf("IsNsfw = true, want false at threshold 0.61")
	}
}

func TestPredictionsFromOutputAppliesSoftmaxToLogits(t *testing.T) {
	p, err := PredictionsFromOutput([]float32{1, 2, 3, 4, 5}, 0.5)
	if err != nil {
		t.Fatal(err)
	}

	sum := p.Drawing + p.Hentai + p.Neutral + p.Porn + p.Sexy
	if math.Abs(float64(sum-1)) > 1e-6 {
		t.Fatalf("sum = %v, want 1", sum)
	}
	if p.Sexy <= p.Porn || p.Sexy <= p.Neutral || p.Sexy <= p.Hentai || p.Sexy <= p.Drawing {
		t.Fatalf("Sexy should be the largest class: %+v", p)
	}
	if !p.IsNsfw {
		t.Fatalf("IsNsfw = false, want true")
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
