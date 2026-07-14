$('#openManuscriptBtn').onclick = () => {
  persistEditor(); queueSaveFS();
  $('#editorView').classList.add('hidden'); $('#manuscriptView').classList.add('active');
  const eps = orderedEpisodes().filter(e=>cleanText(e.body));
  $('#manuscriptTitle').textContent = currentProject().title;
  $('#manuscriptMeta')async function showPodStudio() {
  const p = currentProject(); if(!p) return;
  const set = getPublishSettings(p);

  // 브레드크럼
  $('#podStudioBreadcrumb').textContent = p.title;

  // 기존 설정값 반영
  const margins = set.margins || { top: 20, bottom: 20, inner: 25, outer: 18, bleed: 3 };
  $('#podPaperSize').value = set.paperSize || 'A5';
  $('#podMarginTop').value = margins.top;
  $('#podMarginBottom').value = margins.bottom;
  $('#podMarginInner').value = margins.inner;
  $('#podMarginOuter').value = margins.outer;
  $('#podBleed').value = margins.bleed !== undefined ? margins.bleed : 3;
  $('#podFontSize').value = set.fontSize || 10;
  $('#podLineHeight').value = set.lineHeight || '1.75';
  $('#podAutoTOC').checked = set.autoTOC !== false;
  $('#podShowTitle').checked = !!set.showTitle;

  // 전면부 블록 초기화
  initFmBlocks(p);
  renderFmBlockList();

  // 표지 설정
  $('#podCoverBgColor').value = set.coverOptions?.bgColor || '#2c2c2c';
  $('#podCoverBgColorHex').value = set.coverOptions?.bgColor || '#2c2c2c';
  $('#podSpineFont').value = set.coverOptions?.spineFont || "'KoPub Batang', serif";
  const spineW = calculateSpineWidth(p);
  $('#podSpineWidth').value = set.coverOptions?.spineWidthMm || spineW;
  $('#podSpineCalcText').textContent = `(자동 계산: ${spineW}mm)`;
  $('#podPublisherLogo').value = set.coverOptions?.logo || '';
  if ($('#podLogoOptions')) {
    $('#podLogoOptions').style.display = set.coverOptions?.logo ? 'block' : 'none';
    $('#podLogoFrontSize').value = set.coverOptions?.logoFrontSize || 7;
    $('#podLogoFrontBottom').value = set.coverOptions?.logoFrontBottom || 15;
    $('#podLogoSpineRatio').value = set.coverOptions?.logoSpineRatio || 60;
    $('#podLogoSpineBottom').value = set.coverOptions?.logoSpineBottom || 15;
  }

  // 기타 탭 통계
  const estPages = podEstimatePages(p);
  $('#podEstPages').textContent = estPages;
  $('#podEstSpine').textContent = Math.max(1, Math.round(estPages * 0.05 * 10) / 10);

  // 이미지 로드 (표지) - async 로딩 보장
  const loadImg = src => src ? new Promise(res => {
    const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = src;
  }) : Promise.resolve(null);
  
  const coverOptions = set.coverOptions || {};
  
  [currentFrontCoverObj, currentBackCoverObj] = await Promise.all([
    loadImg(coverOptions.frontOriginal),
    loadImg(coverOptions.backOriginal)
  ]);

  // 화면 전환: manuscriptView를 숨기고 podStudioView를 활성화
  $('#manuscriptView').classList.remove('active');
  $('#editorView').classList.add('hidden');
  $('#podStudioView').classList.add('active');

  // 초기 미리보기 업데이트
  podUpdatePreview();
  podUpdateCoverPreview();
}s.width = Math.round(canvasW_mm * MM_TO_PX * scaleRatio);
  canvas.height = Math.round(canvasH_mm * MM_TO_PX * scaleRatio);
  const ctx = canvas.getContext('2d');
  ctx.scale(scaleRatio, scaleRatio);

  const fullW = Math.round(canvasW_mm * MM_TO_PX);
  const fullH = Math.round(canvasH_mm * MM_TO_PX);

  ctx.fillStyle = opts.bgColor || '#2c2c2c';
  ctx.fillRect(0, 0, fullW, fullH);

  const backCoverW = Math.round((BLEED_MM + paperW) * MM_TO_PX);
  const spineX = backCoverW;
  const spineW_px = Math.round(spineW * MM_TO_PX);
  const frontX = spineX + spineW_px;
  const frontCoverW = Math.round((paperW + BLEED_MM) * MM_TO_PX);

  const loadImg = (src) => new Promise((resolve) => {
    if(!src) return resolve(null);
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src;
  });

  const frontImg = currentFrontCoverObj || await loadImg(opts.frontOriginal);
  const backImg = currentBackCoverObj || await loadImg(opts.backOriginal);
  const logoImg = await loadImg(opts.logo);

  if (frontImg) {
    const scale = Math.max(frontCoverW / frontImg.width, fullH / frontImg.height);
    const dw = frontImg.width * scale; const dh = frontImg.height * scale;
    const dx = frontX + (frontCoverW - dw) / 2; const dy = (fullH - dh) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(frontX, 0, frontCoverW, fullH); ctx.clip();
    ctx.drawImage(frontImg, dx, dy, dw, dh); ctx.restore();
  }
  if (backImg) {
    const scale = Math.max(backCoverW / backImg.width, fullH / backImg.height);
    const dw = backImg.width * scale; const dh = backImg.height * scale;
    const dx = (backCoverW - dw) / 2; const dy = (fullH - dh) / 2;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, backCoverW, fullH); ctx.clip();
    ctx.drawImage(backImg, dx, dy, dw, dh); ctx.restore();
  }

  // 책등 텍스트
  const title = p.title || '제목 없음';
  const author = set.frontMatter?.author || '저자';
  const spineFont = opts.spineFont || "'KoPub Batang', serif";
  
  ctx.save();
  ctx.fillStyle = (opts.bgColor || '#2c2c2c').toLowerCase() === '#ffffff' ? '#000' : '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const titleFontSize = Math.min(Math.max(16, spineW_px * 0.4), spineW_px * 0.8);
  ctx.font = `bold ${titleFontSize}px ${spineFont}`;
  
  let startY = fullH * 0.15; // 상단 여백
  for (let i = 0; i < title.length; i++) {
    if (title[i] === ' ') { startY += titleFontSize * 0.5; continue; }
    ctx.fillText(title[i], spineX + spineW_px / 2, startY);
    startY += titleFontSize * 1.1; // 줄간격
  }
  
  const authorFontSize = Math.min(Math.max(12, spineW_px * 0.3), spineW_px * 0.6);
  ctx.font = `normal ${authorFontSize}px ${spineFont}`;
  
  startY += titleFontSize * 1.5; // 제목과 저자 사이 여백
  for (let i = 0; i < author.length; i++) {
    if (author[i] === ' ') { startY += authorFontSize * 0.5; continue; }
    ctx.fillText(author[i], spineX + spineW_px / 2, startY);
    startY += authorFontSize * 1.1;
  }
  
  if (opts.logo && logoImg) {
    const spineRatio = (opts.logoSpineRatio || 60) / 100;
    const spineBottomMm = opts.logoSpineBottom ?? 15;
    const logoW = spineW_px * spineRatio;
    const logoH = logoImg.height * (logoW / logoImg.width);
    const sLy = fullH - Math.round((BLEED_MM + spineBottomMm) * MM_TO_PX) - logoH;
    ctx.drawImage(logoImg, spineX + (spineW_px - logoW) / 2, sLy, logoW, logoH);

    const frontLogoW_mm = opts.logoFrontSize ?? 7;
    const frontBottomMm = opts.logoFrontBottom ?? 15;
    const frontLogoW = Math.round(frontLogoW_mm * MM_TO_PX);
    const frontLogoH = logoImg.height * (frontLogoW / logoImg.width);
    const fLx = frontX + (frontCoverW - frontLogoW) / 2;
    const fLy = fullH - Math.round((BLEED_MM + frontBottomMm) * MM_TO_PX) - frontLogoH;
    ctx.drawImage(logoImg, fLx, fLy, frontLogoW, frontLogoH);
  }
  ctx.restore();

  // 미리보기 시 도련선(Bleed line) 표시 (점선)
  const bleedPx = Math.round(BLEED_MM * MM_TO_PX);
  ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
  ctx.lineWidth = 4;
  ctx.setLineDash([10, 10]);
  ctx.strokeRect(bleedPx, bleedPx, fullW - bleedPx*2, fullH - bleedPx*2);
  
  // 미리보기 시 책등 경계선 표시
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.beginPath();
  ctx.moveTo(spineX, 0); ctx.lineTo(spineX, fullH);
  ctx.moveTo(spineX + spineW_px, 0); ctx.lineTo(spineX + spineW_px, fullH);
  ctx.stroke();

  return canvas.toDataURL('image/jpeg', 0.85);
}

