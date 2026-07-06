// Słowniki: identyfikatory atrybutów Cinema City → polskie etykiety.

export const FORMAT_LABELS = {
  imax: 'IMAX',
  '4dx': '4DX',
  screenx: 'ScreenX',
  vip: 'VIP',
  '2d': '2D',
  '3d': '3D',
  'dolby-atmos': 'Dolby Atmos',
  'laser-barco': 'Laser',
  superscreen: 'SuperScreen',
};

export const LANG_LABELS = {
  dubbed: 'dubbing',
  subbed: 'napisy',
  voiceover: 'lektor',
  'no-subs': 'bez napisów',
};

export const GENRE_LABELS = {
  action: 'akcja',
  adventure: 'przygodowy',
  animation: 'animacja',
  biography: 'biograficzny',
  comedy: 'komedia',
  'black-comedy': 'czarna komedia',
  crime: 'kryminał',
  documentary: 'dokument',
  drama: 'dramat',
  family: 'familijny',
  fantasy: 'fantasy',
  history: 'historyczny',
  horror: 'horror',
  musical: 'musical',
  music: 'muzyczny',
  mystery: 'tajemnica',
  romance: 'romans',
  'sci-fi': 'sci-fi',
  sport: 'sportowy',
  thriller: 'thriller',
  war: 'wojenny',
  western: 'western',
};

export const STATUS_INFO = {
  premiere: { label: 'Premiera', cls: 'badge-premiere' },
  new: { label: 'Nowość', cls: 'badge-new' },
  upcoming: { label: 'Zapowiedź', cls: 'badge-upcoming' },
  retro: { label: 'Powtórka', cls: 'badge-retro' },
  regular: null,
};

export const fmtLabel = (id) => FORMAT_LABELS[id] ?? id.toUpperCase();
export const genreLabel = (id) => GENRE_LABELS[id] ?? id;
export const langLabel = (id) => (id ? LANG_LABELS[id] ?? id : null);
