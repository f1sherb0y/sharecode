set shell := ["bash", "-euo", "pipefail", "-c"]
set positional-arguments := true

# Local defaults match docker-compose.dev.yml. No .env file is loaded by just.

export dev_database_url := env("SHARECODE_DEV_DATABASE_URL", "postgresql://sharecode:sharecode_dev_password@127.0.0.1:5432/sharecode")
export dev_admin_username := env("SHARECODE_DEV_ADMIN_USERNAME", "local_admin")
export dev_admin_password := env("SHARECODE_DEV_ADMIN_PASSWORD", "LocalTest#2026Strong")

# List available commands.
default:
    @just --list

# Install frontend packages and fetch Rust dependencies.
install:
    cd frontend && bun install
    cargo fetch --manifest-path server-rs/Cargo.toml

# Start PostgreSQL, the API, and the frontend together; Ctrl+C stops both apps.
up: db-up
    cd frontend && bun run concurrently --kill-others --kill-timeout 3000 --names api,web 'just --no-deps server' 'just dev'

# Start the development database and wait until it is ready.
db-up:
    docker compose -f docker-compose.dev.yml up -d --wait postgres

# Stop the development database, keeping its data.
db-stop:
    docker compose -f docker-compose.dev.yml stop postgres

# Follow development database logs.
db-logs:
    docker compose -f docker-compose.dev.yml logs -f postgres

# Open a SQL shell in the development database.
db-shell:
    docker compose -f docker-compose.dev.yml exec postgres psql -U sharecode -d sharecode

# Start code execution and install Python, Java, C/C++, JavaScript and TypeScript.
runner-up:
    docker compose -f docker-compose.dev.yml up -d piston
    docker compose -f docker-compose.dev.yml exec -T piston node < scripts/setup-piston.cjs

# Exercise execution, diagnostics and room language permissions with disposable PostgreSQL.
test-runner:
    bash scripts/test-runner-local.sh

# Start the database and local API on port 3001 (terminal 1).
server: db-up
    @cd server-rs && env \
        DATABASE_URL="$dev_database_url" \
        JWT_SECRET='local-development-secret-change-before-deployment' \
        BIND_ADDRESS=127.0.0.1 PORT=3001 \
        FRONTEND_URL=http://localhost:5173 APP_URL=http://localhost:5173 \
        ADMIN_USERNAME="$dev_admin_username" ADMIN_PASSWORD="$dev_admin_password" \
        ADMIN_EMAIL=local-admin@example.invalid ADMIN_UPDATE_PASSWORD=false \
        TRUSTED_PROXY_CIDRS='' PISTON_URL=http://127.0.0.1:2000 \
        cargo run

# Start the frontend at http://localhost:5173 with hot reload (terminal 2).
dev:
    cd frontend && VITE_API_URL=http://127.0.0.1:3001 bun dev

# Check TypeScript and Rust without creating release bundles.
check:
    cd frontend && bunx tsc --noEmit
    cargo check --manifest-path server-rs/Cargo.toml

# Build the production frontend bundle.
build:
    cd frontend && bun run build

# Build the Rust server in release mode.
build-server:
    cargo build --release --manifest-path server-rs/Cargo.toml

# Install browser engines and their system dependencies for UI tests.
browsers:
    cd frontend && bunx playwright install --with-deps chromium firefox webkit

# Run UI tests with local fixtures; browser: chromium, firefox, or webkit.
test-ui browser="chromium":
    @case "$1" in chromium|firefox|webkit) ;; *) echo 'Browser must be chromium, firefox, or webkit' >&2; exit 2 ;; esac
    cd frontend && UI_BROWSER="$1" node --test tests/workspace-ui.test.mjs

# Run the UI suite in all three browser engines.
test-ui-all:
    just test-ui chromium
    just test-ui firefox
    just test-ui webkit

# Run editor collaboration and Markdown regression tests without a backend.
test-editor:
    cd frontend && node --test tests/collaboration.test.mjs tests/markdown-math.test.mjs

# Check translation coverage, interpolation, and untranslated app labels.
test-i18n:
    cd frontend && node --test tests/i18n.test.mjs

# Run Rust unit tests.
test-server:
    cargo test --manifest-path server-rs/Cargo.toml

# Run the full integration suite with disposable PostgreSQL (requires initdb/pg_ctl).
test-integration:
    bash scripts/test-collaboration-local.sh

# Exercise admin tab loading, server pagination, filtering and permissions.
test-admin:
    bash scripts/test-runner-local.sh tests/admin-pagination.mjs

# Check Canvas delta synchronization, replay, sampling and Follow geometry.
test-canvas:
    cd frontend && bun test tests/canvas-sync.test.ts

# Test Canvas against disposable PostgreSQL/API; browser checks do not simulate drawing.
test-canvas-integration:
    bash scripts/test-runner-local.sh tests/canvas-integration.ts

# Verify code/Markdown switching, delayed responses, and recovery from a blank editor.
test-markdown-switch:
    bash scripts/test-runner-local.sh tests/markdown-switch.mjs

# Required before each deployment: build, auth, browser restarts, UI, fonts and export.
predeploy:
    bash scripts/predeploy.sh

# Check notes read/write permissions and real reader/manager session exports.
test-notes:
    bash scripts/test-runner-local.sh tests/notes-permissions.mjs

# Read-only public smoke checks after deployment; never signs in or edits data.
postdeploy url="https://collabcode.cc":
    cd frontend && node tests/deployment-smoke.mjs "$1"
