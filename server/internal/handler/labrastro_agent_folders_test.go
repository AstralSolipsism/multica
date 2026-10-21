package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/testutil"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func init() {
	for _, table := range []string{"labrastro_agent_folder", "labrastro_agent_placement", "labrastro_agent_squad_placement"} {
		workspaceDeletionManifest[table] = workspaceDelete
	}
}

func agentFolderFixture(t *testing.T) *testutil.Fixture {
	t.Helper()
	ws := dbfx.Workspace(t, "agent folders", "folders-"+uuid.NewString())
	dbfx.Member(t, ws, testUserID, "owner")
	fx := testutil.New(testPool, ws, testUserID)
	t.Cleanup(func() {
		for _, table := range []string{"labrastro_agent_placement", "labrastro_agent_squad_placement", "labrastro_agent_folder"} {
			if _, err := testPool.Exec(context.Background(), "DELETE FROM "+table+" WHERE workspace_id=$1", ws); err != nil {
				t.Error(err)
			}
		}
	})
	return fx
}

func agentFolderCall(t *testing.T, fx *testutil.Fixture, user, method, path string, body any) *testutil.Response {
	t.Helper()
	router := chi.NewRouter()
	testHandler.RegisterLabrastroAgentFolderRoutes(router)
	req := newRequestAsUser(user, method, path, body)
	req.Header.Set("X-Workspace-ID", fx.WorkspaceID)
	return testutil.Call(t, router.ServeHTTP, req)
}

func createAgentFolder(t *testing.T, fx *testutil.Fixture, name, parent string) string {
	t.Helper()
	var folder db.LabrastroAgentFolder
	agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": name, "parent_id": parent}).Want(201).JSON(&folder)
	return uuidToString(folder.ID)
}

func readAgentFolders(t *testing.T, fx *testutil.Fixture, user string) LabrastroAgentFolderTree {
	t.Helper()
	var tree LabrastroAgentFolderTree
	agentFolderCall(t, fx, user, "GET", "/api/agent-folders", nil).Want(200).JSON(&tree)
	if tree.Folders == nil || tree.Placements == nil || tree.Squads == nil {
		t.Fatal("tree arrays must never be null")
	}
	return tree
}

func wantAgentFolderError(t *testing.T, response *testutil.Response, status int, code string) {
	t.Helper()
	var body struct {
		Error, Code string
		Retryable   bool
	}
	response.Want(status).JSON(&body)
	if body.Code != code || body.Error == "" || body.Retryable {
		t.Fatalf("unexpected error: %+v", body)
	}
}

