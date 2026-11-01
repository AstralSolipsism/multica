package handler

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const baselinePATRisk = "### [Risk-1] 基线采用不由服务端核实负责人是否确认过\n\n- 风险：项目开启后，决定人的会话、决定人的个人令牌（`mul_`）和本工作区智能体的任务令牌（`mat_`）都能直接采用候选，包括删除或削弱 `[Rule-*]` 的候选。服务端不判断负责人是否真的同意过这一版；同机程序拿到决定人的 PAT，也能以其名义采用。\n- 已有防线：已采用的正本没有直接改写入口，修改必须先提候选，生成带锚点的 Diff 和告警；daemon 任务里的 CLI 只用任务令牌，不回落读取主机上的 PAT；技能要求先把 Diff 亮给决定人，得到明确同意后才采用。\n- 缓解：每次拍板记录拍板人和凭据种类（会话、个人令牌、智能体任务），看板历史标出拍板方式并保留告警，可随时复核；误采用时，用旧版正文提候选再采用即可回滚。\n- 接受：负责人 2026-10-30 选择 D1 方案 B、2026-11-01 确认方案一时接受（OL-457 评论 01a18cf7、01a19497）。"

func (s *engineeringState) seedRisk(ctx context.Context, actor baselineActor) (bool, error) {
	docs, err := s.docs(ctx, true)
	if err != nil {
		return false, err
	}
	if baselineDoc(docs, "exclusions_and_risks").ID.Valid {
		return false, nil
	}
	if err = s.q.LabrastroEnsureBaselineDoc(ctx, db.LabrastroEnsureBaselineDocParams{WorkspaceID: s.project.WorkspaceID, ProjectID: s.project.ID, Chapter: "exclusions_and_risks"}); err != nil {
		return false, err
	}
	diff, err := engineering.Compute("exclusions_and_risks", "", baselinePATRisk, 0, "", s.issuePrefix)
	if err != nil {
		return false, err
	}
	revision, err := s.createRevision(ctx, "exclusions_and_risks", baselinePATRisk, "Record accepted baseline decision risk", pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{}, actor, diff)
	if err != nil {
		return false, err
	}
	if _, err = s.decide(ctx, revision.ID, "adopted", actor); err != nil {
		return false, err
	}
	err = s.updateDoc(ctx, "exclusions_and_risks", revision.ID, pgtype.UUID{})
	return err == nil, err
}

func deleteWorkspaceEngineeringAndProjects(ctx context.Context, q *db.Queries, workspace pgtype.UUID) error {
	if err := q.LabrastroDeleteWorkspaceEngineering(ctx, workspace); err != nil {
		return err
	}
	return q.DeleteWorkspaceRuntimesAndProjects(ctx, workspace)
}
