package daemon

import (
	"context"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/multica-ai/multica/server/internal/daemon/localenv"
	"github.com/multica-ai/multica/server/internal/envtunnel"
)

func (s *environmentService) allowsTunnelPort(key string, port int) bool {
	if s == nil || port < 1 || port > 65535 {
		return false
	}
	if s.manager != nil {
		for _, env := range s.manager.Snapshot() {
			if env.Key == key && env.Port == port && (env.State == localenv.StateStarting || env.State == localenv.StateRunning) {
				return true
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, env := range s.detected {
		if env.Key == key && env.Kind != localenv.KindApp && env.Port == port {
			return true
		}
	}
	return false
}

func (d *Daemon) openEnvironmentTunnel(ctx context.Context, runtimeID, streamID string) {
	if d.environments == nil || ctx.Err() != nil {
		return
	}
	if _, err := uuid.Parse(streamID); err != nil {
		return
	}
	endpoint := strings.TrimRight(d.client.baseURL, "/") + "/api/daemon/runtimes/" + runtimeID + "/environment-tunnel/" + streamID
	endpoint = strings.Replace(strings.Replace(endpoint, "https://", "wss://", 1), "http://", "ws://", 1)
	dialer := websocket.Dialer{Proxy: http.ProxyFromEnvironment, HandshakeTimeout: 10 * time.Second}
	ws, resp, err := dialer.DialContext(ctx, endpoint, http.Header{"Authorization": {"Bearer " + d.client.Token()}})
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		return
	}
	defer ws.Close()
	port, err := strconv.Atoi(resp.Header.Get("X-Multica-Env-Port"))
	if err != nil || !d.environments.allowsTunnelPort(resp.Header.Get("X-Multica-Env-Key"), port) {
		return
	}
	local, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return
	}
	defer local.Close()
	tunnel := envtunnel.NewConn(ws)
	stop := context.AfterFunc(ctx, func() { tunnel.Close(); local.Close() })
	defer stop()
	done := make(chan struct{})
	go func() { _, _ = io.Copy(local, tunnel); local.Close(); close(done) }()
	_, _ = io.Copy(tunnel, local)
	tunnel.Close()
	<-done
}
