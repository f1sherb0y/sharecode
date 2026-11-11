// Package migrations holds the SQL migrations, the same files server-rs
// embeds, in the order of their numeric prefixes.
package migrations

import "embed"

//go:embed *.sql
var Files embed.FS
