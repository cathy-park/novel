/**
 * 공유 링크의 실제 도메인(novel-iota-mauve.vercel.app)을 안 보이게 TinyURL로 줄여준다.
 * 브라우저에서 TinyURL API를 직접 부르면 CORS가 막을 수 있어 서버(이 함수)에서 대신 호출한다.
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

  try {
    const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
    const text = (await r.text()).trim();
    if (!r.ok || !text.startsWith('http')) throw new Error('TinyURL 응답 이상: ' + text);
    res.status(200).json({ shortUrl: text });
  } catch (e) {
    console.error('단축 URL 생성 실패:', e);
    res.status(200).json({ shortUrl: null, longUrl });
  }
};
