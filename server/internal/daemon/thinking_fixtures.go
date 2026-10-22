package daemon

import (
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

func StepThinkingFixtures() []StepThinkingFixture {
	return []StepThinkingFixture{
		{"before-read", ThinkingMechanical, StepThinkingInput{Goal: "排查任务调度器偶发卡住的问题", Step: 1, AssistantText: "下一步先用 read_file 读取 scheduler.go，目前尚未读入代码或取得错误证据。"}},
		{"concurrent-code", ThinkingFirstDeepProblem, StepThinkingInput{Goal: "排查任务调度器偶发卡住的问题", Step: 2, AssistantText: "完成通知在 dispatch 与 finish 间存在并发交互，先读 scheduler.go 确认锁与唤醒的实现。", ToolName: "read_file", ToolInputSummary: "scheduler.go", ToolResult: "package scheduler\n\n// Scheduler multiplexes pending tasks onto a worker pool. Completion\n// notification flows through per-task channels AND a shared condition\n// variable; finish() racing dispatch() is the suspected cause of the\n// intermittent stalls reported under load.\ntype Scheduler struct {\n\tmu       sync.Mutex\n\tcond     *sync.Cond\n\tpending  map[string]*task\n\tnotify   map[string][]chan struct{}\n\tmetrics  sync.Map // atomic-ish counters read while mu is held elsewhere\n\tdone     chan string\n\twg       sync.WaitGroup\n\tshutdown bool\n}\n\nfunc (s *Scheduler) dispatch(worker int) {\n\tdefer s.wg.Done()\n\tfor {\n\t\ts.mu.Lock()\n\t\tfor len(s.pending) == 0 && !s.shutdown {\n\t\t\ts.cond.Wait() // misses wakeups racing finish()'s Broadcast\n\t\t}\n\t\tif s.shutdown && len(s.pending) == 0 {\n\t\t\ts.mu.Unlock()\n\t\t\treturn\n\t\t}\n\t\tvar next *task\n\t\tfor id, t := range s.pending {\n\t\t\tnext = t\n\t\t\tdelete(s.pending, id)\n\t\t\tbreak\n\t\t}\n\t\ts.mu.Unlock()\n\t\ttimer := time.NewTimer(retryBackoff)\n\t\tselect {\n\t\tcase err := <-runAsync(worker, next, s.done):\n\t\t\tif err != nil {\n\t\t\t\tgo s.retryOrDeadlock(next, err) // re-locks s.mu on another goroutine\n\t\t\t}\n\t\tcase <-timer.C:\n\t\t\ts.metrics.Store(\"worker_timeout\", worker)\n\t\t}\n\t\ttimer.Stop()\n\t}\n}\n\nfunc (s *Scheduler) finish(id string) {\n\ts.mu.Lock()\n\tdefer s.mu.Unlock()\n\tfor _, ch := range s.notify[id] {\n\t\tselect {\n\t\tcase ch <- struct{}{}:\n\t\tdefault: // dropped notification while the waiter is slow\n\t\t}\n\t}\n\tdelete(s.notify, id)\n\ts.cond.Broadcast()\n}\n\nfunc (s *Scheduler) Shutdown(ctx context.Context) error {\n\ts.mu.Lock()\n\ts.shutdown = true\n\ts.cond.Broadcast()\n\ts.mu.Unlock()\n\tdone := make(chan struct{})\n\tgo func() { s.wg.Wait(); close(done) }()\n\tselect {\n\tcase <-done:\n\t\treturn nil\n\tcase <-ctx.Done():\n\t\treturn ctx.Err() // workers may still sit in cond.Wait holding s.mu\n\t}\n}"}},
		{"unused-import", ThinkingSimpleError, StepThinkingInput{Goal: "增加日志字段", Step: 3, ToolName: "exec_command", ToolInputSummary: "go test ./...", ToolResult: "build failed: scheduler.go:4:2: fmt imported and not used", ExitCode: 1, ToolIsError: true, ErrorFeatures: "fmt imported and not used"}},
		{"connection-refused", ThinkingSimpleError, StepThinkingInput{Goal: "运行本地集成测试", Step: 3, ToolName: "exec_command", ToolInputSummary: "go test ./internal/api", ToolResult: "dial tcp 127.0.0.1:5432: connect: connection refused", ExitCode: 1, ToolIsError: true, ErrorFeatures: "connect: connection refused"}},
		{"data-race", ThinkingFirstDeepProblem, StepThinkingInput{Goal: "修复调度器并发问题", Step: 4, ToolName: "exec_command", ToolInputSummary: "go test -race ./internal/scheduler", ToolResult: "WARNING: DATA RACE\nRead at scheduler.go:178 by goroutine 41\nPrevious write at scheduler.go:211 by goroutine 62", ExitCode: 1, ToolIsError: true, ErrorFeatures: "DATA RACE scheduler.go"}},
		{"core-assertion", ThinkingFirstDeepProblem, StepThinkingInput{Goal: "实现事务提交协议", Step: 4, ToolName: "exec_command", ToolInputSummary: "go test ./internal/transaction", ToolResult: "FAIL TestCommitAtomicity: core invariant violated: transaction acknowledged committed but durable log has no commit record.", ExitCode: 1, ToolIsError: true, ErrorFeatures: "TestCommitAtomicity: core invariant violated"}},
		{"wrap-up", ThinkingMechanical, StepThinkingInput{Goal: "修复调度器并发竞态", Step: 8, AssistantText: "实现和回归测试完成，所有检查已通过，下一步只需写最终结果。", ToolName: "exec_command", ToolInputSummary: "go test -race ./...", ToolResult: "PASS\nok all packages"}},
		{"repeated-xhigh-failure", ThinkingRepeatedFailure, StepThinkingInput{Goal: "修复调度器并发竞态", Step: 9, AssistantText: "已在 xhigh 挡位修复，但同一报错在两次验证中仍连续复现，需要重新推导根因。", ToolName: "exec_command", ToolInputSummary: "go test -race ./internal/scheduler", ToolResult: "WARNING: DATA RACE\nRead at scheduler.go:178 by goroutine 41\nPrevious write at scheduler.go:211 by goroutine 62", ExitCode: 1, ToolIsError: true, ErrorFeatures: "DATA RACE scheduler.go", RepeatedErrors: 2}},
	}
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
