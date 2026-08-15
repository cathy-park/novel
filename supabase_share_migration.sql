-- 이북 뷰어 공유 링크 기능을 위한 마이그레이션
-- Supabase 대시보드 → SQL Editor에서 그대로 실행하세요.
-- (2026-08-15 추가: 링크를 짧게 만들기 위한 share_slug 컬럼)

alter table novel_projects add column if not exists is_public boolean not null default false;
alter table novel_projects add column if not exists share_slug text unique;

drop policy if exists "public projects readable" on novel_projects;
create policy "public projects readable" on novel_projects
  for select using (is_public = true);

drop policy if exists "episodes of public projects readable" on novel_episodes;
create policy "episodes of public projects readable" on novel_episodes
  for select using (
    exists (select 1 from novel_projects p where p.id = novel_episodes.project_id and p.is_public = true)
  );
