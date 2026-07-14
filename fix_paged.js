const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

// We need to rewrite renderLivePodPreview and the srcdocScripts.
// Since it's a large block, it's best to replace it entirely.
const startIndex = js.indexOf('async function renderLivePodPreview() {');
const endIndex = js.indexOf('function updateSpineThickness(totalPages) {');
if (startIndex !== -1 && endIndex !== -1) {
  let newFunc = `
async function renderLivePodPreview(forceMode = null) {
  const p = currentProject();
  if(!p) return;
  
  if (p.episodes.some(e => e.body === undefined)) {
    const st = $('#podLiveRenderStatus');
    if(st) st.textContent = '내용 데이터를 불러오는 중...';
    await ensureProjectBodiesLoaded(p);
  }
  const loadedEps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if(loadedEps.length === 0) {
    $('#podLiveRenderStatus').textContent = '출판할 본문 내용이 없습니다.';
    return;
  }

  const activeTab = document.querySelector('.pod-settings-tab.active');
  const isTreeMode = forceMode === 'tree' || (activeTab && activeTab.dataset.pane === 'tree');

  $('#podLiveRenderStatus').textContent = isTreeMode ? '전체 조판 렌더링 중... (Paged.js)' : '미리보기 렌더링 중...';
  const iframe = document.getElementById('podLiveIframe');
  if(!iframe) return;
  const pubSet = getPublishSettings(p);
  
  const mainStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\\n');

  const paperKey = pubSet.paperSize || 'A5';
  const paper = PAPER_SIZES[paperKey] || PAPER_SIZES.A5;
  
  // Set iframe size based on mode
  if (isTreeMode) {
    iframe.style.width = (paper.w * 2) + 'mm';
  } else {
    iframe.style.width = paper.w + 'mm';
  }
  iframe.style.height = paper.h + 'mm';
  
  const canvasW = $('#podPreviewInner').clientWidth || window.innerWidth;
  const canvasH = $('#podPreviewInner').clientHeight || window.innerHeight;
  const targetW_px = (isTreeMode ? paper.w * 2 : paper.w) * (96 / 25.4);
  const paperH_px = paper.h * (96 / 25.4);
  const scale = Math.max(0.2, Math.min(1, (canvasW - 40) / targetW_px, (canvasH - 40) / paperH_px));
  iframe.style.transform = \`scale(\${scale})\`;

  // For preview mode, only render the first chapter to save time
  const epsToRender = isTreeMode ? loadedEps : [loadedEps[0]];
  const bodyContentHTML = generatePODBodyContent(p, pubSet, epsToRender);

  const srcdocScripts = \`
<script>window.PagedConfig = { auto: false };</script>
<script src="https://unpkg.com/pagedjs/dist/js/paged.polyfill.js"></script>
<style>
  .pagedjs_page { margin: 0 !important; border: none !important; box-shadow: 0 4px 16px rgba(0,0,0,0.1) !important; background: #fff !important; flex: 0 0 auto; }
  .pagedjs_left_page::after { content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 20px; background: linear-gradient(to left, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0) 100%); pointer-events: none; z-index: 10; }
  .pagedjs_right_page::after { content: ""; position: absolute; top: 0; left: 0; bottom: 0; width: 20px; background: linear-gradient(to right, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0) 100%); pointer-events: none; z-index: 10; }
</style>
<script>
let currentPolisher = null;
function runPaged() {
  if (typeof Paged === 'undefined' || typeof PagedPolyfill === 'undefined') {
    if (!window.pagedWaitCount) window.pagedWaitCount = 0;
    window.pagedWaitCount++;
    if (window.pagedWaitCount > 200) {
      window.parent.postMessage({ type: 'pagedjs-error', error: '스크립트 로드 실패: PagedJS가 로드되지 않았습니다.' }, '*');
      return;
    }
    setTimeout(runPaged, 50);
    return;
  }
  
  class LiveHandler extends Paged.Handler {
    afterRendered(pages) {
      try {
        var map = [];
        pages.forEach(function(p, idx) {
          var el = p.element || p.pageNode || p.wrapper;
          if (!el) return;
          var pgNum = parseInt(el.dataset ? el.dataset.pageNumber : el.getAttribute('data-page-number'), 10) || 0;
          var fmBlock = el.querySelector('.matter-page');
          var fmLabel = fmBlock ? fmBlock.getAttribute('data-fm-label') : null;
          var chTitle = el.querySelector('.chapter-title, .chapter-content h1');
          var label = fmLabel ? fmLabel : (chTitle ? chTitle.textContent.trim().substring(0,12) : pgNum+'쪽');
          map.push({ pageNum: parseInt(pgNum, 10), label: label, epTitle: chTitle ? chTitle.textContent.trim() : '' });
        });
        window.parent.postMessage({ type: 'pagedjs-rendered', totalPages: pages.length, pageMap: map, isTreeMode: \${isTreeMode} }, '*');
      } catch (err) {
        window.parent.postMessage({ type: 'pagedjs-error', error: 'afterRendered Error: ' + err.message }, '*');
      }
    }
  }
  Paged.registerHandlers(LiveHandler);
  window.parent.postMessage({ type: 'pagedjs-progress', pageNum: 1 }, '*');
  
  var originalHtml = document.body.innerHTML;
  document.body.innerHTML = '';
  var container = document.createElement('div');
  container.innerHTML = originalHtml;
  
  PagedPolyfill.preview(container, [], document.body).then(function() {
    document.body.style.overflow = 'hidden';
  }).catch(function(err) {
    window.parent.postMessage({ type: 'pagedjs-error', error: "Sync: " + err.message }, '*');
  });

  window.addEventListener('message', async function(ev) {
    if (!ev.data) return;
    
    if (ev.data.type === 'SHOW_PAGES') {
      var targetPage = parseInt(ev.data.pageNum, 10);
      var mode = ev.data.mode || (\${isTreeMode} ? 'spread' : 'single');
      var allPages = Array.from(document.querySelectorAll('.pagedjs_page'));
      allPages.forEach(function(p) { p.style.display = 'none'; p.style.position = ''; p.style.left = ''; p.style.right = ''; });
      
      if (mode === 'single') {
        allPages.forEach(function(el) {
          var pNum = parseInt(el.dataset ? el.dataset.pageNumber : el.getAttribute('data-page-number'), 10);
          if (pNum === targetPage) {
            el.style.display = 'block';
            el.style.position = 'absolute';
            el.style.top = '0';
            el.style.left = '0';
          }
        });
      } else {
        var leftPageNum = (targetPage % 2 === 0) ? targetPage : targetPage - 1;
        var rightPageNum = leftPageNum + 1;
        
        allPages.forEach(function(el) {
          var pNum = parseInt(el.dataset ? el.dataset.pageNumber : el.getAttribute('data-page-number'), 10);
          if (pNum === leftPageNum || pNum === rightPageNum) {
            el.style.display = 'block';
            el.style.position = 'absolute';
            el.style.top = '0';
            if (pNum % 2 === 0) el.style.left = '0';
            else el.style.right = '0';
          }
        });
      }
      window.scrollTo(0, 0);
    }
  });
}
runPaged();
</script>\`;

  let html = \`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=KoPub+Batang&family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
<style>
\${mainStyles}
</style>
<style>
  html, body { background: transparent !important; height: auto !important; overflow: visible !important; margin: 0; padding: 0; }
  .pagedjs_pages { display: flex; flex-wrap: wrap; justify-content: center; gap: 0; position: relative; width: 100%; height: 100%; }
  @page front-matter { @bottom-center { content: none; } }
  .bg-colored { page: front-matter; }
  @page {
    size: \${pubSet.paperSize || 'A5'};
    margin: \${pubSet.margins?.top||20}mm \${pubSet.margins?.outer||18}mm \${pubSet.margins?.bottom||20}mm \${pubSet.margins?.inner||25}mm;
    @bottom-center { content: counter(page); font-size: 9pt; font-family: 'KoPub Batang', 'Noto Serif KR', serif; }
  }
  @page:left { margin: \${pubSet.margins?.top||20}mm \${pubSet.margins?.inner||25}mm \${pubSet.margins?.bottom||20}mm \${pubSet.margins?.outer||18}mm; }
  @page:right { margin: \${pubSet.margins?.top||20}mm \${pubSet.margins?.outer||18}mm \${pubSet.margins?.bottom||20}mm \${pubSet.margins?.inner||25}mm; }
  @page:first { @bottom-center { content: none; } }
  @page cover { margin: 0; @bottom-center { content: none; } }
  body {
    font-family: 'KoPub Batang', 'Noto Serif KR', serif;
    font-size: \${pubSet.fontSize||10}pt;
    line-height: \${pubSet.lineHeight||1.75};
    color: #111; background: transparent !important; text-align: justify; word-break: keep-all;
  }
  .ql-align-center { text-align: center !important; }
  .ql-align-right { text-align: right !important; }
  .ql-align-justify { text-align: justify !important; }
  .cover-page { page: cover; break-after: right; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; width: 100%; background-color: \${p.coverColor || '#2c2c2c'}; color: #fff; }
  .title-page { break-before: right; break-after: page; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; text-align: center; }
  .title-page h1 { font-size: 24pt; margin-bottom: 20px; font-weight: 700; }
  .toc-page { break-before: right; break-after: page; padding-top: 40px; }
  .toc-page h2 { font-size: 16pt; font-weight: 700; margin-bottom: 40px; text-align: center; }
  .toc-list { list-style: none; padding: 0; margin: 0 20px; overflow-x: hidden; }
  .toc-list li { margin-bottom: 12px; font-size: 10pt; display: flex; align-items: baseline; }
  .toc-list li .toc-title { flex: 0 0 auto; }
  .toc-list li .toc-page-ref { color: inherit; text-decoration: none; flex: 0 0 auto; }
  .toc-list li .toc-dots { flex: 1 1 auto; border-bottom: 1px dotted #999; margin: 0 8px; position: relative; top: -4px; }
  .toc-list li .toc-page-ref::after { content: target-counter(attr(href), page); }
  .chapter { break-before: page; margin-top: 40px; }
  .chapter.matter-page { break-before: right; }
  .chapter-title { font-size: 14pt; font-weight: 700; margin-bottom: 30px; text-align: center; }
  .chapter-content span { background-color: transparent !important; }
  .chapter-content p { text-indent: 10pt !important; margin: 0 !important; word-break: keep-all; }
  .chapter-content h1, .chapter-content h3 { margin-top: 1.5em !important; margin-bottom: 1em !important; line-height: 1.4; }
  .chapter-content h2 { margin-top: 1.5em !important; margin-bottom: 2.75em !important; line-height: 1.4; }
  .chapter-content .ql-size-huge, .chapter-content .ql-size-large { display: block; margin-top: 1.5em !important; margin-bottom: 1em !important; line-height: 1.4; }
  .chapter-content p.pdf-group-isolated, .chapter-content p.pdf-group-last, .chapter-content .pdf-group-isolated, .chapter-content .pdf-group-last { margin-bottom: 24px !important; border-bottom-left-radius: 6px !important; border-bottom-right-radius: 6px !important; padding-bottom: 14px !important; }
  .chapter-content p.n-msg.pdf-group-isolated, .chapter-content p.n-msg.pdf-group-last, .chapter-content p.n-msg-y.pdf-group-isolated, .chapter-content p.n-msg-y.pdf-group-last, .chapter-content p.n-noti.pdf-group-isolated, .chapter-content p.n-noti.pdf-group-last { margin-bottom: 12px !important; padding-bottom: 10px !important; border-radius: 18px 18px 18px 2px !important; }
  .chapter-content p.pdf-group-first, .chapter-content p.pdf-group-middle, .chapter-content .pdf-group-first, .chapter-content .pdf-group-middle { margin-bottom: 0 !important; border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important; padding-bottom: 4px !important; }
  .chapter-content p.n-msg.pdf-group-first, .chapter-content p.n-msg.pdf-group-middle, .chapter-content p.n-msg-y.pdf-group-first, .chapter-content p.n-msg-y.pdf-group-middle, .chapter-content p.n-noti.pdf-group-first, .chapter-content p.n-noti.pdf-group-middle, .chapter-content p.n-email.pdf-group-first, .chapter-content p.n-email.pdf-group-middle { margin-bottom: 4px !important; border-bottom-left-radius: 6px !important; padding-bottom: 10px !important; }
  .chapter-content p.pdf-group-middle, .chapter-content p.pdf-group-last, .chapter-content .pdf-group-middle, .chapter-content .pdf-group-last { margin-top: 0 !important; border-top-left-radius: 0 !important; border-top-right-radius: 0 !important; padding-top: 4px !important; }
  .chapter-content p.n-msg.pdf-group-middle, .chapter-content p.n-msg.pdf-group-last, .chapter-content p.n-msg-y.pdf-group-middle, .chapter-content p.n-msg-y.pdf-group-last, .chapter-content p.n-noti.pdf-group-middle, .chapter-content p.n-noti.pdf-group-last, .chapter-content p.n-email.pdf-group-middle, .chapter-content p.n-email.pdf-group-last { border-top-left-radius: 6px !important; padding-top: 10px !important; }
  .chapter-content p.n-email-body.pdf-group-middle, .chapter-content p.n-email-body.pdf-group-last, .chapter-content p.n-doc.pdf-group-middle, .chapter-content p.n-doc.pdf-group-last { padding-left: 38px !important; }
  .ql-editor { padding: 0 !important; overflow-y: visible !important; height: auto !important; }
</style>
</head>
<body>
\${bodyContentHTML}
\${srcdocScripts}
</body>
</html>\`;

  // Always re-inject srcdoc to trigger reload with new content/mode
  iframe.removeAttribute('srcdoc');
  setTimeout(() => { iframe.srcdoc = html; }, 10);
  iframe.setAttribute('data-sandbox-initialized', 'true');
}

// ── pagedjs-rendered 메시지 수신 ──────────────────
window.addEventListener('message', (e) => {
  if (!e.data) return;
  
  if (e.data.type === 'pagedjs-progress') {
    const st = $('#podLiveRenderStatus');
    if (st) st.textContent = \`조판 렌더링 진행 중...\`;
    return;
  }
  
  if (e.data.type === 'pagedjs-rendered') {
    const iframe = document.getElementById('podLiveIframe');
    if (iframe) {
      const pubSet = getPublishSettings(currentProject());
      const paper = PAPER_SIZES[pubSet.paperSize || 'A5'] || PAPER_SIZES.A5;
      const isTreeMode = e.data.isTreeMode;
      iframe.style.width = (isTreeMode ? paper.w * 2 : paper.w) + 'mm';
      
      const canvasW = $('#podPreviewInner').clientWidth || window.innerWidth;
      const canvasH = $('#podPreviewInner').clientHeight || window.innerHeight;
      const targetW_px = (isTreeMode ? paper.w * 2 : paper.w) * (96 / 25.4);
      const paperH_px = paper.h * (96 / 25.4);
      const newScale = Math.max(0.2, Math.min(1, (canvasW - 40) / targetW_px, (canvasH - 40) / paperH_px));
      iframe.style.transform = \`scale(\${newScale})\`;
      
      if (isTreeMode) {
        window.podPageMap = e.data.pageMap;
        renderPodPageTree();
      }
      
      // 처음 렌더링 시 첫 번째 페이지 보이기
      iframe.contentWindow.postMessage({ type: 'SHOW_PAGES', pageNum: 1, mode: isTreeMode ? 'spread' : 'single' }, '*');
    }

    const st = $('#podLiveRenderStatus');
    if(st) st.textContent = \`렌더링 완료 ✓\`;
  } else if (e.data.type === 'pagedjs-error') {
    const st = $('#podLiveRenderStatus');
    if(st) st.textContent = \`렌더링 에러: \${e.data.error}\`;
  }
});

\n`;
  js = js.substring(0, startIndex) + newFunc + js.substring(endIndex);
  fs.writeFileSync('app.js', js);
  console.log('Successfully patched renderLivePodPreview.');
} else {
  console.error('Could not find boundaries.');
}
