package logger

import (
	"log/slog"
	"os"
)

var defaultLogger *slog.Logger

func init() {
	defaultLogger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(defaultLogger)
}

func New(requestID string) *slog.Logger {
	return defaultLogger.With(
		slog.String("requestId", requestID),
	)
}

func Default() *slog.Logger {
	return defaultLogger
}

func IsDebug() bool {
	return os.Getenv("IMAGE_DEBUG_LOGS") == "1"
}
