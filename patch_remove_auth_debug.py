import re

with open('app.js', 'r', encoding='utf-8') as f:
    content = f.read()

auth_debug_block = """  // OAuth 리다이렉트 후 에러 확인용 디버그
  const urlHash = window.location.hash;
  const urlSearch = window.location.search;
  if (urlHash.includes('error') || urlSearch.includes('error')) {
    const errParams = new URLSearchParams(urlHash.replace('#', '?') || urlSearch);
    const errDesc = errParams.get('error_description') || errParams.get('error');
    if ($('#authError')) {
      $('#authError').innerHTML = '인증 에러: ' + decodeURIComponent(errDesc);
      $('#authError').style.display = 'block';
    }
    showToast('인증 에러가 발생했습니다.');
  }"""

if auth_debug_block in content:
    content = content.replace(auth_debug_block, "")
    print("Removed auth debug UI.")
else:
    print("Could not find auth debug UI.")

with open('app.js', 'w', encoding='utf-8') as f:
    f.write(content)
