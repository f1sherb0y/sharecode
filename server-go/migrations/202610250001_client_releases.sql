-- Desktop client releases, published by admins. The download page offers the newest
-- installer for each platform; the in-app updater (Tauri) asks for the newest signed update.
CREATE TABLE "ClientRelease" (
    id TEXT PRIMARY KEY,
    -- Semantic version, the same as the app's own version (tauri.conf.json).
    version TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    -- NULL while a draft; published releases are served and no longer edited.
    "publishedAt" TIMESTAMPTZ,
    "createdBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "ClientRelease_version_key" ON "ClientRelease" (version);

-- Files of a release, per platform (Tauri's target-arch names). The installer is what the
-- download page offers; an update bundle is only uploaded when the updater needs a different
-- file (macOS .app.tar.gz), otherwise the installer itself is the update (Windows NSIS
-- setup.exe, Linux AppImage). The minisign signature (the .sig file) enables auto-update.
CREATE TABLE "ClientReleaseAsset" (
    id TEXT PRIMARY KEY,
    "releaseId" TEXT NOT NULL REFERENCES "ClientRelease"(id) ON DELETE CASCADE,
    platform TEXT NOT NULL CHECK (platform IN (
        'windows-x86_64', 'windows-aarch64', 'darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'linux-aarch64'
    )),
    kind TEXT NOT NULL CHECK (kind IN ('installer', 'update')),
    "fileName" TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    signature TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE ("releaseId", platform, kind)
);
