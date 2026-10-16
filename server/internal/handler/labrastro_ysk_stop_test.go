package handler

import (
	"net/http"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestLabrastroYSKTaskStatusReadsCurrentWorkspaceSwitch(t *testing.T) {
	f := newYSKFixture(t)
	// Even a capable daemon must not load context/repos or other workspace
	// fields on every status poll. Fail that query if it is reintroduced.
	fault := &lookupFaultPool{DBTX: testPool, query: "GetWorkspace"}
	h := f.h
	h.Queries = db.New(fault)
	// Every poll uses the same running task; settings changes take effect
	// without a new claim. Absent/invalid settings are off, as at claim time.
	for _, tc := range []struct {
		settings string
		enabled  bool
	}{
		{`{"you_should_know_enabled":true}`, true},
		{`{"you_should_know_enabled":false}`, false},
		{`{}`, false},
		{`{"you_should_know_enabled":"true"}`, false},
		{`{"you_should_know_enabled":null}`, false},
		{`{"you_should_know_enabled":1}`, false},
		{`{"you_should_know_enabled":[true]}`, false},
		{`null`, false},
		{`[]`, false},
		{`{"you_should_know_enabled":true}`, true},
	} {
		f.Exec(t, "UPDATE workspace SET settings=$2 WHERE id=$1", f.WorkspaceID, tc.settings)
		req := newDaemonTokenRequest(http.MethodGet, "/api/daemon/tasks/"+f.task+"/status", nil, f.WorkspaceID, "ysk-daemon")
		req = withURLParam(req, "taskId", f.task)
		req.Header.Set("X-Client-Capabilities", protocol.DaemonCapabilityYouShouldKnowV1)
		var response protocol.DaemonTaskStatus
		testutil.Call(t, h.GetTaskStatus, req).Want(http.StatusOK).JSON(&response)
		if fault.called {
			t.Fatal("status poll read the full workspace")
		}
		if response.Status != "running" || response.YouShouldKnowEnabled == nil || *response.YouShouldKnowEnabled != tc.enabled {
			t.Fatalf("settings %s: unexpected status %+v", tc.settings, response)
		}
	}
}

func TestLabrastroYSKTaskStatusPreservesStatusOnLookupFailure(t *testing.T) {
	f := newYSKFixture(t)
	fault := &lookupFaultPool{DBTX: testPool, query: "LabrastroYSKWorkspaceEnabled"}
	h := f.h
	h.Queries = db.New(fault)
	for _, capability := range []string{"", protocol.DaemonCapabilityYouShouldKnowV1} {
		fault.called = false
		req := newDaemonTokenRequest(http.MethodGet, "/api/daemon/tasks/"+f.task+"/status", nil, f.WorkspaceID, "ysk-daemon")
		req = withURLParam(req, "taskId", f.task)
		req.Header.Set("X-Client-Capabilities", capability)
		var response map[string]any
		testutil.Call(t, h.GetTaskStatus, req).Want(http.StatusOK).JSON(&response)
		if response["status"] != "running" {
			t.Fatalf("status lost: %v", response)
		}
		if _, present := response["you_should_know_enabled"]; present {
			t.Fatalf("unknown YSK state must be omitted: %v", response)
		}
		if fault.called != (capability != "") {
			t.Fatalf("workspace lookup called=%v for capability %q", fault.called, capability)
		}
	}
}

func TestLabrastroYSKTaskStatusAuthorizesBeforeReadingSwitch(t *testing.T) {
	f := newYSKFixture(t)
	fault := &lookupFaultPool{DBTX: testPool, query: "LabrastroYSKWorkspaceEnabled"}
	h := f.h
	h.Queries = db.New(fault)
	req := newDaemonTokenRequest(http.MethodGet, "/api/daemon/tasks/"+f.task+"/status", nil, testWorkspaceID, "other-daemon")
	req = withURLParam(req, "taskId", f.task)
	req.Header.Set("X-Client-Capabilities", protocol.DaemonCapabilityYouShouldKnowV1)
	testutil.Call(t, h.GetTaskStatus, req).Want(http.StatusNotFound)
	if fault.called {
		t.Fatal("read another workspace's YSK setting before authorization")
	}
}
