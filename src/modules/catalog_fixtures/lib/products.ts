import path from 'node:path'

/**
 * Real beverage products for the demo catalog.
 *
 * Unlike the barcodes in `./barcodes`, these GTINs are the genuine EAN-13 codes
 * printed on the packaging, so a scan in the warehouse panel resolves to the
 * product a picker is actually holding. The images live in the repository
 * (see `public/fixtures/catalog/README.md` for their source and license) rather
 * than being downloaded at seed time — a fixture run must not depend on a
 * third-party host being up.
 */
export const FIXTURE_MEDIA_ROOT = path.join(process.cwd(), 'public', 'fixtures', 'catalog')

/** Tried in order against the organization's unit dictionary; first hit wins. */
export const PREFERRED_UNIT_CODES = ['szt', 'pc', 'unit'] as const

export type BeverageDimensions = {
  width: number
  height: number
  depth: number
  unit: string
}

export type BeverageFixture = {
  handle: string
  sku: string
  title: string
  subtitle: string
  description: string
  seoTitle: string
  seoDescription: string
  /** Genuine EAN-13 from the packaging. */
  barcode: string
  countryOfOriginCode: string
  /** File name inside `FIXTURE_MEDIA_ROOT`. */
  image: string
  variantName: string
  /** Gross weight of one sellable unit, in kilograms. */
  weightKg: number
  dimensions: BeverageDimensions
  /** Net volume in litres, used for the unit price reference. */
  volumeLitres: number
}

export const BEVERAGE_PRODUCTS: BeverageFixture[] = [
  {
    handle: 'red-bull-bez-cukru-250ml',
    sku: 'RB-ZERO-250',
    title: 'Red Bull Bez Cukru 250 ml',
    subtitle: 'Napój energetyzujący w puszce, bez cukru',
    description:
      'Red Bull Bez Cukru to klasyczny napój energetyzujący w wersji bez cukru, w poręcznej '
      + 'puszce 250 ml. Zawiera kofeinę, taurynę i witaminy z grupy B, a zamiast cukru użyto '
      + 'substancji słodzących. Sprawdza się w pracy, w podróży i podczas nauki — podawaj '
      + 'dobrze schłodzony.',
    seoTitle: 'Red Bull Bez Cukru 250 ml puszka',
    seoDescription:
      'Napój energetyzujący Red Bull bez cukru w puszce 250 ml. Kofeina, tauryna '
      + 'i witaminy z grupy B bez dodatku cukru.',
    barcode: '9002490287566',
    countryOfOriginCode: 'AT',
    image: 'red-bull-sugarfree-250ml.jpg',
    variantName: 'Puszka 250 ml',
    weightKg: 0.27,
    dimensions: { width: 5.3, height: 13.4, depth: 5.3, unit: 'cm' },
    volumeLitres: 0.25,
  },
  {
    handle: 'sprite-330ml',
    sku: 'SPRITE-330',
    title: 'Sprite 330 ml',
    subtitle: 'Gazowany napój o smaku cytryny i limonki',
    description:
      'Sprite w puszce 330 ml to gazowany napój bezalkoholowy o orzeźwiającym smaku cytryny '
      + 'i limonki, bez barwników. Najlepiej smakuje mocno schłodzony, z lodem i plasterkiem '
      + 'cytryny. Poręczna puszka sprawdza się w gastronomii, w sklepach convenience '
      + 'i w automatach sprzedających.',
    seoTitle: 'Sprite 330 ml puszka',
    seoDescription:
      'Gazowany napój Sprite o smaku cytrynowo-limonkowym w puszce 330 ml. '
      + 'Orzeźwienie bez barwników.',
    barcode: '5000112683059',
    countryOfOriginCode: 'GB',
    image: 'sprite-330ml.jpg',
    variantName: 'Puszka 330 ml',
    weightKg: 0.35,
    dimensions: { width: 5.3, height: 16.8, depth: 5.3, unit: 'cm' },
    volumeLitres: 0.33,
  },
  {
    handle: 'zywiec-zdroj-niegazowana-500ml',
    sku: 'ZZ-NGAZ-500',
    title: 'Żywiec Zdrój Woda Źródlana Niegazowana 500 ml',
    subtitle: 'Naturalna woda źródlana w butelce PET',
    description:
      'Żywiec Zdrój to naturalna woda źródlana o delikatnym, zrównoważonym składzie '
      + 'mineralnym. Butelka PET 500 ml mieści się w kieszeni plecaka i w samochodowym '
      + 'uchwycie na napoje. Wersja niegazowana — dla tych, którzy piją wodę przez cały dzień.',
    seoTitle: 'Żywiec Zdrój niegazowana 500 ml',
    seoDescription:
      'Naturalna woda źródlana Żywiec Zdrój niegazowana w butelce PET 500 ml. '
      + 'Delikatny skład mineralny na co dzień.',
    barcode: '5900541012348',
    countryOfOriginCode: 'PL',
    image: 'zywiec-zdroj-niegazowana-500ml.jpg',
    variantName: 'Butelka PET 500 ml',
    weightKg: 0.52,
    dimensions: { width: 6.5, height: 21.5, depth: 6.5, unit: 'cm' },
    volumeLitres: 0.5,
  },
  {
    handle: 'coca-cola-330ml',
    sku: 'COKE-330',
    title: 'Coca-Cola 330 ml',
    subtitle: 'Klasyczny napój gazowany typu cola',
    description:
      'Coca-Cola w puszce 330 ml — gazowany napój typu cola o oryginalnym smaku, z kofeiną. '
      + 'Podawaj mocno schłodzoną, z lodem i plasterkiem cytryny. Puszka 330 ml to standard '
      + 'w gastronomii, sklepach convenience i automatach sprzedających.',
    seoTitle: 'Coca-Cola 330 ml puszka',
    seoDescription:
      'Coca-Cola w puszce 330 ml — oryginalny smak coli z kofeiną, gotowy do podania '
      + 'na zimno.',
    barcode: '5000112677973',
    countryOfOriginCode: 'GB',
    image: 'coca-cola-330ml.jpg',
    variantName: 'Puszka 330 ml',
    weightKg: 0.35,
    dimensions: { width: 5.3, height: 16.8, depth: 5.3, unit: 'cm' },
    volumeLitres: 0.33,
  },
  {
    handle: 'zywiec-zdroj-mocny-gaz-500ml',
    sku: 'ZZ-MGAZ-500',
    title: 'Żywiec Zdrój Woda Źródlana Mocno Gazowana 500 ml',
    subtitle: 'Woda źródlana mocno nasycona dwutlenkiem węgla',
    description:
      'Żywiec Zdrój Mocny Gaz to naturalna woda źródlana mocno nasycona dwutlenkiem węgla, '
      + 'w butelce PET 500 ml. Wyraźne bąbelki dobrze gaszą pragnienie i sprawdzają się '
      + 'do rozcieńczania soków oraz syropów. Przed otwarciem nie wstrząsać, podawać schłodzoną.',
    seoTitle: 'Żywiec Zdrój mocny gaz 500 ml',
    seoDescription:
      'Naturalna woda źródlana Żywiec Zdrój mocno gazowana w butelce PET 500 ml. '
      + 'Wyraźne nasycenie CO2 dla mocnego orzeźwienia.',
    barcode: '5900541012508',
    countryOfOriginCode: 'PL',
    image: 'zywiec-zdroj-mocny-gaz-500ml.jpg',
    variantName: 'Butelka PET 500 ml',
    weightKg: 0.52,
    dimensions: { width: 6.5, height: 21.5, depth: 6.5, unit: 'cm' },
    volumeLitres: 0.5,
  },
]
