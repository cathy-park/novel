-- 이북 뷰어 공유 링크 기능을 위한 마이그레이션
-- Supabase 대시보드 → SQL Editor에서 그대로 실행하세요.
-- (2026-08-15: share_slug, short_url 컬럼 + 올바른 공개 읽기 정책 재생성)

alter table novel_projects add column if not exists is_public boolean not null default false;
alter table novel_projects add column if not exists share_slug text unique;
alter table novel_projects add column if not exists short_url text;

drop policy if exists "public projects readable" on novel_projects;
create policy "public projects readable" on novel_projects
  as permissive
  for select
  to anon, authenticated
  using (is_public = true);

drop policy if exists "episodes of public projects readable" on novel_episodes;
create policy "episodes of public projects readable" on novel_episodes
  as permissive
  for select
  to anon, authenticated
  using (
    exists (select 1 from novel_projects p where p.id = novel_episodes.project_id and p.is_public = true)
  );
