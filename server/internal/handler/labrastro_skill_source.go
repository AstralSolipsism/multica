package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"

	skillpkg "github.com/multica-ai/multica/server/internal/skill"
	"golang.org/x/sync/errgroup"
)

const labrastroMaxCandidates = 1024
const labrastroSourceCacheBytes = 8 << 20

// One request owns one source context. Trees are shared, downloads are bounded,
// and the cache has a byte budget rather than retaining every candidate bundle.
type labrastroSkillSource struct {
	spec                        githubSpec
	URL                         string
	commit, rootTree, rawPrefix string
	client                      *http.Client
	entries                     map[string]githubTreeEntry
	directories                 map[string]map[string]githubTreeEntry
	fullTree                    bool
	treeRequests                int
	mu                          sync.Mutex
	cache                       map[string][]byte
	cacheBytes                  int
	semaphore                   chan struct{}
}

func labrastroReadGitHubJSON(ctx context.Context, client *http.Client, endpoint string, out any) error {
	resp, err := doGitHubAPIGet(ctx, client, endpoint)
	if err != nil {
		return fmt.Errorf("%w: %v", errImportSourceUnavailable, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: GitHub returned HTTP %d", errImportSourceUnavailable, resp.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 32<<20)).Decode(out); err != nil {
		return fmt.Errorf("%w: invalid GitHub response: %v", errImportSourceUnavailable, err)
	}
	return nil
}

func newLabrastroSkillSource(ctx context.Context, client *http.Client, raw string) (*labrastroSkillSource, error) {
	normalized := strings.TrimSpace(raw)
	if !strings.Contains(normalized, "://") {
		normalized = "https://" + normalized
	}
	u, err := url.Parse(normalized)
	if err != nil {
		return nil, labrastroSkillError(400, "invalid_source", "invalid repository URL")
	}
	if u.Scheme != "https" || u.User != nil || u.Port() != "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, labrastroSkillError(400, "invalid_source", "expected an HTTPS repository or tree URL without credentials, query or fragment")
	}
	if strings.EqualFold(u.Hostname(), "skills.sh") || strings.EqualFold(u.Hostname(), "www.skills.sh") {
		parts := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(parts) != 2 {
			return nil, labrastroSkillError(400, "invalid_source", "skill packages require skills.sh/owner/repo")
		}
		normalized = "https://github.com/" + strings.Join(parts, "/")
	} else if !strings.EqualFold(u.Hostname(), "github.com") && !strings.EqualFold(u.Hostname(), "www.github.com") {
		return nil, labrastroSkillError(400, "invalid_source", "skill packages support GitHub and skills.sh repositories")
	}
	spec, err := parseGitHubURL(normalized)
	if err != nil {
		return nil, labrastroSkillError(400, "invalid_source", err.Error())
	}
	if strings.Contains(u.Path, "/blob/") {
		return nil, labrastroSkillError(400, "invalid_source", "use a repository or tree directory URL")
	}
	if err := resolveGitHubRefAndPath(ctx, client, &spec); err != nil {
		return nil, err
	}
	if spec.ref == "" {
		spec.ref = fetchGitHubDefaultBranch(ctx, client, spec.owner, spec.repo)
	}
	spec.owner = strings.ToLower(spec.owner)
	spec.repo = strings.ToLower(spec.repo)
	if spec.skillDir != "" && !labrastroSafeRepoPath(spec.skillDir) {
		return nil, labrastroSkillError(400, "invalid_source", "invalid repository subdirectory")
	}
	var commit struct {
		SHA    string `json:"sha"`
		Commit struct {
			Tree struct {
				SHA string `json:"sha"`
			} `json:"tree"`
		} `json:"commit"`
	}
	base := fmt.Sprintf("https://api.github.com/repos/%s/%s", url.PathEscape(spec.owner), url.PathEscape(spec.repo))
	if err := labrastroReadGitHubJSON(ctx, client, base+"/commits/"+escapeRefPath(spec.ref), &commit); err != nil {
		return nil, err
	}
	if len(commit.SHA) != 40 || len(commit.Commit.Tree.SHA) != 40 {
		return nil, fmt.Errorf("%w: source commit/tree identity is missing", errImportSourceUnavailable)
	}
	// Persist the resolved ref, not a bare repository URL whose default branch
	// may change between rescans. The commit remains request-local only.
	normalized = buildRawGitHubURL("https://github.com/"+spec.owner+"/"+spec.repo+"/tree/"+escapeRefPath(spec.ref), spec.skillDir)
	s := &labrastroSkillSource{spec: spec, URL: normalized, commit: commit.SHA, rootTree: commit.Commit.Tree.SHA, client: client, entries: map[string]githubTreeEntry{}, directories: map[string]map[string]githubTreeEntry{}, cache: map[string][]byte{}, semaphore: make(chan struct{}, treeDownloadConcurrency)}
	s.rawPrefix = fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/%s", url.PathEscape(spec.owner), url.PathEscape(spec.repo), commit.SHA)
	treeID := s.rootTree
	if spec.skillDir != "" {
		dir := ""
		for _, part := range strings.Split(spec.skillDir, "/") {
			entries, err := s.directory(ctx, dir, treeID)
			if err != nil {
				return nil, err
			}
			e, ok := entries[part]
			if !ok || e.Type != "tree" || e.SHA == "" {
				return nil, labrastroSkillError(400, "invalid_source", fmt.Sprintf("source subdirectory %s is not a regular directory", spec.skillDir))
			}
			dir = path.Join(dir, part)
			treeID = e.SHA
		}
	}
	entries, err := s.tree(ctx, treeID, true)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !labrastroSafeRepoPath(e.Path) {
			return nil, fmt.Errorf("invalid path in repository tree")
		}
		e.Path = path.Join(spec.skillDir, e.Path)
		s.entries[e.Path] = e
	}
	s.fullTree = spec.skillDir == ""
	return s, nil
}

