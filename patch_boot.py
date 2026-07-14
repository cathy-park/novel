import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_boot_trigger = """  document.addEventListener('DOMContentLoaded', boot);"""
new_boot_trigger = """  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }"""

if old_boot_trigger in content:
    content = content.replace(old_boot_trigger, new_boot_trigger, 1)
    print("Patched boot trigger.")
else:
    print("Could not find boot trigger.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
