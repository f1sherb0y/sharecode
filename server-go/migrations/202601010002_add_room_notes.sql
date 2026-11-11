CREATE TABLE IF NOT EXISTS "RoomNote" (
    "id" TEXT PRIMARY KEY,
    "roomId" TEXT NOT NULL REFERENCES "Room"("id") ON DELETE CASCADE,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_room_note_room_id ON "RoomNote"("roomId", "createdAt");
