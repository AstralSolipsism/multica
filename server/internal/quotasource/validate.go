package quotasource

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/multica-ai/multica/server/pkg/remotemcp"
)

// ValidateBaseURL applies the SSRF policy to a user-supplied base_url: public
// HTTPS only, no userinfo/query/fragment, host on the driver's allowlist, and
// the resolved addresses must be public (DNS-rebinding-safe re-check happens
// in the secure client's dial path). Empty returns the driver default.
//
// An operator-named dev origin (MULTICA_PLUGIN_DEV_ORIGINS, the same escape
// hatch the plugin broker uses for tests and staging proxies) satisfies the
// host policy by explicit configuration: validation still runs, but without
// the driver allowlist, whose job is to constrain USER-supplied hosts.
func ValidateBaseURL(ctx context.Context, driver Driver, raw string) (*url.URL, error) {
	base := strings.TrimSpace(raw)
	if base == "" {
		base = driver.DefaultBaseURL()
	}
	allowedHosts := driver.AllowedHosts()
	if isOperatorDevOrigin(base) {
		allowedHosts = nil
	}
	endpoint, err := remotemcp.ValidatePublicHTTPSEndpoint(ctx, base, allowedHosts, nil)
	if err != nil {
		return nil, fmt.Errorf("base_url rejected: %w", err)
	}
	return endpoint, nil
}

// isOperatorDevOrigin reports whether the exact scheme://host[:port] is
// registered in MULTICA_PLUGIN_DEV_ORIGINS.
func isOperatorDevOrigin(raw string) bool {
	configured := strings.TrimSpace(os.Getenv(remotemcp.DevOriginsEnv))
	if configured == "" {
		return false
	}
	for _, entry := range strings.Split(configured, ",") {
		if strings.TrimSpace(entry) == strings.TrimSpace(raw) {
			return true
		}
	}
	return false
}
