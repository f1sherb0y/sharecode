package server

import (
	"bytes"
	"context"
	"crypto/sha512"
	"errors"
	"fmt"
	"hash/crc32"
	"io/fs"
	"log/slog"
	"net/url"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DBTX is what a query needs: the pool, a connection or a transaction.
type DBTX interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// dbError logs a database error and answers 500, as db_error in server-rs.
func dbError(err error, context string) *ApiError {
	slog.Error(context, "error", err)
	return internalError("Internal server error")
}

// rowToStruct maps a row to a struct by column name (`db:"column"` tags) the
// way sqlx::FromRow does: a column the struct has no field for is ignored,
// and a field no column fills keeps its zero value.
func rowToStruct[T any](row pgx.CollectableRow) (T, error) {
	var value T
	fields := structFields(reflect.TypeFor[T]())
	columns := row.FieldDescriptions()
	targets := make([]any, len(columns))
	v := reflect.ValueOf(&value).Elem()
	for i, column := range columns {
		if index, ok := fields[column.Name]; ok {
			targets[i] = v.FieldByIndex(index).Addr().Interface()
		} else {
			targets[i] = new(any)
		}
	}
	err := row.Scan(targets...)
	return value, err
}

var structFieldCache sync.Map // reflect.Type to map[string][]int

func structFields(t reflect.Type) map[string][]int {
	if cached, ok := structFieldCache.Load(t); ok {
		return cached.(map[string][]int)
	}
	fields := map[string][]int{}
	for i := range t.NumField() {
		field := t.Field(i)
		if name := field.Tag.Get("db"); name != "" && name != "-" && field.IsExported() {
			fields[name] = field.Index
		}
	}
	structFieldCache.Store(t, fields)
	return fields
}

// queryAll collects every row of a query into structs (see rowToStruct).
func queryAll[T any](ctx context.Context, db DBTX, sql string, args ...any) ([]T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, rowToStruct[T])
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []T{}
	}
	return out, nil
}

// queryOptional is fetch_optional: the first row, nil without one.
func queryOptional[T any](ctx context.Context, db DBTX, sql string, args ...any) (*T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	row, err := pgx.CollectOneRow(rows, rowToStruct[T])
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

// queryOne is fetch_one: the first row, pgx.ErrNoRows without one.
func queryOne[T any](ctx context.Context, db DBTX, sql string, args ...any) (T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		var zero T
		return zero, err
	}
	return pgx.CollectOneRow(rows, rowToStruct[T])
}

// scalarOptional is query_scalar(...).fetch_optional: nil without a row.
func scalarOptional[T any](ctx context.Context, db DBTX, sql string, args ...any) (*T, error) {
	var value T
	err := db.QueryRow(ctx, sql, args...).Scan(&value)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// scalar is query_scalar(...).fetch_one.
func scalar[T any](ctx context.Context, db DBTX, sql string, args ...any) (T, error) {
	var value T
	err := db.QueryRow(ctx, sql, args...).Scan(&value)
	return value, err
}

// scalars is query_scalar(...).fetch_all.
func scalars[T any](ctx context.Context, db DBTX, sql string, args ...any) ([]T, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	out, err := pgx.CollectRows(rows, pgx.RowTo[T])
	if out == nil && err == nil {
		out = []T{}
	}
	return out, err
}

// uniqueViolation returns the constraint of a unique violation, "" for any
// other error.
func uniqueViolation(err error) (constraint string, ok bool) {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" {
		return pg.ConstraintName, true
	}
	return "", false
}

// pgErrorCode returns the SQLSTATE of a database error, "" otherwise.
func pgErrorCode(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}

// usernameHolder reports who holds a username: usernames are unique
// whatever their case or surrounding spaces, and deleted accounts keep
// theirs. It returns whether the holder (other than except) is deleted, nil
// when nobody holds it.
func usernameHolder(ctx context.Context, db DBTX, username string, except *string) (*bool, error) {
	deleted, err := scalarOptional[bool](ctx, db, `SELECT "isDeleted" FROM "User"
        WHERE lower(btrim(username)) = lower(btrim($1)) AND ($2::text IS NULL OR id <> $2)
        ORDER BY "isDeleted" LIMIT 1`, username, except)
	if err != nil {
		return nil, dbError(err, "Failed to check username")
	}
	return deleted, nil
}

// userCreationError turns the unique violations a concurrent registration
// can cause into client errors.
func userCreationError(err error) *ApiError {
	if constraint, ok := uniqueViolation(err); ok {
		switch constraint {
		case "User_username_key":
			return badRequest("Username already taken")
		case "User_email_key":
			return badRequest("Email already in use")
		}
	}
	return dbError(err, "Failed to create user")
}

