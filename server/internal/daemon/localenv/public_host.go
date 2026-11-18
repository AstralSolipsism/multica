package localenv

import (
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

func publicHostFromEnv() string {
	host := strings.TrimSpace(os.Getenv("MULTICA_ENV_PUBLIC_HOST"))
	if host == "" {
		return "localhost"
	}
	if strings.Contains(host, "://") {
		if u, err := url.Parse(host); err == nil {
			host = u.Hostname()
		}
	}
	host = strings.Trim(host, "[]")
	if host == "" || (net.ParseIP(host) == nil && strings.ContainsAny(host, "/:@?# ")) {
		return "localhost"
	}
	return host
}

func expandEnvURL(raw string, port int, host string) string {
	urlHost := host
	if strings.Contains(host, ":") {
		urlHost = "[" + host + "]"
	}
	raw = strings.NewReplacer("${MULTICA_HOST}", urlHost, "$MULTICA_HOST", urlHost).Replace(expandPort(raw, port))
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() != "localhost" {
		return raw
	}
	urlPort := u.Port()
	u.Host = urlHost
	if urlPort != "" {
		u.Host = net.JoinHostPort(host, urlPort)
	}
	return u.String()
}

func expandReadyURL(def Definition, port int, host string) string {
	if host != "localhost" && !def.ReadyExplicit && def.URL != "" {
		return expandEnvURL(def.Ready, port, "127.0.0.1")
	}
	return expandEnvURL(def.Ready, port, host)
}

func detectedServerURL(port int) string {
	return "http://" + net.JoinHostPort(publicHostFromEnv(), strconv.Itoa(port))
}