func TestLabrastroAgentFolderTreeVisibilityAndDanglingRecords(t *testing.T) {
	fx := agentFolderFixture(t)
	member := fx.User(t, "viewer", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, member, "member")
	folder := createAgentFolder(t, fx, "folder", "")
	private := fx.Agent(t, "hidden", "")
	archived := fx.Agent(t, "archived visible", "", testutil.Cols{"owner_id": member, "archived_at": testutil.Raw("now()")})
	allowed := fx.Agent(t, "allow-listed", "", testutil.Cols{"permission_mode": "public_to"})
	fx.Insert(t, "agent_invocation_target", testutil.Cols{"agent_id": allowed, "target_type": "member", "target_id": member})
	notAllowed := fx.Agent(t, "not allow-listed", "", testutil.Cols{"permission_mode": "public_to"})
	other := agentFolderFixture(t)
	foreignAgent := other.Agent(t, "foreign", "")
	for _, id := range []string{private, archived, allowed, notAllowed, foreignAgent, uuid.NewString()} {
		fx.Exec(t, "INSERT INTO labrastro_agent_placement(workspace_id,agent_id,folder_id) VALUES ($1,$2,$3)", fx.WorkspaceID, id, folder)
	}
	squad := fx.Squad(t, "live squad", allowed)
	for _, id := range []string{private, allowed, notAllowed, foreignAgent, uuid.NewString()} {
		fx.SquadMember(t, squad, "agent", id)
	}
	fx.SquadMember(t, squad, "member", member)
	archivedSquad := fx.Squad(t, "archived squad", archived, testutil.Cols{"archived_at": testutil.Raw("now()")})
	fx.SquadMember(t, archivedSquad, "agent", archived)
	fx.Exec(t, "INSERT INTO labrastro_agent_squad_placement VALUES ($1,$2,$3),($1,$4,$5)", fx.WorkspaceID, archivedSquad, folder, squad, uuid.NewString())
	tree := readAgentFolders(t, fx, member)
	placedAgents := []string{}
	for _, p := range tree.Placements {
		placedAgents = append(placedAgents, uuidToString(p.AgentID))
	}
	slices.Sort(placedAgents)
	wantPlaced := []string{archived, allowed}
	slices.Sort(wantPlaced)
	if len(tree.Folders) != 1 || !reflect.DeepEqual(placedAgents, wantPlaced) {
		t.Fatalf("visibility/archived agent: %+v", tree)
	}
	if len(tree.Squads) != 1 || tree.Squads[0].ParentID.Valid || !reflect.DeepEqual(tree.Squads[0].AgentIDs, []string{allowed}) {
		t.Fatalf("derived squad: %+v", tree.Squads)
	}
	adminTree := readAgentFolders(t, fx, testUserID)
	if len(adminTree.Squads[0].AgentIDs) != 3 {
		t.Fatalf("admin view: %+v", adminTree.Squads)
	}
	// Read ignores stale rows without mutating them; a later successful write prunes them.
	if fx.Count(t, "SELECT count(*) FROM labrastro_agent_placement WHERE workspace_id=$1", fx.WorkspaceID) != 6 {
		t.Fatal("read modified placements")
	}
	createAgentFolder(t, fx, "cleanup", "")
	if fx.Count(t, "SELECT count(*) FROM labrastro_agent_placement WHERE workspace_id=$1", fx.WorkspaceID) != 4 || fx.Count(t, "SELECT count(*) FROM labrastro_agent_squad_placement WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
		t.Fatal("dangling rows were not cleaned")
	}
	fx.Exec(t, "DELETE FROM labrastro_agent_folder WHERE id=$1", folder)
	if len(readAgentFolders(t, fx, testUserID).Placements) != 0 {
		t.Fatal("missing folder placement is visible")
	}
	createAgentFolder(t, fx, "cleanup missing folder", "")
	if fx.Count(t, "SELECT count(*) FROM labrastro_agent_placement WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
		t.Fatal("missing folder placements were not cleaned")
	}
}

func TestLabrastroAgentFoldersCRUDAndCycles(t *testing.T) {
	fx := agentFolderFixture(t)
	root := createAgentFolder(t, fx, "root", "")
	child := createAgentFolder(t, fx, "child", root)
	grandchild := createAgentFolder(t, fx, "leaf", child)
	for _, parent := range []string{root, child, grandchild} {
		wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+root, map[string]string{"parent_id": parent}), 409, "folder_cycle")
	}
	wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": "root"}), 409, "name_conflict")
	wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": "child", "parent_id": root}), 409, "name_conflict")
	peer := createAgentFolder(t, fx, "peer", root)
	wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+peer, map[string]string{"name": "child"}), 409, "name_conflict")
	var result db.LabrastroAgentFolder
	agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+child, map[string]string{"name": "renamed"}).Want(200).JSON(&result)
	if result.Name != "renamed" || uuidToString(result.ParentID) != root {
		t.Fatalf("rename: %+v", result)
	}
	agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+child, map[string]string{"parent_id": ""}).Want(200).JSON(&result)
	if result.Name != "renamed" || result.ParentID.Valid {
		t.Fatalf("move to root: %+v", result)
	}
	other := agentFolderFixture(t)
	foreignFolder := createAgentFolder(t, other, "foreign", "")
	for _, id := range []string{uuid.NewString(), foreignFolder} {
		agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+id, map[string]string{"name": "no"}).Want(404)
		agentFolderCall(t, fx, testUserID, "DELETE", "/api/agent-folders/"+id, nil).Want(404)
		agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": "no", "parent_id": id}).Want(404)
		agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+root, map[string]string{"parent_id": id}).Want(404)
	}
}

