import re
with open('index.html', 'r', encoding='utf-8') as f:
    text = f.read()

with open('/tmp/recovered_block.js', 'r', encoding='utf-8') as f:
    recovered = f.read()

# recovered includes "async function showPodStudio() {" at the start and "function podSaveSettings() {" at the end.
# We will match the same in index.html.
pattern = re.compile(r'async function showPodStudio\(\) \{.*?function podSaveSettings\(\) \{', re.DOTALL)
new_text = pattern.sub(recovered.strip(), text)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(new_text)

print("Replacement done.")
