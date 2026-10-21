package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type taskOutputCase struct{ name, output, want string }

var taskOutputCases = []taskOutputCase{
	{"paragraphs", `para1\n\npara2`, "para1\n\npara2"},
	{"heading and path paragraphs", `Summary:\nEdited D:\repo\a.go\n\nNext step`, "Summary:\n" + `Edited D:\repo\a.go` + "\n\nNext step"},
	{"Chinese prose after path", `已修改 D:\work\text.go，测试通过\n\n下一步：提交\n\n完成`, `已修改 D:\work\text.go，测试通过` + "\n\n下一步：提交\n\n完成"},
	{"formula", `$$\Delta \ln P_{0,i}(a_{\text{exec}} \mid s_t) \propto \eta_{\text{lr}} \cdot \sigma\left(\gamma_1 R_{\text{somatic}} + \gamma_2 V_{\text{ego_appraisal}}\right)$$`, `$$\Delta \ln P_{0,i}(a_{\text{exec}} \mid s_t) \propto \eta_{\text{lr}} \cdot \sigma\left(\gamma_1 R_{\text{somatic}} + \gamma_2 V_{\text{ego_appraisal}}\right)$$`},
	{"matrix and inline math", `$\begin{matrix}a&b\\c&d\end{matrix}$ $\text{睡前}\times\theta\tau\rho\nu\nabla x\neq y\to z$`, `$\begin{matrix}a&b\\c&d\end{matrix}$ $\text{睡前}\times\theta\tau\rho\nu\nabla x\neq y\to z$`},
	{"code", "`\\n\\r\\t\\\\`", "`\\n\\r\\t\\\\`"},
	{"decoded multiline", "Heading\n" + `bare \n \r \t \\ \text{x} \right) \neq \ncustom`, "Heading\n" + `bare \n \r \t \\ \text{x} \right) \neq \ncustom`},
	{"CRLF output", "Heading\r\n" + `a\\b\t\r\n`, "Heading\r\n" + `a\\b\t\r\n`},
	{"multiline math", "$$\n" + `\begin{aligned}a&=b\\c&=d\end{aligned}` + "\n$$", "$$\n" + `\begin{aligned}a&=b\\c&=d\end{aligned}` + "\n$$"},
}

func TestNormalizeTaskOutput(t *testing.T) {
	for _, tc := range taskOutputCases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeTaskOutput(tc.output); got != tc.want {
				t.Fatalf("output = %q, want %q", got, tc.want)
			}
			result, err := json.Marshal(protocol.TaskCompletedPayload{Output: tc.output})
			if err != nil {
				t.Fatal(err)
			}
			if got := quickCreateFailureDetail(result); got != tc.want {
				t.Fatalf("failure detail = %q, want %q", got, tc.want)
			}
		})
	}
}

// Exercise both actual completion writes, including the JSON wire decode.
func TestCompleteTaskPreservesOutput(t *testing.T) {
	f, owner := newPrincipalFixture(t)
	agent := f.privateAgentOwnedBy(t, owner, "output")
	ctx := context.Background()
	for _, surface := range []string{"chat", "comment"} {
		cases := append([]taskOutputCase(nil), taskOutputCases...)
		if surface == "chat" {
			cases = append(cases, taskOutputCase{
				"escaped quick-actions footer",
				`Answer:\n$x\n$\n\n` + "```quick-actions\\n" + `[{"label":"A","prompt":"B"}]` + "\\n```",
				"Answer:\n" + `$x\n$`,
			}, taskOutputCase{
				"decoded body before real footer",
				`Literal \n \r \t \\` + "\n```quick-actions\n[]\n```",
				`Literal \n \r \t \\`,
			})
		}
		for _, tc := range cases {
			t.Run(surface+"/"+tc.name, func(t *testing.T) {
				cols := testutil.Cols{
					"status": "running", "started_at": testutil.Raw("now()"),
					"runtime_id": testutil.Raw("(SELECT runtime_id FROM agent WHERE id='" + agent + "')"),
				}
				if surface == "chat" {
					session := f.ChatSession(t, agent)
					cols["chat_session_id"] = session
					f.Cleanup(t, "DELETE FROM chat_message WHERE chat_session_id=$1", session)
				} else {
					issue := f.Issue(t, "Output preservation")
					cols["issue_id"] = issue
					f.Cleanup(t, "DELETE FROM comment WHERE issue_id=$1", issue)
				}
				taskID := f.Task(t, agent, cols)
				result, err := json.Marshal(protocol.TaskCompletedPayload{Output: tc.output})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.svc.TaskSvc.CompleteTask(ctx, parseTestUUID(t, taskID), result, "", "", "", false, "", ""); err != nil {
					t.Fatal(err)
				}
				var got string
				if surface == "chat" {
					f.QueryRow(t, "SELECT content FROM chat_message WHERE task_id=$1 AND role='assistant'", taskID).Scan(&got)
				} else {
					f.QueryRow(t, "SELECT content FROM comment WHERE source_task_id=$1 AND author_type='agent'", taskID).Scan(&got)
				}
				if got != tc.want {
					t.Fatalf("stored %s = %q, want %q", surface, got, tc.want)
				}
			})
		}
	}
}
