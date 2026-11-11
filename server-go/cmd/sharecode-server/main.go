// Command sharecode-server is the ShareCode API server.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"sharecode/server/internal/server"
	"sharecode/server/migrations"
)

func main() {
	loadDotEnv(".env")
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx, migrations.Files); err != nil {
		slog.Error("server stopped", "error", err)
		os.Exit(1)
	}
}
