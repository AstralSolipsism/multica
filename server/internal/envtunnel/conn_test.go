package envtunnel

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestConnStreamsFramesAndInterruptsRead(t *testing.T) {
	accepted := make(chan *Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			accepted <- NewConn(ws)
		}
	}))
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial(strings.Replace(server.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	client := NewConn(ws)
	defer client.Close()
	peer := <-accepted
	defer peer.Close()
	peer.SetDeadline(time.Now().Add(time.Second))
	for _, part := range []string{"first", "second"} {
		if _, err := client.Write([]byte(part)); err != nil {
			t.Fatal(err)
		}
	}
	b := make([]byte, 11)
	if _, err := io.ReadFull(peer, b); err != nil || string(b) != "firstsecond" {
		t.Fatalf("stream=%q err=%v", b, err)
	}
	reading := make(chan struct{})
	done := make(chan error, 1)
	go func() { close(reading); _, err := peer.Read(b); done <- err }()
	<-reading
	if err := peer.SetReadDeadline(time.Now()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("deadline did not interrupt read")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked read survived deadline")
	}
}
