import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_boot = """  function boot() {
    if (typeof Paged === 'undefined') {"""
new_boot = """  function boot() {
    if (!document.body) return setTimeout(boot, 50);
    if (typeof Paged === 'undefined') {"""

if old_boot in content:
    content = content.replace(old_boot, new_boot, 1)
    print("Patched boot body check.")
else:
    print("Could not find boot func.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
