package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cli"
	"github.com/multica-ai/multica/server/internal/daemon/jev"
	"github.com/spf13/cobra"
)

var jevCmd = newJevCmd()

func newJevCmd() *cobra.Command {
	root := &cobra.Command{Use: "jev", Short: "Evaluate business input with the managed decision service"}
	evaluate := &cobra.Command{Use: "evaluate", Short: "Return scores for ordered criteria inside an active task", Args: exactArgs(0), RunE: runJevEvaluate}
	evaluate.Flags().String("input-file", "", "Read a JSON evaluation from a file, or - for stdin")
	evaluate.Flags().String("output", "table", "Output format: table or json")
	_ = evaluate.MarkFlagRequired("input-file")
	root.AddCommand(evaluate)
	return root
}

func runJevEvaluate(cmd *cobra.Command, _ []string) error {
	format, _ := cmd.Flags().GetString("output")
	if format != "json" && format != "table" {
		return fmt.Errorf("output must be table or json")
	}
	// Use only injected task credentials and loopback port, never owner config,
	// profiles or the public server URL. Validate the port before constructing a URL.
	port, err := strconv.Atoi(os.Getenv("MULTICA_DAEMON_PORT"))
	taskID := os.Getenv("MULTICA_TASK_ID")
	token := os.Getenv("MULTICA_TOKEN")
	if err != nil || port < 1 || port > 65535 || !strings.HasPrefix(token, "mat_") {
		return fmt.Errorf("jev evaluate requires a daemon-managed active task")
	}
	if _, err := uuid.Parse(taskID); err != nil {
		return fmt.Errorf("jev evaluate requires a valid active task id")
	}
	filename, _ := cmd.Flags().GetString("input-file")
	var input io.Reader = cmd.InOrStdin()
	if filename != "-" {
		file, err := os.Open(filename)
		if err != nil {
			return fmt.Errorf("open evaluation input: %w", err)
		}
		defer file.Close()
		input = file
	}
	payload, err := jev.DecodeEvaluation(input)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(cmd.Context(), 11*time.Second)
	defer cancel()
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/tasks/%s/jev-evaluate", port, taskID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(data))
	if err != nil {
		return fmt.Errorf("create evaluation request")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{
		Transport:     &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("evaluation daemon unavailable or timed out")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("evaluation rejected (HTTP %d); requires an active task and a daemon supporting jev evaluate", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20+1))
	if err != nil || len(raw) > 1<<20 {
		return fmt.Errorf("invalid evaluation response")
	}
	var result jev.EvaluationResult
	if json.Unmarshal(raw, &result) != nil {
		return fmt.Errorf("invalid evaluation response")
	}
	if format == "json" {
		if err := cli.PrintJSON(cmd.OutOrStdout(), result); err != nil {
			return err
		}
	} else if result.OK {
		keys := make([]string, 0, len(result.Answers))
		for key := range result.Answers {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var rows [][]string
		for _, key := range keys {
			rows = append(rows, []string{key, strconv.FormatFloat(result.Answers[key].Score, 'f', -1, 64)})
		}
		cli.PrintTable(cmd.OutOrStdout(), []string{"QUESTION", "SCORE"}, rows)
	}
	if !result.OK {
		if format == "json" {
			return errSilent
		}
		return fmt.Errorf("evaluation unavailable (%s)", result.Reason)
	}
	return nil
}
