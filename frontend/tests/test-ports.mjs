// The local ports of one test run. scripts/test-runner-local.sh starts the database
// at the base port and the API at the next one; suites take the ones after for their
// own servers (0 database, 1 API, 2 web, 3 and up: whatever else a suite starts).
// SHARECODE_TEST_PORT_BASE moves the block, so several suites can run at once.
const base = Number(process.env.SHARECODE_TEST_PORT_BASE || 55459)
export const testPort = offset => base + offset
