const fs = require('fs');
let js = fs.readFileSync('app.js', 'utf8');

// We need to ensure that renderLivePodPreview('cover') in showPodStudio is delayed slightly if the viewer element isn't fully drawn,
// but the current implementation already has: `renderLivePodPreview('cover');` 
// Let's replace it with a delayed version to match the previous behavior, avoiding blank screens on initial load.
const target = "renderLivePodPreview('cover');";
if (js.includes(target)) {
  js = js.replace(target, "setTimeout(() => { renderLivePodPreview('cover'); }, 300);");
  fs.writeFileSync('app.js', js);
  console.log('Added delay to initial render');
} else {
  console.log('Target string not found');
}
