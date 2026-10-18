-- Sessions are no longer cancelled or completed by hand: a session planned by
-- mistake is deleted, and a session reads as completed once its room has ended.
-- The agent in charge is gone too: whoever created a session is its creator
-- ("createdBy"), and a customer belongs to the agent who created it.
DELETE FROM "Appointment" WHERE status = 'cancelled';
ALTER TABLE "Appointment" DROP COLUMN status, DROP COLUMN "agentId";

-- "Only mine": an agent's own customers, in list order.
CREATE INDEX "Customer_createdBy_idx" ON "Customer" ("createdBy", lower(name), id) WHERE NOT "isDeleted";
