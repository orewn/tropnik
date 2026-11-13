// Package policy defines stable internal limits and coordination identifiers.
// These safety bounds are reviewed with the code, not arbitrary environment knobs.
package policy

// AdvisoryLockID belongs to PostgreSQL's single-bigint advisory-lock namespace.
// Preserve existing identifiers across releases; unrelated operations must never
// share one merely because their constants were declared in separate packages.
type AdvisoryLockID int64

const (
	MigrationLock        AdvisoryLockID = 87071204
	BootstrapAdminLock   AdvisoryLockID = 87071205
	AccountMailQueueLock AdvisoryLockID = 87071206
)
