import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Append css to <style> tag
new_css = """
  .ql-editor img {
    max-width: 100% !important;
    width: 100% !important;
    height: auto !important;
    display: block;
    margin: 1rem auto;
  }
"""

if "ql-editor img" not in content:
    content = content.replace("</style>", new_css + "</style>", 1)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patched index.html CSS.")
