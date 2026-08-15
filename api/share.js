const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://vsmqtpavcvabalrveqma.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzbXF0cGF2Y3ZhYmFscnZlcW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDEzNjksImV4cCI6MjA5NzQxNzM2OX0.TFvpFln-1QunLVpxAZgQIHcfsJjsK6Anal8kI4zETNk';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 카카오톡/텔레그램 같은 링크 미리보기 크롤러는 JS를 실행하지 않고 첫 응답 HTML의
 * <title>/og:* 태그만 읽는다. index.html은 정적 파일이라 항상 앱 고정 제목만 보여줬는데,
 * ?s=<slug> 공유 링크는 실제로는 작품마다 다른 페이지이므로 여기서 그 작품 제목으로
 * 서버에서 미리 바꿔치기해서 응답한다(사람이 브라우저로 열 때도 동일 HTML이라 문제없음).
 *
 * 다만 실제 사람이 쓰는 브라우저까지 이 Supabase 조회를 기다리게 하면 HTML 첫 바이트가
 * 늦어져 체감 로딩이 오히려 느려진다(og 태그는 크롤러에게만 의미가 있고, 사람 방문자는
 * 클라이언트 JS가 표지를 직접 그린다). 그래서 User-Agent로 링크 미리보기 크롤러일
 * 때만 이 조회를 기다리고, 일반 브라우저는 곧바로 정적 HTML을 응답한다.
 */
function isPreviewCrawler(userAgent) {
  return /kakaotalk|telegrambot|facebookexternalhit|twitterbot|slackbot|whatsapp|discordbot|linkedinbot|line\/|naver/i.test(String(userAgent || ''));
}

module.exports = async (req, res) => {
  const slug = req.query.s;
  const indexPath = path.join(process.cwd(), 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');

  if (slug && isPreviewCrawler(req.headers['user-agent'])) {
    try {
      const url = `${SUPABASE_URL}/rest/v1/novel_projects?select=title,cover&share_slug=eq.${encodeURIComponent(slug)}&is_public=eq.true`;
      const r = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
      const rows = await r.json();
      const project = Array.isArray(rows) ? rows[0] : null;

      if (project && project.title) {
        const title = escapeHtml(project.title);
        const desc = escapeHtml(`${project.title}을(를) 지금 바로 읽어보세요.`);
        html = html.replace(/<title>.*?<\/title>/, `<title>${title}</title>`);
        const ogTags = [
          `<meta property="og:title" content="${title}">`,
          `<meta property="og:description" content="${desc}">`,
          `<meta name="description" content="${desc}">`,
          project.cover ? `<meta property="og:image" content="${escapeHtml(project.cover)}">` : '',
        ].filter(Boolean).join('\n');
        html = html.replace('</head>', `${ogTags}\n</head>`);
      }
    } catch (e) {
      console.error('공유 미리보기 제목 생성 실패:', e);
      // 실패해도 기본 index.html 그대로 응답 — 뷰어 자체는 정상 동작해야 한다.
    }
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).send(html);
};