func (s *labrastroSkillSource) tree(ctx context.Context, sha string, recursive bool) ([]githubTreeEntry, error) {
	s.treeRequests++
	if s.treeRequests > 256 {
		return nil, fmt.Errorf("%w: repository traversal exceeds 256 tree requests; choose a smaller source", errImportCapExceeded)
	}
	endpoint := fmt.Sprintf("https://api.github.com/repos/%s/%s/git/trees/%s", url.PathEscape(s.spec.owner), url.PathEscape(s.spec.repo), url.PathEscape(sha))
	if recursive {
		endpoint += "?recursive=1"
	}
	var tree githubTreeResponse
	if err := labrastroReadGitHubJSON(ctx, s.client, endpoint, &tree); err != nil {
		return nil, err
	}
	if tree.Truncated {
		return nil, labrastroImportFailure("tree_incomplete", "", "", fmt.Errorf("repository tree is truncated; retry with a smaller subdirectory URL"), false)
	}
	return tree.Tree, nil
}
func (s *labrastroSkillSource) directory(ctx context.Context, dir, sha string) (map[string]githubTreeEntry, error) {
	if e, ok := s.directories[dir]; ok {
		return e, nil
	}
	entries, err := s.tree(ctx, sha, false)
	if err != nil {
		return nil, err
	}
	m := map[string]githubTreeEntry{}
	for _, e := range entries {
		m[e.Path] = e
	}
	s.directories[dir] = m
	return m, nil
}
func (s *labrastroSkillSource) lookup(ctx context.Context, p string) (githubTreeEntry, bool, error) {
	if e, ok := s.entries[p]; ok {
		return e, true, nil
	}
	if s.fullTree || labrastroInside(p, s.spec.skillDir) {
		return githubTreeEntry{}, false, nil
	}
	dir, sha := "", s.rootTree
	parts := strings.Split(p, "/")
	for i, part := range parts {
		m, err := s.directory(ctx, dir, sha)
		if err != nil {
			return githubTreeEntry{}, false, err
		}
		e, ok := m[part]
		if !ok {
			return e, false, nil
		}
		e.Path = p
		if i == len(parts)-1 {
			return e, true, nil
		}
		if e.Type != "tree" {
			return githubTreeEntry{}, false, nil
		}
		sha = e.SHA
		dir = path.Join(dir, part)
	}
	return githubTreeEntry{}, false, nil
}
func (s *labrastroSkillSource) fetch(ctx context.Context, p string) ([]byte, error) {
	s.mu.Lock()
	data, ok := s.cache[p]
	s.mu.Unlock()
	if ok {
		return data, nil
	}
	select {
	case s.semaphore <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-s.semaphore }()
	data, err := fetchRawFile(ctx, s.client, buildRawGitHubURL(s.rawPrefix, p))
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cacheBytes+len(data) > labrastroSourceCacheBytes {
		s.cache = map[string][]byte{}
		s.cacheBytes = 0
	}
	if _, ok := s.cache[p]; !ok {
		s.cache[p] = data
		s.cacheBytes += len(data)
	}
	return data, nil
}

