package daemon

import (
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

func StepThinkingFixtures() []StepThinkingFixture {
	return []StepThinkingFixture{
		{"before-read", ThinkingMechanical, StepThinkingInput{Goal: "排查任务调度器偶发卡住的问题", Step: 1, AssistantText: "下一步先用 read_file 读取 scheduler.go，目前尚未读入代码或取得错误证据。"}},
		{"concurrent-code", ThinkingFirstDeepProblem, StepThinkingInput{Goal: "排查任务调度器偶发卡住的问题", Step: 2, AssistantText: "已读入复杂的并发实现，下一步分析锁顺序和 channel 生命周期。", ToolName: "read_file", ToolInputSummary: "scheduler.go", ToolResult: "阅读摘要：多个 goroutine 交叉持有 mutex，回调在锁内发送无缓冲 channel，取消路径与完成路径竞争同一个状态。"}},
		{"unused-import", ThinkingSimpleError, StepThinkingInput{Goal: "增加日志字段", Step: 3, ToolName: "exec_command", ToolInputSummary: "go test ./...", ToolResult: "build failed: scheduler.go:4:2: fmt imported and not used", ExitCode: 1}},
		{"connection-refused", ThinkingSimpleError, StepThinkingInput{Goal: "运行本地集成测试", Step: 3, ToolName: "exec_command", ToolInputSummary: "go test ./internal/api", ToolResult: "dial tcp 127.0.0.1:5432: connect: connection refused", ExitCode: 1}},
		{"data-race", ThinkingFirstDeepProblem, StepThinkingInput{Goal: "修复调度器并发问题", Step: 4, ToolName: "exec_command", ToolInputSummary: "go test -race ./internal/scheduler", ToolResult: "WARNING: DATA RACE\nRead at scheduler.go:178 by goroutine 41\nPrevious write at scheduler.go:211 by goroutine 62\n首次发现，尚未尝试修复。", ExitCode: 1}},
		{"core-assertion", ThinkingFirstDeepProblem, StepThinkingInput{Goal: "实现事务提交协议", Step: 4, ToolName: "exec_command", ToolInputSummary: "go test ./internal/transaction", ToolResult: "FAIL TestCommitAtomicity: core invariant violated: transaction acknowledged committed but durable log has no commit record. First failure; no fix attempted yet.", ExitCode: 1}},
		{"wrap-up", ThinkingMechanical, StepThinkingInput{Goal: "修复调度器并发竞态", Step: 8, AssistantText: "实现和回归测试完成，所有检查已通过，下一步只需写最终结果。", ToolName: "exec_command", ToolInputSummary: "go test -race ./...", ToolResult: "PASS\nok all packages"}},
		{"repeated-xhigh-failure", ThinkingRepeatedFailure, StepThinkingInput{Goal: "修复调度器并发竞态", Step: 9, AssistantText: "已在 xhigh 挡位修复，但同一报错在两次验证中仍连续复现，需要重新推导根因。", ToolName: "exec_command", ToolInputSummary: "go test -race ./internal/scheduler", ToolResult: "WARNING: DATA RACE at scheduler.go:178 and scheduler.go:211; same error after both fixes", ExitCode: 1, RepeatedErrors: 2}},
	}
}

type thinkingFixtureQuestion struct {
	Type         string            `json:"type"`
	Instructions string            `json:"instructions"`
	Criteria     map[string]string `json:"criteria"`
}

// ThinkingEvaluationFixture is the rendered corpus used by live evaluation and
// exported for train/evaluation separation. Request is the exact engine input.
type ThinkingEvaluationFixture struct {
	ID               string                             `json:"id"`
	Scope            string                             `json:"scope"`
	CandidateGroup   string                             `json:"candidate_group"`
	ExpectedCategory string                             `json:"expected_category"`
	State            string                             `json:"state"`
	Questions        map[string]thinkingFixtureQuestion `json:"questions"`
	Request          jev.Request                        `json:"-"`
}

func ThinkingEvaluationFixtures() []ThinkingEvaluationFixture {
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
		appendFixture := func(id, scope, category, state string) {
			req := ThinkingRequest(state, candidates)
			criteria := make(map[string]string)
			for _, option := range req.Options {
				criteria[option.Value] = option.Description
			}
			fixtures = append(fixtures, ThinkingEvaluationFixture{ID: id, Scope: scope, CandidateGroup: group.name, ExpectedCategory: category, State: state, Request: req,
				Questions: map[string]thinkingFixtureQuestion{"effort": {Type: "choice", Instructions: req.Instructions, Criteria: criteria}},
			})
		}
		for _, fixture := range runs {
			appendFixture(fixture.id, "run", fixture.category, BuildRunThinkingState(fixture.task, group.name, group.model))
		}
		for _, fixture := range StepThinkingFixtures() {
			appendFixture(fixture.ID, "step", fixture.ExpectedCategory, BuildStepThinkingState(fixture.Input))
		}
	}
	return fixtures
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
