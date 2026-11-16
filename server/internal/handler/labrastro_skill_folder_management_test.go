package handler

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

func TestLabrastroDeleteFolderPromotesSameNameAtomically(t *testing.T) {
	for _, nested := range []bool{false, true} {
		for _, collision := range []bool{false, true} {
			t.Run(fmt.Sprintf("nested=%v/collision=%v", nested, collision), func(t *testing.T) {
				fx := labrastroPackageDBFixture(t)
				var parent any
				if nested {
					parent = fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Parent"})
				}
				folder := fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Review", "parent_id": parent})
				child := fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Review", "parent_id": folder})
				grandchild := fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Grandchild", "parent_id": child})
				skill := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "keep", "content": "keep", "created_by": testUserID})
				fx.InsertNoID(t, "labrastro_skill_placement", testutil.Cols{"workspace_id": fx.WorkspaceID, "skill_id": skill, "folder_id": folder}, "workspace_id=$1 AND skill_id=$2", fx.WorkspaceID, skill)
				if collision {
					fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Busy", "parent_id": parent})
					fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Busy", "parent_id": folder})
				}
				h := *testHandler
				h.Bus = events.New()
				broadcasts := 0
				h.Bus.Subscribe(protocol.EventSkillUpdated, func(events.Event) { broadcasts++ })
				before, immutable := migrationRows(t, fx, true), migrationRows(t, fx, false)
				status := 200
				if collision {
					status = 409
				}
				labrastroCall(t, fx, testUserID, h.LabrastroDeleteFolder, "DELETE", nil, "folderId", folder).Want(status)
				if immutable != migrationRows(t, fx, false) {
					t.Fatal("folder deletion changed skills or bindings")
				}
				if collision {
					if broadcasts != 0 || before != migrationRows(t, fx, true) {
						t.Fatal("name collision left partial changes or published an event")
					}
					return
				}
				if broadcasts != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE id=$1", folder) != 0 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND name='Review'", child, parent) != 1 || fx.Count(t, "SELECT count(*) FROM labrastro_skill_folder WHERE id=$1 AND parent_id=$2", grandchild, child) != 1 {
					t.Fatal("same-named child did not take its parent's place")
				}
				if nested {
					if fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1 AND folder_id=$2", skill, parent) != 1 {
						t.Fatal("skill not promoted to parent")
					}
				} else if fx.Count(t, "SELECT count(*) FROM labrastro_skill_placement WHERE skill_id=$1", skill) != 0 {
					t.Fatal("root folder deletion did not unclassify skill")
				}
			})
		}
	}
}

func TestLabrastroSkillOrganizationEventsOnlyAfterCommit(t *testing.T) {
	for _, action := range []string{"create", "update", "delete-folder", "move", "detach", "dissolve", "delete-empty-package", "delete-package"} {
		for _, failCommit := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/rollback=%v", action, failCommit), func(t *testing.T) {
				fx := labrastroPackageDBFixture(t)
				h := *testHandler
				h.Bus = events.New()
				folder := fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Custom"})
				skill := fx.Insert(t, "skill", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "alpha", "content": "keep", "created_by": testUserID})
				var handler http.HandlerFunc
				method, status := "POST", 200
				var body any
				var params []string
				switch action {
				case "create":
					handler, body, status = h.LabrastroCreateFolder, map[string]string{"name": "New"}, 201
				case "update":
					handler, method, body, params = h.LabrastroUpdateFolder, "PATCH", map[string]string{"name": "Renamed"}, []string{"folderId", folder}
				case "delete-folder":
					handler, method, params = h.LabrastroDeleteFolder, "DELETE", []string{"folderId", folder}
				case "move":
					handler, method, body, params = h.LabrastroMoveSkill, "PUT", map[string]string{"folder_id": folder}, []string{"skillId", skill}
				default:
					pkg := uuid.NewString()
					root := fx.Insert(t, "labrastro_skill_folder", testutil.Cols{"workspace_id": fx.WorkspaceID, "name": "Package", "package_id": pkg, "package_path": ""})
					fx.Insert(t, "labrastro_skill_package", testutil.Cols{"id": pkg, "workspace_id": fx.WorkspaceID, "owner_repo": "example/skills", "source_url": "https://github.com/example/skills/tree/main", "source_ref": "main", "root_folder_id": root, "created_by": testUserID})
					if action != "delete-empty-package" {
						fx.InsertNoID(t, "labrastro_skill_placement", testutil.Cols{"workspace_id": fx.WorkspaceID, "skill_id": skill, "folder_id": root, "package_id": pkg, "source_path": "alpha"}, "workspace_id=$1 AND skill_id=$2", fx.WorkspaceID, skill)
					}
					if action == "detach" {
						handler, params = h.LabrastroDetachSkill, []string{"skillId", skill}
					} else {
						var preview map[string]any
						labrastroCall(t, fx, testUserID, h.LabrastroPackageDeletePreview, "GET", nil, "packageId", pkg).Want(200).JSON(&preview)
						body, params = map[string]any{"preview_id": preview["preview_id"]}, []string{"packageId", pkg}
						handler = h.LabrastroDissolvePackage
						if action != "dissolve" {
							handler, method = h.LabrastroDeletePackage, "DELETE"
						}
					}
				}
				before, immutable := migrationRows(t, fx, true), migrationRows(t, fx, false)
				broadcasts, deleted := 0, 0
				h.Bus.Subscribe(protocol.EventSkillUpdated, func(e events.Event) {
					broadcasts++
					if e.WorkspaceID != fx.WorkspaceID || e.ActorType != "member" || e.ActorID != testUserID || e.Payload.(map[string]any)["folder_tree_updated"] != true {
						t.Errorf("wrong event: %+v", e)
					}
					if migrationRows(t, fx, true) == before {
						t.Error("event published before durable tree change")
					}
				})
				h.Bus.Subscribe(protocol.EventSkillDeleted, func(e events.Event) {
					deleted++
					if e.WorkspaceID != fx.WorkspaceID || e.Payload.(map[string]any)["skill_id"] != skill {
						t.Errorf("wrong delete event: %+v", e)
					}
				})
				if failCommit {
					h.TxStarter, status = rollbackOnCommitTxStarter{pool: testPool}, 500
				}
				labrastroCall(t, fx, testUserID, handler, method, body, params...).Want(status)
				if failCommit {
					if broadcasts != 0 || deleted != 0 || before != migrationRows(t, fx, true) || immutable != migrationRows(t, fx, false) {
						t.Fatal("rollback changed data or published event")
					}
				} else if action == "delete-package" {
					if broadcasts != 0 || deleted != 1 {
						t.Fatalf("nonempty delete events: updated=%d deleted=%d", broadcasts, deleted)
					}
				} else {
					if broadcasts != 1 || deleted != 0 || immutable != migrationRows(t, fx, false) {
						t.Fatalf("tree-only events/data: updated=%d deleted=%d", broadcasts, deleted)
					}
				}
			})
		}
	}
}
