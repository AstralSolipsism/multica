package branding

import (
	"encoding/json"
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

func brandCheck(t *testing.T) func(string) bool {
	t.Helper()
	data, err := os.ReadFile("../../../scripts/branding-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var policy struct {
		AllowedTokens []exception `json:"allowedTokens"`
	}
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatal(err)
	}
	for _, entry := range policy.AllowedTokens {
		if entry.Value == "" || strings.TrimSpace(entry.Reason) == "" {
			t.Fatalf("every brand exception needs a value and reason: %+v", entry)
		}
	}
	retired := regexp.MustCompile(`\b(Multica|Mika)\b`)
	return func(text string) bool {
		for _, entry := range policy.AllowedTokens {
			text = strings.ReplaceAll(text, entry.Value, "")
		}
		return retired.MatchString(text)
	}
}

// Parse literals rather than grep source: exported symbols, comments and stable
// lowercase CLI/env/package/protocol identifiers are not product display copy.
// This covers handler errors, CLI output, channel messages and generated prompts.
func TestServerBranding(t *testing.T) {
	hasRetiredBrand := brandCheck(t)
	err := filepath.WalkDir("../..", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			// Generated SQL and historical migrations are storage contracts, not
			// display copy; their embedded SQL comments may describe upstream.
			if path == "../../pkg/db" || path == "../../migrations" || entry.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		positions := token.NewFileSet()
		file, err := parser.ParseFile(positions, path, nil, 0)
		if err != nil {
			return err
		}
		ast.Inspect(file, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			text, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			if hasRetiredBrand(text) {
				t.Errorf("%s: retired product branding in %q", positions.Position(literal.Pos()), text)
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// Embedded instructions are shipped to agents as text, not Go literals.
	for _, directory := range []string{"builtin_agents", "builtin_skills", "builtin_skills_legacy"} {
		err := filepath.WalkDir(filepath.Join("../service", directory), func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			body, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if hasRetiredBrand(string(body)) {
				t.Errorf("%s: retired product branding in embedded instructions", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestBrandGuardRejectsRegressions(t *testing.T) {
	hasRetiredBrand := brandCheck(t)
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
