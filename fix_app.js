const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

// Fix `pPub` in `generatePODBodyContent`
js = js.replace(
  /const pPub\s*=\s*escapeHtml\(c\.publisher \|\| pubSet\.frontMatter\?\.fmPublisher \|\| ''\);/,
  "const presetObj = POD_PRESETS[pubSet.preset] || {};\n    const pPub    = escapeHtml(c.publisher || pubSet.frontMatter?.fmPublisher || presetObj.name || '');"
);

// We need to change the initial tab in showPodStudio to 'cover'
const showPodStudioStart = js.indexOf('function showPodStudio() {');
const showPodStudioEnd = js.indexOf('function hidePodStudio() {');
if (showPodStudioStart !== -1 && showPodStudioEnd !== -1) {
  let funcBlock = js.substring(showPodStudioStart, showPodStudioEnd);
  
  // Replace the initialization logic
  funcBlock = funcBlock.replace(
    /$$('.pod-preview-tab').forEach[\s\S]*?\$\('#podPageToggleWrap'\)\.style\.display = 'flex';/,
    `$$('.pod-settings-tab').forEach(b => b.classList.remove('active'));
  const coverTab = document.querySelector('.pod-settings-tab[data-pane="cover"]');
  if (coverTab) coverTab.classList.add('active');
  
  $$('.pod-settings-pane').forEach(p => p.classList.remove('active'));
  if ($('#podPane-cover')) $('#podPane-cover').classList.add('active');

  // Trigger preview for cover
  renderLivePodPreview('cover');`
  );
  
  js = js.substring(0, showPodStudioStart) + funcBlock + js.substring(showPodStudioEnd);
}

// In renderLivePodPreview, if forceMode == 'cover' or activeTab is cover, show cover, else iframe
const renderPodPreviewStart = js.indexOf('async function renderLivePodPreview(forceMode = null) {');
const renderPodPreviewEnd = js.indexOf('function updateSpineThickness(totalPages) {');
if (renderPodPreviewStart !== -1 && renderPodPreviewEnd !== -1) {
  let funcBlock = js.substring(renderPodPreviewStart, renderPodPreviewEnd);
  
  funcBlock = funcBlock.replace(
    /const isTreeMode = forceMode === 'tree' || \(activeTab && activeTab\.dataset\.pane === 'tree'\);/,
    `const activePane = activeTab ? activeTab.dataset.pane : 'inner';
  const isTreeMode = forceMode === 'tree' || activePane === 'tree';
  const isCoverMode = forceMode === 'cover' || activePane === 'cover';
  const isFmMode = forceMode === 'fm' || activePane === 'fm';
  
  if (isCoverMode) {
    if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'block';
    if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'none';
    if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = 'none';
    return; // Cover handles its own preview
  } else {
    if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'none';
    if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'flex';
    if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = isTreeMode ? 'none' : 'flex';
  }`
  );
  
  // Fix the srcdocScripts script injection (put it in head, avoid polyfill execution error)
  funcBlock = funcBlock.replace(
    /<script>window\.PagedConfig = { auto: false };<\/script>\s*<script src="https:\/\/unpkg\.com\/pagedjs\/dist\/js\/paged\.polyfill\.js"><\/script>/,
    `<script>window.PagedConfig = { auto: false };</script>
<script src="https://unpkg.com/pagedjs/dist/js/paged.polyfill.js"></script>`
  );
  
  // Also we need to make sure the HTML template puts scripts in head
  funcBlock = funcBlock.replace(
    /<body>\n\${bodyContentHTML}\n\${srcdocScripts}\n<\/body>/,
    `<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=KoPub+Batang&family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
\${srcdocScripts}
<style>
\${mainStyles}
</style>
... // We'll just manually replace this part since it's cleaner to rewrite the template`
  );

  js = js.substring(0, renderPodPreviewStart) + funcBlock + js.substring(renderPodPreviewEnd);
}

fs.writeFileSync('app.js', js);
console.log('App.js modified partially.');
