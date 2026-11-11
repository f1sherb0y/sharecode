// Package server is the ShareCode API server: the REST routes, the
// collaboration WebSocket (on the ygo CRDT library) and the background
// jobs. It is a port of server-rs, file for file, on the same database.
package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// App is what every handler works with (AppState in server-rs).
type App struct {
	Config *Config
	DB     *pgxpool.Pool
	WS     *WsState
}

// registrars are the route tables of the modules; each file with routes
// adds its own in an init function.
var registrars []func(a *App, mux *http.ServeMux)

// Handler is the whole HTTP surface: routes, CORS and request logging.
func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/admin/audit", h(a.listAuditEvents))
	mux.HandleFunc("GET /api/admin/users/{id}/devices", h(a.listUserDevices))
	for _, register := range registrars {
		register(a, mux)
	}
	return logRequests(a.cors(mux))
}

func parseLogLevel(level string) slog.Level {
	switch strings.ToLower(level) {
	case "trace", "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

// Run starts the server and returns when it stops: on an error, or when ctx
// ends. migrations holds the SQL files.
func Run(ctx context.Context, migrations fs.FS) error {
	config := ConfigFromEnv()
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parseLogLevel(config.LogLevel)})))
	if config.ClientReleasesCITokenSHA256 == nil && strings.TrimSpace(os.Getenv("CLIENT_RELEASES_CI_TOKEN_SHA256")) != "" {
		slog.Warn("CLIENT_RELEASES_CI_TOKEN_SHA256 is not 64 hex digits; CI release uploads are off")
	}

	db, err := connect(ctx, config.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	encoding, err := scalar[string](ctx, db, "SHOW server_encoding")
	if err != nil {
		return err
	}
	if encoding != "UTF8" {
		return errors.New("ShareCode requires a UTF-8 PostgreSQL database")
	}

	started := time.Now()
	slog.Info("starting database migrations")
	if err := runMigrations(ctx, db, migrations); err != nil {
		slog.Error("database migrations failed", "elapsed_ms", time.Since(started).Milliseconds(), "error", err)
		return err
	}
	slog.Info("database migrations complete", "elapsed_ms", time.Since(started).Milliseconds())

	app := &App{Config: config, DB: db}
	app.WS = newWsState(app)
	if err := app.initializeAdmin(ctx); err != nil {
		slog.Error("Failed to initialize admin user", "error", err)
		return err
	}
	app.spawnInactiveRoomCleanup(ctx)
	app.spawnExpiredShareLinkCleanup(ctx)

	addr := net.JoinHostPort(config.BindAddress.String(), fmt.Sprint(config.Port))
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	slog.Info("sharecode server-go listening", "addr", addr)
	srv := &http.Server{Handler: app.Handler(), ReadHeaderTimeout: 30 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if err := srv.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