func TestLabrastroAgentFolderNamesAndRequestValidation(t *testing.T) {
	fx := agentFolderFixture(t)
	for _, name := range []string{"", " leading", "trailing\u3000", "new\nline", "new\rline", "tab\there", "control\x7f", "control\u0085", "line\u2028break", "line\u2029break", strings.Repeat("a", 256), strings.Repeat("界", 86)} {
		wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": name}), 400, "invalid_name")
	}
	createAgentFolder(t, fx, strings.Repeat("界", 85), "")
	createAgentFolder(t, fx, strings.Repeat("a", 255), "")
	valid := createAgentFolder(t, fx, "valid", "")
	for _, body := range []any{map[string]any{"name": nil}, map[string]any{"parent_id": nil}} {
		wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+valid, body), 400, "invalid_request")
	}
	agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": "valid", "parent_id": "invalid"}).Want(400)
	agentFolderCall(t, fx, testUserID, "POST", "/api/agent-folders", map[string]string{"name": "valid", "unknown": "field"}).Want(400)
	for _, path := range []string{"/api/agent-placements/", "/api/agent-squad-placements/"} {
		for _, body := range []any{nil, map[string]any{}, map[string]any{"folder_id": nil}, map[string]any{"folder_id": 42}} {
			agentFolderCall(t, fx, testUserID, "PUT", path+uuid.NewString(), body).Want(400)
		}
	}
}

func TestLabrastroAgentPlacementRejectsSystemAgents(t *testing.T) {
	fx := agentFolderFixture(t)
	folder := createAgentFolder(t, fx, "folder", "")
	system := fx.Agent(t, "system carrier", "", testutil.Cols{"kind": "system"})
	// System agents are execution carriers, not tree citizens: the placement
	// endpoint 404s like GetAgentInWorkspace and writes nothing.
	wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-placements/"+system, map[string]string{"folder_id": folder}), 404, "not_found")
	if fx.Count(t, "SELECT count(*) FROM labrastro_agent_placement WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
		t.Fatal("system agent placement was written")
	}
	// A pre-existing placement for a system agent is dangling and is pruned by
	// the next successful tree mutation.
	fx.Exec(t, "INSERT INTO labrastro_agent_placement(workspace_id,agent_id,folder_id) VALUES ($1,$2,$3)", fx.WorkspaceID, system, folder)
	createAgentFolder(t, fx, "cleanup", "")
	if fx.Count(t, "SELECT count(*) FROM labrastro_agent_placement WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
		t.Fatal("system agent placement was not cleaned")
	}
}

func TestLabrastroAgentFolderDeletePromotesAtomically(t *testing.T) {
	for _, rootDestination := range []bool{true, false} {
		t.Run(map[bool]string{true: "root", false: "parent"}[rootDestination], func(t *testing.T) {
			fx := agentFolderFixture(t)
			parent := ""
			if !rootDestination {
				parent = createAgentFolder(t, fx, "parent", "")
			}
			folder := createAgentFolder(t, fx, "folder", parent)
			child := createAgentFolder(t, fx, "conflict", folder)
			conflict := createAgentFolder(t, fx, "conflict", parent)
			agent := fx.Agent(t, "placed", "")
			squad := fx.Squad(t, "squad", agent)
			agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-placements/"+agent, map[string]string{"folder_id": folder}).Want(200)
			agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-squad-placements/"+squad, map[string]string{"folder_id": folder}).Want(200)
			before := readAgentFolders(t, fx, testUserID)
			wantAgentFolderError(t, agentFolderCall(t, fx, testUserID, "DELETE", "/api/agent-folders/"+folder, nil), 409, "name_conflict")
			if after := readAgentFolders(t, fx, testUserID); !reflect.DeepEqual(before, after) {
				t.Fatalf("conflict mutated tree: before=%+v after=%+v", before, after)
			}
			agentFolderCall(t, fx, testUserID, "DELETE", "/api/agent-folders/"+conflict, nil).Want(200)
			// A child may take the deleted folder's own name.
			agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+child, map[string]string{"name": "folder"}).Want(200)
			agentFolderCall(t, fx, testUserID, "DELETE", "/api/agent-folders/"+folder, nil).Want(200)
			tree := readAgentFolders(t, fx, testUserID)
			for _, f := range tree.Folders {
				if uuidToString(f.ID) == child && uuidToString(f.ParentID) != parent {
					t.Fatalf("child not promoted: %+v", f)
				}
			}
			if uuidToString(tree.Squads[0].ParentID) != parent {
				t.Fatalf("squad not promoted: %+v", tree.Squads)
			}
			if rootDestination {
				if len(tree.Placements) != 0 || fx.Count(t, "SELECT count(*) FROM labrastro_agent_squad_placement WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
					t.Fatal("root placements not removed")
				}
			} else if len(tree.Placements) != 1 || uuidToString(tree.Placements[0].FolderID) != parent {
				t.Fatalf("agent not promoted: %+v", tree.Placements)
			}
			if fx.Count(t, "SELECT count(*) FROM agent WHERE id=$1", agent) != 1 || fx.Count(t, "SELECT count(*) FROM squad WHERE id=$1", squad) != 1 {
				t.Fatal("folder deletion deleted an entity")
			}
		})
	}
}

