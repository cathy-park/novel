import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_body_css = """  .chapter-content p { text-indent:10pt !important; margin:0 !important; }
  .ql-editor { padding:0 !important; overflow-y:visible !important; height:auto !important; }`;"""

new_body_css = """  .chapter-content p { text-indent:10pt !important; margin:0 !important; }
  .ql-editor { padding:0 !important; overflow-y:visible !important; height:auto !important; }
  img { max-width: 100% !important; width: 100% !important; height: auto !important; display: block; margin: 10px auto; }`;"""

if old_body_css in content:
    content = content.replace(old_body_css, new_body_css, 1)
    print("Patched app.js bodyCSS for images.")
else:
    print("Could not find bodyCSS in app.js.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