// stripUnsupportedParams drops the query parameters libpq does not know
// (schema, which Prisma adds).
func stripUnsupportedParams(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	query := parsed.Query()
	query.Del("schema")
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

// connect opens the pool as server-rs does: ten connections, five seconds
// to get one.
func connect(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	config, err := pgxpool.ParseConfig(stripUnsupportedParams(databaseURL))
	if err != nil {
		return nil, err
	}
	config.MaxConns = 10
	config.ConnConfig.ConnectTimeout = 5 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// --- migrations, in the bookkeeping of sqlx ---
//
// The migrations are the SQL files server-rs embeds, and they are recorded
// in the table sqlx keeps (_sqlx_migrations: version, description,
// checksum = SHA-384 of the file), under the advisory lock sqlx takes. A
// database migrated by either server is accepted by the other.

type migration struct {
	version     int64
	description string
	sql         []byte
	checksum    []byte
}

func loadMigrations(files fs.FS) ([]migration, error) {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return nil, err
	}
	var out []migration
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".sql") {
			continue
		}
		prefix, rest, ok := strings.Cut(strings.TrimSuffix(name, ".sql"), "_")
		if !ok {
			continue
		}
		version, err := strconv.ParseInt(prefix, 10, 64)
		if err != nil {
			continue
		}
		sql, err := fs.ReadFile(files, name)
		if err != nil {
			return nil, err
		}
		sum := sha512.Sum384(sql)
		out = append(out, migration{version, strings.ReplaceAll(rest, "_", " "), sql, sum[:]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// migrationLockID is the advisory lock sqlx takes for a database: derived
// from its name as sqlx derives it.
func migrationLockID(database string) int64 {
	const seed = 0x3d32ad9e
	return seed * int64(crc32.ChecksumIEEE([]byte(database)))
}

func runMigrations(ctx context.Context, pool *pgxpool.Pool, files fs.FS) error {
	migrations, err := loadMigrations(files)
	if err != nil {
		return err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()

	database, err := scalar[string](ctx, conn, "SELECT current_database()")
	if err != nil {
		return err
	}
	lock := migrationLockID(database)
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lock); err != nil {
		return err
	}
	defer func() { _, _ = conn.Exec(context.Background(), "SELECT pg_advisory_unlock($1)", lock) }()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS _sqlx_migrations (
    version BIGINT PRIMARY KEY,
    description TEXT NOT NULL,
    installed_on TIMESTAMPTZ NOT NULL DEFAULT now(),
    success BOOLEAN NOT NULL,
    checksum BYTEA NOT NULL,
    execution_time BIGINT NOT NULL
)`); err != nil {
		return err
	}
	if dirty, err := scalarOptional[int64](ctx, conn, "SELECT version FROM _sqlx_migrations WHERE NOT success ORDER BY version LIMIT 1"); err != nil {
		return err
	} else if dirty != nil {
		return fmt.Errorf("migration %d is partially applied; fix and remove row from `_sqlx_migrations` table", *dirty)
	}

	type appliedRow struct {
		Version  int64  `db:"version"`
		Checksum []byte `db:"checksum"`
	}
	applied, err := queryAll[appliedRow](ctx, conn, "SELECT version, checksum FROM _sqlx_migrations ORDER BY version")
	if err != nil {
		return err
	}
	known := map[int64]migration{}
	for _, m := range migrations {
		known[m.version] = m
	}
	done := map[int64]bool{}
	for _, row := range applied {
		m, ok := known[row.Version]
		if !ok {
			return fmt.Errorf("migration %d was previously applied but is missing in the resolved migrations", row.Version)
		}
		if !bytes.Equal(m.checksum, row.Checksum) {
			return fmt.Errorf("migration %d was previously applied but has been modified", row.Version)
		}
		done[row.Version] = true
	}

	for _, m := range migrations {
		if done[m.version] {
			continue
		}
		start := time.Now()
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		// The simple protocol: a migration file holds many statements.
		if _, err := tx.Conn().PgConn().Exec(ctx, string(m.sql)).ReadAll(); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("while executing migration %d: %w", m.version, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
            VALUES ($1, $2, TRUE, $3, -1)`, m.version, m.description, m.checksum); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		if _, err := conn.Exec(ctx, "UPDATE _sqlx_migrations SET execution_time = $1 WHERE version = $2",
			time.Since(start).Nanoseconds(), m.version); err != nil {
			return err
		}
		slog.Info("applied migration", "version", m.version, "description", m.description)
	}
	return nil
}
