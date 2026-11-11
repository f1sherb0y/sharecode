-- The 管理 a session belongs to, when one was chosen; otherwise its customer's agent, else its planner.
ALTER TABLE "Appointment" ADD COLUMN "managerId" TEXT REFERENCES "User"(id) ON DELETE RESTRICT;
