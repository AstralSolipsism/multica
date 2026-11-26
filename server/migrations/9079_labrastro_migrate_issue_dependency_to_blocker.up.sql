-- The fork's informational issue_dependency relations give way to upstream's
-- native issue_blocker (MUL-8860). Every historical blocking edge becomes a
-- manual blocker; issue_dependency, its rows and its audit log stay as they
-- are, so nothing already stored is lost.
--
-- One edge at a time: the issue_blocker triggers refuse an edge that closes a
-- cycle with the same-parent stage order or that links an ancestor with a
-- descendant. Such an edge stays behind in issue_dependency and the upgrade
-- continues. A rerun inserts nothing: each edge is either already present or
-- refused the same way.
DO $$
DECLARE
	edge record;
BEGIN
	FOR edge IN
		-- dependent -> prerequisite, both endpoints in one workspace
		SELECT i.workspace_id, i.id AS issue_id, p.id AS blocker_issue_id, i.creator_id AS creator_id
		FROM issue_dependency d
		JOIN issue i ON i.id = d.issue_id
		JOIN issue p ON p.id = d.depends_on_issue_id AND p.workspace_id = i.workspace_id
		WHERE d.type = 'blocked_by' AND i.id <> p.id
		UNION
		-- the retired "blocks" spelling stored the same edge the other way round
		SELECT i.workspace_id, p.id, i.id, p.creator_id
		FROM issue_dependency d
		JOIN issue i ON i.id = d.issue_id
		JOIN issue p ON p.id = d.depends_on_issue_id AND p.workspace_id = i.workspace_id
		WHERE d.type = 'blocks' AND i.id <> p.id
		ORDER BY issue_id, blocker_issue_id
	LOOP
		BEGIN
			INSERT INTO issue_blocker (workspace_id, issue_id, blocker_issue_id, created_by_type, created_by_id)
			VALUES (edge.workspace_id, edge.issue_id, edge.blocker_issue_id, 'member', edge.creator_id)
			ON CONFLICT (workspace_id, issue_id, blocker_issue_id) DO NOTHING;
		EXCEPTION WHEN check_violation THEN
			RAISE NOTICE 'issue_dependency edge % -> % kept as retired data: %', edge.issue_id, edge.blocker_issue_id, SQLERRM;
		END;
	END LOOP;
END
$$;