type LabrastroSkillCandidate struct {
	Path            string                  `json:"path"`
	Name            string                  `json:"name"`
	Description     string                  `json:"description"`
	DefaultSelected bool                    `json:"default_selected"`
	State           string                  `json:"state"`
	SkillID         string                  `json:"skill_id,omitempty"`
	Conflict        string                  `json:"conflict,omitempty"`
	CanWrite        bool                    `json:"can_write"`
	Digest          string                  `json:"digest,omitempty"`
	FileCount       int                     `json:"file_count"`
	Bytes           int                     `json:"bytes"`
	SharedFiles     []string                `json:"shared_files"`
	Diagnostics     []SkillImportDiagnostic `json:"diagnostics"`
}

func (s *labrastroSkillSource) bundle(ctx context.Context, dir string) (*importedSkill, error) {
	primary := path.Join(dir, "SKILL.md")
	e, ok := s.entries[primary]
	if !ok || !labrastroRegularBlob(e) {
		return nil, fmt.Errorf("candidate SKILL.md is not a regular file")
	}
	body, err := s.fetch(ctx, primary)
	if err != nil {
		return nil, err
	}
	name, desc := skillpkg.ParseSkillFrontmatter(string(body))
	if name == "" {
		name = path.Base(dir)
		if dir == "" {
			name = s.spec.repo
		}
	}
	r := &importedSkill{name: name, description: desc, content: string(body), origin: map[string]any{"type": "github", "source_url": fmt.Sprintf("https://github.com/%s/%s/tree/%s/%s", s.spec.owner, s.spec.repo, escapeRefPath(s.spec.ref), dir), "owner": s.spec.owner, "repo": s.spec.repo, "ref": s.spec.ref, "path": dir}}
	var selected []githubTreeEntry
	var total int64
	for _, entry := range s.entries {
		if !labrastroInside(entry.Path, dir) || !labrastroRegularBlob(entry) || !labrastroTextPath(entry.Path) || strings.EqualFold(path.Base(entry.Path), "SKILL.md") {
			continue
		}
		if entry.size() > maxImportFileSize {
			return nil, fmt.Errorf("%w: file %s too large", errImportCapExceeded, entry.Path)
		}
		selected = append(selected, entry)
		total += entry.size()
	}
	if len(selected) > maxImportFileCount || total > maxImportTotalSize {
		return nil, fmt.Errorf("%w: skill %s exceeds supporting-file budget", errImportCapExceeded, dir)
	}
	sort.Slice(selected, func(i, j int) bool { return selected[i].Path < selected[j].Path })
	files := make([][]byte, len(selected))
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(treeDownloadConcurrency)
	for i, e := range selected {
		g.Go(func() error {
			body, err := s.fetch(gctx, e.Path)
			if err != nil {
				return labrastroImportFailure("support_file_unavailable", primary, e.Path, err, !isCapError(err))
			}
			files[i] = body
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	for i, e := range selected {
		rel := e.Path
		if dir != "" {
			rel = strings.TrimPrefix(rel, dir+"/")
		}
		if err := r.addFile(rel, string(files[i])); err != nil {
			return nil, err
		}
	}
	if err := labrastroCompleteReferences(ctx, r, dir, s.lookup, s.fetch); err != nil {
		return nil, err
	}
	return r, nil
}
func labrastroBundleDigest(s *importedSkill) string {
	hashText := func(text string) string {
		sum := sha256.Sum256([]byte(sanitizeNullBytes(text)))
		return hex.EncodeToString(sum[:])
	}
	files := [][2]string{}
	for _, f := range s.files {
		files = append(files, [2]string{f.path, hashText(f.content)})
	}
	return labrastroJSONHash([]any{sanitizeNullBytes(s.name), sanitizeNullBytes(s.description), hashText(s.content), files})
}

func (s *labrastroSkillSource) candidates(ctx context.Context) ([]LabrastroSkillCandidate, []SkillImportDiagnostic, error) {
	paths := []string{}
	for p, e := range s.entries {
		if path.Base(p) == "SKILL.md" && labrastroRegularBlob(e) {
			dir := path.Dir(p)
			if dir == "." {
				dir = ""
			}
			paths = append(paths, dir)
		}
	}
	sort.Strings(paths)
	if len(paths) > labrastroMaxCandidates {
		return nil, nil, fmt.Errorf("%w: more than %d candidates; use a smaller subdirectory", errImportCapExceeded, labrastroMaxCandidates)
	}
	defaults, diags, err := s.manifest(ctx, paths)
	if err != nil {
		return nil, nil, err
	}
	result := make([]LabrastroSkillCandidate, 0, len(paths))
	for _, dir := range paths {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		c := LabrastroSkillCandidate{Path: dir, DefaultSelected: defaults[dir], State: "new", CanWrite: true, SharedFiles: []string{}, Diagnostics: []SkillImportDiagnostic{}}
		bundle, err := s.bundle(ctx, dir)
		if err != nil {
			c.Name = path.Base(dir)
			c.State = "failed"
			c.DefaultSelected = false
			c.CanWrite = false
			var detail *labrastroImportError
			if errors.As(err, &detail) {
				c.Diagnostics = append(c.Diagnostics, detail.Diagnostic)
			} else {
				code := "source_unavailable"
				if isCapError(err) {
					code = "limit_exceeded"
				}
				c.Diagnostics = append(c.Diagnostics, SkillImportDiagnostic{Code: code, Path: dir, Message: err.Error(), Retryable: !isCapError(err)})
			}
		} else {
			c.Name = bundle.name
			c.Description = bundle.description
			c.Digest = labrastroBundleDigest(bundle)
			c.FileCount = len(bundle.files)
			c.Bytes = len(bundle.content) + bundle.bundleSize
			c.Diagnostics = append(c.Diagnostics, bundle.diagnostics...)
			for _, f := range bundle.files {
				if strings.HasPrefix(f.path, "_shared/") {
					c.SharedFiles = append(c.SharedFiles, f.path)
				}
			}
		}
		result = append(result, c)
	}
	// Prefer ordinary paths for a same-name dot-directory mirror. All other
	// collisions remain explicit candidates rather than being guessed away.
	normal := map[string]bool{}
	for _, c := range result {
		if !labrastroDotDirectory(c.Path) {
			normal[c.Name] = true
		}
	}
	filtered := result[:0]
	for _, c := range result {
		if labrastroDotDirectory(c.Path) && normal[c.Name] {
			diags = append(diags, SkillImportDiagnostic{Code: "dot_directory_duplicate", Path: c.Path, Message: "ordinary-directory candidate takes precedence"})
			continue
		}
		filtered = append(filtered, c)
	}
	return filtered, diags, nil
}
func labrastroDotDirectory(p string) bool {
	for _, part := range strings.Split(p, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

func (s *labrastroSkillSource) manifest(ctx context.Context, paths []string) (map[string]bool, []SkillImportDiagnostic, error) {
	selected := map[string]bool{}
	p := ".claude-plugin/plugin.json"
	e, exists, err := s.lookup(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	if !exists {
		for _, p := range paths {
			selected[p] = true
		}
		return selected, nil, nil
	}
	invalid := func(message string) (map[string]bool, []SkillImportDiagnostic, error) {
		return selected, []SkillImportDiagnostic{{Code: "manifest_invalid", Path: p, Message: message}}, nil
	}
	if !labrastroRegularBlob(e) {
		return invalid("manifest must be a regular file; no candidates selected by default")
	}
	body, err := s.fetch(ctx, p)
	if err != nil {
		return nil, nil, err
	}
	var manifest struct {
		Skills json.RawMessage `json:"skills"`
	}
	if json.Unmarshal(body, &manifest) != nil || len(manifest.Skills) == 0 {
		return invalid("manifest skills must be a directory or path list; no defaults selected")
	}
	var entries []string
	var dir string
	if json.Unmarshal(manifest.Skills, &dir) == nil {
		entries = []string{dir}
	} else if json.Unmarshal(manifest.Skills, &entries) != nil || entries == nil {
		return invalid("manifest skills is invalid; no defaults selected")
	}
	for _, entry := range entries {
		entry = strings.TrimSuffix(strings.TrimPrefix(entry, "./"), "/")
		if entry == "." {
			entry = ""
		}
		if entry != "" && !labrastroSafeRepoPath(entry) {
			return invalid("manifest path leaves the repository or is malformed; no defaults selected")
		}
	}
	for _, entry := range entries {
		entry = strings.TrimSuffix(strings.TrimPrefix(entry, "./"), "/")
		if entry == "." {
			entry = ""
		}
		entry = strings.TrimSuffix(entry, "/SKILL.md")
		for _, p := range paths {
			if p == entry || labrastroInside(p, entry) {
				selected[p] = true
			}
		}
	}
	return selected, nil, nil
}
