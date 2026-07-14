$('#openManuscriptBtn').onclick = () => {
  persistEditor(); queueSaveFS();
  $('#editorView').classList.add('hidden'); $('#manuscriptView').classList.add('active');
  const eps = orderedEpisodes().filter(e=>cleanText(e.body));
  $('#manuscriptTitle').textContent = currentProject().title;
  $('#manuscriptMeta').textContent = `총 ${eps.reduce((s,e)=>s+stats(e.body).withSpaces,0).toLocaleString()}자 · ${eps.length}회차`;
  $('#manuscriptContent').innerHTML = eps.map(e=>`<article class="manuscript-ep"><div class="ql-editor">${e.body||''}</div></article>`).join('');
};
$('#backFromManuscript').onclick = showEditor;
$('#copyManuscriptFull').onclick = () => {
  const mdText = orderedEpisodes().filter(e => cleanText(e.body)).map(e => getMarkdownForEpisode(e)).join('\n\n\n');
  copyText(mdText, '전체 본문을 복사했어요. (마크다운)');
};

// Publish Settings Logic
function getPublishSettings(p) {
  return p.publishSettings || { paperSize: 'A5', includeCover: true, autoTOC: true, showTitle: false };
}
$('#openPublishSettingsBtn').onclick = () => {
  const p = currentProject(); if(!p) return;
  const set = getPublishSettings(p);
  $('#pubPaperSize').value = set.paperSize;
  $('#pubIncludeCover').checked = set.includeCover;
  $('#pubAutoTOC').checked = set.autoTOC;
  $('#pubShowTitle').checked = set.showTitle;
  openModal('publishSettingsModal');
};
$('#savePublishSettingsBtn').onclick = () => {
  const p = currentProject(); if(!p) return;
  p.publishSettings = {
    paperSize: $('#pubPaperSize').value,
    includeCover: $('#pubIncludeCover').checked,
    autoTOC: $('#pubAutoTOC').checked,
    showTitle: $('#pubShowTitle').checked
  };
  touchProject(); queueSaveFS();
  closeModal('publishSettingsModal');
  showToast('출판 설정이 저장되었습니다.');
};

$('#exportPODBtn').onclick = exportPODPdf;
function processEpisodeBody(html, epTitle, isForPublishing = false) {
  if (!html) return { body: '', hasTitle: false };
  
  // <br> 태그를 문단 분리(</p><p>)로 정규화하여 빈 줄 감지를 정확하게 함
  let normalizedHtml = html;
  if (isForPublishing) {
    normalizedHtml = html.replace(/<br\s*\/?>/gi, '</p><p>');
  }
  
  const div = document.createElement('div');
  div.innerHTML = normalizedHtml;

  // 1. 빈 리스트 삭제
  div.querySelectorAll('li').forEach(li => {
    if (!li.textContent.trim() && !li.querySelector('img')) li.remove();
  });
  div.querySelectorAll('ul, ol').forEach(list => {
    if (list.children.length === 0) list.remove();
  });

  // 2. 서사 블록 그룹화 (PDF용 Fallback)
  const nClasses = ['n-msg', 'n-msg-y', 'n-sys', 'n-log', 'n-alert', 'n-record', 'n-status', 'n-email', 'n-email-body', 'n-doc', 'n-noti', 'n-field', 'n-memo'];
  const els = Array.from(div.children);
  for (let i = 0; i < els.length; i++) {
    const cur = els[i];
    for (let cls of nClasses) {
      const isCls = cur.classList.contains(cls) || cur.querySelector('.' + cls);
      if (isCls) {
        const prev = els[i-1], next = els[i+1];
        const pIsCls = prev && (prev.classList.contains(cls) || prev.querySelector('.' + cls));
        const nIsCls = next && (next.classList.contains(cls) || next.querySelector('.' + cls));
        
        let target = cur.classList.contains(cls) ? cur : cur.querySelector('.' + cls);
        if (pIsCls && nIsCls) target.classList.add('pdf-group-middle');
        else if (pIsCls && !nIsCls) target.classList.add('pdf-group-last');
        else if (!pIsCls && nIsCls) target.classList.add('pdf-group-first');
        else target.classList.add('pdf-group-isolated'); // 단독 블록
        break;
      }
    }
  }

  // 3. 제목 중복 체크 (첫 번째 의미 있는 헤딩)
  let hasTitle = false;
  if (epTitle) {
    const norm = (s) => s.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    const titleNorm = norm(epTitle);
    
    // 1. 헤딩 태그 검사
    const headings = div.querySelectorAll('h1, h2');
    if (headings.length > 0) {
      const firstH = headings[0];
      let isFirstMeaningful = true;
      for (const cur of els) {
        if (cur === firstH) break;
        if (cur.textContent.trim() !== '') {
           isFirstMeaningful = false; break;
        }
      }
      if (isFirstMeaningful && norm(firstH.textContent) === titleNorm) {
        hasTitle = true;
        firstH.remove(); // 제목을 본문에서 아예 제거! (중복 방지)
      }
    }
    
    // 2. 만약 헤딩이 아니더라도 첫 번째 단락(p)이 제목과 똑같다면 제거
    if (!hasTitle && els.length > 0) {
      for (const cur of els) {
        if (cur.textContent.trim() !== '') {
          if (norm(cur.textContent) === titleNorm) {
            hasTitle = true;
            cur.remove(); // 첫 번째 단락이 제목이면 제거
          }
          break; // 첫 의미있는 요소만 검사
        }
      }
    }
  }

  // 4. 종이책용 연속된 빈 줄 정리 (웹소설식 1칸 띄어쓰기 완전 제거)
  if (isForPublishing) {
    let emptyNodes = [];
    Array.from(div.children).forEach(child => {
      // 빈 문자열이거나 nbsp(\u00A0) 등만 있는 문단 감지
      if (child.tagName === 'P' && !child.textContent.replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, '').trim() && !child.querySelector('img')) {
        emptyNodes.push(child);
      } else {
        if (emptyNodes.length === 1) {
          emptyNodes[0].remove(); // 단일 빈 줄은 일반 문단 바꿈이므로 제거
        } else if (emptyNodes.length > 1) {
          // 2개 이상의 빈 줄은 장면 전환(Scene break)이므로 1개만 남기고 모두 제거
          for (let i = 1; i < emptyNodes.length; i++) {
            emptyNodes[i].remove();
          }
        }
        emptyNodes = [];
      }
    });
    emptyNodes.forEach(node => node.remove()); // 마지막 빈 줄 제거
  }

  return { body: div.innerHTML, hasTitle };
}

