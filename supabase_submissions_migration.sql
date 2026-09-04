-- 투고현황(출판사 투고 기록) 기능을 위한 마이그레이션
-- Supabase 대시보드 → SQL Editor에서 그대로 실행하세요.
-- (2026-09-04: novel_projects에 submissions(jsonb) 컬럼 추가)

alter table novel_projects add column if not exists submissions jsonb not null default '[]'::jsonb;
