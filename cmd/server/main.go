package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"edge-image/internal/allowlist"
	"edge-image/internal/cache"
	"edge-image/internal/config"
	"edge-image/internal/fetcher"
	"edge-image/internal/logger"
	"edge-image/internal/processor"
	"edge-image/internal/server"
)

func main() {
	log := logger.Default()

	cfg := config.Load()
	log.Info("server: config loaded",
		"maxDimension", cfg.MaxDimension,
		"defaultQuality", cfg.DefaultQuality,
		"cacheType", cfg.Cache.Type,
		"cacheMemoryMB", cfg.Cache.MaxMemoryMB,
		"cacheDiskGB", cfg.Cache.MaxDiskGB,
	)

	processor.InitVips()
	defer processor.ShutdownVips()

	var c *cache.Cache
	if cfg.Cache.Type != "none" {
		basePath := "/data"
		if cfg.Cache.MaxDiskGB <= 0 {
			basePath = ""
		}
		var err error
		c, err = cache.New(cfg.Cache.MaxMemoryMB, cfg.Cache.MaxDiskGB, basePath, log)
		if err != nil {
			log.Error("server: cache init failed, continuing without cache", "error", err)
		} else {
			log.Info("server: cache enabled",
				"memoryMB", cfg.Cache.MaxMemoryMB,
				"diskGB", cfg.Cache.MaxDiskGB,
			)
			c.Cleanup()
		}
	}
	if c != nil {
		defer c.Close()
	}

	al := allowlist.NewFromEnv()
	f := fetcher.New(log)

	imageHandler := server.NewHandler(cfg, al, c, f, log)
	batchHandler := server.NewBatchHandler(cfg, al, c, f, log)

	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	mux.Handle("/api/media/", imageHandler)
	mux.Handle("/api/batch", batchHandler)

	publicDir := "./public"
	if dir := os.Getenv("PUBLIC_DIR"); dir != "" {
		publicDir = dir
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" && r.URL.Path != "/index.html" {
			http.ServeFile(w, r, publicDir+r.URL.Path)
			return
		}
		http.ServeFile(w, r, publicDir+"/index.html")
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  60 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Info("server: listening", "addr", ":"+port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Error("server: listen failed", "error", err)
			os.Exit(1)
		}
	}()

	<-done
	log.Info("server: shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Error("server: shutdown failed", "error", err)
	}

	log.Info("server: stopped")
}