async function exportPODPdf() {
  const p = currentProject();
  if(!p) return;
  
  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (eps.length === 0) return showToast('출판할 본문이 없습니다.');
  
  // 브라우저 팝업 차단 우회를 위해 await 전에 창을 띄웁니다.
  const win = window.open('', '_blank');
  if (!win) {
    showToast('팝업 차단을 해제하고 다시 시도해주세요.');
    return;
  }
  win.document.write('<div style="text-align:center; padding:50px; font-family:sans-serif;">PDF 변환을 준비 중입니다. 잠시만 기다려주세요...<br><br><small>본문 데이터가 많을 경우 수 초가 소요될 수 있습니다.</small></div>');

  if (p.episodes.some(e => e.body === undefined)) {
    showToast('PDF 생성을 위해 데이터를 불러오는 중입니다...');
    await ensureProjectBodiesLoaded(p);
  }
  
  const loadedEps = orderedEpisodes(p).filter(e => cleanText(e.body));
  
  showToast('PDF 변환을 준비 중입니다... 새 창을 허용해주세요.');
  
  const mainStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\n');
  const pubSet = getPublishSettings(p);
  
  let html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${escapeHtml(p.title)} - 출판용 원고</title>
<link href="https://fonts.googleapis.com/css2?family=KoPub+Batang&family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/toss/tossface/dist/tossface.css">
<style>
${mainStyles}
</style>
<script src="https://unpkg.com/pagedjs/dist/js/paged.polyfill.js"></${'script'}>
<style>
  @page {
    size: ${pubSet.paperSize};
    margin: 20mm 15mm 20mm 15mm;
    @bottom-center {
      content: counter(page);
      font-size: 9pt;
      font-family: 'KoPub Batang', 'Noto Serif KR', serif;
    }
  }
  @page:first {
    @bottom-center { content: none; }
  }
  @page cover {
    margin: 0;
    @bottom-center { content: none; }
  }
  body {
    font-family: 'KoPub Batang', 'Noto Serif KR', serif;
    font-size: 10pt;
    line-height: 1.75;
    color: #111;
    background: #fff;
    text-align: justify;
    word-break: keep-all;
  }
  .cover-page {
    page: cover;
    break-after: right;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    width: 100%;
    background-color: ${p.coverColor || '#2c2c2c'};
    color: #fff;
  }
  .title-page {
    break-before: right;
    break-after: page;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    text-align: center;
  }
  .title-page h1 { font-size: 24pt; margin-bottom: 20px; font-weight: 700; }
  .toc-page {
    break-before: right;
    break-after: page;
    padding-top: 40px;
  }
  .toc-page h2 {
    font-size: 16pt;
    font-weight: 700;
    margin-bottom: 40px;
    text-align: center;
  }
  .toc-list {
    list-style: none;
    padding: 0;
    margin: 0 20px;
    overflow-x: hidden;
  }
  .toc-list li {
    margin-bottom: 12px;
    font-size: 10pt;
  }
  .toc-title {
    color: inherit;
    text-decoration: none;
    display: block;
  }
  .toc-title::after {
    content: leader('.') target-counter(attr(href), page);
  }
  .toc-prefix {
    color: #888;
    margin-right: 6px;
  }
  .chapter {
    break-before: page;
    margin-top: 40px;
  }
  .chapter.matter-page {
    break-before: right;
  }
  .chapter-title {
    font-size: 14pt;
    font-weight: 700;
    margin-bottom: 30px;
    text-align: center;
  }
  .chapter-content p {
    text-indent: 10pt !important;
    margin: 0 !important;
    word-break: keep-all;
  }
