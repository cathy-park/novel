import re
with open('index.html', 'r', encoding='utf-8') as f:
    text = f.read()

# Find the first POD Publishing Studio header
pattern = re.compile(r'(// ============================================================\n//  POD Publishing Studio — Phase 1\n//  Split View 출판 스튜디오 로직\n// ============================================================).*?(// ============================================================\n//  POD Publishing Studio — Phase 1\n//  Split View 출판 스튜디오 로직\n// ============================================================)', re.DOTALL)

def replacement(match):
    return """
// Publish Settings Logic
function getPublishSettings(p) {
  return p.publishSettings || { paperSize: 'A5', includeCover: true, autoTOC: true, showTitle: false };
}

function calculateSpineWidth(p) {
  const eps = p.episodes || [];
  let estimatedPages = 0;
  
  for (const e of eps) {
    if (!e.body) continue;
    const textLen = e.body.replace(/<[^>]*>?/gm, '').length;
    let epPages = Math.max(2, Math.ceil(textLen / 350));
    estimatedPages += epPages;
  }
  
  estimatedPages += 10;
  return Math.max(1, Math.round(estimatedPages * 0.05 * 10) / 10);
}

""" + match.group(2)

new_text = pattern.sub(replacement, text, count=1)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(new_text)
print("Garbage block removed and functions injected.")
