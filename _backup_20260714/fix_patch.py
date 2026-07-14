import re

with open("index.html", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Sidebar button
content = content.replace(
    '<button id="openManuscriptBtn" class="secondary" type="button">전체 원고 보기</button>',
    '<button id="openPublishSettingsFromEditorBtn" class="ghost" style="background:#6B5CE7; color:#fff;" type="button">📐 출판 스튜디오</button>\n      <button id="openManuscriptBtn" class="secondary" type="button">전체 원고 보기</button>'
)

# 2. Topbar button
content = content.replace(
    '<button id="openPCEbookBtn" class="ghost" type="button">📖 이북 뷰어</button>\n        <button id="toggleDrawerBtn" class="ghost" type="button">기획 ▤</button>',
    '<button id="openPCEbookBtn" class="ghost" type="button">📖 이북 뷰어</button>\n        <button id="openPublishSettingsTopBtn" class="ghost" style="background:#6B5CE7; color:#fff;" type="button">📐 출판 스튜디오</button>\n        <button id="toggleDrawerBtn" class="ghost" type="button">기획 ▤</button>'
)

# 3. renderProjectPlan list change
content = content.replace(
    "const p = currentProject(), list = $('#projectPlanList'), sections = p.planSections||[];",
    "const p = currentProject(), list = $('#planBodyWrapper'), sections = p.planSections||[];"
)

# 4. renderPCCommentList list change
content = content.replace(
    "const list = $('#projectCommentList');",
    "const list = $('#commentBodyWrapper');"
)

# 5. toggleDrawerBtn to closePlanDrawerBtn in one line
content = content.replace(
    "if ($('#closeDrawerBtn')) $('#closeDrawerBtn').onclick = togglePlanDrawer;",
    "if ($('#closePlanDrawerBtn')) $('#closePlanDrawerBtn').onclick = togglePlanDrawer;"
)

# 6. Tab toggles
content = content.replace(
    "  if($('#projectPlanList')) $('#projectPlanList').classList.remove('hidden');\n  $('#planToolbar').classList.remove('hidden');\n  if($('#projectCommentList')) $('#projectCommentList').classList.add('hidden');",
    "  $('#planBodyWrapper').style.display = 'flex';\n  $('#planToolbar').classList.remove('hidden');\n  $('#commentBodyWrapper').style.display = 'none';"
)
content = content.replace(
    "  if($('#projectCommentList')) $('#projectCommentList').classList.remove('hidden');\n  if($('#projectPlanList')) $('#projectPlanList').classList.add('hidden');\n  $('#planToolbar').classList.add('hidden');",
    "  $('#commentBodyWrapper').style.display = 'flex';\n  $('#planBodyWrapper').style.display = 'none';\n  $('#planToolbar').classList.add('hidden');"
)

# 7. runPaged replacements
# The patch is quite large for runPaged, but I'll use regex.
import re

run_paged_regex = re.compile(r'function runPaged\(\) \{.*?\n<\/script>', re.DOTALL)
run_paged_new = """function runPaged() {
  if (typeof Paged === 'undefined' || typeof PagedPolyfill === 'undefined') {
    if (!window.pagedWaitCount) window.pagedWaitCount = 0;
    window.pagedWaitCount++;
    if (window.pagedWaitCount > 100) {
      window.parent.postMessage({ type: 'pagedjs-error', error: '스크립트 로드 실패: PagedJS가 5초 이상 로드되지 않았습니다.' }, '*');
      return;
    }
    window.setTimeout(runPaged, 50);
    return;
  }
  window.parent.postMessage({ type: 'pagedjs-progress', pageNum: 0 }, '*');
  class LiveHandler extends Paged.Handler {
    afterRendered(pages) {
      try {
        if (window.podProgressTimer) clearInterval(window.podProgressTimer);
        var map = [];
        pages.forEach(function(p, idx) {
          var el = p.element || p.pageNode || p.wrapper;
          if (!el) return;
          
          var pgNum = parseInt(el.dataset ? el.dataset.pageNumber : el.getAttribute('data-page-number'), 10) || 0;
          if (el.style) {
            if (pgNum !== 1) {
              el.style.display = 'none';
            } else {
              el.style.position = 'absolute';
              el.style.top = '0';
              el.style.right = '0';
            }
          }

          var fmBlock = el.querySelector('.matter-page');
          var fmLabel = fmBlock ? fmBlock.getAttribute('data-fm-label') : null;
          var epBlock = el.querySelector('[data-ep-id]');
          var chTitle = el.querySelector('.chapter-title, .chapter-content h1');
          var epTitle = epBlock ? (epBlock.getAttribute('data-ep-title') || '') : (chTitle ? chTitle.textContent.trim() : '');
          var label = fmLabel ? fmLabel : (epTitle ? epTitle.substring(0,12) : pgNum+'쪽');
          map.push({
            pageNum: parseInt(pgNum, 10),
            label: label,
            epTitle: epTitle,
            epId: epBlock ? epBlock.getAttribute('data-ep-id') : '',
            epType: epBlock ? epBlock.getAttribute('data-ep-type') : '',
            fmLabel: fmLabel || ''
          });
        });
        window.parent.postMessage({ type: window.podSliceMode ? 'pagedjs-slice-rendered' : 'pagedjs-rendered', totalPages: pages.length, pageMap: map }, '*');
      } catch (err) {
        window.parent.postMessage({ type: 'pagedjs-error', error: 'afterRendered Error: ' + err.message }, '*');
      }
    }
  }
  try {
    Paged.registerHandlers(LiveHandler);
  } catch(err) {
    window.parent.postMessage({ type: 'pagedjs-error', error: 'Handler Error: ' + err.message }, '*');
  }
  function showSpread(pageNum) {
    var targetSpread = [];
    if (pageNum === 1) targetSpread = [1];
    else if (pageNum % 2 === 0) targetSpread = [pageNum, pageNum + 1];
    else targetSpread = [pageNum - 1, pageNum];

    var allPages = document.querySelectorAll('.pagedjs_page');
    allPages.forEach(function(p) { p.style.display = 'none'; p.style.position = ''; p.style.left = ''; p.style.right = ''; });

    targetSpread.forEach(function(num) {
      var el = document.querySelector('.pagedjs_page[data-page-number="' + num + '"]');
      if (el) {
        el.style.display = 'block';
        el.style.position = 'absolute';
        el.style.top = '0';
        if (num % 2 === 0) el.style.left = '0';
        else el.style.right = '0';
      }
    });
    window.scrollTo(0, 0);
  }

  function showFirstRenderedSpread(startPage) {
    var allPages = Array.from(document.querySelectorAll('.pagedjs_page'));
    allPages.forEach(function(p) { p.style.display = 'none'; p.style.position = ''; p.style.left = ''; p.style.right = ''; });
    allPages.slice(0, 2).forEach(function(el, idx) {
      var actualPage = startPage + idx;
      el.style.display = 'block';
      el.style.position = 'absolute';
      el.style.top = '0';
      if (actualPage % 2 === 0) el.style.left = '0';
      else el.style.right = '0';
    });
    window.scrollTo(0, 0);
  }

  window.addEventListener('message', function(ev) {
    if (!ev.data) return;
    if (ev.data.type === 'pod-scroll-to-page') {
      showSpread(parseInt(ev.data.page, 10));
      return;
    }
    if (ev.data.type === 'pod-render-slice') {
      var source = document.getElementById('podSource');
      if (!source || typeof PagedPolyfill === 'undefined') return;
      var startPage = Math.max(1, parseInt(ev.data.startPage, 10) || 1);
      var counterStyle = document.getElementById('podPageCounterStyle');
      if (counterStyle) counterStyle.textContent = 'body { counter-reset: page ' + (startPage - 1) + '; }';
      document.querySelectorAll('.pagedjs_pages, .pagedjs_page').forEach(function(el) { el.remove(); });
      source.innerHTML = ev.data.html || '';
      window.podSliceMode = true;
      window.parent.postMessage({ type: 'pagedjs-progress', pageNum: 0 }, '*');
      PagedPolyfill.preview(source, [], document.body).then(function(flow) {
        showFirstRenderedSpread(startPage);
      }).catch(function(err) {
        window.parent.postMessage({ type: 'pagedjs-error', error: 'slice preview: ' + err.message }, '*');
      });
    }
  });

  window.podProgressTimer = setInterval(function() {
    var count = document.querySelectorAll('.pagedjs_page').length;
    if (count > 0) {
      try { window.parent.postMessage({ type: 'pagedjs-progress', pageNum: count }, '*'); } catch(err) {}
    }
  }, 250);
  try {
    window.podSliceMode = false;
    var source = document.getElementById('podSource') || document.body;
    PagedPolyfill.preview(source, [], document.body).catch(function(e) {
      try { window.parent.postMessage({ type: 'pagedjs-error', error: 'preview catch: ' + e.message }, '*'); } catch(e2) {}
    });
  } catch (err) {
    try { window.parent.postMessage({ type: 'pagedjs-error', error: "Sync: " + err.message }, '*'); } catch(e2) {}
  }
}
runPaged();
</script>"""
content = run_paged_regex.sub(run_paged_new, content)

# 8. Add <style id="podPageCounterStyle"></style> <div id="podSource">
content = content.replace(
    '</style>\n </head>\n <body>\n`;\n\n  html += generatePODBodyContent(p, pubSet, loadedEps);',
    '</style>\n </head>\n <body>\n<style id="podPageCounterStyle"></style>\n<div id="podSource">\n`;\n\n  html += generatePODBodyContent(p, pubSet, loadedEps);\n  html += `</div>`;'
)

# 9. Modify tree rendering in renderPodPageTree
content = content.replace(
    "if (window.podPageMap && window.podPageMap.length > 0) {\n    // 렌더링 완료: postMessage로 받은 실제 페이지 맵 사용\n    window.podPageMap.forEach(pg => {\n      let isFm = false;\n      const FM_LABELS = ['속표지', '본표지', '판권지', '목차', '헌정', '제사', '여백'];\n      if (FM_LABELS.includes(pg.label)) isFm = true;\n      pagesData.push({ pageNum: pg.pageNum, label: pg.label, sublabel: pg.epTitle || '', type: isFm ? 'fm' : 'inner', accent: isFm ? '#7c6bf6' : null });\n    });",
    """if (window.podPageMap && window.podPageMap.length > 0) {
    // 렌더링 완료: postMessage로 받은 실제 페이지 맵 사용
    const seenBlocks = new Set();
    window.podPageMap.forEach(pg => {
      const FM_LABELS = ['속표지', '본표지', '판권지', '목차', '헌정', '제사', '여백'];
      const isFm = FM_LABELS.includes(pg.label) || !!pg.fmLabel;
      const blockKey = pg.epId ? `ep:${pg.epId}` : `fm:${pg.fmLabel || pg.label}:${pg.pageNum}`;
      if (seenBlocks.has(blockKey)) return;
      seenBlocks.add(blockKey);
      pagesData.push({
        pageNum: pg.pageNum,
        label: pg.label,
        sublabel: pg.epTitle || '',
        type: isFm ? 'fm' : 'inner',
        accent: isFm ? '#7c6bf6' : null,
        epId: pg.epId || '',
        epType: pg.epType || '',
        fmLabel: pg.fmLabel || ''
      });
    });"""
)

# Also update the postMessage inside renderPodPageTree
content = content.replace(
    "        // postMessage로 iframe 내부에 스크롤 요청\n        const liveIframe = document.getElementById('podLiveIframe');\n        if (liveIframe?.contentWindow) {\n          liveIframe.contentWindow.postMessage({ type: 'pod-scroll-to-page', page: data.pageNum }, '*');\n        }",
    """        const liveIframe = document.getElementById('podLiveIframe');
        if (liveIframe?.contentWindow) {
          const sliceHtml = generatePODSliceContent(p, set, data);
          if (sliceHtml) {
            liveIframe.contentWindow.postMessage({ type: 'pod-render-slice', html: sliceHtml, startPage: data.pageNum }, '*');
          } else {
            liveIframe.contentWindow.postMessage({ type: 'pod-scroll-to-page', page: data.pageNum }, '*');
          }
        }"""
)

# 10. Update generatePODBodyContent loops and generatePODEpisodeContent
content = content.replace(
    """  // 5. 본문 (목차 이후의 회차 및 뒷부속)
  afterTocEps.forEach((ep, i) => {
    const processed = processEpisodeBody(ep.body, ep.title, true);
    const isMatter = ep.type === 'frontmatter' || ep.type === 'backmatter';
    const renderTitle = !isMatter && pubSet.showTitle && !processed.hasTitle;
    const displayTitle = getEpisodeDisplayTitle(ep, p);
    
    bodyHtml += `
  <div class="chapter ${isMatter ? 'matter-page' : ''}">
    ${renderTitle ? `<div class="chapter-title" id="ep-${ep.id}">${escapeHtml(displayTitle)}</div>` : `<div class="chapter-title" id="ep-${ep.id}" style="display:none;"></div>`}
    <div class="chapter-content ql-editor">${processed.body}</div>
  </div>`;
  });""",
    """  // 5. 본문 (목차 이후의 회차 및 뒷부속)
  afterTocEps.forEach((ep, i) => {
    bodyHtml += generatePODEpisodeContent(p, pubSet, ep);
  });"""
)

# Append generatePODEpisodeContent and generatePODSliceContent before exportPODPdf
content = content.replace(
    "async function exportPODPdf(isSilent = false) {",
    """function generatePODEpisodeContent(p, pubSet, ep) {
  const processed = processEpisodeBody(ep.body, ep.title, true);
  const isMatter = ep.type === 'frontmatter' || ep.type === 'backmatter';
  const renderTitle = !isMatter && pubSet.showTitle && !processed.hasTitle;
  const displayTitle = getEpisodeDisplayTitle(ep, p);
  const typeAttr = escapeHtml(ep.type || 'chapter');

  return `
  <div class="chapter ${isMatter ? 'matter-page' : ''}" data-ep-id="${escapeHtml(ep.id)}" data-ep-type="${typeAttr}" data-ep-title="${escapeHtml(displayTitle)}">
    ${renderTitle ? `<div class="chapter-title" id="ep-${ep.id}">${escapeHtml(displayTitle)}</div>` : `<div class="chapter-title" id="ep-${ep.id}" style="display:none;">${escapeHtml(displayTitle)}</div>`}
    <div class="chapter-content ql-editor">${processed.body}</div>
  </div>`;
}

function generatePODSliceContent(p, pubSet, slice) {
  if (!slice) return '';
  if (slice.epId) {
    const ep = orderedEpisodes(p).find(e => e.id === slice.epId);
    if (!ep) return '';
    return generatePODEpisodeContent(p, pubSet, ep);
  }
  return '';
}

async function exportPODPdf(isSilent = false) {"""
)

# 11. Settings button bindings
content = content.replace(
    "$('#openPublishSettingsBtn').onclick = showPodStudio;",
    "$('#openPublishSettingsBtn').onclick = showPodStudio;\nif ($('#openPublishSettingsFromEditorBtn')) $('#openPublishSettingsFromEditorBtn').onclick = () => { persistEditor(); queueSaveFS(); showPodStudio(); };\nif ($('#openPublishSettingsTopBtn')) $('#openPublishSettingsTopBtn').onclick = () => { persistEditor(); queueSaveFS(); showPodStudio(); };"
)


with open("index.html", "w", encoding="utf-8") as f:
    f.write(content)
print("Patch applied successfully.")
