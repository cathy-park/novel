
window.addEventListener('error', function(e) {
  setTimeout(() => showToast('에러: ' + e.message), 1000);
});
window.addEventListener('unhandledrejection', function(e) {
  setTimeout(() => showToast('Promise 에러: ' + e.reason), 1000);
});

