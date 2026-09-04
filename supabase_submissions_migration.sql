-- 투고현황(출판사 투고 기록) 기능을 위한 마이그레이션
-- Supabase 대시보드 → SQL Editor에서 그대로 실행하세요.
-- (2026-09-04: novel_projects에 submissions(jsonb) 컬럼 추가)

alter table novel_projects add column if not exists submissions jsonb not null default '[]'::jsonb;

-- 서재 책 카드의 "투고중" 체크박스 상태. 이미 투고 기록(submissions)이 있는 작품은
-- 이 컬럼이 아직 없거나 null일 때 앱에서 자동으로 켜진 것으로 취급하므로(app.js
-- isSubmissionActive 참고) 마이그레이션 직후 기존 데이터가 사라지지 않는다.
alter table novel_projects add column if not exists submission_active boolean not null default false;
