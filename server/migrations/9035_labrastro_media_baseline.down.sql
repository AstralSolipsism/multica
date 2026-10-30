DROP TABLE IF EXISTS attachment_upload_part;
DROP TABLE IF EXISTS attachment_upload;
DROP TABLE IF EXISTS media_job_attempt;
DROP TABLE IF EXISTS media_job;
DROP TABLE IF EXISTS media_executor;
ALTER TABLE attachment DROP COLUMN IF EXISTS sha256;
