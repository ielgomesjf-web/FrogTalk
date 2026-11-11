'use strict';
/* Figurinhas de sapo em pixel art (24x24), desenhadas por código e convertidas em PNG na hora.
   Na mensagem só vai o nome da figurinha (ex.: "kkk"), então quase não gasta internet. */
const FIGURINHAS = (() => {
  const T = 24;
  const C = {
    o: '#1d4d22', g: '#5bbf4f', s: '#46a043', l: '#a5e88f', w: '#ffffff', k: '#141414',
    r: '#e8364f', p: '#ff9bb8', m: '#7a1f2e', t: '#ff5d7a', a: '#56b6ff', y: '#ffd23f', x: '#7c3aed',
  };
  const grade = () => Array.from({ length: T }, () => Array(T).fill(null));
  const px = (g, x, y, c) => { if (x >= 0 && y >= 0 && x < T && y < T) g[y][x] = c; };
  const pontos = (g, lista, c) => lista.forEach(([x, y]) => px(g, x, y, c));
  function elipse(g, cx, cy, rx, ry, c) {
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) g[y][x] = c;
    }
  }
  function contorno(g, c) {
    const n = g.map(l => l.slice());
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      if (g[y][x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < T && yy < T && g[yy][xx]) { n[y][x] = c; break; }
      }
    }
    return n;
  }
  function sprite(g, x0, y0, linhas) {
    linhas.forEach((l, y) => [...l].forEach((ch, x) => { if (ch !== '.') px(g, x0 + x, y0 + y, C[ch]); }));
  }
  function juntar(g, por) { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (por[y][x]) g[y][x] = por[y][x]; }

  // letrinhas 3x5
  const FONTE = {
    K: ['101', '110', '100', '110', '101'], G: ['111', '100', '101', '101', '111'], O: ['111', '101', '101', '101', '111'],
    I: ['111', '010', '010', '010', '111'], Z: ['111', '001', '010', '100', '111'], '!': ['1', '1', '1', '0', '1'],
    '?': ['111', '001', '011', '000', '010'],
  };
  function texto(g, x, y, str, cor) {
    const t = grade();
    let cx = x;
    for (const ch of str) {
      const f = FONTE[ch];
      f.forEach((l, yy) => [...l].forEach((b, xx) => { if (b === '1') px(t, cx + xx, y + yy, cor); }));
      cx += f[0].length + 1;
    }
    juntar(g, contorno(t, C.w));
  }
  const coracao = ['.r.r.', 'rrrrr', 'rrrrr', '.rrr.', '..r..'];

  // ---------- partes do sapo ----------
  function corpo(g) {
    elipse(g, 12, 16, 10.5, 7.4, C.g);
    elipse(g, 7, 10, 4.2, 4.2, C.g);
    elipse(g, 17, 10, 4.2, 4.2, C.g);
    for (let y = 21; y < T; y++) for (let x = 0; x < T; x++) if (g[y][x]) g[y][x] = C.s;
    elipse(g, 12, 20, 6, 2.6, C.l);
  }
  const bochechas = g => pontos(g, [[4, 17], [5, 17], [18, 17], [19, 17]], C.p);
  function olhos(g, tipo) {
    for (const ex of [7, 17]) {
      const d = ex - 7; // 0 no olho esquerdo, 10 no direito
      if (['normal', 'baixo', 'cima', 'grande', 'bravo'].includes(tipo)) elipse(g, ex, 10, 2.7, 2.7, C.w);
      if (tipo === 'normal' || tipo === 'bravo') { pontos(g, [[6 + d, 9], [7 + d, 9], [6 + d, 10], [7 + d, 10]], C.k); px(g, 6 + d, 9, C.w); }
      if (tipo === 'baixo') pontos(g, [[6 + d, 11], [7 + d, 11], [6 + d, 12], [7 + d, 12]], C.k);
      if (tipo === 'cima') pontos(g, [[7 + d, 8], [8 + d, 8], [7 + d, 9], [8 + d, 9]], C.k);
      if (tipo === 'grande') px(g, 7 + d, 10, C.k);
      if (tipo === 'feliz') pontos(g, [[5 + d, 11], [6 + d, 10], [7 + d, 10], [8 + d, 11]], C.o);
      if (tipo === 'dormindo') pontos(g, [[5 + d, 10], [6 + d, 11], [7 + d, 11], [8 + d, 10]], C.o);
      if (tipo === 'coracao') sprite(g, 5 + d, 8, coracao);
    }
    if (tipo === 'bravo') {
      pontos(g, [[4, 6], [5, 6], [6, 7], [7, 7], [8, 8]], C.o);
      pontos(g, [[19, 6], [18, 6], [17, 7], [16, 7], [15, 8]], C.o);
    }
    if (tipo === 'oculos') {
      for (let x = 4; x <= 19; x++) px(g, x, 9, C.k);
      for (const x0 of [4, 14]) for (let x = x0; x < x0 + 6; x++) for (let y = 10; y <= 11; y++) px(g, x, y, C.k);
      pontos(g, [[5, 10], [15, 10]], C.w);
    }
  }
  function boca(g, tipo) {
    if (tipo === 'sorriso') pontos(g, [[7, 17], [8, 18], [9, 19], [10, 19], [11, 19], [12, 19], [13, 19], [14, 19], [15, 18], [16, 17]], C.o);
    if (tipo === 'aberta') { elipse(g, 12, 19, 3.8, 2.3, C.m); pontos(g, [[10, 20], [11, 20], [12, 20], [13, 20]], C.t); }
    if (tipo === 'triste') pontos(g, [[8, 20], [9, 19], [10, 19], [11, 19], [12, 19], [13, 19], [14, 19], [15, 20]], C.o);
    if (tipo === 'o') pontos(g, [[11, 18], [12, 18], [11, 19], [12, 19], [11, 20], [12, 20]], C.m);
    if (tipo === 'reta') pontos(g, [[9, 19], [10, 19], [11, 19], [12, 19], [13, 19], [14, 19]], C.o);
    if (tipo === 'sorrisinho') pontos(g, [[9, 19], [10, 19], [11, 19], [12, 19], [13, 19], [14, 18], [15, 17]], C.o);
    if (tipo === 'pequena') pontos(g, [[11, 19], [12, 19]], C.o);
  }

  function sapo({ olho = 'normal', bocaT = 'sorriso', bochecha = false, extra }) {
    let g = grade();
    corpo(g);
    if (bochecha) bochechas(g);
    olhos(g, olho);
    boca(g, bocaT);
    g = contorno(g, C.o);
    if (extra) extra(g);
    return g;
  }

  const lista = [
    ['feliz', 'Feliz', { bochecha: true }],
    ['oi', 'Oi!', { bochecha: true, extra: g => texto(g, 6, 0, 'OI!', C.x) }],
    ['kkk', 'KKK', { olho: 'feliz', bocaT: 'aberta', extra: g => { pontos(g, [[3, 12], [3, 13], [20, 12], [20, 13]], C.a); texto(g, 6, 0, 'KKK', C.x); } }],
    ['triste', 'Triste', { olho: 'baixo', bocaT: 'triste', extra: g => pontos(g, [[5, 13], [5, 14], [4, 15], [5, 15]], C.a) }],
    ['bravo', 'Bravo', { olho: 'bravo', bocaT: 'triste', extra: g => pontos(g, [[19, 0], [21, 0], [20, 1], [19, 2], [21, 2], [22, 3], [18, 3]], C.r) }],
    ['amei', 'Amei', { olho: 'coracao', bochecha: true, extra: g => sprite(g, 18, 0, coracao) }],
    ['joinha', 'Joinha', { extra: g => sprite(g, 16, 13, ['...oo...', '..olgo..', '..oggo..', 'oooggooo', 'olllgggo', 'oggggggo', 'olllgggo', 'oggggggo', 'olllgggo', '.oooooo.']) }],
    ['dormindo', 'Dormindo', { olho: 'dormindo', bocaT: 'pequena', extra: g => texto(g, 15, 0, 'ZZ', C.x) }],
    ['surpreso', 'Surpreso', { olho: 'grande', bocaT: 'o', extra: g => texto(g, 19, 0, '!', C.r) }],
    ['legal', 'Legal', { olho: 'oculos', bocaT: 'sorrisinho' }],
    ['pensando', 'Pensando', { olho: 'cima', bocaT: 'reta', extra: g => texto(g, 18, 0, '?', C.x) }],
    ['gg', 'GG', { extra: g => texto(g, 8, 0, 'GG', C.x) }],
  ];

  const tela = document.createElement('canvas');
  tela.width = T; tela.height = T;
  const ctx = tela.getContext('2d');
  const prontas = lista.map(([id, nome, op]) => {
    const g = sapo(op);
    ctx.clearRect(0, 0, T, T);
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) if (g[y][x]) { ctx.fillStyle = g[y][x]; ctx.fillRect(x, y, 1, 1); }
    return { id, nome, url: tela.toDataURL('image/png'), pixel: true };
  });
  // pacote dos lutadores do BATTLE WISH (figurinhas_bw.js, gerado pelo próprio jogo)
  const bw = typeof FIGURINHAS_BW !== 'undefined' ? FIGURINHAS_BW : [];
  return { lista: prontas, bw, porId: new Map([...prontas, ...bw].map(f => [f.id, f])) };
})();
