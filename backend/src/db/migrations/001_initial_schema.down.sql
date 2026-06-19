-- Reverses 001_initial_schema.up.sql. Drops tables in reverse dependency order.

DROP TABLE IF EXISTS ai_provider_logs;
DROP TABLE IF EXISTS template_questions;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS chat_sessions;
DROP TABLE IF EXISTS page_chunks;
DROP TABLE IF EXISTS page_facts;
DROP TABLE IF EXISTS pages;
DROP TABLE IF EXISTS crawl_jobs;
DROP TABLE IF EXISTS websites;
