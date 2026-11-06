package daemon

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/jev"
)

func (d *Daemon) jevEvaluateHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		task, auth := d.activeRepoCheckoutTask(r)
		if auth != repoCheckoutAuthOK {
			http.Error(w, "evaluation requires an active task credential", http.StatusUnauthorized)
			return
		}
		if taskIDFromRequest(r) != task.TaskID {
			http.Error(w, "task id does not match the credential", http.StatusForbidden)
			return
		}
		req, err := jev.DecodeEvaluation(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		result := jev.EvaluationResult{Reason: jev.ReasonDisabled}
		if d.jevClient != nil {
			result = d.jevClient.Evaluate(ctx, req)
		}
		result.DaemonVersion = d.cfg.CLIVersion
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	}
}