func TestLabrastroAgentPlacementSquadMembersCanBePlaced(t *testing.T) {
	fx := agentFolderFixture(t)
	folder := createAgentFolder(t, fx, "custom position", "")
	agent := fx.Agent(t, "agent", "")
	path := "/api/agent-placements/" + agent
	squads := []string{fx.Squad(t, "first", agent), fx.Squad(t, "second", agent)}
	for _, squad := range squads {
		fx.SquadMember(t, squad, "agent", agent)
	}
	agentFolderCall(t, fx, testUserID, "PUT", path, map[string]string{"folder_id": folder}).Want(200)
	tree := readAgentFolders(t, fx, testUserID)
	if len(tree.Placements) != 1 || uuidToString(tree.Placements[0].FolderID) != folder || len(tree.Squads) != 2 {
		t.Fatalf("dual placement: %+v", tree)
	}
	for _, squad := range tree.Squads {
		if !reflect.DeepEqual(squad.AgentIDs, []string{agent}) {
			t.Fatalf("multi-squad membership: %+v", tree.Squads)
		}
	}
	// Returning to root clears only the custom placement; squad membership stays.
	agentFolderCall(t, fx, testUserID, "PUT", path, map[string]string{"folder_id": ""}).Want(200)
	tree = readAgentFolders(t, fx, testUserID)
	if len(tree.Placements) != 0 || fx.Count(t, "SELECT count(*) FROM squad_member WHERE member_type='agent' AND member_id=$1", agent) != 2 {
		t.Fatal("moving the agent changed squad membership")
	}
	agentFolderCall(t, fx, testUserID, "PUT", path, map[string]string{"folder_id": folder}).Want(200)
	fx.Exec(t, "DELETE FROM squad_member WHERE squad_id=$1", squads[0])
	fx.Exec(t, "UPDATE squad SET archived_at=now() WHERE id=$1", squads[1])
	tree = readAgentFolders(t, fx, testUserID)
	if len(tree.Placements) != 1 || uuidToString(tree.Placements[0].FolderID) != folder {
		t.Fatal("leaving squads changed custom position")
	}
}

func TestLabrastroAgentFolderPlacementPermissionsAndWorkspaceScope(t *testing.T) {
	fx := agentFolderFixture(t)
	member := fx.User(t, "member", uuid.NewString()+"@example.com")
	fx.Member(t, fx.WorkspaceID, member, "member")
	folder := createAgentFolder(t, fx, "folder", "")
	owned := fx.Agent(t, "member owned", "", testutil.Cols{"owner_id": member})
	otherAgent := fx.Agent(t, "other", "")
	ownedSquad := fx.Squad(t, "owned squad", owned, testutil.Cols{"creator_id": member})
	otherSquad := fx.Squad(t, "other squad", otherAgent)
	archivedSquad := fx.Squad(t, "archived", otherAgent, testutil.Cols{"archived_at": testutil.Raw("now()")})
	foreign := agentFolderFixture(t)
	foreignFolder := createAgentFolder(t, foreign, "foreign", "")
	foreignAgent := foreign.Agent(t, "foreign", "")
	foreignSquad := foreign.Squad(t, "foreign", foreignAgent)
	for _, tc := range []struct{ prefix, owned, forbidden, foreign string }{
		{"/api/agent-placements/", owned, otherAgent, foreignAgent},
		{"/api/agent-squad-placements/", ownedSquad, otherSquad, foreignSquad},
	} {
		for _, destination := range []string{folder, ""} {
			agentFolderCall(t, fx, member, "PUT", tc.prefix+tc.owned, map[string]string{"folder_id": destination}).Want(200)
			wantAgentFolderError(t, agentFolderCall(t, fx, member, "PUT", tc.prefix+tc.forbidden, map[string]string{"folder_id": destination}), 403, "forbidden")
			agentFolderCall(t, fx, testUserID, "PUT", tc.prefix+tc.owned, map[string]string{"folder_id": destination}).Want(200)
		}
		for _, id := range []string{uuid.NewString(), tc.foreign} {
			agentFolderCall(t, fx, testUserID, "PUT", tc.prefix+id, map[string]string{"folder_id": folder}).Want(404)
		}
		for _, target := range []string{uuid.NewString(), foreignFolder, ownedSquad} {
			agentFolderCall(t, fx, member, "PUT", tc.prefix+tc.owned, map[string]string{"folder_id": target}).Want(404)
		}
	}
	agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-squad-placements/"+archivedSquad, map[string]string{"folder_id": folder}).Want(404)
	// Ordinary members share folder management, regardless of who made the folder.
	agentFolderCall(t, fx, member, "POST", "/api/agent-folders", map[string]string{"name": "member folder"}).Want(201)
	agentFolderCall(t, fx, member, "PATCH", "/api/agent-folders/"+folder, map[string]string{"name": "renamed"}).Want(200)
	agentFolderCall(t, fx, member, "DELETE", "/api/agent-folders/"+folder, nil).Want(200)
	fx.Exec(t, "DELETE FROM member WHERE workspace_id=$1 AND user_id=$2", fx.WorkspaceID, member)
	agentFolderCall(t, fx, member, "GET", "/api/agent-folders", nil).Want(404)
}

