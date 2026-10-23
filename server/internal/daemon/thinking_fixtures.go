package daemon

import (
	_ "embed"
	"encoding/json"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/multica-ai/multica/server/pkg/agent"
)

const (
	ThinkingMechanical       = "机械"
	ThinkingSimpleError      = "低级报错"
	ThinkingFirstDeepProblem = "首次深层问题"
	ThinkingRepeatedFailure  = "重复失败"
)

// StepThinkingFixture is shared with the step-level adapter's evaluation suite.
type StepThinkingFixture struct {
	ID               string
	ExpectedCategory string
	Input            StepThinkingInput
}

//go:embed testdata/thinking-steps/runs.json
var stepThinkingRunsJSON []byte

type stepThinkingFixtureRun struct {
	Goal  string `json:"goal"`
	Steps []struct {
		ID               string                  `json:"id"`
		ExpectedCategory string                  `json:"expected_category"`
		Request          thinkingDecisionRequest `json:"request"`
	} `json:"steps"`
}

func StepThinkingFixtures() []StepThinkingFixture {
	var runs []stepThinkingFixtureRun
	if err := json.Unmarshal(stepThinkingRunsJSON, &runs); err != nil {
		panic(err) // Invalid embedded evaluation corpus is a build-time defect.
	}
	var fixtures []StepThinkingFixture
	for _, source := range runs {
		run := stepEffortRun{Goal: source.Goal}
		for _, step := range source.Steps {
			// Replay intervening edits too: errors are counted in the same
			// six-step window as production, never supplied by the fixture.
			_, input := run.buildStepRequest(step.Request)
			if step.ID != "" {
				fixtures = append(fixtures, StepThinkingFixture{step.ID, step.ExpectedCategory, input})
			}
		}
	}
	return fixtures
}

// ThinkingEvaluationFixture is the rendered corpus used by live evaluation and
// exported for train/evaluation separation. Request is the exact engine input.
type ThinkingEvaluationFixture struct {
	ID               string          `json:"id"`
	Scope            string          `json:"scope"`
	CandidateGroup   string          `json:"candidate_group"`
	ExpectedCategory string          `json:"expected_category"`
	State            string          `json:"state"`
	Questions        json.RawMessage `json:"questions"`
	Request          jev.Request     `json:"-"`
}

func ThinkingEvaluationFixtures() ([]ThinkingEvaluationFixture, error) {
	runs := []struct {
		id, category string
		task         Task
	}{
		{"typo", ThinkingMechanical, Task{ThreadName: "改正 README 错别字", IssueDescription: "将 instal 改为 install，只改这一处文字，不改变代码行为。"}},
		{"dependency", ThinkingMechanical, Task{ThreadName: "升级依赖补丁版本", IssueDescription: "将依赖从 1.2.3 更新到 1.2.4，API 不变，更新 lockfile 并运行现有测试。"}},
		{"race", ThinkingFirstDeepProblem, Task{ThreadName: "排查并发竞态", IssueDescription: "高并发下任务偶发被领取两次，需要分析共享状态和锁顺序。首次调查，尚未修复过。"}},
		{"deadlock", ThinkingFirstDeepProblem, Task{ThreadName: "定位架构死锁", IssueDescription: "多个服务间的回调和背压互相等待，任务永不结束。首次出现，要定位跨模块等待环路，尚未尝试修复。"}},
		{"retry-comment", ThinkingRepeatedFailure, Task{ThreadName: "修复任务领取竞态", IssueDescription: "高并发下同一任务被重复领取。", TriggerCommentContent: "上次修复没解决，同一报错仍在。你上次用 high 分析并修复过，但重跑后还是出现重复领取，请重新推导根因。"}},
	}
	groups := []struct {
		name, model string
		levels      []string
	}{
		{"claude", "claude-opus-5-5", []string{"low", "medium", "high", "xhigh", "max"}},
		{"codex", "gpt-6-sol", []string{"minimal", "low", "medium", "high", "xhigh", "max", "ultra"}},
	}
	var fixtures []ThinkingEvaluationFixture
	for _, group := range groups {
		var candidates []agent.ThinkingLevel
		for _, level := range group.levels {
			candidates = append(candidates, agent.ThinkingLevel{Value: level, Label: level})
		}
		appendFixture := func(id, scope, category, state string) error {
			req := ThinkingRequest(state, candidates)
			questions, err := req.MarshalQuestionsJSON()
			if err != nil {
				return err
			}
			fixtures = append(fixtures, ThinkingEvaluationFixture{ID: id, Scope: scope, CandidateGroup: group.name, ExpectedCategory: category, State: state, Request: req,
				Questions: questions,
			})
			return nil
		}
		for _, fixture := range runs {
			if err := appendFixture(fixture.id, "run", fixture.category, BuildRunThinkingState(fixture.task, group.name, group.model)); err != nil {
				return nil, err
			}
		}
		for _, fixture := range StepThinkingFixtures() {
			if err := appendFixture(fixture.ID, "step", fixture.ExpectedCategory, BuildStepThinkingState(fixture.Input)); err != nil {
				return nil, err
			}
		}
	}
	return fixtures, nil
}

func (fixture ThinkingEvaluationFixture) Accepts(choice string) bool {
	switch fixture.ExpectedCategory {
	case ThinkingMechanical:
		return choice != "max" && choice != "ultra" && (choice == fixture.Request.Options[0].Value || choice == fixture.Request.Options[1].Value)
	case ThinkingSimpleError:
		return choice == "minimal" || choice == "low" || choice == "medium"
	case ThinkingFirstDeepProblem:
		return choice == "high" || choice == "xhigh"
	case ThinkingRepeatedFailure:
		return choice == "max" || (fixture.CandidateGroup == "codex" && choice == "ultra")
	}
	return false
}
