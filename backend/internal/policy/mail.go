package policy

import "time"

const (
	AccountMailQueueLimit       = 36
	AccountMailWorkers          = 4
	AccountMailMaxAttempts      = 8
	AccountMailLease            = 60 * time.Second
	AccountMailOperationTimeout = 20 * time.Second
	AccountMailStoreTimeout     = 5 * time.Second
	AccountMailIdlePoll         = 500 * time.Millisecond
	AccountMailErrorPoll        = 5 * time.Second
	AccountMailWarningInterval  = 30 * time.Second
	AccountMailRetryBase        = 30 * time.Second
	AccountMailRetryMaximum     = 5 * time.Minute
	AccountMailRetention        = 24 * time.Hour
	AccountMailPruneBatch       = 100
	AccountMailPruneMaxBatches  = 10
	AccountMailPruneBudget      = 500 * time.Millisecond
	AccountMailPruneIdle        = time.Minute
	AccountMailPruneCatchUp     = 100 * time.Millisecond
)
