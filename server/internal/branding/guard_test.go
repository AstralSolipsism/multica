package branding

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

type exception struct {
	Value  string `json:"value"`
	Reason string `json:"reason"`
}

func brandCheck() (func(string) bool, error) {
	data, err := os.ReadFile("../../../scripts/branding-policy.json")
	if err != nil {
		return nil, err
	}
	var policy struct {
		AllowedTokens []exception `json:"allowedTokens"`
	}
	if err := json.Unmarshal(data, &policy); err != nil {
		return nil, err
	}
	for _, entry := range policy.AllowedTokens {
		if entry.Value == "" || strings.TrimSpace(entry.Reason) == "" {
			return nil, fmt.Errorf("every brand exception needs a value and reason: %+v", entry)
		}
	}
	retired := regexp.MustCompile(`\b(Multica|Mika)\b`)
	return func(text string) bool {
		for _, entry := range policy.AllowedTokens {
			text = strings.ReplaceAll(text, entry.Value, "")
		}
		return retired.MatchString(text)
	}, nil
}

// Parse literals rather than grep source: exported symbols, comments and stable
// lowercase CLI/env/package/protocol identifiers are not product display copy.
// This covers handler errors, CLI output, channel messages and generated prompts.
func scanGoSource(path string, hasRetiredBrand func(string) bool) ([]string, error) {
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, path, nil, 0)
	if err != nil {
		return nil, err
	}
	var violations []string
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		text, unquoteErr := strconv.Unquote(literal.Value)
		if unquoteErr != nil {
			err = unquoteErr
			return false
		}
		if hasRetiredBrand(text) {
			violations = append(violations, fmt.Sprintf("%s: retired product branding in %q", positions.Position(literal.Pos()), text))
		}
		return true
	})
	return violations, err
}

func isEmbeddedInstruction(name string) bool {
	for _, directory := range []string{"builtin_agents", "builtin_skills", "builtin_skills_legacy"} {
		if strings.HasPrefix(name, "internal/service/"+directory+"/") {
			return true
		}
	}
	return false
}

func scanServer(root string) ([]string, error) {
	hasRetiredBrand, err := brandCheck()
	if err != nil {
		return nil, err
	}
	var violations []string
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name = filepath.ToSlash(name)
		if entry.IsDir() {
			// Generated SQL and historical migrations are storage contracts, not
			// display copy; their embedded SQL comments may describe upstream.
			if name == "pkg/db" || name == "migrations" || (entry.Name() == "testdata" && !isEmbeddedInstruction(name)) {
				return filepath.SkipDir
			}
			return nil
		}
		// Embedded instructions are shipped to agents as text, not Go literals.
		if isEmbeddedInstruction(name) {
			body, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if hasRetiredBrand(string(body)) {
				violations = append(violations, fmt.Sprintf("%s: retired product branding in embedded instructions", path))
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			found, err := scanGoSource(path, hasRetiredBrand)
			violations = append(violations, found...)
			return err
		}
		return nil
	})
	return violations, err
}

func TestServerBranding(t *testing.T) {
	violations, err := scanServer("../..")
	if err != nil {
		t.Fatal(err)
	}
	for _, violation := range violations {
		t.Error(violation)
	}
}

func TestBrandGuardRejectsRegressions(t *testing.T) {
	hasRetiredBrand, err := brandCheck()
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"Start with Mika", "Mika와 시작", "Multicaへようこそ", "X-Multica-Signature: use Multica"} {
		if !hasRetiredBrand(text) {
			t.Errorf("guard accepted regression %q", text)
		}
	}
	for _, text := range []string{"multica setup", "MULTICA_APP_URL", "@multica/core", "multica://", "https://github.com/multica-ai/multica", "X-Multica-Signature"} {
		if hasRetiredBrand(text) {
			t.Errorf("guard rejected compatible identifier %q", text)
		}
	}
}

func writeFixture(t *testing.T, root, name, content string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestScanServerTraversesProductionSourcesAndEmbeddedInstructions(t *testing.T) {
	root := t.TempDir()
	files := map[string]string{
		"internal/handler/errors.go":                               "package handler\nconst message = \"Start with Mika\"",
		"internal/cli/setup.go":                                    "package cli\nconst message = \"Welcome to Multica\"",
		"cmd/multica/root.go":                                      "package main\nconst message = \"Mikaへようこそ\"",
		"pkg/integrations/reply.go":                                "package integrations\nconst message = \"X-Multica-Signature: use Multica\"",
		"internal/service/builtin_agents/mika/prompt.md":           "Start with Mika",
		"internal/service/builtin_skills/setup/SKILL.md":           "Configure Multica",
		"internal/service/builtin_skills/setup/testdata/prompt.md": "Start with Mika",
		"internal/service/builtin_skills_legacy/intro.txt":         "Meet Mika",
	}
	for name, content := range files {
		writeFixture(t, root, name, content)
	}
	for _, name := range []string{"pkg/db/generated/queries.go", "migrations/schema.go", "internal/handler/testdata/fixture.go", "internal/handler/errors_test.go"} {
		writeFixture(t, root, name, "package fixture\nconst message = \"Start with Mika\"")
	}
	writeFixture(t, root, "internal/service/identity.go", "package service\n// Mika\nconst MikaDefaultName = \"Mizuki\"\nconst header = \"X-Multica-Signature\"")
	writeFixture(t, root, "README.md", "Multica")

	violations, err := scanServer(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) != len(files) {
		t.Fatalf("got %d violations, want %d: %v", len(violations), len(files), violations)
	}
	for name, content := range files {
		if !strings.Contains(strings.Join(violations, "\n"), filepath.Join(root, name)+":") {
			t.Errorf("missing violation in %s: %v", name, violations)
		}
		writeFixture(t, root, name, strings.ReplaceAll(strings.ReplaceAll(content, "Mika", "Mizuki"), "Multica", "Labrastro"))
	}
	if violations, err := scanServer(root); err != nil || len(violations) != 0 {
		t.Fatalf("corrected fixture must pass with exemptions preserved: %v, %v", violations, err)
	}
}

func TestScanServerFailsClosedOnTraversalAndParseErrors(t *testing.T) {
	root := t.TempDir()
	if _, err := scanServer(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing source root must fail")
	}
	writeFixture(t, root, "internal/handler/invalid.go", "package handler\nconst message = \"unterminated")
	if _, err := scanServer(root); err == nil {
		t.Fatal("unparseable production source must fail")
	}
}
