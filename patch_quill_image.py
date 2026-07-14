import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add image to toolbar
old_toolbar = "['bold', 'italic', 'underline', 'strike', 'ui', 'hideicon', 'divider'],"
new_toolbar = "['bold', 'italic', 'underline', 'strike', 'ui', 'hideicon', 'divider', 'image'],"
content = content.replace(old_toolbar, new_toolbar)

# 2. Add custom image handler
old_divider_handler = """    quill.getModule('toolbar').addHandler('divider', function() {"""
new_divider_image_handler = """    // Custom Image Handler for Compression and Resizing
    quill.getModule('toolbar').addHandler('image', function() {
      const input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', 'image/*');
      input.click();
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        showToast('이미지 최적화 중...');
        try {
          const compressedDataUrl = await compressImage(file, 1200); // Max width 1200px
          const range = quill.getSelection(true);
          quill.insertEmbed(range.index, 'image', compressedDataUrl, Quill.sources.USER);
          quill.setSelection(range.index + 1, Quill.sources.SILENT);
          showToast('이미지가 삽입되었습니다.');
        } catch (e) {
          console.error(e);
          showToast('이미지 처리 실패');
        }
      };
    });

    quill.getModule('toolbar').addHandler('divider', function() {"""
content = content.replace(old_divider_handler, new_divider_image_handler)

# 3. Add compressImage function somewhere
compress_func = """
// ── 이미지 압축 함수 ────────────────────────────
async function compressImage(file, maxWidth = 1200) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = event => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxWidth) {
          h = Math.round((h * maxWidth) / w);
          w = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = error => reject(error);
    };
    reader.onerror = error => reject(error);
  });
}
"""
if "compressImage(" not in content:
    content += compress_func

# 4. Handle paste/drop images inside Quill (convert to compressed)
paste_handler = """
    quill.root.addEventListener('paste', async (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf('image') === 0) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            showToast('붙여넣은 이미지 최적화 중...');
            const compressedDataUrl = await compressImage(file, 1200);
            const range = quill.getSelection(true);
            quill.insertEmbed(range.index, 'image', compressedDataUrl, Quill.sources.USER);
            quill.setSelection(range.index + 1, Quill.sources.SILENT);
          }
        }
      }
    });
"""
if "addEventListener('paste'" not in content:
    content = content.replace("quill.on('text-change',", paste_handler + "\n    quill.on('text-change',")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patched Quill image handler.")
