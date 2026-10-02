-- Synthetic data for the OL-98 upgrade rehearsal, on a disposable baseline DB.
-- Apply once to f89cba43e after its migrations; never use a production database.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO "user" (id,name,email) VALUES ('98000000-0000-4000-8000-000000000001','Upgrade owner','ol98@example.invalid');
INSERT INTO workspace (id,name,slug,issue_prefix,settings) VALUES
 ('98000000-0000-4000-8000-000000000002','Upgrade disabled','ol98-disabled','UPG','{"pr_auto_complete_enabled":false}'),
 ('98000000-0000-4000-8000-000000000012','Upgrade explicit','ol98-explicit','EXP','{"pr_merge_status":"in_review"}'),
 ('98000000-0000-4000-8000-000000000022','Upgrade default','ol98-default','DFT','{}');
INSERT INTO member (workspace_id,user_id,role) VALUES ('98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000001','owner');
INSERT INTO agent_runtime (id,workspace_id,name,runtime_mode,provider,status,last_seen_at,visibility,owner_id) VALUES ('98000000-0000-4000-8000-000000000013','98000000-0000-4000-8000-000000000002','Upgrade runtime','cloud','ol98-rehearsal','offline',now(),'private','98000000-0000-4000-8000-000000000001');
INSERT INTO agent (id,workspace_id,name,runtime_mode,owner_id) VALUES ('98000000-0000-4000-8000-000000000003','98000000-0000-4000-8000-000000000002','Upgrade private agent','cloud','98000000-0000-4000-8000-000000000001');
INSERT INTO issue (id,workspace_id,title,number,status,creator_type,creator_id) VALUES
 ('98000000-0000-4000-8000-000000000004','98000000-0000-4000-8000-000000000002','Existing parent',1,'in_progress','member','98000000-0000-4000-8000-000000000001'),
 ('98000000-0000-4000-8000-000000000005','98000000-0000-4000-8000-000000000002','Existing child',2,'todo','member','98000000-0000-4000-8000-000000000001');
UPDATE issue SET parent_issue_id='98000000-0000-4000-8000-000000000004',stage=1 WHERE id='98000000-0000-4000-8000-000000000005';
INSERT INTO issue_dependency (issue_id,depends_on_issue_id,type) VALUES ('98000000-0000-4000-8000-000000000005','98000000-0000-4000-8000-000000000004','blocks');
INSERT INTO chat_session (id,workspace_id,agent_id,creator_id,title) VALUES ('98000000-0000-4000-8000-000000000006','98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000003','98000000-0000-4000-8000-000000000001','Existing external conversation');
INSERT INTO chat_message (chat_session_id,role,content) VALUES ('98000000-0000-4000-8000-000000000006','user','Preserve external source text');
INSERT INTO agent_task_queue (id,agent_id,chat_session_id,runtime_id,status,originator_user_id,accountable_user_id,originator_source) VALUES ('98000000-0000-4000-8000-000000000007','98000000-0000-4000-8000-000000000003','98000000-0000-4000-8000-000000000006','98000000-0000-4000-8000-000000000013','completed','98000000-0000-4000-8000-000000000001','98000000-0000-4000-8000-000000000001','channel_integration');
INSERT INTO agent_task_queue (id,agent_id,runtime_id,status,originator_user_id,accountable_user_id,originator_source,retry_of_task_id) VALUES ('98000000-0000-4000-8000-000000000008','98000000-0000-4000-8000-000000000003','98000000-0000-4000-8000-000000000013','completed','98000000-0000-4000-8000-000000000001','98000000-0000-4000-8000-000000000001','channel_integration','98000000-0000-4000-8000-000000000007');
INSERT INTO channel_installation (id,workspace_id,agent_id,channel_type,installer_user_id,config) VALUES ('98000000-0000-4000-8000-000000000009','98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000003','feishu','98000000-0000-4000-8000-000000000001','{"conversation":{"id":"upgrade-grant","authorized_by":"98000000-0000-4000-8000-000000000001","scope":"workspace","chats":[{"chat_id":"oc_upgrade","chat_type":"group"}]}}');
INSERT INTO channel_task_delivery (task_id,binding_id,installation_id,channel_type,channel_chat_id,chat_type,route_revision,config)
 SELECT '98000000-0000-4000-8000-000000000007','98000000-0000-4000-8000-000000000019',id,'feishu','external/upgrade-grant/group/oc_upgrade','group',1,config || '{"chat_id":"oc_upgrade"}' FROM channel_installation WHERE id='98000000-0000-4000-8000-000000000009';
INSERT INTO issue_wakeup (id,workspace_id,issue_id,agent_id,created_by,instruction,kind,mode,event_types) VALUES ('98000000-0000-4000-8000-000000000010','98000000-0000-4000-8000-000000000002','98000000-0000-4000-8000-000000000004','98000000-0000-4000-8000-000000000003','98000000-0000-4000-8000-000000000001','Existing wakeup','event','continuous','{comment.created}');
COMMIT;
