/**
 * 공유 링크의 실제 도메인(novel-iota-mauve.vercel.app)을 안 보이게 is.gd로 줄여준다.
 * TinyURL은 처음 보는 링크에 중간 안내 페이지를 보여줄 때가 있어(이탈 유발) is.gd로 바꿨다 —
 * is.gd는 중간 페이지 없이 바로 리다이렉트되는 것으로 잘 알려져 있다.
 * 브라우저에서 직접 부르면 CORS가 막을 수 있어 서버(이 함수)에서 대신 호출한다.
 * 임의의 url을 받지 않고 slug만 받아 서버가 직접 우리 도메인 링크를 만든다 —
 * 이 엔드포인트가 아무 URL이나 줄여주는 공개 프록시로 악용되지 않게 하기 위함이다.
 */
module.exports = async (req, res) => {
  const slug = req.query.slug;
  if (!slug || typeof slug !== 'string' || !/^[a-z0-9]+$/i.test(slug)) {
    res.status(400).json({ error: '유효하지 않은 slug입니다.' });
    return;
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const longUrl = `https://${host}/share?s=${slug}`;

  async function tryShorten(apiUrl) {
    const r = await fetch(apiUrl);
    const text = (await r.text()).trim();
    if (!r.ok || !text.startsWith('http')) throw new Error('단축 서비스 응답 이상: ' + text);
    return text;
  }

  // is.gd가 중간 안내 페이지 없이 바로 리다이렉트돼 1순위지만, 가끔 일시적으로 에러를
  // 낼 때가 있어(예: "database insert failed") TinyURL을 예비로 둔다.
  try {
    res.status(200).json({ shortUrl: await tryShorten(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`) });
  } catch (e1) {
    console.error('is.gd 단축 실패, TinyURL로 재시도:', e1);
    try {
      res.status(200).json({ shortUrl: await tryShorten(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`) });
    } catch (e2) {
      console.error('TinyURL도 실패:', e2);
      res.status(200).json({ shortUrl: null, longUrl });
    }
  }
};