if ($('#pubIncludeCover')) $('#pubIncludeCover').onchange = (e) => { $('#pubCoverOptions').style.display = e.target.checked ? 'flex' : 'none'; };
$('#pubShowCopyright').onchange = (e) => { $('#pubCopyrightOptions').style.display = e.target.checked ? 'flex' : 'none'; };

function updateCoverPreviewRender() {
  const p = currentProject(); if(!p) return;
  const set = getPublishSettings(p);
  
  // exportPODPdf update logic would use:
  // fmOrder: [
  //   { id: 'half_title', name: '속표지 (책 제목)', active: true },
  //   { id: 'title_page', name: '본표지 (제목, 저자, 출판사)', active: true },
  //   { id: 'copyright', name: '판권지', active: true },
  //   { id: 'toc', name: '목차', active: true }
  // ],
  // author:        $('#podAuthor').value,
  // publishDate:   $('#podPublishDate').value,
  // fmTitle:       $('#podFmTitle').value,
  // fmSubtitle:    $('#podFmSubtitle').value,
  // fmPublisher:   $('#podFmPublisher').value,
  // fmBgColor:     $('#podFmBgColor').value
  // ... and style="transform: center; .copyright { font-size: 8pt !important; }"

  generateCoverPreview(p, set).then(b64 => {
    $('#pubCoverImagePreview').src = b64;
    $('#pubCoverImagePreview').style.display = 'block';
    $('#pubCoverImagePreview').dataset.base64 = b64;
  });
}
$('#pubPaperSize').addEventListener('change', updateCoverPreviewRender);
$('#pubSpineWidth').addEventListener('input', updateCoverPreviewRender);

