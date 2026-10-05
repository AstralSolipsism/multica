package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/handler"
)

// Use the production decode types, not copies of their fields. Every allowed
// non-GET route must be classified, including DELETE bodies and bodyless writes.
func TestExternalConversationRequestInventory(t *testing.T) {
	requests := map[string]any{
		"POST /api/issues":                                handler.CreateIssueRequest{},
		"POST /api/issues/with-dependencies":              handler.CreateIssueRequest{},
		"PUT /api/issues/{id}":                            handler.UpdateIssueRequest{},
		"PATCH /api/issues/{id}/with-dependencies":        handler.UpdateIssueRequest{},
		"POST /api/issues/query":                          map[string]string{},
		"POST /api/issues/{id}/comments":                  handler.CreateCommentRequest{},
		"PUT /api/comments/{commentId}":                   handler.UpdateCommentRequest{},
		"DELETE /api/comments/{commentId}":                nil,
		"DELETE /api/comments/{commentId}/keep-replies":   nil,
		"POST /api/comments/{commentId}/resolve":          nil,
		"DELETE /api/comments/{commentId}/resolve":        nil,
		"POST /api/comments/{commentId}/reactions":        handler.ReactionRequest{},
		"DELETE /api/comments/{commentId}/reactions":      handler.ReactionRequest{},
		"POST /api/issues/{id}/reactions":                 handler.ReactionRequest{},
		"DELETE /api/issues/{id}/reactions":               handler.ReactionRequest{},
		"POST /api/issues/{id}/labels":                    handler.AttachLabelRequest{},
		"DELETE /api/issues/{id}/labels/{labelId}":        nil,
		"PUT /api/issues/{id}/metadata/{key}":             handler.SetIssueMetadataKeyRequest{},
		"DELETE /api/issues/{id}/metadata/{key}":          nil,
		"PUT /api/issues/{id}/properties/{propertyId}":    handler.SetIssuePropertyRequest{},
		"DELETE /api/issues/{id}/properties/{propertyId}": nil,
		"DELETE /api/attachments/{id}":                    nil,
	}
	var catalog strings.Builder
	for _, route := range externalRouteInventory(t) {
		if route.decision != "allow" || route.method == "GET" {
			continue
		}
		key := route.method + " " + strings.TrimSuffix(route.pattern, "/")
		if key == "POST /api/upload-file" {
			fmt.Fprintf(&catalog, "%s\tmultipart\t%s\n", key, strings.Join(externalUploadFields(t), ","))
			continue
		}
		request, ok := requests[key]
		if !ok {
			t.Fatalf("allowed route %s has no reviewed request classification", key)
		}
		delete(requests, key)
		kind, fields := "no-body", "-"
		if request != nil {
			typ := reflect.TypeOf(request)
			kind = typ.String()
			fields = strings.Join(externalRequestFields(typ, ""), ",")
		}
		fmt.Fprintf(&catalog, "%s\t%s\t%s\n", key, kind, fields)
	}
	if len(requests) != 0 {
		t.Fatalf("request inventory contains routes that are no longer allowed: %v", requests)
	}
	const path = "testdata/labrastro-external-requests.tsv"
	if os.Getenv("LABRASTRO_UPDATE_REQUEST_INVENTORY") == "1" {
		if err := os.WriteFile(path, []byte(catalog.String()), 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != catalog.String() {
		t.Fatalf("external-conversation request fields changed; review their authorization and side effects before regenerating %s with LABRASTRO_UPDATE_REQUEST_INVENTORY=1\nactual:\n%s", path, catalog.String())
	}
}

// Include promoted and nested JSON fields, types and tag options. RawMessage
// and maps remain explicit open shapes; their validation still needs review.
func externalRequestFields(typ reflect.Type, prefix string) []string {
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	if typ.Kind() != reflect.Struct {
		return []string{prefix + "*=" + typ.String()}
	}
	var fields []string
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		tag := field.Tag.Get("json")
		name, _, _ := strings.Cut(tag, ",")
		if name == "-" || (!field.IsExported() && !field.Anonymous) {
			continue
		}
		if field.Anonymous && name == "" {
			fields = append(fields, externalRequestFields(field.Type, prefix)...)
			continue
		}
		if name == "" {
			name = field.Name
		}
		path := prefix + name
		fields = append(fields, path+"="+field.Type.String()+"["+tag+"]")
		child := field.Type
		for child.Kind() == reflect.Pointer || child.Kind() == reflect.Slice || child.Kind() == reflect.Array || child.Kind() == reflect.Map {
			child = child.Elem()
		}
		if child.Kind() == reflect.Struct {
			fields = append(fields, externalRequestFields(child, path+".")...)
		}
	}
	slices.Sort(fields)
	return fields
}

// Multipart has no request struct. Read its literal field accesses from the
// production handler so adding a form field fails the same review gate.
func externalUploadFields(t *testing.T) []string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "../../internal/handler/file.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var fields []string
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Name.Name != "UploadFile" {
			continue
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || (selector.Sel.Name != "FormValue" && selector.Sel.Name != "FormFile") {
				return true
			}
			if len(call.Args) != 1 {
				t.Fatal("review UploadFile's new form access")
			}
			literal, ok := call.Args[0].(*ast.BasicLit)
			if !ok {
				t.Fatal("review UploadFile's nonliteral form field")
			}
			name, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			fields = append(fields, name+"="+selector.Sel.Name)
			return true
		})
	}
	if len(fields) == 0 {
		t.Fatal("UploadFile form fields not found")
	}
	slices.Sort(fields)
	return fields
}
