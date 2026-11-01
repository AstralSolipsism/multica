package handler

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/engineering"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const baselinePATRisk = "### [Risk-1] 成员个人令牌可被同机程序用来拍板基线\n\n- 风险：成员 PAT（`mul_`）在服务端等同成员本人。任何拿到决定人 PAT 的程序都能以该成员的名义采用基线，服务端分不清是本人操作还是程序代办。当前运行时主机的 `~/.multica/config.json` 存有负责人的 PAT，同机进程读得到。\n- 已有防线：daemon 任务里的 CLI 只用任务令牌，不回落读取这个文件；要冒充，只能主动去读凭据文件。\n- 缓解：每次拍板记录凭据种类，看板给\"经个人令牌采用\"的版本加标识，可在历史列表中筛出来复核；技能禁止读取或转用凭据文件；需要智能体代办时，在项目工程能力启用后直接使用任务令牌，以智能体身份如实记账。\n- 接受：负责人 2026-10-30 选择 D1 方案 B 时接受（OL-457 评论 01a18cf7）。"

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
	revision, err := s.createRevision(ctx, "exclusions_and_risks", baselinePATRisk, "Record accepted PAT decision risk", pgtype.UUID{}, pgtype.UUID{}, pgtype.UUID{}, actor, diff)
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
