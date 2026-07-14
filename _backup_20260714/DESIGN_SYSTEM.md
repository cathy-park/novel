# 야니의 소설창고 v5 디자인 시스템

AIXIT의 시각 언어에서 참고한 **잉크 블랙, 차가운 뉴트럴, 아이스 블루·라일락·연핑크 파스텔 포인트, 얇은 보더와 절제된 선택 상태**를 기준으로 한다.

## 브랜드

- 이름: `야니의 소설창고`
- 아이콘: 펼친 책 + 작은 펜촉
- 아이콘 의미: 책은 여러 작품을 쌓아두는 ‘창고’, 펜촉은 집필 행위를 상징한다.
- 아이콘 배경: Ice Blue → Lilac → Soft Pink 브랜드 그래디언트
- 아이콘 선: Ink / Neutral 900

## 컬러 토큰

- Ink / Neutral 900: `#17141F`
- Neutral 700: `#454650`
- Neutral 600: `#686A76`
- Neutral 500: `#858793`
- Neutral 300: `#D4D7E0`
- Neutral 200: `#E4E6ED`
- Neutral 100: `#F2F3F7`
- Neutral 50: `#F8F8FB`
- Primary 700: `#5949D1`
- Primary 600: `#6B5CE7`
- Primary 500: `#7C6DF2`
- Primary 100: `#ECE8FF`
- Ice Blue: `#BFEAFF`
- Soft Pink: `#FFD7E8`
- Success: `#258265`
- Danger: `#C94F68`

## 책 표지 컬러

단색 표지는 기본 디자인 시스템과 분리된 작품 식별 컬러로 사용한다.

기본 프리셋:

- Ink `#17141F`
- Violet `#6B5CE7`
- Blue `#6D9DF6`
- Cyan `#5CB6C9`
- Green `#46A57F`
- Pink `#F39AB9`
- Peach `#F5B86C`
- Lavender `#B4A5FF`
- Slate `#8C91A5`
- Cool Gray `#E4E6ED`

사용자는 컬러 피커로 임의의 단색 컬러도 지정할 수 있다. 표지 이미지가 존재하면 이미지가 단색보다 우선 표시되며, 이미지를 제거하면 저장된 단색 컬러 표지로 복귀한다.

## 사용 원칙

1. 메인 CTA는 잉크 블랙을 사용한다.
2. 보라색은 활성 상태, 포커스, 선택 상태에 제한한다.
3. 아이스 블루·연핑크는 브랜드 그래디언트와 브랜드 아이콘에 제한한다.
4. 넓은 면적 배경은 흰색 또는 Neutral 50을 사용한다.
5. 모든 입력 포커스는 Primary 500 + 12% 링으로 통일한다.
6. 상태 칩은 의미별 소프트 배경과 1px 보더를 사용한다.
7. 작품 표지 컬러는 사용자의 작품 구분을 돕는 식별 수단으로 자유롭게 허용한다.

## 컴포넌트

- Button radius: 8px
- Input radius: 10px
- Card radius: 12px
- Modal radius: 16px
- Large surface radius: 22px
- 기본 border: Neutral 200, 1px
- 선택 border: Primary 200~300
- 기본 그림자: `0 1px 2px rgba(23,20,31,.04)`
- 강조 그림자: `0 18px 50px rgba(23,20,31,.09)`

## 타이포그래피

Pretendard → Apple SD Gothic Neo → System Sans 순서. 명조체는 사용하지 않는다.

본문은 17px / line-height 2, UI 본문은 11~14px, 화면 제목은 28~40px 범위로 사용한다.
