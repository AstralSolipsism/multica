package daemon

// Labrastro fork addition: terminal usage reporting variant. Moved verbatim
// out of daemon.go (upstream high-churn file) so the fork footprint there
// stays minimal.

import (
	"sort"

	"github.com/multica-ai/multica/server/pkg/agent"
)

// reportedTaskUsageEntries converts the terminal usage map, keeping explicitly
// reported zero entries (see TestHandleTaskPreservesReportedZeroUsage).
func reportedTaskUsageEntries(provider string, usage map[string]agent.TokenUsage) []TaskUsageEntry {
	var entries []TaskUsageEntry
	for model, u := range usage {
		entries = append(entries, TaskUsageEntry{
			Provider:         provider,
			Model:            model,
			InputTokens:      u.InputTokens,
			OutputTokens:     u.OutputTokens,
			CacheReadTokens:  u.CacheReadTokens,
			CacheWriteTokens: u.CacheWriteTokens,
			CostUSDTicks:     u.CostUSDTicks,
		})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Model < entries[j].Model })
	return entries
}