let currentFrontCoverObj = null;
let currentBackCoverObj = null;

$('#pubSpineWidth').addEventListener('input', updateCoverPreviewRender);
$('#pubCoverBgColor').addEventListener('input', (e) => {
  $('#pubCoverBgColorHex').value = e.target.value;
  updateCoverPreviewRender();
});
$('#pubCoverBgColorHex').addEventListener('input', (e) => {
  if (/^#[0-9A-Fa-f]{6}$/i.test(e.target.value)) {
    $('#pubCoverBgColor').value = e.target.value;
    updateCoverPreviewRender();
  }
});
$('#pubSpineFont').addEventListener('change', updateCoverPreviewRender);

$('#pubFrontCoverInput').onchange = (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => { currentFrontCoverObj = img; updateCoverPreviewRender(); };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
};

$('#pubBackCoverInput').onchange = (e) => {
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    const img = new Image();
    img.onload = () => { currentBackCoverObj = img; updateCoverPreviewRender(); };
    img.src = event.target.result;
  };
  reader.readAsDataURL(file);
};

// ============================================================
//  POD Publishing Studio — Phase 1
//  Split View 출판 스튜디오 로직
// ============================================================

// ── 출판사 프리셋 데이터 ──────────────────────────────────────
const POD_PRESETS = {
  purple: {
    name: '교보 퍼플',
    paperSize: 'A5',
    margins: { top: 20, bottom: 20, inner: 25, outer: 18, bleed: 3 }
  },
  bookcube: {
    name: '부크크',
    paperSize: 'A5',
    margins: { top: 20, bottom: 20, inner: 22, outer: 17, bleed: 0 }
  },
  onehyphen: {
    name: '원하이프레스',
    paperSize: 'A5',
    margins: { top: 18, bottom: 18, inner: 23, outer: 16, bleed: 3 }
  }
};

// ── mm → px 변환 (화면 축척 기준) ────────────────────────────
const PREVIEW_SCALE = 1; // 화면 내 1mm = PREVIEW_SCALE px (JS에서 계산)
let podPreviewScale = 1;

function mmToPreviewPx(mm) {
  return mm * podPreviewScale;
}

// ── 용지 크기 매핑 ────────────────────────────────────────────
const PAPER_SIZES = {
  A5: { w: 148, h: 210 },
  B6: { w: 128, h: 182 }
};

// ── 스튜디오 열기 ─────────────────────────────────────────────