func TestLabrastroAgentFolderConcurrentMovesCannotCycle(t *testing.T) {
	fx := agentFolderFixture(t)
	first := createAgentFolder(t, fx, "first", "")
	second := createAgentFolder(t, fx, "second", "")
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, move := range [][2]string{{first, second}, {second, first}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := agentFolderCall(t, fx, testUserID, "PATCH", "/api/agent-folders/"+move[0], map[string]string{"parent_id": move[1]})
			statuses <- response.Code
		}()
	}
	wg.Wait()
	close(statuses)
	codes := []int{}
	for status := range statuses {
		codes = append(codes, status)
	}
	slices.Sort(codes)
	if !reflect.DeepEqual(codes, []int{http.StatusOK, http.StatusConflict}) {
		t.Fatalf("concurrent moves: %v", codes)
	}
}

func TestLabrastroAgentFolderWorkspaceDeletion(t *testing.T) {
	fx := agentFolderFixture(t)
	folder := createAgentFolder(t, fx, "folder", "")
	agent := fx.Agent(t, "agent", "")
	squad := fx.Squad(t, "squad", agent)
	agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-placements/"+agent, map[string]string{"folder_id": folder}).Want(200)
	agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-squad-placements/"+squad, map[string]string{"folder_id": folder}).Want(200)
	labrastroCall(t, fx, testUserID, testHandler.DeleteWorkspace, "DELETE", nil, "id", fx.WorkspaceID).Want(204)
	for _, table := range []string{"labrastro_agent_folder", "labrastro_agent_placement", "labrastro_agent_squad_placement"} {
		if fx.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", fx.WorkspaceID) != 0 {
			t.Fatalf("workspace deletion left %s", table)
		}
	}
}

func TestLabrastroAgentFolderWireShape(t *testing.T) {
	fx := agentFolderFixture(t)
	folder := createAgentFolder(t, fx, "folder", "")
	agent := fx.Agent(t, "agent", "")
	squad := fx.Squad(t, "squad", agent)
	fx.SquadMember(t, squad, "agent", agent)
	agentFolderCall(t, fx, testUserID, "PUT", "/api/agent-squad-placements/"+squad, map[string]string{"folder_id": folder}).Want(200)
	var body map[string]json.RawMessage
	agentFolderCall(t, fx, testUserID, "GET", "/api/agent-folders", nil).Want(200).JSON(&body)
	var squads []map[string]any
	if err := json.Unmarshal(body["squads"], &squads); err != nil {
		t.Fatal(err)
	}
	if len(squads) != 1 || squads[0]["avatar_url"] != nil || squads[0]["parent_id"] != folder || squads[0]["creator_id"] != testUserID {
		t.Fatalf("wire shape: %s", body["squads"])
	}
}
