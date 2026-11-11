'use strict';
/*
  FrogTalk — chat + call no navegador, sem servidor próprio.

  - Carteiro: dois brokers MQTT públicos (EMQX e HiveMQ). Cada pacote vai pros dois e quem recebe
    ignora o repetido (todo pacote tem um número único "p").
  - Tranca: o broker é público, então tudo vai trancado (AES-GCM).
      * Grupo: a chave sai do código da sala.
      * Amigo (privado): cada conta tem um par de chaves (ECDH) que nunca sai do aparelho.
        As duas chaves combinadas dão uma tranca que só os dois têm.
  - Número de 5 dígitos: fica "anotado" no broker (mensagem retida) junto com a chave pública.
    Adicionar amigo = mandar PEDIDO; só vira conversa se a outra pessoa aceitar.
  - Caixinha: cada conta deixa no broker (retida) as últimas mensagens que mandou em cada conversa.
    Assim quem estava offline recebe quando abrir.
  - Perfil (foto, recado) e status ficam num canal pessoal trancado; quem é amigo ou está numa
    sala com você recebe a chave dele.
  - Grupo com admin: a configuração do grupo vai ASSINADA (ECDSA). Só vale se quem assinou é admin.
    Remover alguém = o grupo ganha código novo, entregue escondido só pra quem ficou.
  - Contas compartilhadas: cada conta mora num "cantinho" separado do navegador. Dar acesso = mandar
    as chaves da conta pelo privado. Quem tem acesso sincroniza amigos/grupos/perfil pelo canal da conta.
  - Call: WebRTC (o áudio vai direto entre os aparelhos). O broker só leva o "aperto de mão".
*/

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const ALFA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // sem 0/O, 1/I/L pra ninguém confundir
const MAX_MSGS = 500;      // quantas mensagens cada conversa guarda
const MAX_HIST = 60;       // quantas manda pra quem chega
const ONLINE_SEG = 45;     // sem sinal por esse tempo = saiu
const DIA = 864e5;
const MAX_IMG = 150000;    // tamanho máximo de figurinha própria (texto base64)
const MAX_FOTO = 160000;   // foto comprimida que vai dentro da mensagem
const MAX_ARQ = 50 * 1024 * 1024;     // arquivo (vai direto de aparelho pra aparelho)
const AUTO_BAIXAR = 10 * 1024 * 1024; // até esse tamanho baixa sozinho
const SPAM_QTD = 10;               // mais que isso…
const SPAM_JANELA = 20000;         // …em 20 segundos…
const SPAM_CASTIGO = 5 * 60000;    // …= 5 minutos sem mandar
const CHAMAR_INTERVALO = 30000;    // chamar: no máximo 1 vez a cada 30 s por conversa
const REACOES = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🐸'];
const JOKENPO = { pedra: '✊', papel: '✋', tesoura: '✌️' };
const GANHA_DE = { pedra: 'tesoura', papel: 'pedra', tesoura: 'papel' };
// eventos: mensagens escondidas que mexem em outra (reação, edição, apagar, voto, jogada)
const ehEvento = m => !!(m && (m.reage || m.edita || m.apaga || m.voto || m.jogada));
const MAX_VOZ = 170000;            // áudio vai dentro da mensagem (chega offline)
const VOZ_SEG = 60;                // gravação para sozinha em 1 minuto
const CORES = ['#7c3aed', '#db2777', '#2563eb', '#059669', '#d97706', '#dc2626', '#0891b2', '#9333ea', '#4f46e5', '#65a30d'];
const CORES_STATUS = ['#6d28d9', '#9333ea', '#db2777', '#2563eb', '#059669', '#ea580c', '#1f1235'];
// o que vai junto quando alguém ganha acesso a uma conta
const CHAVES_CONTA = ['uid', 'apelido', 'recado', 'foto', 'identidade', 'amigos', 'pedidos', 'bloqueados', 'canais', 'contatos', 'apagados', 'perfilTs', 'acessos', 'compartilhada'];

const $ = s => document.querySelector(s);
const enc = new TextEncoder(), dec = new TextDecoder();
const celular = matchMedia('(pointer: coarse)').matches;

// ================= contas e armazenamento =================
// cada conta guarda tudo com um prefixo próprio; a "principal" usa o prefixo antigo
function lerGlobal(k, padrao) { try { const v = localStorage.getItem(k); return v == null ? padrao : JSON.parse(v); } catch (e) { return padrao; } }
function guardarGlobal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function lerContas() {
  const l = lerGlobal('frogchat-contas', null);
  return Array.isArray(l) && l.some(c => c.id === 'principal') ? l : [{ id: 'principal' }, ...(Array.isArray(l) ? l : [])];
}
const CONTA = (() => { const a = lerGlobal('frogchat-ativa', 'principal'); return lerContas().some(c => c.id === a) ? a : 'principal'; })();
const prefixoDe = c => c === 'principal' ? 'frogchat:' : 'frogchat@' + c + ':';
const PREFIXO = prefixoDe(CONTA);

function lerDe(conta, k, padrao) {
  try { const v = localStorage.getItem(prefixoDe(conta) + k); return v == null ? padrao : JSON.parse(v); }
  catch (e) { return padrao; }
}
function guardarEm(conta, k, v) { try { localStorage.setItem(prefixoDe(conta) + k, JSON.stringify(v)); } catch (e) { console.warn('[FrogTalk] localStorage', e); } }
const ler = (k, padrao) => lerDe(CONTA, k, padrao);
const guardar = (k, v) => guardarEm(CONTA, k, v);
function apagar(k) { try { localStorage.removeItem(PREFIXO + k); } catch (e) {} }

// ================= utilidades =================
function idAleatorio(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = ''; for (const x of b) s += (x % 36).toString(36);
  return s;
}
function corDe(uid) { let h = 0; for (const ch of String(uid)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return CORES[h % CORES.length]; }
function inicial(nome) { return (Array.from(String(nome || '?').trim())[0] || '?').toUpperCase(); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function linkar(s) {
  return esc(s).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function soEmoji(s) { return s.length <= 16 && /^(\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(s); }
function hora(ts) { return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
function rotuloDia(ts) {
  const d = new Date(ts), hoje = new Date(), ontem = new Date(Date.now() - DIA);
  if (d.toDateString() === hoje.toDateString()) return 'Hoje';
  if (d.toDateString() === ontem.toDateString()) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: d.getFullYear() === hoje.getFullYear() ? undefined : 'numeric' });
}
function haQuanto(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 1440) return `há ${Math.floor(min / 60)} h`;
  return `há ${Math.floor(min / 1440)} dias`;
}
function imagemValida(s, max) { return typeof s === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(s) && s.length <= max; }

function novoCodigo() { const b = crypto.getRandomValues(new Uint8Array(8)); let s = ''; for (const x of b) s += ALFA[x % ALFA.length]; return s; }
function limparCodigo(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function codigoValido(c) { return c.length === 8 && [...c].every(ch => ALFA.includes(ch)); }
function codigoBonito(c) { return c.slice(0, 4) + '-' + c.slice(4); }
function linkConvite(sala) {
  let l = location.origin + location.pathname + '#entrar=' + sala.codigo + '&nome=' + encodeURIComponent(nomeCanal(sala));
  if (sala.donoHash) l += '&dono=' + sala.donoHash;
  return l;
}

// ================= banco (IndexedDB: mensagens, perfis, figurinhas) =================
const DB = (() => {
  let aberto = null;
  const nome = CONTA === 'principal' ? 'frogchat' : 'frogchat@' + CONTA;
  function abrir() {
    if (!aberto) aberto = new Promise((res, rej) => {
      const r = indexedDB.open(nome, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return aberto;
  }
  async function op(modo, fn) {
    const db = await abrir();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', modo);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req && req.result);
      tx.onerror = () => rej(tx.error);
    });
  }
  return {
    get: k => op('readonly', s => s.get(k)).catch(() => undefined),
    set: (k, v) => op('readwrite', s => s.put(v, k)).catch(e => console.warn('[FrogTalk] db', e)),
    del: k => op('readwrite', s => s.delete(k)).catch(() => {}),
  };
})();

// ================= tranca (criptografia) =================
function paraB64(buf) {
  const a = new Uint8Array(buf); let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
}
function deB64(s) { const bin = atob(s); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function hex(a) { return Array.from(a, x => x.toString(16).padStart(2, '0')).join(''); }
function concat(a, b) { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }
async function sha(d) { return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof d === 'string' ? enc.encode(d) : d)); }
const importarAES = raw => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function prepararSala(codigo) {
  const topico = 'frogchat/v1/' + hex((await sha('frogchat-sala:' + codigo)).slice(0, 12));
  const base = await crypto.subtle.importKey('raw', enc.encode(codigo), 'PBKDF2', false, ['deriveKey']);
  const chave = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('frogchat-sal-v1'), iterations: 150000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { topico, chave };
}
async function trancar(chave, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const d = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, chave, enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, iv: paraB64(iv), d: paraB64(d) });
}
async function destrancar(chave, texto) {
  const o = typeof texto === 'string' ? JSON.parse(texto) : texto;
  if (o.v !== 1) throw new Error('versão');
  const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(o.iv) }, chave, deB64(o.d));
  return JSON.parse(dec.decode(p));
}

// segredo combinado com outra conta (ECDH): os dois lados chegam no mesmo valor
const segredos = new Map();
async function segredoCom(pubB64) {
  if (segredos.has(pubB64)) return segredos.get(pubB64);
  const pub = await crypto.subtle.importKey('raw', deB64(pubB64), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eu.priv, 256));
  const derivar = rotulo => sha(concat(enc.encode(rotulo), bits));
  const s = {
    chaveDM: await importarAES(await derivar('frogchat-dm-chave')),
    chaveCx: await importarAES(await derivar('frogchat-cx-chave')),
    topicoDM: 'frogchat/v1/' + hex((await derivar('frogchat-dm-topico')).slice(0, 12)),
    id: hex((await derivar('frogchat-dm-id')).slice(0, 6)),
  };
  segredos.set(pubB64, s);
  return s;
}
// pacote selado pra UMA conta (só ela abre)
async function selarPara(pubDest, obj) {
  const s = await segredoCom(pubDest);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const d = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, s.chaveCx, enc.encode(JSON.stringify({ p: idAleatorio(12), ...obj })));
  return JSON.stringify({ v: 1, de: eu.pubB64, iv: paraB64(iv), d: paraB64(d) });
}
async function abrirSelado(payload) {
  const o = JSON.parse(dec.decode(payload));
  if (!o || o.v !== 1 || typeof o.de !== 'string' || o.de === eu.pubB64) return null;
  const s = await segredoCom(o.de);
  const pk = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: deB64(o.iv) }, s.chaveCx, deB64(o.d))));
  return { de: o.de, pk };
}

// assinatura (configuração dos grupos)
async function assinar(txt) { return paraB64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, eu.signPriv, enc.encode(txt))); }
async function verificar(pubB64, txt, sig) {
  try {
    const k = await crypto.subtle.importKey('raw', deB64(pubB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, deB64(sig), enc.encode(txt));
  } catch (e) { return false; }
}

const topicoPessoalDe = async kB64 => 'frogchat/v1/p/' + hex((await sha('frogchat-pessoal:' + kB64)).slice(0, 12));
const topicoInboxDe = async pubB64 => 'frogchat/v1/cx/' + hex((await sha('frogchat-inbox:' + pubB64)).slice(0, 12));
const topicoNumero = num => 'frogchat/v1/n/' + num;
const mvIdDe = async pubB64 => hex((await sha('frogchat-mv:' + pubB64)).slice(0, 8));
const hashDono = async s => hex((await sha('frogchat-dono:' + s)).slice(0, 8));

// ================= quem sou eu =================
const eu = {
  uid: ler('uid', null), sessao: idAleatorio(10),
  apelido: ler('apelido', ''), recado: ler('recado', ''), foto: ler('foto', null),
  compartilhada: ler('compartilhada', false),
  num: null, priv: null, pubB64: null, kB64: null, chavePessoal: null, signPriv: null, signPubB64: null,
  topicoPessoal: null, topicoInbox: null, caixaId: null, mvId: null, topicoConta: null, chaveConta: null,
};
if (!eu.uid) { eu.uid = idAleatorio(12); guardar('uid', eu.uid); }

async function novaIdentidade() {
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ass = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    priv: await crypto.subtle.exportKey('jwk', par.privateKey),
    pub: paraB64(await crypto.subtle.exportKey('raw', par.publicKey)),
    k: paraB64(crypto.getRandomValues(new Uint8Array(32))),
    num: null,
    sign: { priv: await crypto.subtle.exportKey('jwk', ass.privateKey), pub: paraB64(await crypto.subtle.exportKey('raw', ass.publicKey)) },
  };
}
async function carregarIdentidade() {
  let id = ler('identidade', null);
  let ok = false;
  if (id && id.priv && id.pub && id.k) {
    try {
      eu.priv = await crypto.subtle.importKey('jwk', id.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      ok = true;
    } catch (e) { console.warn('[FrogTalk] identidade estragada, criando outra', e); }
  }
  if (!ok) {
    id = await novaIdentidade();
    guardar('identidade', id);
    eu.priv = await crypto.subtle.importKey('jwk', id.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }
  if (!id.sign) { // conta da versão antiga: ganha a "caneta" de assinar agora
    const ass = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    id.sign = { priv: await crypto.subtle.exportKey('jwk', ass.privateKey), pub: paraB64(await crypto.subtle.exportKey('raw', ass.publicKey)) };
    guardar('identidade', id);
  }
  eu.pubB64 = id.pub; eu.kB64 = id.k; eu.num = id.num || null;
  eu.signPriv = await crypto.subtle.importKey('jwk', id.sign.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  eu.signPubB64 = id.sign.pub;
  eu.chavePessoal = await importarAES(deB64(eu.kB64));
  eu.topicoPessoal = await topicoPessoalDe(eu.kB64);
  eu.topicoInbox = await topicoInboxDe(eu.pubB64);
  eu.caixaId = hex((await sha('frogchat-caixa:' + eu.uid)).slice(0, 8));
  eu.mvId = await mvIdDe(eu.pubB64);
  // canal da conta: só quem tem a chave privada (o dono e quem ganhou acesso) chega aqui
  eu.topicoConta = 'frogchat/v1/acc/' + hex((await sha('frogchat-conta:' + id.priv.d)).slice(0, 12));
  eu.chaveConta = await importarAES(await sha('frogchat-conta-chave:' + id.priv.d));
}
function salvarNumero(num) {
  eu.num = num;
  const id = ler('identidade', {});
  id.num = num; guardar('identidade', id);
  renderEu();
}

// ================= perfis, contatos e status =================
const perfis = new Map();     // uid -> {nome, foto, recado, status:[], ts}
const contatos = new Map();   // uid -> {k, topico, chave}   (de quem eu sei a chave pessoal)
const porPessoal = new Map(); // topico -> uid
let meusStatus = [];          // [{id, ts, tipo:'texto'|'foto', txt, cor, img}]
const statusVistos = new Set(ler('statusVistos', []));

function statusAtivos(lista) { const lim = Date.now() - DIA; return (lista || []).filter(s => s.ts > lim); }
function nomeDe(uid, reserva) {
  if (uid === eu.uid) return eu.apelido;
  const p = perfis.get(uid);
  return (p && p.nome) || reserva || '???';
}
function fotoDe(uid) { if (uid === eu.uid) return eu.foto; const p = perfis.get(uid); return p && p.foto; }
function avatarHTML(uid, nome, cls = '') {
  const f = fotoDe(uid);
  if (f) return `<img class="avatar ${cls}" src="${esc(f)}" alt="">`;
  return `<div class="avatar ${cls}" style="background:${corDe(uid)}">${esc(inicial(nome || nomeDe(uid)))}</div>`;
}

let tPerfis = 0;
function salvarPerfis() {
  clearTimeout(tPerfis);
  tPerfis = setTimeout(() => DB.set('perfis', Object.fromEntries(perfis)), 500);
}

async function registrarContato(uid, kB64) {
  if (!uid || uid === eu.uid || typeof kB64 !== 'string' || contatos.has(uid)) return; // a 1ª chave vale (ninguém troca a de outro)
  let chave;
  try { const raw = deB64(kB64); if (raw.length !== 32) return; chave = await importarAES(raw); } catch (e) { return; }
  if (contatos.has(uid)) return;
  const topico = await topicoPessoalDe(kB64);
  contatos.set(uid, { k: kB64, topico, chave });
  porPessoal.set(topico, uid);
  for (const c of conexoes) if (c.connected) c.subscribe(topico, { qos: 0 });
  guardar('contatos', [...contatos].map(([u, v]) => ({ u, k: v.k })));
}

// meu perfil + status ficam retidos no meu canal pessoal
let tPessoal = 0;
function agendarPessoal() { clearTimeout(tPessoal); tPessoal = setTimeout(publicarPessoal, 800); }
async function publicarPessoal() {
  if (!eu.chavePessoal) return;
  let status = statusAtivos(meusStatus);
  let pk;
  for (;;) {
    pk = { p: idAleatorio(12), t: 'pessoal', u: eu.uid, ts: Date.now(), perfil: { nome: eu.apelido, foto: eu.foto, recado: eu.recado }, status };
    if (JSON.stringify(pk).length < 230000 || !status.length) break;
    status = status.slice(1); // grande demais: os status mais velhos ficam de fora
  }
  const txt = await trancar(eu.chavePessoal, pk);
  for (const c of conexoes) c.publish(eu.topicoPessoal, txt, { qos: 0, retain: true });
}

async function processarPessoal(topico, payload) {
  const uid = porPessoal.get(topico);
  const ct = uid && contatos.get(uid);
  if (!ct) return;
  let pk;
  try { pk = await destrancar(ct.chave, dec.decode(payload)); } catch (e) { return; }
  if (!pk || pk.u !== uid || !pk.perfil) return;
  const antes = perfis.get(uid);
  if (antes && antes.ts >= pk.ts) return;
  const status = (Array.isArray(pk.status) ? pk.status : []).filter(s => s && typeof s.id === 'string' && Number(s.ts))
    .map(limparStatus).filter(Boolean);
  perfis.set(uid, {
    nome: String(pk.perfil.nome || '').slice(0, 24) || (antes && antes.nome) || '???',
    foto: imagemValida(pk.perfil.foto, 60000) ? pk.perfil.foto : null,
    recado: String(pk.perfil.recado || '').slice(0, 80),
    status, ts: Number(pk.ts) || Date.now(),
  });
  salvarPerfis();
  renderTudo();
}
function limparStatus(s) {
  const r = {
    id: String(s.id).slice(0, 20), ts: Number(s.ts), tipo: s.tipo === 'foto' ? 'foto' : 'texto',
    txt: String(s.txt || '').slice(0, 300), cor: CORES_STATUS.includes(s.cor) ? s.cor : CORES_STATUS[0],
    img: s.tipo === 'foto' && imagemValida(s.img, 120000) ? s.img : null,
  };
  return (r.tipo === 'texto' ? r.txt : r.img) ? r : null;
}

// ================= canais (grupos e amigos) =================
const salas = new Map();      // id -> canal
const porTopico = new Map();  // topico -> canal
let atual = null;             // canal aberto na tela

async function abrirCanal(def) {
  if (salas.has(def.id)) return salas.get(def.id);
  const sala = {
    tsAdd: Date.now(),
    ...def,
    msgs: (await DB.get('msgs:' + def.id)) || [],
    naoLidas: ler('nl:' + def.id, 0),
    online: new Map(),     // sessao -> {uid, n, visto}
    naCall: new Map(),     // sessao -> {uid, n, mudo}
    digitando: new Map(),  // sessao -> {n, ate}
    membros: new Map(ler('membros:' + def.id, [])), // uid -> {n, pub, sp, visto}  (só grupos)
    cfg: null, cfgPacote: null,
    ultimoAnuncio: 0, tchauPronto: null, tSalvar: 0, tCaixa: 0, tMembros: 0,
  };
  if (salas.has(def.id)) return salas.get(def.id);
  salas.set(sala.id, sala);
  porTopico.set(sala.topico, sala);
  if (sala.tipo === 'grupo') {
    const guardada = ler('cfg:' + sala.id, null);
    if (guardada) await aceitarCfg(sala, guardada, true);
    atualizarMembro(sala, { u: eu.uid, n: eu.apelido, pub: eu.pubB64, sp: eu.signPubB64 });
  }
  salvarListaSalas();
  for (const c of conexoes) if (c.connected) assinarCanal(c, sala);
  anunciar(sala);
  prepararTchau(sala);
  renderSalas();
  return sala;
}
function topicosDoCanal(sala) {
  const l = [sala.topico, sala.topico + '/r/+'];
  if (sala.tipo === 'grupo') l.push(sala.topico + '/cfg', sala.topico + '/mv/' + eu.mvId);
  return l;
}
function assinarCanal(c, sala) { c.subscribe(topicosDoCanal(sala), { qos: 0 }); }

async function abrirGrupo(codigo, nome, extra = {}) {
  const id = 'g-' + codigo;
  if (salas.has(id)) return salas.get(id);
  const { topico, chave } = await prepararSala(codigo);
  return abrirCanal({ id, tipo: 'grupo', codigo, nome: nome || 'Grupo ' + codigo.slice(0, 4), semNome: !nome, topico, chave, ...extra });
}
async function abrirDM(amigo, extra = {}) {
  const s = await segredoCom(amigo.pub);
  return abrirCanal({ id: 'dm-' + s.id, tipo: 'dm', pub: amigo.pub, topico: s.topicoDM, chave: s.chaveDM, ...extra });
}

function nomeCanal(sala) {
  if (sala.tipo !== 'dm') return (sala.cfg && sala.cfg.nome) || sala.nome;
  const a = amigos.get(sala.pub);
  if (!a) return 'Conversa';
  return (a.uid && perfis.get(a.uid) && perfis.get(a.uid).nome) || a.nome || 'Nº ' + a.num;
}
function avatarCanal(sala, cls = '') {
  if (sala.tipo === 'dm') {
    const a = amigos.get(sala.pub);
    if (a && a.uid) return avatarHTML(a.uid, nomeCanal(sala), cls);
    return `<div class="avatar ${cls}" style="background:#a78bfa">?</div>`;
  }
  if (sala.cfg && sala.cfg.foto) return `<img class="avatar ${cls}" src="${esc(sala.cfg.foto)}" alt="">`;
  return `<div class="avatar av-grupo ${cls}">${esc(inicial(nomeCanal(sala)))}</div>`;
}

function salvarListaSalas() {
  guardar('canais', [...salas.values()].map(s => s.tipo === 'dm'
    ? { id: s.id, tipo: 'dm', pub: s.pub, ts: s.tsAdd }
    : { id: s.id, tipo: 'grupo', codigo: s.codigo, nome: s.nome, dono: s.donoHash, ts: s.tsAdd }));
  mudouConta();
}
function salvarMsgs(sala) {
  guardar('nl:' + sala.id, sala.naoLidas);
  clearTimeout(sala.tSalvar);
  sala.tSalvar = setTimeout(() => DB.set('msgs:' + sala.id, sala.msgs), 400);
}
function atualizarMembro(sala, pk) {
  if (sala.tipo !== 'grupo' || !pk.u) return;
  const m = sala.membros.get(pk.u) || {};
  const novo = { n: String(pk.n || m.n || '???').slice(0, 24), pub: typeof pk.pub === 'string' ? pk.pub : m.pub, sp: typeof pk.sp === 'string' ? pk.sp : m.sp, visto: Date.now() };
  sala.membros.set(pk.u, novo);
  clearTimeout(sala.tMembros);
  sala.tMembros = setTimeout(() => guardar('membros:' + sala.id, [...sala.membros]), 1000);
}

function largarCanal(sala, { semTchau = false } = {}) {
  if (call.sala === sala) sairCall();
  if (!semTchau) enviar(sala, 'tchau');
  for (const c of conexoes) c.publish(sala.topico + '/r/' + eu.caixaId, '', { qos: 0, retain: true }); // esvazia minha caixinha
  setTimeout(() => { for (const c of conexoes) c.unsubscribe(topicosDoCanal(sala)); }, 800);
  salas.delete(sala.id);
  porTopico.delete(sala.topico);
  DB.del('msgs:' + sala.id); apagar('nl:' + sala.id); apagar('cfg:' + sala.id); apagar('membros:' + sala.id);
  if (!mesclando) { apagados.canais[sala.id] = Date.now(); guardar('apagados', apagados); }
  salvarListaSalas();
  if (atual === sala) fecharChat();
  renderSalas();
}

// "cheguei!" + "o que eu perdi?"
function anunciar(sala) {
  const agora = Date.now();
  if (agora - sala.ultimoAnuncio < 3000) return;
  sala.ultimoAnuncio = agora;
  enviar(sala, 'oi', { novo: true, ...dadosOi(sala) });
  const ult = sala.msgs.length ? sala.msgs[sala.msgs.length - 1].ts : 0;
  enviar(sala, 'pede', { desde: ult });
  if (sala.cfgPacote && souAdmin(sala)) republicarCfg(sala); // garante que a config continua no broker
}
function dadosOi(sala) {
  return {
    call: call.sala === sala, mudo: call.sala === sala && call.mudo, k: eu.kB64, pub: eu.pubB64, sp: eu.signPubB64,
    s: sala.tipo === 'grupo' && !sala.semNome ? nomeCanal(sala) : undefined,
  };
}

// escolhe as mensagens mais novas que cabem no limite (uma foto grande que não cabe fica de fora, os textos não)
function cortarPorTamanho(lista, max) {
  const r = []; let total = 0;
  for (let i = lista.length - 1; i >= 0; i--) {
    const t = JSON.stringify(lista[i]).length;
    if (total + t > max) continue;
    total += t; r.unshift(lista[i]);
  }
  return r;
}

// minha caixinha: as últimas mensagens que EU mandei nesta conversa, retidas no broker
function agendarCaixa(sala) { clearTimeout(sala.tCaixa); sala.tCaixa = setTimeout(() => publicarCaixa(sala), 1200); }
async function publicarCaixa(sala) {
  if (!salas.has(sala.id)) return;
  const minhas = cortarPorTamanho(sala.msgs.filter(m => m.u === eu.uid).slice(-40), 170000);
  const pk = { p: idAleatorio(12), t: 'caixa', f: eu.sessao, u: eu.uid, n: eu.apelido, k: eu.kB64, pub: eu.pubB64, sp: eu.signPubB64, msgs: minhas };
  marcarVisto(pk.p);
  const txt = await trancar(sala.chave, pk);
  for (const c of conexoes) c.publish(sala.topico + '/r/' + eu.caixaId, txt, { qos: 0, retain: true });
}

// ================= grupos: admin e configurações =================
function souAdmin(sala) { return !!(sala.cfg && sala.cfg.admins.some(a => a.s === eu.signPubB64)); }
function souDono(sala) { return !!(sala.cfg && sala.cfg.dono === eu.signPubB64); }
function ehAdminUid(sala, uid) { return !!(sala.cfg && sala.cfg.admins.some(a => a.u === uid)); }
function podeFalar(sala) {
  const c = sala.cfg;
  if (!c || sala.tipo !== 'grupo') return true;
  if (c.encerrado || c.movido) return false;
  return !c.soAdmins || souAdmin(sala);
}
function limparCfg(c) {
  return {
    ver: c.ver, ts: Number(c.ts) || 0,
    nome: String(c.nome || '').slice(0, 40), desc: String(c.desc || '').slice(0, 200),
    foto: imagemValida(c.foto, 60000) ? c.foto : null,
    soAdmins: !!c.soAdmins, soAdminsConvidam: !!c.soAdminsConvidam,
    admins: c.admins.slice(0, 20).filter(a => a && typeof a.s === 'string' && typeof a.u === 'string')
      .map(a => ({ s: a.s, u: a.u, n: String(a.n || '???').slice(0, 24) })),
    dono: c.dono, encerrado: !!c.encerrado, movido: !!c.movido,
  };
}

// só aceita configuração assinada por um admin (e mais nova que a que eu já tenho)
async function aceitarCfg(sala, pacote, carregando = false) {
  const { cfg, por, sig } = pacote || {};
  if (!cfg || typeof por !== 'string' || typeof sig !== 'string' || !Array.isArray(cfg.admins) || typeof cfg.dono !== 'string') return false;
  if (!Number.isInteger(cfg.ver) || cfg.ver < 1) return false;
  const velha = sala.cfg;
  if (velha) {
    if (cfg.ver <= velha.ver || cfg.dono !== velha.dono) return false;
    if (!velha.admins.some(a => a.s === por)) return false;
  } else {
    if (!cfg.admins.some(a => a.s === por)) return false;
    if (sala.donoHash && (await hashDono(cfg.dono)) !== sala.donoHash) return false;
  }
  if (!cfg.admins.some(a => a.s === cfg.dono)) return false;
  if (!(await verificar(por, JSON.stringify(cfg), sig))) return false;
  sala.cfg = limparCfg(cfg);
  sala.cfgPacote = { cfg, por, sig };
  if (!sala.donoHash) { sala.donoHash = await hashDono(cfg.dono); }
  guardar('cfg:' + sala.id, sala.cfgPacote);
  if (sala.cfg.nome) { sala.nome = sala.cfg.nome; sala.semNome = false; }
  if (!carregando) {
    salvarListaSalas();
    renderSalas();
    if (sala === atual) { renderTopo(); renderMsgs(); renderCaixa(); }
    if (janelaConfig && janelaConfig.sala === sala) desenharConfig();
  }
  return true;
}

async function publicarCfg(sala, mudancas) {
  const base = sala.cfg || { ver: 0, nome: sala.nome, desc: '', foto: null, soAdmins: false, soAdminsConvidam: false, admins: [{ s: eu.signPubB64, u: eu.uid, n: eu.apelido }], dono: eu.signPubB64 };
  const cfg = { ...base, ...mudancas, ver: base.ver + 1, ts: Date.now() };
  const pacote = { cfg, por: eu.signPubB64, sig: await assinar(JSON.stringify(cfg)) };
  if (!(await aceitarCfg(sala, pacote))) { avisar('Não consegui salvar a configuração. 😕'); return false; }
  await republicarCfg(sala);
  return true;
}
async function republicarCfg(sala) {
  if (!sala.cfgPacote) return;
  const txt = await trancar(sala.chave, { p: idAleatorio(12), t: 'cfg', ...sala.cfgPacote });
  for (const c of conexoes) c.publish(sala.topico + '/cfg', txt, { qos: 0, retain: true });
}
async function processarCfg(sala, payload) {
  let pk; try { pk = await destrancar(sala.chave, dec.decode(payload)); } catch (e) { return; }
  if (!pk || pk.t !== 'cfg') return;
  const era = sala.cfg;
  if (await aceitarCfg(sala, pk) && era) {
    if (sala.cfg.encerrado && !era.encerrado) avisar(`O grupo "${nomeCanal(sala)}" foi encerrado.`);
    else if (souAdmin(sala) && !era.admins.some(a => a.s === eu.signPubB64)) avisar(`⭐ Você virou admin de "${nomeCanal(sala)}"!`);
  }
}

// grupo ganha código novo; quem continua recebe o código escondido (só ele abre)
async function rodarGrupo(sala, tirarUid) {
  const novo = novoCodigo();
  const cfgNova = { ...sala.cfg, admins: sala.cfg.admins.filter(a => a.u !== tirarUid), movido: false, encerrado: false };
  delete cfgNova.ver; delete cfgNova.ts;
  const ns = await abrirGrupo(novo, nomeCanal(sala), { donoHash: sala.donoHash });
  ns.msgs = sala.msgs.slice(); salvarMsgs(ns);
  for (const [u, m] of sala.membros) if (u !== tirarUid) ns.membros.set(u, m);
  // config do grupo novo (versão 1, mesmo dono e admins)
  const cfg = { ...cfgNova, ver: 1, ts: Date.now() };
  const pacote = { cfg, por: eu.signPubB64, sig: await assinar(JSON.stringify(cfg)) };
  await aceitarCfg(ns, pacote);
  await republicarCfg(ns);
  let avisados = 0;
  for (const [u, m] of sala.membros) {
    if (u === tirarUid || u === eu.uid || !m.pub) continue;
    const txt = await selarPara(m.pub, { t: 'mudou', codigo: novo, nome: nomeCanal(sala), u: eu.uid });
    const destino = sala.topico + '/mv/' + await mvIdDe(m.pub);
    for (const c of conexoes) c.publish(destino, txt, { qos: 0, retain: true });
    avisados++;
  }
  // o grupo velho fica marcado como "mudou" (quem saiu fica sem o código novo)
  await publicarCfg(sala, { movido: true });
  largarCanal(sala, { semTchau: true });
  selecionarSala(ns);
  return avisados;
}
async function processarMudou(sala, payload) {
  let r; try { r = await abrirSelado(payload); } catch (e) { return; }
  if (!r || r.pk.t !== 'mudou' || !codigoValido(String(r.pk.codigo))) return;
  // só vale se veio de um admin do grupo
  const m = sala.membros.get(r.pk.u);
  if (!ehAdminUid(sala, r.pk.u) || (m && m.pub && m.pub !== r.de)) return;
  if (salas.has('g-' + r.pk.codigo)) return;
  const ns = await abrirGrupo(r.pk.codigo, String(r.pk.nome || '').slice(0, 40) || nomeCanal(sala), { donoHash: sala.donoHash });
  ns.msgs = sala.msgs.slice(); salvarMsgs(ns);
  for (const [u, mm] of sala.membros) ns.membros.set(u, mm);
  const estavaVendo = atual === sala;
  largarCanal(sala, { semTchau: true });
  if (estavaVendo) selecionarSala(ns);
  avisar(`🔄 O grupo "${nomeCanal(ns)}" ganhou um código novo. Você continua nele!`);
}

// ================= amigos =================
const amigos = new Map(ler('amigos', []).map(a => [a.pub, a]));  // pub -> {pub, num, uid, nome, estado:'enviado'|'amigo', k, ts}
const pedidos = new Map(ler('pedidos', []).map(p => [p.pub, p])); // pedidos que EU recebi
const bloqueados = new Set(ler('bloqueados', []));
const apagados = Object.assign({ amigos: {}, canais: {}, status: {} }, ler('apagados', {})); // "lápides" pra sincronizar remoções
function salvarAmigos() {
  guardar('amigos', [...amigos.values()]);
  guardar('pedidos', [...pedidos.values()]);
  guardar('bloqueados', [...bloqueados]);
  mudouConta();
}

// procurar quem é dono de um número (a "plaquinha" retida no broker)
const esperandoNumero = new Map(); // topico -> [resolver]
function buscarNumero(num, ms = 4500) {
  return new Promise(res => {
    const topico = topicoNumero(num);
    let fim = false;
    const acabar = v => {
      if (fim) return; fim = true;
      const l = (esperandoNumero.get(topico) || []).filter(f => f !== acabar);
      if (l.length) esperandoNumero.set(topico, l); else { esperandoNumero.delete(topico); for (const c of conexoes) c.unsubscribe(topico); }
      res(v);
    };
    esperandoNumero.set(topico, [...(esperandoNumero.get(topico) || []), acabar]);
    for (const c of conexoes) if (c.connected) c.subscribe(topico, { qos: 0 });
    setTimeout(() => acabar(null), ms);
  });
}
function aoNumero(topico, payload) {
  const l = esperandoNumero.get(topico);
  if (!l) return;
  let o; try { o = JSON.parse(dec.decode(payload)); } catch (e) { return; }
  if (!o || o.v !== 1 || typeof o.pub !== 'string') return;
  for (const f of [...l]) f(o);
}

let garantindo = null; // os dois brokers conectam juntos: só um sorteio por vez
function garantirNumero() {
  if (!garantindo) garantindo = sortearNumero().finally(() => { garantindo = null; });
  return garantindo;
}
async function sortearNumero() {
  if (eu.num) { publicarNumero(); return; }
  for (let i = 0; i < 10; i++) {
    const num = String(10000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90000));
    const dono = await buscarNumero(num, 3000);
    if (!dono || dono.pub === eu.pubB64) { salvarNumero(num); publicarNumero(); mudouConta(); return; }
  }
}
function publicarNumero() {
  if (!eu.num) return;
  const txt = JSON.stringify({ v: 1, pub: eu.pubB64 });
  for (const c of conexoes) if (c.connected) c.publish(topicoNumero(eu.num), txt, { qos: 0, retain: true });
}

async function enviarInbox(pubDest, obj) {
  const txt = await selarPara(pubDest, obj);
  const topico = await topicoInboxDe(pubDest);
  for (const c of conexoes) c.publish(topico, txt, { qos: 0 });
}
function meuCartao() { return { uid: eu.uid, num: eu.num, nome: eu.apelido, k: eu.kB64 }; }

async function adicionarAmigo(num) {
  if (num === eu.num) { avisar('Esse número é o seu! 😄'); return; }
  const ja = [...amigos.values()].find(a => a.num === num);
  if (ja) { const c = await abrirDM(ja); selecionarSala(c); return; }
  if (!conectado()) { avisar('Sem internet agora. Tenta de novo daqui a pouco.'); return; }
  const aviso = avisar('Procurando o número ' + num + '…', null, null, 6000);
  const dono = await buscarNumero(num);
  aviso.remove();
  if (!dono) { avisar(`Não achei ninguém com o número ${num}. Confere o número (a pessoa precisa ter aberto o FrogTalk pelo menos uma vez).`, null, null, 8000); return; }
  if (dono.pub === eu.pubB64) { avisar('Esse número é o seu! 😄'); return; }
  try { await segredoCom(dono.pub); } catch (e) { avisar('Esse número está com defeito. 😕'); return; }
  const pedido = pedidos.get(dono.pub);
  if (pedido) { await aceitarPedido(pedido); return; } // a pessoa já tinha me pedido: vira amizade direto
  const a = { pub: dono.pub, num, uid: null, nome: null, estado: 'enviado', k: null, ts: Date.now() };
  amigos.set(a.pub, a); salvarAmigos();
  const c = await abrirDM(a);
  enviarInbox(a.pub, { t: 'pedido', ...meuCartao() });
  selecionarSala(c);
  avisar(`Pedido enviado pro número ${num}! Quando a pessoa aceitar, vocês podem conversar. 📨`, null, null, 7000);
}

// fica reenviando os pedidos que ainda não foram respondidos (a pessoa pode estar offline)
function reenviarPedidos() {
  for (const a of amigos.values()) if (a.estado === 'enviado') enviarInbox(a.pub, { t: 'pedido', ...meuCartao() });
}

const inboxVistos = new Set();
async function processarInbox(payload) {
  let r;
  try { r = await abrirSelado(payload); } catch (e) { return; }
  if (!r || bloqueados.has(r.de)) return;
  const { de, pk } = r;
  if (!pk || inboxVistos.has(pk.p)) return;
  inboxVistos.add(pk.p);
  const cartao = { pub: de, uid: String(pk.uid || ''), num: /^\d{5}$/.test(pk.num) ? pk.num : '?????', nome: String(pk.nome || '???').slice(0, 24), k: pk.k };
  if (!cartao.uid) return;

  if (pk.t === 'pedido') {
    const a = amigos.get(de);
    if (a && a.estado === 'amigo') { enviarInbox(de, { t: 'aceito', ...meuCartao() }); return; } // já somos amigos: confirma de novo
    if (a && a.estado === 'enviado') { await aceitarPedido(cartao); return; }                    // os dois se adicionaram
    const novo = !pedidos.has(de);
    pedidos.set(de, { ...cartao, ts: Date.now() });
    salvarAmigos(); renderPedidos();
    if (novo) { somMsg(); avisar(`📨 ${cartao.nome} (nº ${cartao.num}) quer ser seu amigo!`, null, null, 7000).classList.add('de-pedido'); }
  } else if (pk.t === 'aceito') {
    const a = amigos.get(de);
    if (!a) return;
    virouAmigo(a, cartao);
  }
}

function virouAmigo(a, cartao) {
  const era = a.estado;
  a.estado = 'amigo'; a.uid = cartao.uid; a.nome = cartao.nome; a.ts = Date.now();
  if (cartao.num && cartao.num !== '?????') a.num = cartao.num;
  if (cartao.k) { a.k = cartao.k; registrarContato(cartao.uid, cartao.k); }
  salvarAmigos();
  if (era !== 'amigo' && !mesclando) avisar(`🎉 ${a.nome} aceitou seu pedido de amizade!`);
  renderTudo();
}

async function aceitarPedido(p) {
  document.querySelectorAll('.aviso.de-pedido').forEach(a => a.remove());
  pedidos.delete(p.pub);
  const a = { pub: p.pub, num: p.num, uid: p.uid, nome: p.nome, estado: 'amigo', k: p.k, ts: Date.now() };
  amigos.set(a.pub, a); salvarAmigos();
  if (p.k) registrarContato(p.uid, p.k);
  enviarInbox(p.pub, { t: 'aceito', ...meuCartao() });
  const c = await abrirDM(a);
  // mensagem de sistema: vai pra caixinha também, então chega mesmo se a pessoa estiver offline
  mandarConteudo({ sys: true, txt: 'Agora vocês são amigos! 👋' }, c);
  renderPedidos();
  selecionarSala(c);
}
function recusarPedido(p) {
  document.querySelectorAll('.aviso.de-pedido').forEach(a => a.remove());
  pedidos.delete(p.pub);
  bloqueados.add(p.pub);
  salvarAmigos(); renderPedidos();
}
function confirmarAmigoPeloCanal(sala, pk) {
  const a = amigos.get(sala.pub);
  if (!a || !pk.u || pk.u === eu.uid) return;
  if (a.estado !== 'amigo' || a.uid !== pk.u) virouAmigo(a, { uid: pk.u, nome: pk.n, num: a.num, k: pk.k });
  else if (pk.k && !contatos.has(pk.u)) registrarContato(pk.u, pk.k);
}

// ================= sincronizar a conta (quem tem acesso vê as mesmas coisas) =================
let mesclando = false;       // true enquanto aplico o que veio de outro aparelho (não conta como mudança minha)
let tEstado = 0, ultimaMudanca = 0;
function mudouConta() {
  if (mesclando) return;
  ultimaMudanca = Date.now();
  clearTimeout(tEstado);
  tEstado = setTimeout(publicarEstado, 1500);
}
async function publicarEstado() {
  if (!eu.chaveConta) return;
  const est = {
    p: idAleatorio(12), t: 'estado', f: eu.sessao, ts: Date.now(),
    perfil: { apelido: eu.apelido, recado: eu.recado, foto: eu.foto, ts: ler('perfilTs', 0) },
    amigos: [...amigos.values()], pedidos: [...pedidos.values()], bloqueados: [...bloqueados],
    canais: ler('canais', []), apagados,
    status: statusAtivos(meusStatus), acessos: ler('acessos', []),
  };
  const txt = await trancar(eu.chaveConta, est);
  for (const c of conexoes) c.publish(eu.topicoConta, txt, { qos: 0, retain: true });
}
async function processarEstado(payload) {
  let est; try { est = await destrancar(eu.chaveConta, dec.decode(payload)); } catch (e) { return; }
  if (!est || est.t !== 'estado' || est.f === eu.sessao || vistos.has(est.p)) return;
  marcarVisto(est.p);
  mesclando = true;
  let mudou = false;
  try {
    // lápides (o que alguém apagou)
    for (const tipo of ['amigos', 'canais', 'status']) {
      for (const [k, ts] of Object.entries((est.apagados || {})[tipo] || {})) {
        if (!(apagados[tipo][k] >= ts)) { apagados[tipo][k] = ts; mudou = true; }
      }
    }
    // perfil: o mais novo vence
    const pf = est.perfil || {};
    if (Number(pf.ts) > ler('perfilTs', 0) && pf.apelido) {
      eu.apelido = String(pf.apelido).slice(0, 24); eu.recado = String(pf.recado || '').slice(0, 80);
      eu.foto = imagemValida(pf.foto, 60000) ? pf.foto : null;
      guardar('apelido', eu.apelido); guardar('recado', eu.recado); guardar('foto', eu.foto); guardar('perfilTs', Number(pf.ts));
      mudou = true;
    }
    // amigos
    for (const a of Array.isArray(est.amigos) ? est.amigos : []) {
      if (!a || typeof a.pub !== 'string' || apagados.amigos[a.pub] >= (a.ts || 0)) continue;
      const meu = amigos.get(a.pub);
      if (!meu || (a.estado === 'amigo' && meu.estado !== 'amigo') || (a.ts || 0) > (meu.ts || 0)) {
        amigos.set(a.pub, { pub: a.pub, num: a.num, uid: a.uid || null, nome: a.nome || null, estado: a.estado === 'amigo' ? 'amigo' : 'enviado', k: a.k || null, ts: a.ts || 0 });
        if (a.uid && a.k) registrarContato(a.uid, a.k);
        mudou = true;
      }
    }
    for (const [pub, a] of [...amigos]) if (apagados.amigos[pub] >= (a.ts || 0)) { amigos.delete(pub); mudou = true; }
    for (const b of Array.isArray(est.bloqueados) ? est.bloqueados : []) if (!bloqueados.has(b)) { bloqueados.add(b); mudou = true; }
    for (const p of Array.isArray(est.pedidos) ? est.pedidos : []) {
      if (p && p.pub && !pedidos.has(p.pub) && !amigos.has(p.pub) && !bloqueados.has(p.pub)) { pedidos.set(p.pub, p); mudou = true; }
    }
    for (const pub of [...pedidos.keys()]) if (amigos.has(pub) || bloqueados.has(pub)) { pedidos.delete(pub); mudou = true; }
    // canais
    for (const c of Array.isArray(est.canais) ? est.canais : []) {
      if (!c || !c.id || apagados.canais[c.id] >= (c.ts || 0) || salas.has(c.id)) continue;
      if (c.tipo === 'grupo' && codigoValido(String(c.codigo))) { await abrirGrupo(c.codigo, c.nome, { tsAdd: c.ts || 0, donoHash: c.dono }); mudou = true; }
      else if (c.tipo === 'dm' && amigos.has(c.pub)) { await abrirDM(amigos.get(c.pub), { tsAdd: c.ts || 0 }); mudou = true; }
    }
    for (const a of amigos.values()) if (a.estado === 'amigo' || a.estado === 'enviado') {
      const id = 'dm-' + (await segredoCom(a.pub)).id;
      if (!salas.has(id) && !(apagados.canais[id] >= (a.ts || 0))) { await abrirDM(a); mudou = true; }
    }
    for (const sala of [...salas.values()]) if (apagados.canais[sala.id] >= (sala.tsAdd || 0)) { largarCanal(sala, { semTchau: true }); mudou = true; }
    // status
    const ids = new Set(meusStatus.map(s => s.id));
    for (const s of Array.isArray(est.status) ? est.status : []) {
      const l = s && limparStatus(s);
      if (l && !ids.has(l.id) && !apagados.status[l.id]) { meusStatus.push(l); mudou = true; }
    }
    const antes = meusStatus.length;
    meusStatus = statusAtivos(meusStatus).filter(s => !apagados.status[s.id]).sort((a, b) => a.ts - b.ts);
    if (meusStatus.length !== antes) mudou = true;
    // quem tem acesso
    const acessos = ler('acessos', []);
    for (const x of Array.isArray(est.acessos) ? est.acessos : []) {
      if (x && x.nome && !acessos.some(y => y.nome === x.nome && y.ts === x.ts)) { acessos.push({ nome: String(x.nome).slice(0, 24), ts: Number(x.ts) || 0 }); mudou = true; }
    }
    if (mudou) {
      guardar('acessos', acessos);
      guardar('apagados', apagados);
      salvarAmigos(); salvarListaSalas();
      DB.set('meusStatus', meusStatus);
    }
  } finally { mesclando = false; }
  if (mudou) { renderTudo(); agendarPessoal(); }
  if ((est.ts || 0) < ultimaMudanca) publicarEstado(); // eu tenho coisa mais nova: mando de volta
}

// ================= rede (MQTT) =================
const conexoes = [];
const vistos = new Set(), ordemVistos = [];
function marcarVisto(p) { vistos.add(p); ordemVistos.push(p); if (ordemVistos.length > 5000) vistos.delete(ordemVistos.shift()); }
function conectado() { return conexoes.some(c => c.connected); }

function conectar() {
  for (const url of BROKERS) {
    const c = mqtt.connect(url, {
      clientId: 'fc_' + idAleatorio(14), keepalive: 30, clean: true,
      reconnectPeriod: 3000, connectTimeout: 10000,
    });
    c.on('connect', () => {
      for (const s of salas.values()) assinarCanal(c, s);
      const extra = [eu.topicoInbox, eu.topicoConta, ...porPessoal.keys(), ...esperandoNumero.keys()];
      c.subscribe(extra, { qos: 0 });
      renderStatus();
      for (const s of salas.values()) anunciar(s);
      clearTimeout(c.tPrimeiro);
      c.tPrimeiro = setTimeout(() => { garantirNumero(); publicarPessoal(); reenviarPedidos(); }, 300);
      clearTimeout(c.tEstado);
      c.tEstado = setTimeout(publicarEstado, 2500);
    });
    c.on('close', renderStatus);
    c.on('offline', renderStatus);
    c.on('error', e => console.warn('[FrogTalk] broker', url, e && e.message));
    c.on('message', aoChegar);
    conexoes.push(c);
  }
}

// envia em fila pra ordem não embaralhar (oferta da call antes dos candidatos, etc.)
let filaEnvio = Promise.resolve();
function enviar(sala, t, dados = {}) {
  const pk = { p: idAleatorio(12), t, f: eu.sessao, u: eu.uid, n: eu.apelido, ...dados };
  marcarVisto(pk.p);
  filaEnvio = filaEnvio.then(async () => {
    const txt = await trancar(sala.chave, pk);
    for (const c of conexoes) c.publish(sala.topico, txt, { qos: 0 });
  }).catch(e => console.warn('[FrogTalk] envio', e));
  return pk;
}

// recebe em fila também
let filaRecebe = Promise.resolve();
const RE_CANAL = /^(frogchat\/v1\/[0-9a-f]{24})(?:\/(r|cfg|mv)(?:\/.*)?)?$/;
function aoChegar(topico, payload, pacote) {
  if (!payload || !payload.length) return;
  if (topico.startsWith('frogchat/v1/n/')) { aoNumero(topico, payload); return; }
  let tarefa;
  if (topico === eu.topicoInbox) tarefa = () => processarInbox(payload);
  else if (topico === eu.topicoConta) tarefa = () => processarEstado(payload);
  else if (porPessoal.has(topico)) tarefa = () => processarPessoal(topico, payload);
  else {
    const m = topico.match(RE_CANAL);
    if (!m) return;
    const sala = porTopico.get(m[1]);
    if (!sala) return;
    if (m[2] === 'cfg') tarefa = () => processarCfg(sala, payload);
    else if (m[2] === 'mv') tarefa = () => processarMudou(sala, payload);
    else tarefa = () => processar(m[1], payload, m[2] === 'r' || (pacote && pacote.retain));
  }
  filaRecebe = filaRecebe.then(tarefa).catch(e => console.warn('[FrogTalk] recebe', e));
}

async function processar(topico, payload, daCaixa) {
  const sala = porTopico.get(topico);
  if (!sala) return;
  let pk;
  try { pk = await destrancar(sala.chave, dec.decode(payload)); } catch (e) { return; } // não é nosso / sem chave
  if (!pk || typeof pk.p !== 'string' || vistos.has(pk.p)) return;
  marcarVisto(pk.p);
  if (pk.f === eu.sessao) return;
  if (pk.to && pk.to !== eu.sessao) return;
  if (!salas.has(sala.id)) return;
  pk.n = String(pk.n || '???').slice(0, 24);
  if (sala.tipo === 'dm') confirmarAmigoPeloCanal(sala, pk);
  else {
    if (pk.k && pk.u !== eu.uid) registrarContato(pk.u, pk.k);
    if (pk.t === 'oi' || pk.t === 'caixa' || pk.t === 'msg') atualizarMembro(sala, pk);
  }
  if (!daCaixa && pk.t !== 'tchau' && pk.t !== 'caixa') {
    const novo = !sala.online.has(pk.f);
    sala.online.set(pk.f, { uid: pk.u, n: pk.n, visto: Date.now() });
    if (novo && sala === atual) renderOnline();
  }
  await tratar(sala, pk);
}

function limparMsg(m, autor) {
  const r = limparMsgBase(m, autor);
  // resposta: a citação da mensagem respondida
  if (r && m.resp && typeof m.resp === 'object' && typeof m.resp.id === 'string' && !r.sys && !r.reage && !r.chamar) {
    r.resp = { id: m.resp.id.slice(0, 20), u: String(m.resp.u || '').slice(0, 20), n: String(m.resp.n || '???').slice(0, 24), p: String(m.resp.p || '').slice(0, 120) };
  }
  return r;
}
function limparMsgBase(m, autor) {
  if (!m || !m.id) return null;
  const r = { id: String(m.id).slice(0, 20), u: autor || m.u, n: String(m.n || '???').slice(0, 24), ts: Number(m.ts) || Date.now() };
  if (m.sys) { r.sys = true; r.txt = String(m.txt || '').slice(0, 200); return r; }
  if (m.chamar) { r.chamar = true; return r; }
  if (m.reage && typeof m.reage === 'object' && typeof m.reage.alvo === 'string') {
    r.reage = { alvo: m.reage.alvo.slice(0, 20), e: REACOES.includes(m.reage.e) ? m.reage.e : '' };
    return r;
  }
  // ---- eventos escondidos (mexem numa mensagem que já existe) ----
  const alvo = x => x && typeof x === 'object' && typeof x.alvo === 'string' ? x.alvo.slice(0, 20) : null;
  if (alvo(m.edita) && typeof m.edita.txt === 'string' && m.edita.txt.trim()) { r.edita = { alvo: alvo(m.edita), txt: m.edita.txt.slice(0, 2000) }; return r; }
  if (alvo(m.apaga)) { r.apaga = { alvo: alvo(m.apaga) }; return r; }
  if (alvo(m.voto) && Array.isArray(m.voto.ops)) {
    r.voto = { alvo: alvo(m.voto), ops: [...new Set(m.voto.ops.filter(i => Number.isInteger(i) && i >= 0 && i < 6))] };
    return r;
  }
  if (alvo(m.jogada)) {
    const j = { alvo: alvo(m.jogada) };
    if (Number.isInteger(m.jogada.casa) && m.jogada.casa >= 0 && m.jogada.casa < 9) j.casa = m.jogada.casa;
    else if (typeof m.jogada.comp === 'string' && /^[0-9a-f]{64}$/.test(m.jogada.comp)) j.comp = m.jogada.comp;
    else if (m.jogada.rev && JOKENPO[m.jogada.rev.e] && typeof m.jogada.rev.sal === 'string') j.rev = { e: m.jogada.rev.e, sal: m.jogada.rev.sal.slice(0, 40) };
    else return null;
    r.jogada = j;
    return r;
  }
  // ---- enquete e minijogos (aparecem na conversa) ----
  if (m.enquete && typeof m.enquete === 'object' && typeof m.enquete.perg === 'string' && Array.isArray(m.enquete.ops)) {
    const ops = m.enquete.ops.filter(o => typeof o === 'string' && o.trim()).slice(0, 6).map(o => o.slice(0, 60));
    if (ops.length < 2) return null;
    r.enquete = { perg: m.enquete.perg.slice(0, 200), ops, multi: !!m.enquete.multi };
    return r;
  }
  if (m.jogo && typeof m.jogo === 'object' && ['velha', 'ppt', 'dado'].includes(m.jogo.tipo)) {
    r.jogo = { tipo: m.jogo.tipo };
    if (m.jogo.tipo === 'dado') r.jogo.valor = Math.min(6, Math.max(1, Math.round(Number(m.jogo.valor) || 1)));
    return r;
  }
  if (m.voz && typeof m.voz === 'object' && typeof m.voz.src === 'string' && /^data:audio\/[a-z0-9.+-]+(;[^,]*)?;base64,/.test(m.voz.src) && m.voz.src.length <= MAX_VOZ) {
    r.voz = { src: m.voz.src, dur: Math.min(VOZ_SEG + 5, Math.max(0, Number(m.voz.dur) || 0)), ondas: /^[0-9]{0,60}$/.test(m.voz.ondas || '') ? m.voz.ondas : '' };
    return r;
  }
  if (typeof m.fig === 'string' && FIGURINHAS.porId.has(m.fig)) { r.fig = m.fig; return r; }
  if (imagemValida(m.img, MAX_IMG)) { r.img = m.img; return r; }
  const legenda = typeof m.txt === 'string' && m.txt ? m.txt.slice(0, 2000) : null;
  if (imagemValida(m.foto, MAX_FOTO)) { r.foto = m.foto; if (legenda) r.txt = legenda; return r; }
  if (m.arq && typeof m.arq === 'object' && typeof m.arq.id === 'string' && Number(m.arq.tam) > 0 && Number(m.arq.tam) <= MAX_ARQ) {
    const a = m.arq;
    r.arq = {
      id: a.id.replace(/[^0-9a-z]/g, '').slice(0, 24), nome: String(a.nome || 'arquivo').slice(0, 120), tam: Number(a.tam),
      tipo: String(a.tipo || '').slice(0, 80), thumb: imagemValida(a.thumb, 40000) ? a.thumb : null,
    };
    if (legenda) r.txt = legenda;
    return r;
  }
  if (m.conta && typeof m.conta === 'object' && m.conta.dados && JSON.stringify(m.conta).length < 120000) {
    r.conta = { nome: String(m.conta.nome || 'Conta').slice(0, 24), foto: imagemValida(m.conta.foto, 60000) ? m.conta.foto : null, dados: m.conta.dados };
    return r;
  }
  if (typeof m.txt === 'string' && m.txt) { r.txt = m.txt.slice(0, 2000); return r; }
  return null;
}

async function tratar(sala, pk) {
  switch (pk.t) {
    case 'oi':
      if (pk.call) {
        if (!sala.naCall.has(pk.f)) { sala.naCall.set(pk.f, { uid: pk.u, n: pk.n, mudo: !!pk.mudo }); renderCall(); renderSalas(); }
      } else if (sala.naCall.has(pk.f)) {
        sala.naCall.delete(pk.f);
        if (call.sala === sala) fecharPeer(pk.f);
        renderCall(); renderSalas();
      }
      if (sala.semNome && !sala.cfg && typeof pk.s === 'string' && pk.s.trim()) {
        sala.nome = pk.s.trim().slice(0, 40); sala.semNome = false;
        salvarListaSalas(); renderSalas(); if (sala === atual) renderTopo();
      }
      if (pk.novo) setTimeout(() => { if (salas.has(sala.id)) enviar(sala, 'oi', dadosOi(sala)); }, 300 + Math.random() * 1200);
      break;

    case 'tchau':
      sala.online.delete(pk.f); sala.naCall.delete(pk.f); sala.digitando.delete(pk.f);
      if (call.sala === sala) fecharPeer(pk.f);
      if (sala === atual) { renderOnline(); renderDigitando(); }
      renderCall(); renderSalas();
      break;

    case 'msg': {
      const m = limparMsg(pk, pk.u);
      if (!m) break;
      // "só admins mandam mensagem": ignora quem não é admin
      if (sala.tipo === 'grupo' && sala.cfg && (sala.cfg.encerrado || (sala.cfg.soAdmins && !ehAdminUid(sala, pk.u))) && !m.sys) break;
      // reação: só atualiza os emojis embaixo da mensagem (não faz barulho nem conta como não lida)
      if (ehEvento(m)) { if (adicionarMsg(sala, m, true)) { salvarMsgs(sala); if (sala === atual) agendarRender(); aoEvento(sala, m); } break; }
      // anti-spam do lado de quem recebe (pega quem trapaceou pra passar do limite)
      if (!m.sys && pk.u !== eu.uid && spammando(sala, pk.u)) break;
      sala.digitando.delete(pk.f);
      if (sala === atual) renderDigitando();
      if (adicionarMsg(sala, m)) {
        notificar(sala, m);
        if (m.chamar && pk.u !== eu.uid) alertaChamada(sala, m);
        // arquivo pequeno chegando ao vivo: baixa sozinho (quem mandou está online agora)
        if (m.arq && m.arq.tam <= AUTO_BAIXAR) setTimeout(() => baixarArquivo(sala, m, true), 400);
      }
      break;
    }

    case 'pede': {
      const desde = Number(pk.desde) || 0;
      const lista = cortarPorTamanho(sala.msgs.filter(m => m.ts > desde && !m.conta).slice(-MAX_HIST), 190000); // não manda pacote gigante
      if (lista.length) setTimeout(() => { if (salas.has(sala.id)) enviar(sala, 'hist', { to: pk.f, msgs: lista }); }, 150 + Math.random() * 900);
      break;
    }

    case 'hist':
    case 'caixa':
      if (Array.isArray(pk.msgs)) {
        let novas = 0, ultima = null, reacoesNovas = false;
        for (const bruta of pk.msgs) {
          // na caixinha só valem as mensagens do próprio dono
          if (pk.t === 'caixa' && bruta && bruta.u !== pk.u) continue;
          if (pk.t === 'hist' && bruta && bruta.conta) continue;
          const m = limparMsg(bruta, pk.t === 'caixa' ? pk.u : undefined);
          if (m && adicionarMsg(sala, m, true)) {
            if (ehEvento(m)) { reacoesNovas = true; aoEvento(sala, m); continue; } // reação/voto/jogada não conta como mensagem nova
            novas++; ultima = m;
            // chamada que chegou pela caixinha/histórico (a pessoa estava offline ou acabou de entrar) e ainda é recente
            if (m.chamar && m.u !== eu.uid) alertaChamada(sala, m);
          }
        }
        if (novas) {
          salvarMsgs(sala);
          if (sala === atual) renderMsgs();
          if (pk.t === 'caixa' && ultima && ultima.u !== eu.uid && Date.now() - ultima.ts < 7 * DIA) {
            if (sala !== atual || document.hidden) { sala.naoLidas += novas; salvarMsgs(sala); }
          }
          renderSalas(); renderTitulo();
        } else if (reacoesNovas) { salvarMsgs(sala); if (sala === atual) agendarRender(); }
      }
      break;

    case 'dig':
      sala.digitando.set(pk.f, { n: pk.n, ate: Date.now() + 4000 });
      if (sala === atual) renderDigitando();
      break;

    case 'call_entra': await aoEntrarNaCall(sala, pk); break;
    case 'call_sai':
      sala.naCall.delete(pk.f);
      if (call.sala === sala) fecharPeer(pk.f);
      iceEspera.delete(pk.f);
      renderCall(); renderSalas();
      break;
    case 'call_mudo': {
      const p = sala.naCall.get(pk.f);
      if (p) { p.mudo = !!pk.m; renderCall(); }
      break;
    }
    case 'arq_pede': await aoPedidoArquivo(sala, pk); break;
    case 'arq_tenho': await aoTenhoArquivo(sala, pk); break;
    case 'arq_sdp': await aoSdpArquivo(sala, pk); break;
    case 'arq_ice': await aoIceArquivo(pk); break;
    case 'call_tela':
      if (pk.on) { tipoVideo.set(pk.f, pk.tipo === 'camera' ? 'camera' : 'tela'); renderPalco(); }
      else esconderTela(pk.f);
      break;
    case 'call_emoji': aoEmojiCall(sala, pk); break;
    case 'sdp': if (call.sala === sala) await aoSdp(pk); break;
    case 'ice': if (call.sala === sala) await aoIce(pk); break;
  }
}

const novasNaTela = new Set(); // ids que acabaram de chegar (ganham animação)
function adicionarMsg(sala, m, emLote) {
  if (sala.msgs.some(x => x.id === m.id)) return false;
  let i = sala.msgs.length;
  while (i > 0 && sala.msgs[i - 1].ts > m.ts) i--;
  sala.msgs.splice(i, 0, m);
  if (sala.msgs.length > MAX_MSGS) sala.msgs.splice(0, sala.msgs.length - MAX_MSGS);
  if (!emLote) { novasNaTela.add(m.id); salvarMsgs(sala); if (sala === atual) renderMsgs(); renderSalas(); }
  return true;
}

// presença: "tô aqui" a cada 15 s; quem some por 45 s saiu
setInterval(() => {
  const agora = Date.now();
  for (const sala of salas.values()) {
    if (conectado()) enviar(sala, 'oi', dadosOi(sala));
    for (const [id, o] of sala.online) {
      if (agora - o.visto > ONLINE_SEG * 1000) {
        sala.online.delete(id); sala.naCall.delete(id);
        if (call.sala === sala) fecharPeer(id);
      }
    }
    prepararTchau(sala);
  }
  renderOnline(); renderCall(); renderSalas();
}, 15000);
setInterval(() => { if (conectado()) reenviarPedidos(); }, 90000);
setInterval(() => { renderStatusLista(); renderSalas(); }, 60000); // status vencendo, "há X min"

// o "tchau" fica pronto (já trancado) pra sair na hora que a aba fecha
async function prepararTchau(sala) {
  const pk = { p: idAleatorio(12), t: 'tchau', f: eu.sessao, u: eu.uid, n: eu.apelido };
  sala.tchauPronto = await trancar(sala.chave, pk);
}
addEventListener('pagehide', () => {
  for (const sala of salas.values()) if (sala.tchauPronto) for (const c of conexoes) if (c.connected) c.publish(sala.topico, sala.tchauPronto, { qos: 0 });
});

// ================= sons =================
let ctxAudio = null;
function audioCtx() {
  if (!ctxAudio) ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
  if (ctxAudio.state === 'suspended') ctxAudio.resume().catch(() => {});
  return ctxAudio;
}
addEventListener('pointerdown', () => audioCtx(), { once: true });
addEventListener('keydown', () => audioCtx(), { once: true });

function bip(notas, tipo = 'sine', vol = 0.08) {
  try {
    const ctx = audioCtx(); let t = ctx.currentTime;
    for (const [f, d] of notas) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = tipo; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + d + 0.02);
      t += d * 0.85;
    }
  } catch (e) {}
}
const somMsg = () => bip([[880, 0.09], [1320, 0.13]]);
const somEntrou = () => bip([[523, 0.1], [784, 0.16]], 'triangle', 0.07);
const somSaiu = () => bip([[784, 0.1], [523, 0.16]], 'triangle', 0.07);
function somChamada() {
  for (let i = 0; i < 3; i++) setTimeout(() => bip([[660, 0.25], [880, 0.35]], 'triangle', 0.1), i * 1100);
  if (navigator.vibrate) navigator.vibrate([300, 200, 300]);
}

// ================= notificações =================
function notificar(sala, m) {
  const vendo = sala === atual && !document.hidden;
  if (m.u === eu.uid) { renderSalas(); return; } // mensagem da própria conta (outra pessoa com acesso)
  if (!vendo) {
    sala.naoLidas++; salvarMsgs(sala);
    if (!m.chamar) somMsg();
    if (!m.chamar) notificarSistema(nomeCanal(sala), previaMsg(m), sala); // só aparece se o FrogTalk estiver escondido
  }
  else if (document.hasFocus && !document.hasFocus()) somMsg();
  if (sala === atual && !pertoDoFim()) { novasAbaixo++; renderDescer(); }
  renderSalas(); renderTitulo();
}
function renderTitulo() {
  let n = 0; for (const s of salas.values()) n += s.naoLidas;
  n += pedidos.size;
  document.title = n ? `(${n}) FrogTalk` : 'FrogTalk';
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && atual) { atual.naoLidas = 0; salvarMsgs(atual); renderSalas(); renderTitulo(); }
});

// ================= call (WebRTC) =================
// peers: sessao -> {pc, nick, audio, estado, educado, fazendoOferta, faixas, senderTela}
// tela: a MINHA tela sendo mostrada; telas: as telas que estão chegando (sessao ou 'eu' -> {stream, nome})
const call = { sala: null, stream: null, mudo: false, peers: new Map(), tela: null, telas: new Map() };
const iceEspera = new Map(); // candidatos que chegaram antes da hora

async function entrarCall(sala) {
  if (call.sala === sala) return;
  if (call.sala) sairCall();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    avisar('Esse navegador não deixa usar o microfone aqui.'); return;
  }
  try {
    call.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
  } catch (e) {
    avisar('Não deu pra usar o microfone. Libera o microfone pro site (no cadeado da barra de endereço) e tenta de novo.');
    return;
  }
  audioCtx();
  document.querySelectorAll('.aviso.de-call').forEach(a => a.remove());
  call.sala = sala; call.mudo = false;
  medirVoz('eu', call.stream);
  enviar(sala, 'call_entra');
  somEntrou();
  renderCall(); renderSalas();
}

function sairCall() {
  const sala = call.sala;
  if (!sala) return;
  pararTela();
  enviar(sala, 'call_sai');
  for (const id of [...call.peers.keys()]) fecharPeer(id);
  for (const id of [...call.telas.keys()]) esconderTela(id);
  if (call.stream) call.stream.getTracks().forEach(t => t.stop());
  medidores.delete('eu');
  call.stream = null; call.sala = null; call.mudo = false;
  iceEspera.clear();
  somSaiu();
  renderCall(); renderSalas();
}

function alternarMudo() {
  if (!call.sala) return;
  call.mudo = !call.mudo;
  call.stream.getAudioTracks().forEach(t => { t.enabled = !call.mudo; });
  enviar(call.sala, 'call_mudo', { m: call.mudo });
  renderCall();
}

// "Negociação educada": qualquer um dos dois pode pedir pra (re)negociar a qualquer hora (ex.: quando alguém
// começa a mostrar a tela). Se os dois pedirem juntos, o "educado" cede a vez. Assim a call não cai.
function novoPeer(id, nick) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const peer = { pc, nick, audio: null, estado: 'conectando', educado: eu.sessao > id, fazendoOferta: false, faixas: false, senderTela: null };
  call.peers.set(id, peer);
  const sala = call.sala;
  pc.onnegotiationneeded = async () => {
    try {
      peer.fazendoOferta = true;
      await pc.setLocalDescription();
      if (call.peers.get(id) === peer) enviar(sala, 'sdp', { to: id, d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } catch (e) { console.warn('[FrogTalk] negociar', e); }
    finally { peer.fazendoOferta = false; }
  };
  pc.onicecandidate = e => { if (e.candidate && call.sala === sala) enviar(sala, 'ice', { to: id, c: e.candidate.toJSON() }); };
  pc.ontrack = e => {
    if (e.track.kind === 'video') {  // 🖥️ a tela de alguém chegando
      const s = e.streams[0] || new MediaStream([e.track]);
      mostrarTela(id, s, nick);
      e.track.addEventListener('ended', () => esconderTela(id));
      return;
    }
    if (!peer.audio) {
      peer.audio = document.createElement('audio');
      peer.audio.autoplay = true; peer.audio.playsInline = true;
      $('#audios').appendChild(peer.audio);
    }
    peer.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
    peer.audio.play().catch(() => {});
    medirVoz(id, peer.audio.srcObject);
  };
  pc.onconnectionstatechange = () => {
    if (call.peers.get(id) !== peer) return;
    peer.estado = pc.connectionState;
    if (pc.connectionState === 'failed') avisar(`Não consegui ligar o áudio com ${nick}. A internet de um de vocês pode estar bloqueando a call.`);
    renderCall();
  };
  return peer;
}
// põe o meu microfone (e a minha tela, se estiver mostrando) na conexão
function adicionarFaixas(peer) {
  if (peer.faixas) return;
  peer.faixas = true;
  for (const t of call.stream.getTracks()) peer.pc.addTrack(t, call.stream);
  if (call.tela) peer.senderTela = peer.pc.addTrack(call.tela.getVideoTracks()[0], call.tela);
}

function fecharPeer(id) {
  const peer = call.peers.get(id);
  if (!peer) return;
  call.peers.delete(id);
  try { peer.pc.close(); } catch (e) {}
  if (peer.audio) { peer.audio.srcObject = null; peer.audio.remove(); }
  medidores.delete(id);
  esconderTela(id);
}

// alguém entrou: quem já está na call liga pra ele
async function aoEntrarNaCall(sala, pk) {
  const estavaVazia = sala.naCall.size === 0;
  sala.naCall.set(pk.f, { uid: pk.u, n: pk.n, mudo: false });
  if (call.sala === sala) {
    somEntrou();
    fecharPeer(pk.f);
    adicionarFaixas(novoPeer(pk.f, pk.n)); // (pôr as faixas dispara a negociação sozinha)
  } else if (estavaVazia && !call.sala) {
    somChamada();
    avisar(`📞 ${nomeDe(pk.u, pk.n)} começou uma call em "${nomeCanal(sala)}"`, 'Entrar', () => { selecionarSala(sala); entrarCall(sala); }, 15000)
      .classList.add('de-call');
  }
  renderCall(); renderSalas();
}

async function aoSdp(pk) {
  const d = pk.d;
  if (!d || typeof d.sdp !== 'string') return;
  if (d.type === 'offer') {
    let peer = call.peers.get(pk.f);
    if (!peer) peer = novoPeer(pk.f, pk.n);
    // os dois pediram juntos? o "mal-educado" ignora a do outro; o "educado" desfaz a dele e aceita
    const colisao = peer.fazendoOferta || peer.pc.signalingState !== 'stable';
    if (colisao && !peer.educado) return;
    await peer.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    adicionarFaixas(peer); // (depois de ler a oferta: o microfone entra no lugar que ela já reservou)
    await soltarIce(pk.f);
    await peer.pc.setLocalDescription();
    enviar(call.sala, 'sdp', { to: pk.f, d: { type: 'answer', sdp: peer.pc.localDescription.sdp } });
  } else if (d.type === 'answer') {
    const peer = call.peers.get(pk.f);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    await soltarIce(pk.f);
  }
}

async function aoIce(pk) {
  if (!pk.c) return;
  const peer = call.peers.get(pk.f);
  if (!peer || !peer.pc.remoteDescription) {
    if (!iceEspera.has(pk.f)) iceEspera.set(pk.f, []);
    iceEspera.get(pk.f).push(pk.c);
    return;
  }
  try { await peer.pc.addIceCandidate(pk.c); } catch (e) {}
}
async function soltarIce(id) {
  const lista = iceEspera.get(id) || [];
  iceEspera.delete(id);
  const peer = call.peers.get(id);
  if (!peer) return;
  for (const c of lista) { try { await peer.pc.addIceCandidate(c); } catch (e) {} }
}

// ---------- 🖥️ mostrar a tela / 📷 ligar a câmera na call ----------
// (os dois usam o mesmo "cano" de vídeo: ou eu mostro a tela, ou a câmera — nunca os dois juntos)
// Celular: o navegador NÃO deixa site nenhum compartilhar a tela; a câmera funciona.
const podeMostrarTela = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !celular;
const podeCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
const tipoVideo = new Map(); // sessao -> 'tela' | 'camera' (o que cada um está mostrando)
async function ligarVideo(tipo) {
  if (!call.sala) return;
  if (call.tela) { const era = call.telaTipo; pararTela(); if (era === tipo) return; } // (apertou de novo = desliga)
  let s;
  try {
    if (tipo === 'tela') {
      if (!podeMostrarTela()) { avisar('O navegador do celular não deixa mostrar a tela. Dá pra ligar a 📷 câmera!'); return; }
      s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } else {
      s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: call.lente || 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    }
  } catch (e) {
    if (tipo === 'camera') avisar('Não deu pra usar a câmera. Libera a câmera pro site e tenta de novo.');
    return; // (ou a pessoa cancelou a escolha da tela)
  }
  if (!call.sala) { s.getTracks().forEach(t => t.stop()); return; }
  call.tela = s; call.telaTipo = tipo;
  const v = s.getVideoTracks()[0];
  v.addEventListener('ended', pararTela); // (quando aperta "parar de compartilhar" do navegador)
  for (const peer of call.peers.values()) if (peer.faixas) peer.senderTela = peer.pc.addTrack(v, s); // → renegocia sozinho
  enviar(call.sala, 'call_tela', { on: true, tipo });
  mostrarTela('eu', s, 'Você');
  renderCall();
}
const alternarTela = () => ligarVideo('tela');
const alternarCamera = () => ligarVideo('camera');
// 🔄 trocar a câmera da frente pela de trás (sem renegociar: só troca a imagem que vai)
async function virarCamera() {
  if (!call.tela || call.telaTipo !== 'camera') return;
  call.lente = call.lente === 'environment' ? 'user' : 'environment';
  let s;
  try { s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: call.lente, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }); }
  catch (e) { avisar('Não achei a outra câmera.'); return; }
  const nova = s.getVideoTracks()[0];
  for (const peer of call.peers.values()) if (peer.senderTela) { try { await peer.senderTela.replaceTrack(nova); } catch (e) {} }
  call.tela.getTracks().forEach(t => t.stop());
  nova.addEventListener('ended', pararTela);
  call.tela = s;
  mostrarTela('eu', s, 'Você');
}
function pararTela() {
  if (!call.tela) return;
  call.tela.getTracks().forEach(t => t.stop());
  for (const peer of call.peers.values()) {
    if (peer.senderTela) { try { peer.pc.removeTrack(peer.senderTela); } catch (e) {} peer.senderTela = null; }
  }
  call.tela = null; call.telaTipo = null;
  if (call.sala) enviar(call.sala, 'call_tela', { on: false });
  esconderTela('eu');
  renderCall();
}
function mostrarTela(id, stream, nome) {
  call.telas.set(id, { stream, nome });
  call.telaFoco = id; // a última que começou fica no palco
  call.palcoFechado = false;
  renderPalco();
}
function esconderTela(id) {
  if (!call.telas.delete(id)) return;
  if (call.telaFoco === id) call.telaFoco = [...call.telas.keys()].pop() || null;
  renderPalco();
}
function rotuloVideo(id) {
  const t = call.telas.get(id);
  const tipo = id === 'eu' ? call.telaTipo : (tipoVideo.get(id) || 'tela');
  if (id === 'eu') return tipo === 'camera' ? '📷 Sua câmera' : '📺 Você está mostrando a sua tela';
  return tipo === 'camera' ? `📷 Câmera de ${t.nome}` : `📺 Tela de ${t.nome}`;
}
function renderPalco() {
  const palco = $('#palco');
  const t = call.telaFoco && call.telas.get(call.telaFoco);
  const mostrar = !!(t && atual && call.sala === atual && !call.palcoFechado);
  palco.classList.toggle('escondido', !mostrar);
  if (!mostrar) return;
  const v = $('#videoPalco');
  if (v.srcObject !== t.stream) { v.srcObject = t.stream; v.play().catch(() => {}); }
  v.muted = true;
  const minhaCamera = call.telaFoco === 'eu' && call.telaTipo === 'camera';
  v.classList.toggle('espelho', minhaCamera && call.lente !== 'environment'); // (selfie: igual espelho)
  $('#nomePalco').textContent = rotuloVideo(call.telaFoco);
  $('#btPararTelaPalco').classList.toggle('escondido', call.telaFoco !== 'eu');
  $('#btVirarCamera').classList.toggle('escondido', !minhaCamera || !celular);
  // as outras câmeras/telas em miniatura (toca pra trocar quem fica no palco)
  const outras = [...call.telas.keys()].filter(id => id !== call.telaFoco);
  const mini = $('#miniaturas');
  mini.classList.toggle('escondido', !outras.length);
  const ja = new Map([...mini.querySelectorAll('video')].map(el => [el.dataset.id, el]));
  mini.replaceChildren(...outras.map(id => {
    const el = ja.get(id) || Object.assign(document.createElement('video'), { autoplay: true, muted: true, playsInline: true });
    el.dataset.id = id; el.title = rotuloVideo(id);
    if (el.srcObject !== call.telas.get(id).stream) { el.srcObject = call.telas.get(id).stream; el.play().catch(() => {}); }
    el.classList.toggle('espelho', id === 'eu' && call.telaTipo === 'camera' && call.lente !== 'environment');
    return el;
  }));
}
$('#miniaturas').onclick = e => { const v = e.target.closest('video'); if (v) { call.telaFoco = v.dataset.id; renderPalco(); } };
$('#btVirarCamera').onclick = virarCamera;
$('#btTela').onclick = alternarTela;
$('#btCamera').onclick = alternarCamera;
$('#btPararTelaPalco').onclick = pararTela;
$('#btTelaCheia').onclick = () => { const v = $('#videoPalco'); (v.requestFullscreen || v.webkitEnterFullscreen || (() => {})).call(v); };
$('#btFecharPalco').onclick = () => { call.palcoFechado = true; renderPalco(); avisar('Palco escondido. Toque em 📺 na barra da call pra ver de novo.'); };
$('#btVerPalco').onclick = () => { call.palcoFechado = false; renderPalco(); };

// ---------- 😂 emojis voando durante a call ----------
const EMOJIS_CALL = ['😂', '👏', '🔥', '❤️', '😮', '🐸'];
let ultimoEmoji = 0;
function mandarEmojiCall(e) {
  if (!call.sala || Date.now() - ultimoEmoji < 350) return;
  ultimoEmoji = Date.now();
  enviar(call.sala, 'call_emoji', { e });
  soltarEmoji(e, 'Você');
}
const emojiDe = new Map(); // sessao -> ts (não deixa ninguém metralhar)
function aoEmojiCall(sala, pk) {
  if (!EMOJIS_CALL.includes(pk.e) || sala !== atual) return;
  if (Date.now() - (emojiDe.get(pk.f) || 0) < 250) return;
  emojiDe.set(pk.f, Date.now());
  soltarEmoji(pk.e, nomeDe(pk.u, pk.n));
}
function soltarEmoji(e, nome) {
  const area = $('#chat');
  const el = document.createElement('div');
  el.className = 'emoji-voando';
  el.innerHTML = `<span>${e}</span><small>${esc(nome)}</small>`;
  el.style.left = (10 + Math.random() * 75) + '%';
  el.style.setProperty('--balanco', (Math.random() * 40 - 20) + 'px');
  area.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}
$('#emojisCall').innerHTML = EMOJIS_CALL.map(e => `<button data-emoji="${e}" title="Mandar ${e}">${e}</button>`).join('');
$('#emojisCall').onclick = ev => { const b = ev.target.closest('[data-emoji]'); if (b) mandarEmojiCall(b.dataset.emoji); };

// quem está falando (anel verde)
const medidores = new Map();
function medirVoz(id, stream) {
  try {
    const ctx = audioCtx();
    const an = ctx.createAnalyser(); an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    medidores.set(id, { an, buf: new Uint8Array(an.fftSize) });
  } catch (e) {}
}
setInterval(() => {
  for (const [id, m] of medidores) {
    m.an.getByteTimeDomainData(m.buf);
    let s = 0; for (const v of m.buf) { const x = (v - 128) / 128; s += x * x; }
    const falando = Math.sqrt(s / m.buf.length) > 0.035 && !(id === 'eu' && call.mudo);
    const el = document.querySelector(`[data-voz="${id}"]`);
    if (el) el.classList.toggle('falando', falando);
  }
}, 120);

// ================= imagens =================
function escolherImagem() {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = () => res(inp.files && inp.files[0] || null);
    inp.click();
  });
}
function carregarImg(arquivo) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(arquivo);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('imagem')); };
    img.src = url;
  });
}
// quadrado = corta o meio (foto de perfil / figurinha); senão só diminui
async function reduzirImagem(arquivo, max, { quadrado = false, tipo = 'image/jpeg', qualidade = 0.75 } = {}) {
  const img = await carregarImg(arquivo);
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (quadrado) { const lado = Math.min(sw, sh); sx = (sw - lado) / 2; sy = (sh - lado) / 2; sw = sh = lado; }
  const escala = Math.min(1, max / Math.max(sw, sh));
  const tela = document.createElement('canvas');
  tela.width = Math.round(sw * escala); tela.height = Math.round(sh * escala);
  const ctx = tela.getContext('2d');
  if (tipo === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tela.width, tela.height); }
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, tela.width, tela.height);
  return tela.toDataURL(tipo, qualidade);
}

// ================= figurinhas =================
let minhasFig = [];   // dataURLs das figurinhas que eu criei/salvei
let abaFig = 'sapos';
function salvarMinhasFig() { DB.set('minhasFig', minhasFig); }

function renderPainelFig() {
  document.querySelectorAll('[data-fig]').forEach(b => b.classList.toggle('ativa', b.dataset.fig === abaFig));
  const grade = $('#gradeFig');
  if (abaFig === 'sapos' || abaFig === 'bw') {
    const lista = (abaFig === 'sapos' ? FIGURINHAS.lista : FIGURINHAS.bw).filter(f => !f.oculta); // (as antigas paradas ficam escondidas)
    grade.innerHTML = lista.map(f => `<button class="fig" data-id="${f.id}" title="${esc(f.nome)}"><img src="${esc(f.url)}" class="${f.pixel ? 'pixel' : ''}" alt="${esc(f.nome)}" loading="lazy"></button>`).join('');
  } else {
    grade.innerHTML = `<button class="fig criar" id="btCriarFig" title="Criar figurinha com uma imagem"><span>＋</span><small>Criar</small></button>`
      + minhasFig.map((u, i) => `<button class="fig" data-minha="${i}"><img src="${esc(u)}" alt=""></button>`).join('');
  }
}
$('#gradeFig').addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b || !atual) return;
  if (b.id === 'btCriarFig') { criarFigurinha(); return; }
  if (b.dataset.id) mandarConteudo({ fig: b.dataset.id });
  else if (b.dataset.minha) mandarConteudo({ img: minhasFig[Number(b.dataset.minha)] });
  fecharPainelFig();
});
$('#gradeFig').addEventListener('contextmenu', async e => {
  const b = e.target.closest('[data-minha]');
  if (!b) return;
  e.preventDefault();
  const ok = await perguntar({ titulo: 'Apagar figurinha?', texto: '<p>Ela sai das suas figurinhas.</p>', ok: 'Apagar', perigo: true });
  if (ok) { minhasFig.splice(Number(b.dataset.minha), 1); salvarMinhasFig(); renderPainelFig(); }
});
document.querySelectorAll('[data-fig]').forEach(b => b.onclick = () => { abaFig = b.dataset.fig; renderPainelFig(); });
function fecharPainelFig() { $('#painelFig').classList.add('escondido'); $('#btFig').classList.remove('ativo'); }
$('#btFig').onclick = () => {
  const p = $('#painelFig');
  const abrir = p.classList.contains('escondido');
  p.classList.toggle('escondido', !abrir);
  $('#btFig').classList.toggle('ativo', abrir);
  if (abrir) renderPainelFig();
};

async function criarFigurinha() {
  const arq = await escolherImagem();
  if (!arq) return;
  let url;
  try {
    url = await reduzirImagem(arq, 256, { quadrado: true, tipo: 'image/webp', qualidade: 0.8 });
    if (!url.startsWith('data:image/webp') || url.length > MAX_IMG) url = await reduzirImagem(arq, 200, { quadrado: true, tipo: 'image/jpeg', qualidade: 0.7 });
  } catch (e) { avisar('Não consegui abrir essa imagem.'); return; }
  if (url.length > MAX_IMG) { avisar('Essa imagem ficou grande demais pra virar figurinha.'); return; }
  minhasFig.unshift(url);
  if (minhasFig.length > 60) minhasFig.length = 60;
  salvarMinhasFig();
  abaFig = 'minhas'; renderPainelFig();
  avisar('Figurinha criada! ⭐ Toca nela pra mandar.');
}

async function salvarFigurinhaRecebida(url) {
  if (minhasFig.includes(url)) { avisar('Essa figurinha já está nas suas. ⭐'); return; }
  const ok = await perguntar({ titulo: 'Salvar figurinha?', texto: `<img src="${esc(url)}" class="fig-previa" alt=""><p>Ela vai pras suas figurinhas (aba ⭐).</p>`, ok: 'Salvar' });
  if (!ok) return;
  minhasFig.unshift(url); salvarMinhasFig();
  avisar('Figurinha salva! ⭐');
}

// ================= status (tipo o do zap) =================
function pessoasComStatus() {
  const lista = [];
  for (const [uid, p] of perfis) {
    if (uid === eu.uid) continue;
    const st = statusAtivos(p.status);
    if (st.length) lista.push({ uid, nome: p.nome, status: st, visto: st.every(s => statusVistos.has(uid + ':' + s.id)) });
  }
  return lista.sort((a, b) => (a.visto - b.visto) || (b.status[b.status.length - 1].ts - a.status[a.status.length - 1].ts));
}

function renderStatusLista() {
  const meus = statusAtivos(meusStatus);
  $('#meuStatus').innerHTML = `<div class="av-anel ${meus.length ? 'anel visto' : ''}">${avatarHTML(eu.uid, eu.apelido)}</div>
    <div class="info"><div class="nome-sala">Meu status</div>
    <div class="previa">${meus.length ? `${meus.length} status · toque pra ver` : 'Posta um texto ou uma foto (some em 24 h)'}</div></div>`;
  $('#meuStatus').onclick = () => { if (meus.length) abrirVisor([{ uid: eu.uid, nome: 'Você', status: meus }], 0); };
  const pessoas = pessoasComStatus();
  $('#listaStatus').innerHTML = pessoas.length ? pessoas.map((p, i) => `<li class="sala" data-i="${i}">
      <div class="av-anel ${p.visto ? 'anel visto' : 'anel'}">${avatarHTML(p.uid, p.nome)}</div>
      <div class="info"><div class="nome-sala">${esc(p.nome)}</div><div class="previa">${haQuanto(p.status[p.status.length - 1].ts)}</div></div></li>`).join('')
    : '<li class="vazio-lista">Nenhum status dos seus amigos agora.</li>';
  $('#listaStatus').onclick = e => { const li = e.target.closest('[data-i]'); if (li) abrirVisor(pessoas, Number(li.dataset.i)); };
  $('#badgeStatus').classList.toggle('escondido', !pessoas.some(p => !p.visto));
}

let visor = null;
function abrirVisor(pessoas, iPessoa) {
  fecharVisor();
  visor = { pessoas, iP: iPessoa, iS: 0, timer: 0 };
  const st = pessoas[iPessoa].status;
  const primeiroNaoVisto = st.findIndex(s => !statusVistos.has(pessoas[iPessoa].uid + ':' + s.id));
  visor.iS = primeiroNaoVisto >= 0 ? primeiroNaoVisto : 0;
  $('#visor').classList.remove('escondido');
  mostrarStatus();
}
function fecharVisor() {
  if (!visor) return;
  clearTimeout(visor.timer);
  visor = null;
  $('#visor').classList.add('escondido');
  $('#visor').innerHTML = '';
  renderStatusLista(); renderSalas();
}
function passarStatus(d) {
  if (!visor) return;
  visor.iS += d;
  if (visor.iS >= visor.pessoas[visor.iP].status.length) { visor.iP++; visor.iS = 0; }
  if (visor.iS < 0) { visor.iP--; if (visor.iP < 0) { visor.iP = 0; visor.iS = 0; } else visor.iS = visor.pessoas[visor.iP].status.length - 1; }
  if (visor.iP >= visor.pessoas.length) { fecharVisor(); return; }
  mostrarStatus();
}
function mostrarStatus() {
  const p = visor.pessoas[visor.iP], s = p.status[visor.iS];
  if (p.uid !== eu.uid) { statusVistos.add(p.uid + ':' + s.id); guardar('statusVistos', [...statusVistos].slice(-500)); }
  const v = $('#visor');
  v.style.background = s.tipo === 'foto' ? '#000' : s.cor;
  v.innerHTML = `<div class="visor-barras">${p.status.map((_, i) => `<div class="barra"><div class="${i < visor.iS ? 'cheia' : i === visor.iS ? 'enchendo' : ''}"></div></div>`).join('')}</div>
    <div class="visor-topo">${avatarHTML(p.uid, p.nome)}<div><b>${esc(p.nome)}</b><small>${haQuanto(s.ts)}</small></div>
      ${p.uid === eu.uid ? '<button class="bt-icone" id="visorApagar" title="Apagar este status">🗑️</button>' : ''}
      <button class="bt-icone" id="visorFechar" title="Fechar">✕</button></div>
    <div class="visor-meio">${s.tipo === 'foto' ? `<img src="${esc(s.img)}" alt="">` : ''}
      ${s.txt ? `<div class="${s.tipo === 'foto' ? 'legenda' : 'texto-status'}">${esc(s.txt)}</div>` : ''}</div>
    <div class="visor-toque esq"></div><div class="visor-toque dir"></div>`;
  v.querySelector('.visor-toque.esq').onclick = () => passarStatus(-1);
  v.querySelector('.visor-toque.dir').onclick = () => passarStatus(1);
  $('#visorFechar').onclick = fecharVisor;
  const ap = $('#visorApagar');
  if (ap) ap.onclick = async () => {
    clearTimeout(visor.timer);
    const ok = await perguntar({ titulo: 'Apagar status?', ok: 'Apagar', perigo: true });
    if (ok) {
      meusStatus = meusStatus.filter(x => x.id !== s.id);
      apagados.status[s.id] = Date.now(); guardar('apagados', apagados);
      DB.set('meusStatus', meusStatus); agendarPessoal(); mudouConta(); fecharVisor();
    } else mostrarStatus();
  };
  clearTimeout(visor.timer);
  visor.timer = setTimeout(() => passarStatus(1), s.tipo === 'foto' ? 7000 : 5000);
  v.querySelector('.enchendo').style.animationDuration = (s.tipo === 'foto' ? 7 : 5) + 's';
}
addEventListener('keydown', e => {
  if (!visor) return;
  if (e.key === 'Escape') fecharVisor();
  if (e.key === 'ArrowRight') passarStatus(1);
  if (e.key === 'ArrowLeft') passarStatus(-1);
});

function postarStatus(s) {
  meusStatus = statusAtivos(meusStatus);
  meusStatus.push({ id: idAleatorio(10), ts: Date.now(), ...s });
  if (meusStatus.length > 15) meusStatus = meusStatus.slice(-15);
  DB.set('meusStatus', meusStatus);
  agendarPessoal(); mudouConta();
  renderStatusLista();
  avisar('Status postado! Some em 24 horas. ⭕');
}

$('#btStatusTexto').onclick = () => {
  let cor = CORES_STATUS[Math.floor(Math.random() * CORES_STATUS.length)];
  const fundo = document.createElement('div');
  fundo.className = 'fundo-janela';
  fundo.innerHTML = `<form class="janela"><h3>Status de texto</h3>
    <textarea class="campo previa-status" maxlength="300" placeholder="O que você tá pensando?" rows="4"></textarea>
    <div class="cores">${CORES_STATUS.map(c => `<button type="button" class="cor" data-cor="${c}" style="background:${c}"></button>`).join('')}</div>
    <div class="botoes"><button type="button" class="bt claro cancelar">Cancelar</button><button class="bt">Postar</button></div></form>`;
  const ta = fundo.querySelector('textarea');
  const pintar = () => { ta.style.background = cor; fundo.querySelectorAll('.cor').forEach(b => b.classList.toggle('ativa', b.dataset.cor === cor)); };
  fundo.querySelectorAll('.cor').forEach(b => b.onclick = () => { cor = b.dataset.cor; pintar(); ta.focus(); });
  fundo.querySelector('.cancelar').onclick = () => fundo.remove();
  fundo.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const txt = ta.value.trim();
    if (!txt) return;
    fundo.remove();
    postarStatus({ tipo: 'texto', txt, cor });
  };
  document.body.appendChild(fundo);
  pintar(); ta.focus();
};

$('#btStatusFoto').onclick = async () => {
  const arq = await escolherImagem();
  if (!arq) return;
  let img;
  try { img = await reduzirImagem(arq, 560, { qualidade: 0.6 }); } catch (e) { avisar('Não consegui abrir essa imagem.'); return; }
  if (img.length > 120000) img = await reduzirImagem(arq, 420, { qualidade: 0.5 });
  const legenda = await perguntar({ titulo: 'Status de foto', texto: `<img src="${img}" class="foto-previa" alt="">`, campo: 'Legenda (opcional)', ok: 'Postar', max: 120 });
  if (legenda === null) return;
  postarStatus({ tipo: 'foto', img, txt: legenda });
};

// ================= arquivos, fotos e vídeos =================
// Foto: vai comprimida dentro da mensagem (chega até offline).
// Vídeo/arquivo: a mensagem leva só nome, tamanho e miniatura; o arquivo em si vai direto
// de um aparelho pro outro (WebRTC), de quem tiver ele guardado e estiver online.
const arqUrls = new Map();     // id -> objectURL (arquivo que este aparelho já tem)
const arqChecado = new Set();  // ids que já procurei no banco
const baixando = new Map();    // id -> {pct}
const pedidosArq = new Map();  // tid -> {sala, m, respondeu, silencioso}
const transf = new Map();      // tid -> {pc, remoto, sala, ice:[]}

function fmtTam(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return Math.round(b / 1024) + ' KB';
  return (b / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}
function tipoArq(a) {
  if (a.tipo.startsWith('video/')) return 'video';
  if (a.tipo.startsWith('audio/')) return 'audio';
  if (a.tipo.startsWith('image/')) return 'imagem';
  return 'arquivo';
}
function iconeArq(a) {
  const ext = (a.nome.split('.').pop() || '').toLowerCase();
  if (tipoArq(a) === 'video') return '🎬';
  if (tipoArq(a) === 'audio') return '🎵';
  if (tipoArq(a) === 'imagem') return '🖼️';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  if (['pdf'].includes(ext)) return '📕';
  if (['exe', 'msi', 'apk'].includes(ext)) return '⚙️';
  if (['txt', 'doc', 'docx', 'md'].includes(ext)) return '📝';
  return '📄';
}
// procura no banco se este aparelho já tem o arquivo (e redesenha quando acha)
function conferirArquivo(id) {
  if (arqChecado.has(id)) return;
  arqChecado.add(id);
  DB.get('arq:' + id).then(blob => {
    if (blob instanceof Blob && !arqUrls.has(id)) { arqUrls.set(id, URL.createObjectURL(blob)); agendarRender(); }
  });
}
let tRender = 0;
function agendarRender() { clearTimeout(tRender); tRender = setTimeout(() => renderMsgs(), 60); }

function lerComoDataURL(arquivo) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(arquivo); });
}
async function comprimirFoto(arquivo) {
  for (const [max, q] of [[1280, 0.72], [1024, 0.62], [800, 0.55], [640, 0.5]]) {
    const url = await reduzirImagem(arquivo, max, { qualidade: q });
    if (url.length <= MAX_FOTO) return url;
  }
  return null;
}
function miniaturaVideo(arquivo) {
  return new Promise(res => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(arquivo);
    let feito = false;
    const fim = r => { if (feito) return; feito = true; URL.revokeObjectURL(url); res(r); };
    v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
    v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 3); };
    v.onseeked = () => {
      try {
        const escala = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * escala); c.height = Math.round(v.videoHeight * escala);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        fim(c.toDataURL('image/jpeg', 0.6));
      } catch (e) { fim(null); }
    };
    v.onerror = () => fim(null);
    setTimeout(() => fim(null), 5000);
  });
}

async function enviarArquivos(lista) {
  if (!atual) return;
  if (!podeFalar(atual)) { avisar('Você não pode mandar mensagem neste grupo. 🔒'); return; }
  if (emCastigo()) { avisar(textoCastigo()); return; }
  for (const arquivo of [...lista]) await prepararEnvio(arquivo);
}
async function prepararEnvio(arquivo) {
  if (arquivo.size > MAX_ARQ) { avisar(`"${arquivo.name}" é grande demais (${fmtTam(arquivo.size)}). O limite é ${fmtTam(MAX_ARQ)}.`, null, null, 7000); return; }
  const sala = atual;
  let conteudo = null, previa = '';
  try {
    if (arquivo.type.startsWith('image/') && arquivo.type !== 'image/gif' && arquivo.type !== 'image/svg+xml') {
      const foto = await comprimirFoto(arquivo);
      if (foto) { conteudo = { foto }; previa = `<img src="${foto}" class="foto-previa" alt="">`; }
    } else if (arquivo.type === 'image/gif' && arquivo.size <= MAX_FOTO * 0.74) {
      const foto = await lerComoDataURL(arquivo); // GIF pequeno vai inteiro (continua animado)
      conteudo = { foto }; previa = `<img src="${foto}" class="foto-previa" alt="">`;
    }
  } catch (e) { conteudo = null; }
  let blob = null;
  if (!conteudo) {
    const arq = { id: idAleatorio(16), nome: arquivo.name || 'arquivo', tam: arquivo.size, tipo: arquivo.type || '', thumb: null };
    if (arq.tipo.startsWith('video/')) arq.thumb = await miniaturaVideo(arquivo);
    else if (arq.tipo.startsWith('image/')) { try { arq.thumb = await reduzirImagem(arquivo, 320, { qualidade: 0.6 }); } catch (e) {} }
    conteudo = { arq }; blob = arquivo;
    previa = arq.thumb ? `<img src="${arq.thumb}" class="foto-previa" alt="">`
      : `<div class="arq-previa"><span>${iconeArq(arq)}</span><div><b>${esc(arq.nome)}</b><small>${fmtTam(arq.tam)}</small></div></div>`;
    previa += `<p class="dica-num">${tipoArq(arq) === 'video' ? 'O vídeo' : 'O arquivo'} vai direto do seu aparelho pro dos outros — eles baixam enquanto você estiver online.</p>`;
  }
  const legenda = await perguntar({ titulo: conteudo.foto ? 'Mandar foto' : tipoArq(conteudo.arq) === 'video' ? 'Mandar vídeo' : 'Mandar arquivo', texto: previa, campo: 'Legenda (opcional)', ok: 'Enviar ➤', max: 500 });
  if (legenda === null) return;
  if (blob) {
    await DB.set('arq:' + conteudo.arq.id, blob);
    arqUrls.set(conteudo.arq.id, URL.createObjectURL(blob));
    arqChecado.add(conteudo.arq.id);
  }
  mandarConteudo(legenda ? { ...conteudo, txt: legenda } : conteudo, sala);
}

// --- baixar: pergunta quem tem, o primeiro que responder manda direto ---
function baixarArquivo(sala, m, silencioso = false) {
  const a = m.arq;
  if (!a || arqUrls.has(a.id) || baixando.has(a.id)) return;
  const tid = idAleatorio(10);
  baixando.set(a.id, { pct: 0 });
  pedidosArq.set(tid, { sala, m, respondeu: false, silencioso });
  enviar(sala, 'arq_pede', { a: a.id, tid });
  agendarRender();
  setTimeout(() => {
    const p = pedidosArq.get(tid);
    if (!p || p.respondeu) return;
    pedidosArq.delete(tid); baixando.delete(a.id); agendarRender();
    if (!silencioso) avisar(`Ninguém que tem "${a.nome}" está online agora. Tenta de novo quando ${m.u === eu.uid ? 'o outro aparelho' : nomeDe(m.u, m.n)} estiver online.`, null, null, 7000);
  }, 8000);
}
async function aoPedidoArquivo(sala, pk) {
  const id = String(pk.a || '');
  if (!id || !pk.tid) return;
  const blob = await DB.get('arq:' + id);
  if (blob instanceof Blob) enviar(sala, 'arq_tenho', { to: pk.f, a: id, tid: pk.tid });
}
function novoPcArquivo(tid, sala, remoto) {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  const t = { pc, sala, remoto, ice: [], vivo: Date.now() };
  transf.set(tid, t);
  pc.onicecandidate = e => { if (e.candidate) enviar(sala, 'arq_ice', { to: remoto, tid, c: e.candidate.toJSON() }); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) fecharTransf(tid, pc.connectionState === 'failed'); };
  t.timer = setInterval(() => { if (Date.now() - t.vivo > 25000) fecharTransf(tid, true); }, 5000); // travou = desiste
  return t;
}
function fecharTransf(tid, falhou) {
  const t = transf.get(tid);
  if (!t) return;
  transf.delete(tid);
  clearInterval(t.timer);
  try { t.pc.close(); } catch (e) {}
  const p = pedidosArq.get(tid);
  if (p) {
    pedidosArq.delete(tid);
    if (!arqUrls.has(p.m.arq.id)) {
      baixando.delete(p.m.arq.id); agendarRender();
      if (falhou || !p.silencioso) avisar(`Não consegui baixar "${p.m.arq.nome}". A internet de alguém pode estar bloqueando — tenta de novo.`, null, null, 7000);
    }
  }
}
// quem pediu: recebeu "eu tenho" → abre o cano direto e espera os pedaços
async function aoTenhoArquivo(sala, pk) {
  const p = pedidosArq.get(pk.tid);
  if (!p || p.respondeu) return;
  p.respondeu = true;
  const a = p.m.arq;
  const t = novoPcArquivo(pk.tid, sala, pk.f);
  const dc = t.pc.createDataChannel('arq', { ordered: true });
  dc.binaryType = 'arraybuffer';
  const pedacos = []; let recebido = 0, ultimoDesenho = 0;
  dc.onmessage = async e => {
    pedacos.push(e.data); recebido += e.data.byteLength; t.vivo = Date.now();
    const pct = Math.min(100, Math.round(recebido / a.tam * 100));
    baixando.set(a.id, { pct });
    if (Date.now() - ultimoDesenho > 150) { ultimoDesenho = Date.now(); const b = document.querySelector(`[data-prog="${a.id}"]`); if (b) b.style.width = pct + '%'; }
    if (recebido >= a.tam) {
      const blob = new Blob(pedacos, { type: a.tipo });
      await DB.set('arq:' + a.id, blob);
      arqUrls.set(a.id, URL.createObjectURL(blob));
      baixando.delete(a.id);
      pedidosArq.delete(pk.tid);
      fecharTransf(pk.tid);
      agendarRender();
    }
  };
  const oferta = await t.pc.createOffer();
  await t.pc.setLocalDescription(oferta);
  enviar(sala, 'arq_sdp', { to: pk.f, tid: pk.tid, a: a.id, d: { type: 'offer', sdp: t.pc.localDescription.sdp } });
}
// quem tem: recebeu a oferta → responde e manda o arquivo em pedaços
async function aoSdpArquivo(sala, pk) {
  const d = pk.d;
  if (!d || typeof d.sdp !== 'string' || !pk.tid) return;
  if (d.type === 'offer') {
    const blob = await DB.get('arq:' + String(pk.a || ''));
    if (!(blob instanceof Blob)) return;
    const t = novoPcArquivo(pk.tid, sala, pk.f);
    t.pc.ondatachannel = e => mandarBlob(e.channel, blob, t);
    await t.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    await soltarIceArquivo(pk.tid);
    const resp = await t.pc.createAnswer();
    await t.pc.setLocalDescription(resp);
    enviar(sala, 'arq_sdp', { to: pk.f, tid: pk.tid, d: { type: 'answer', sdp: t.pc.localDescription.sdp } });
  } else if (d.type === 'answer') {
    const t = transf.get(pk.tid);
    if (!t || t.pc.signalingState !== 'have-local-offer') return;
    await t.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    await soltarIceArquivo(pk.tid);
  }
}
async function aoIceArquivo(pk) {
  const t = transf.get(pk.tid);
  if (!t || !pk.c) return;
  if (!t.pc.remoteDescription) { t.ice.push(pk.c); return; }
  try { await t.pc.addIceCandidate(pk.c); } catch (e) {}
}
async function soltarIceArquivo(tid) {
  const t = transf.get(tid);
  if (!t) return;
  const l = t.ice; t.ice = [];
  for (const c of l) { try { await t.pc.addIceCandidate(c); } catch (e) {} }
}
function mandarBlob(dc, blob, t) {
  const PEDACO = 16 * 1024;
  let pos = 0, mandando = false;
  dc.bufferedAmountLowThreshold = 512 * 1024;
  const mandar = async () => {
    if (mandando) return;
    mandando = true;
    try {
      while (pos < blob.size && dc.readyState === 'open') {
        if (dc.bufferedAmount > 2 * 1024 * 1024) { mandando = false; dc.onbufferedamountlow = () => { dc.onbufferedamountlow = null; mandar(); }; return; }
        const p = await blob.slice(pos, pos + PEDACO).arrayBuffer();
        dc.send(p); pos += p.byteLength; t.vivo = Date.now();
      }
    } catch (e) { console.warn('[FrogTalk] envio de arquivo', e); }
    mandando = false;
  };
  dc.onopen = mandar;
  if (dc.readyState === 'open') mandar();
}

// foto em tela cheia
function verFoto(src, nome) {
  const fundo = document.createElement('div');
  fundo.className = 'lupa';
  fundo.innerHTML = `<img src="${esc(src)}" alt=""><div class="lupa-botoes">
    <a class="bt claro" href="${esc(src)}" download="${esc(nome || 'foto-frogchat.jpg')}">⬇ Salvar</a><button class="bt">✕ Fechar</button></div>`;
  fundo.onclick = e => { if (e.target === fundo || e.target.closest('button')) fundo.remove(); };
  fundo.addEventListener('keydown', e => { if (e.key === 'Escape') fundo.remove(); });
  document.body.appendChild(fundo);
  fundo.tabIndex = -1; fundo.focus();
}

// botão 📎, arrastar e colar
function escolherArquivos() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.onchange = () => { if (inp.files && inp.files.length) enviarArquivos(inp.files); };
  inp.click();
}
$('#btAnexo').onclick = () => abrirMenuAnexo();
$('#chat').addEventListener('dragover', e => { if (atual && e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); $('#chat').classList.add('soltando'); } });
$('#chat').addEventListener('dragleave', e => { if (e.target === $('#chat') || !$('#chat').contains(e.relatedTarget)) $('#chat').classList.remove('soltando'); });
$('#chat').addEventListener('drop', e => {
  $('#chat').classList.remove('soltando');
  if (!atual || !e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  enviarArquivos(e.dataTransfer.files);
});
$('#campoMsg').addEventListener('paste', e => {
  const arqs = e.clipboardData && [...e.clipboardData.files];
  if (arqs && arqs.length) { e.preventDefault(); enviarArquivos(arqs); }
});

// ================= anti-spam =================
// quem manda mais de 10 mensagens em 20 s fica 5 minutos sem mandar (o castigo fica salvo)
let envios = ler('envios', []);
let castigoAte = ler('castigoAte', 0);
const emCastigo = () => Date.now() < castigoAte;
function contarEnvio() {
  const agora = Date.now();
  envios = envios.filter(t => agora - t < SPAM_JANELA);
  if (envios.length >= SPAM_QTD) {
    castigoAte = agora + SPAM_CASTIGO; envios = [];
    guardar('castigoAte', castigoAte); guardar('envios', envios);
    avisar('🐢 Calma! Você mandou mensagens rápido demais e vai ficar 5 minutos sem mandar.', null, null, 7000);
    renderCaixa();
    return false;
  }
  envios.push(agora);
  guardar('envios', envios);
  if (envios.length === SPAM_QTD - 2) avisar('⚠️ Devagar! Mais 2 mensagens rápidas e você fica 5 minutos sem mandar.', null, null, 4000);
  return true;
}
function textoCastigo() {
  const s = Math.max(0, Math.ceil((castigoAte - Date.now()) / 1000));
  return `🐢 Você mandou mensagens rápido demais. Espera ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} pra mandar de novo.`;
}
setInterval(() => {
  if (!atual) return;
  const el = $('#semPermissao');
  if (emCastigo()) { if (el.classList.contains('escondido')) renderCaixa(); else el.textContent = textoCastigo(); }
  else if (castigoAte && !el.classList.contains('escondido') && podeFalar(atual)) { castigoAte = 0; guardar('castigoAte', 0); renderCaixa(); }
}, 1000);
// do lado de quem recebe: conta as mensagens de cada pessoa; passou do limite = ignora por 5 min
const recebidas = new Map(); // sala.id + uid -> {ts:[], ate}
function spammando(sala, uid) {
  const k = sala.id + ':' + uid, agora = Date.now();
  const r = recebidas.get(k) || { ts: [], ate: 0 };
  recebidas.set(k, r);
  if (agora < r.ate) return true;
  r.ts = r.ts.filter(t => agora - t < SPAM_JANELA);
  r.ts.push(agora);
  if (r.ts.length > SPAM_QTD) { r.ate = agora + SPAM_CASTIGO; r.ts = []; return true; }
  return false;
}

// ================= chamar ("Fulano está te chamando") =================
function chamar() {
  if (!atual) return;
  const sala = atual;
  const a = sala.tipo === 'dm' ? amigos.get(sala.pub) : null;
  if (a && a.estado !== 'amigo') { avisar('Espera a pessoa aceitar o pedido de amizade. ⏳'); return; }
  const ultima = ler('chamou:' + sala.id, 0);
  const falta = Math.ceil((ultima + CHAMAR_INTERVALO - Date.now()) / 1000);
  if (falta > 0) { avisar(`Você acabou de chamar. Espera ${falta} s pra chamar de novo. 🔔`); return; }
  if (mandarConteudo({ chamar: true }, sala)) {
    guardar('chamou:' + sala.id, Date.now());
    tremer();
    bip([[988, 0.08], [1319, 0.12]], 'square', 0.04);
  }
}
const ultimaChamadaDe = new Map(); // uid -> ts (não deixa tocar sem parar)
function alertaChamada(sala, m) {
  if (Date.now() - m.ts > 2 * 60000) return;                    // chamada velha não toca
  if (Date.now() - (ultimaChamadaDe.get(m.u) || 0) < 15000) return;
  ultimaChamadaDe.set(m.u, Date.now());
  const nome = nomeDe(m.u, m.n);
  const onde = sala.tipo === 'grupo' ? ` em "${nomeCanal(sala)}"` : '';
  document.querySelectorAll('.aviso.de-chamar').forEach(a => a.remove());
  avisar(`🔔 ${nome} está te chamando${onde}!`, 'Responder', () => selecionarSala(sala), 20000).classList.add('de-chamar');
  somChamar();
  tremer();
  if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
  notificarSistema(`🔔 ${nome} está te chamando!`, sala.tipo === 'grupo' ? `No grupo "${nomeCanal(sala)}"` : 'Toque pra responder', sala, true);
}
function somChamar() {
  for (let i = 0; i < 3; i++) setTimeout(() => bip([[1046, 0.09], [1318, 0.09], [1568, 0.14]], 'square', 0.05), i * 450);
}
function tremer() {
  const app = $('#app');
  app.classList.remove('tremer'); void app.offsetWidth; app.classList.add('tremer');
  setTimeout(() => app.classList.remove('tremer'), 700);
}

// ================= notificações do sistema (Windows / celular) =================
let registroSW = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(r => { registroSW = r; }).catch(() => {});
  navigator.serviceWorker.addEventListener('message', e => {
    const s = e.data && salas.get(e.data.abrir);
    if (s) selecionarSala(s);
  });
}
const podeNotificar = () => 'Notification' in window && Notification.permission === 'granted';
async function notificarSistema(titulo, corpo, sala, forte = false) {
  if (!podeNotificar()) return;
  if (!forte && !document.hidden) return; // mensagem comum só avisa se o FrogTalk estiver escondido
  const op = { body: corpo, tag: sala ? sala.id : 'frogchat', renotify: true, data: sala ? sala.id : null, icon: FIGURINHAS.porId.get('feliz').url, requireInteraction: forte };
  try {
    if (registroSW) { await registroSW.showNotification(titulo, op); return; }
  } catch (e) {}
  try {
    const n = new Notification(titulo, op);
    n.onclick = () => { window.focus(); if (sala) selecionarSala(sala); n.close(); };
  } catch (e) {}
}
function renderBannerNotif() {
  const mostrar = 'Notification' in window && Notification.permission === 'default' && !ler('semBannerNotif', false);
  $('#bannerNotif').classList.toggle('escondido', !mostrar);
}
$('#btAtivarNotif').onclick = async () => {
  try { await Notification.requestPermission(); } catch (e) {}
  renderBannerNotif();
  if (podeNotificar()) avisar('🔔 Notificações ligadas! Você vai saber quando te chamarem.');
};
$('#btFecharNotif').onclick = () => { guardar('semBannerNotif', true); renderBannerNotif(); };
$('#btChamar').onclick = chamar;

// ================= 🌙 tema escuro =================
function temaAtual() {
  const t = document.documentElement.dataset.tema;
  if (t) return t;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}
function renderTema() {
  const escuro = temaAtual() === 'escuro';
  $('#btTema').textContent = escuro ? '☀️' : '🌙';
  $('#btTema').title = escuro ? 'Tema claro' : 'Tema escuro';
  document.querySelector('meta[name=theme-color]').content = escuro ? '#2e1065' : '#6d28d9';
}
$('#btTema').onclick = () => {
  const novo = temaAtual() === 'escuro' ? 'claro' : 'escuro';
  document.documentElement.dataset.tema = novo;
  guardarGlobal('frogchat-tema', novo);
  renderTema();
};
renderTema();

// ================= 📲 instalar como aplicativo =================
let pedidoInstalar = null; // o navegador guarda o "pode instalar" até a gente usar
const jaInstalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ehIphone = /iphone|ipad|ipod/i.test(navigator.userAgent);
addEventListener('beforeinstallprompt', e => { e.preventDefault(); pedidoInstalar = e; renderBannerInstalar(); });
addEventListener('appinstalled', () => { pedidoInstalar = null; renderBannerInstalar(); avisar('📲 FrogTalk instalado! Agora ele tem o ícone do sapo. 🐸'); });
function renderBannerInstalar() {
  const mostrar = !jaInstalado() && !ler('semBannerInstalar', false) && (pedidoInstalar || ehIphone);
  $('#bannerInstalar').classList.toggle('escondido', !mostrar);
}
async function instalarApp() {
  if (pedidoInstalar) {
    pedidoInstalar.prompt();
    const { outcome } = await pedidoInstalar.userChoice;
    if (outcome === 'accepted') pedidoInstalar = null;
    renderBannerInstalar();
  } else if (ehIphone) {
    perguntar({ titulo: '📲 Instalar no iPhone', cancelar: null, ok: 'Entendi',
      texto: '<p>No Safari, toque em <b>Compartilhar</b> (o quadradinho com a setinha pra cima) e depois em <b>Adicionar à Tela de Início</b>.</p>' });
  } else if (jaInstalado()) avisar('O FrogTalk já está instalado! 🐸');
  else avisar('Esse navegador não deixa instalar daqui. No Chrome ou no Edge aparece o botão de instalar na barra de endereço.', null, null, 7000);
}
$('#btInstalar').onclick = instalarApp;
$('#btFecharInstalar').onclick = () => { guardar('semBannerInstalar', true); renderBannerInstalar(); };
renderBannerInstalar();

// ================= tela: utilidades =================
function avisar(texto, botao, acao, ms) {
  const div = document.createElement('div');
  div.className = 'aviso';
  div.innerHTML = `<span>${esc(texto)}</span>`;
  if (botao) {
    const b = document.createElement('button');
    b.className = 'bt verde'; b.textContent = botao;
    b.onclick = () => { div.remove(); acao(); };
    div.appendChild(b);
  }
  div.addEventListener('click', e => { if (e.target === div || e.target.tagName === 'SPAN') div.remove(); });
  $('#avisos').appendChild(div);
  setTimeout(() => div.remove(), ms || (botao ? 12000 : 5000));
  return div;
}

// janelinha (no lugar do prompt/alert do navegador)
function perguntar({ titulo, texto = '', campo = null, valor = '', ok = 'OK', cancelar = 'Cancelar', perigo = false, max = 40, modo = 'text' }) {
  return new Promise(res => {
    const fundo = document.createElement('div');
    fundo.className = 'fundo-janela';
    fundo.innerHTML = `<form class="janela">
      <h3>${esc(titulo)}</h3>
      ${texto ? `<div>${texto}</div>` : ''}
      ${campo ? `<input class="campo" maxlength="${max}" placeholder="${esc(campo)}" value="${esc(valor)}" autocomplete="off" ${modo === 'num' ? 'inputmode="numeric"' : ''}>` : ''}
      <div class="botoes">
        ${cancelar ? `<button type="button" class="bt claro cancelar">${esc(cancelar)}</button>` : ''}
        <button class="bt ${perigo ? 'vermelho' : ''}">${esc(ok)}</button>
      </div></form>`;
    const form = fundo.querySelector('form'), input = fundo.querySelector('input');
    const fim = v => { fundo.remove(); res(v); };
    form.onsubmit = e => { e.preventDefault(); fim(input ? input.value.trim() : true); };
    const bc = fundo.querySelector('.cancelar'); if (bc) bc.onclick = () => fim(null);
    fundo.addEventListener('pointerdown', e => { if (e.target === fundo) fim(null); });
    fundo.addEventListener('keydown', e => { if (e.key === 'Escape') fim(null); });
    document.body.appendChild(fundo);
    (input || form.querySelector('button:last-child')).focus();
  });
}
// janela "livre": devolve o fundo pra quem chamou montar o conteúdo
function janela(html, cls = '') {
  const fundo = document.createElement('div');
  fundo.className = 'fundo-janela';
  fundo.innerHTML = `<div class="janela ${cls}">${html}</div>`;
  fundo.addEventListener('pointerdown', e => { if (e.target === fundo) fundo.remove(); });
  fundo.addEventListener('keydown', e => { if (e.key === 'Escape') fundo.remove(); });
  document.body.appendChild(fundo);
  return fundo;
}

async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch (e) {
    const t = document.createElement('textarea'); t.value = texto; document.body.appendChild(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) {}
    t.remove(); return ok;
  }
}

async function mostrarConvite(sala) {
  const link = linkConvite(sala);
  const r = await perguntar({
    titulo: 'Convidar amigos',
    texto: `<p>Manda esse link ou o código pros seus amigos. <b>Só quem tem o código entra</b>, então manda só pra quem você conhece!</p>
            <div class="codigo-grande">${codigoBonito(sala.codigo)}</div>`,
    ok: '📋 Copiar link', cancelar: 'Fechar',
  });
  if (r) avisar(await copiar(link) ? 'Link copiado! Cola na conversa com seu amigo.' : 'Não consegui copiar. Manda o código: ' + codigoBonito(sala.codigo));
}

// ================= configurações do grupo =================
let janelaConfig = null; // {sala, fundo}
function abrirConfig(sala) {
  const fundo = janela('', 'grande config');
  janelaConfig = { sala, fundo, foto: undefined };
  const obs = new MutationObserver(() => { if (!fundo.isConnected) { janelaConfig = null; obs.disconnect(); } });
  obs.observe(document.body, { childList: true });
  desenharConfig();
}
function desenharConfig() {
  const { sala, fundo } = janelaConfig;
  const caixa = fundo.querySelector('.janela');
  const c = sala.cfg;
  const adm = souAdmin(sala);
  const foto = janelaConfig.foto !== undefined ? janelaConfig.foto : c && c.foto;
  const membros = [...sala.membros].map(([u, m]) => ({ u, ...m, admin: ehAdminUid(sala, u), dono: c && c.admins.some(a => a.u === u && a.s === c.dono) }))
    .sort((a, b) => (b.dono - a.dono) || (b.admin - a.admin) || a.n.localeCompare(b.n));
  if (!c) {
    caixa.innerHTML = `<h3>⚙️ ${esc(nomeCanal(sala))}</h3>
      <p>Esse grupo ainda não tem admin (ele foi criado antes das configurações existirem).</p>
      <p>Quem tocar primeiro em <b>Virar admin</b> vira o dono do grupo.</p>
      <div class="botoes"><button class="bt claro fechar">Fechar</button><button class="bt virar">⭐ Virar admin</button></div>`;
    caixa.querySelector('.fechar').onclick = () => fundo.remove();
    caixa.querySelector('.virar').onclick = async () => {
      if (await publicarCfg(sala, {})) { salvarListaSalas(); avisar('⭐ Agora você é o dono do grupo!'); desenharConfig(); }
    };
    return;
  }
  const trava = adm ? '' : 'disabled';
  caixa.innerHTML = `
    <div class="config-topo">
      <button type="button" class="foto-grupo" ${trava} title="${adm ? 'Trocar foto do grupo' : ''}" style="${foto ? `background-image:url('${esc(foto)}')` : ''}">
        ${foto ? '' : `<span>${esc(inicial(nomeCanal(sala)))}</span>`}${adm ? '<i>📷</i>' : ''}</button>
      <div class="config-titulo"><h3>${esc(nomeCanal(sala))}</h3><small>${adm ? (souDono(sala) ? '👑 Você é o dono' : '⭐ Você é admin') : 'Só admins mudam as configurações'}</small></div>
    </div>
    ${c.encerrado ? '<div class="barra-aviso">🛑 Esse grupo foi encerrado.</div>' : ''}
    ${c.movido ? '<div class="barra-aviso">🔄 Esse grupo mudou de código.</div>' : ''}
    <label class="rotulo">Nome<input class="campo" name="nome" maxlength="40" value="${esc(c.nome || sala.nome)}" ${trava}></label>
    <label class="rotulo">Descrição<textarea class="campo" name="desc" maxlength="200" rows="2" placeholder="${adm ? 'Do que é esse grupo?' : 'Sem descrição'}" ${trava}>${esc(c.desc || '')}</textarea></label>
    <label class="chave"><input type="checkbox" name="soAdmins" ${c.soAdmins ? 'checked' : ''} ${trava}><span></span>Só admins mandam mensagens</label>
    <label class="chave"><input type="checkbox" name="soAdminsConvidam" ${c.soAdminsConvidam ? 'checked' : ''} ${trava}><span></span>Só admins podem convidar</label>
    <div class="titulo-secao">Membros (${membros.length})</div>
    <div class="membros">${membros.map(m => `<div class="membro" data-u="${esc(m.u)}">
        ${avatarHTML(m.u, m.n)}
        <div class="info"><div class="nome-sala">${esc(m.u === eu.uid ? 'Você' : nomeDe(m.u, m.n))}</div>
          <div class="previa">${m.dono ? '👑 Dono' : m.admin ? '⭐ Admin' : 'Membro'} · ${m.u === eu.uid ? 'agora' : 'visto ' + haQuanto(m.visto)}</div></div>
        ${adm && m.u !== eu.uid && !m.dono ? `<div class="acoes-membro">
          ${m.admin ? '<button class="bt claro mini tirar-admin">Tirar admin</button>' : (m.sp ? '<button class="bt claro mini por-admin">⭐ Admin</button>' : '')}
          <button class="bt claro mini remover" title="Remover do grupo">🚫</button></div>` : ''}
      </div>`).join('')}</div>
    ${adm ? `<div class="acoes-perigo">
        <button class="bt claro novo-codigo">🔄 Gerar código novo</button>
        ${souDono(sala) && !c.encerrado ? '<button class="bt vermelho encerrar">🛑 Encerrar grupo</button>' : ''}</div>` : ''}
    <div class="botoes"><button class="bt claro fechar">${adm ? 'Cancelar' : 'Fechar'}</button>${adm ? '<button class="bt salvar">Salvar</button>' : ''}</div>`;
  caixa.querySelector('.fechar').onclick = () => fundo.remove();
  if (!adm) return;
  caixa.querySelector('.foto-grupo').onclick = async () => {
    const arq = await escolherImagem();
    if (!arq) return;
    try { janelaConfig.foto = await reduzirImagem(arq, 128, { quadrado: true, qualidade: 0.72 }); }
    catch (e) { avisar('Não consegui abrir essa imagem.'); return; }
    const b = caixa.querySelector('.foto-grupo');
    b.style.backgroundImage = `url('${janelaConfig.foto}')`;
    const letra = b.querySelector('span'); if (letra) letra.remove();
  };
  caixa.querySelector('.salvar').onclick = async () => {
    const nome = caixa.querySelector('[name=nome]').value.trim();
    if (!nome) { avisar('O grupo precisa de um nome.'); return; }
    const ok = await publicarCfg(sala, {
      nome, desc: caixa.querySelector('[name=desc]').value.trim(),
      soAdmins: caixa.querySelector('[name=soAdmins]').checked,
      soAdminsConvidam: caixa.querySelector('[name=soAdminsConvidam]').checked,
      ...(janelaConfig.foto !== undefined ? { foto: janelaConfig.foto } : {}),
    });
    if (ok) { salvarListaSalas(); fundo.remove(); avisar('Configurações salvas! ✅'); }
  };
  caixa.querySelector('.membros').onclick = async e => {
    const linha = e.target.closest('.membro');
    if (!linha) return;
    const u = linha.dataset.u, m = sala.membros.get(u);
    const nome = nomeDe(u, m && m.n);
    if (e.target.closest('.por-admin')) {
      if (await publicarCfg(sala, { admins: [...sala.cfg.admins, { s: m.sp, u, n: nome }] })) avisar(`⭐ ${nome} agora é admin.`);
    } else if (e.target.closest('.tirar-admin')) {
      if (await publicarCfg(sala, { admins: sala.cfg.admins.filter(a => a.u !== u) })) avisar(`${nome} não é mais admin.`);
    } else if (e.target.closest('.remover')) {
      const sim = await perguntar({
        titulo: `Remover ${nome}?`, perigo: true, ok: 'Remover',
        texto: `<p>Pra ${esc(nome)} não conseguir mais ler o grupo, ele vai <b>ganhar um código novo</b>. Quem continua no grupo recebe o código novo sozinho.</p>
                <p class="dica-num">Quem nunca apareceu no grupo desde que você entrou pode ficar de fora — aí é só mandar o convite novo.</p>`,
      });
      if (!sim) return;
      fundo.remove();
      const n = await rodarGrupo(sala, u);
      avisar(`🚫 ${nome} foi removido. Código novo mandado pra ${n} ${n === 1 ? 'pessoa' : 'pessoas'}.`, null, null, 7000);
    }
  };
  caixa.querySelector('.novo-codigo').onclick = async () => {
    const sim = await perguntar({
      titulo: 'Gerar código novo?', ok: 'Gerar',
      texto: '<p>Use quando o código vazou pra quem não devia. O código antigo para de funcionar e quem está no grupo recebe o novo sozinho.</p>',
    });
    if (!sim) return;
    fundo.remove();
    const n = await rodarGrupo(sala, null);
    avisar(`🔄 Código novo criado e mandado pra ${n} ${n === 1 ? 'pessoa' : 'pessoas'}.`, null, null, 7000);
  };
  const btEncerrar = caixa.querySelector('.encerrar');
  if (btEncerrar) btEncerrar.onclick = async () => {
    const sim = await perguntar({ titulo: 'Encerrar o grupo?', perigo: true, ok: 'Encerrar', texto: '<p>Ninguém mais vai conseguir mandar mensagem. Isso não dá pra desfazer.</p>' });
    if (sim && await publicarCfg(sala, { encerrado: true })) { fundo.remove(); avisar('🛑 Grupo encerrado.'); }
  };
}

// ================= contas (trocar, criar compartilhada, dar acesso) =================
function trocarConta(id) {
  guardarGlobal('frogchat-ativa', id);
  location.hash = '';
  location.reload();
}
function infoConta(id) {
  return { id, nome: lerDe(id, 'apelido', '???'), foto: lerDe(id, 'foto', null), uid: lerDe(id, 'uid', id), compartilhada: lerDe(id, 'compartilhada', false), num: (lerDe(id, 'identidade', {}) || {}).num };
}
function avatarConta(info, cls = '') {
  return info.foto ? `<img class="avatar ${cls}" src="${esc(info.foto)}" alt="">` : `<div class="avatar ${cls}" style="background:${corDe(info.uid)}">${esc(inicial(info.nome))}</div>`;
}

function abrirContas() {
  const contas = lerContas().map(c => infoConta(c.id));
  const fundo = janela(`<h3>Contas</h3>
    <div class="lista-contas">${contas.map(c => `<div class="conta-linha ${c.id === CONTA ? 'ativa' : ''}" data-id="${esc(c.id)}">
        ${avatarConta(c)}
        <div class="info"><div class="nome-sala">${esc(c.nome)} ${c.compartilhada ? '<span class="tag-comp">👥 compartilhada</span>' : ''}</div>
          <div class="previa">${c.num ? 'Nº ' + c.num : 'sem número ainda'}${c.id === CONTA ? ' · usando agora' : ''}</div></div>
        ${c.compartilhada ? '<button class="bt claro mini dar-acesso" title="Dar acesso a um amigo">🔑 Dar acesso</button>' : ''}
        ${c.id === CONTA ? '<span class="check">✓</span>' : ''}
      </div>`).join('')}</div>
    <button class="bt claro largo meu-perfil">✏️ Editar perfil de ${esc(eu.apelido)}</button>
    ${eu.compartilhada ? '<button class="bt claro largo ver-acessos">👥 Quem tem acesso a esta conta</button>' : ''}
    <button class="bt largo criar-conta">➕ Criar conta compartilhada</button>
    ${jaInstalado() ? '' : '<button class="bt claro largo instalar">📲 Instalar o FrogTalk como aplicativo</button>'}
    <p class="dica-num">Conta compartilhada é tipo a de um estúdio: várias pessoas entram nela e falam como ela.</p>
    <div class="botoes"><button class="bt claro fechar">Fechar</button></div>`, 'contas');
  fundo.querySelector('.fechar').onclick = () => fundo.remove();
  fundo.querySelector('.meu-perfil').onclick = () => { fundo.remove(); abrirPerfil(); };
  fundo.querySelector('.criar-conta').onclick = () => { fundo.remove(); criarContaCompartilhada(); };
  const bi = fundo.querySelector('.instalar'); if (bi) bi.onclick = () => { fundo.remove(); instalarApp(); };
  const va = fundo.querySelector('.ver-acessos'); if (va) va.onclick = () => { fundo.remove(); verAcessos(); };
  fundo.querySelector('.lista-contas').onclick = e => {
    const linha = e.target.closest('.conta-linha');
    if (!linha) return;
    if (e.target.closest('.dar-acesso')) { fundo.remove(); darAcesso(linha.dataset.id); return; }
    if (linha.dataset.id !== CONTA) trocarConta(linha.dataset.id);
  };
}

async function criarContaCompartilhada() {
  let foto = null;
  const fundo = janela(`<form class="perfil-form"><h3>Nova conta compartilhada</h3>
    <button type="button" class="foto-perfil" title="Escolher foto"><span class="trocar">📷</span></button>
    <label class="rotulo">Nome da conta<input class="campo" name="nome" maxlength="24" placeholder="Ex.: Frogbit Studio" required></label>
    <p class="dica-num">Ela ganha número, amigos e grupos próprios. Depois você dá acesso pra galera do estúdio em <b>🔑 Dar acesso</b>.</p>
    <div class="botoes"><button type="button" class="bt claro fechar">Cancelar</button><button class="bt">Criar</button></div></form>`, 'perfil');
  const bFoto = fundo.querySelector('.foto-perfil');
  bFoto.style.backgroundColor = '#8b5cf6';
  bFoto.onclick = async () => {
    const arq = await escolherImagem();
    if (!arq) return;
    try { foto = await reduzirImagem(arq, 128, { quadrado: true, qualidade: 0.72 }); bFoto.style.backgroundImage = `url("${foto}")`; }
    catch (e) { avisar('Não consegui abrir essa imagem.'); }
  };
  fundo.querySelector('.fechar').onclick = () => fundo.remove();
  fundo.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const nome = e.target.nome.value.trim();
    if (!nome) return;
    const uid = idAleatorio(12), id = 'c-' + uid;
    guardarEm(id, 'uid', uid);
    guardarEm(id, 'apelido', nome.slice(0, 24));
    guardarEm(id, 'foto', foto);
    guardarEm(id, 'compartilhada', true);
    guardarEm(id, 'perfilTs', Date.now());
    guardarEm(id, 'identidade', await novaIdentidade());
    guardarEm(id, 'acessos', [{ nome: eu.apelido, ts: Date.now() }]);
    guardarGlobal('frogchat-contas', [...lerContas(), { id }]);
    fundo.remove();
    avisar(`Conta "${nome}" criada! Entrando nela…`);
    setTimeout(() => trocarConta(id), 900);
  };
}

function pacoteDaConta(id) {
  const dados = {};
  for (const k of CHAVES_CONTA) { const v = lerDe(id, k, undefined); if (v !== undefined) dados[k] = v; }
  dados.compartilhada = true;
  return dados;
}

async function darAcesso(idConta) {
  const info = infoConta(idConta);
  if (!info.num) { avisar(`Abre a conta "${info.nome}" uma vez antes (ela precisa ganhar um número).`); return; }
  const lista = [...amigos.values()].filter(a => a.estado === 'amigo');
  if (!lista.length) { avisar('Você precisa ter amigos aqui pra dar acesso. Adicione pelo número primeiro.'); return; }
  const fundo = janela(`<h3>🔑 Dar acesso a "${esc(info.nome)}"</h3>
    <p>Quem você escolher vai poder <b>entrar nessa conta e falar como ela</b>. Escolhe só gente de confiança!</p>
    <p class="dica-num">Atenção: depois de dar, não dá pra tirar o acesso. Se precisar, crie outra conta.</p>
    <div class="membros">${lista.map(a => `<div class="membro clicavel" data-pub="${esc(a.pub)}">${avatarHTML(a.uid, a.nome)}
      <div class="info"><div class="nome-sala">${esc(nomeDe(a.uid, a.nome))}</div><div class="previa">Nº ${esc(a.num)}</div></div>
      <button class="bt mini">Dar acesso</button></div>`).join('')}</div>
    <div class="botoes"><button class="bt claro fechar">Fechar</button></div>`);
  fundo.querySelector('.fechar').onclick = () => fundo.remove();
  fundo.querySelector('.membros').onclick = async e => {
    const linha = e.target.closest('.membro');
    if (!linha) return;
    const a = amigos.get(linha.dataset.pub);
    const nome = nomeDe(a.uid, a.nome);
    const sim = await perguntar({ titulo: `Dar acesso pra ${nome}?`, texto: `<p>${esc(nome)} vai poder usar a conta <b>${esc(info.nome)}</b>.</p>`, ok: 'Dar acesso' });
    if (!sim) return;
    fundo.remove();
    // anota quem ganhou acesso (na conta compartilhada)
    const acessos = lerDe(idConta, 'acessos', []);
    acessos.push({ nome, ts: Date.now() });
    guardarEm(idConta, 'acessos', acessos);
    if (idConta === CONTA) mudouConta();
    const sala = await abrirDM(a);
    mandarConteudo({ conta: { nome: info.nome, foto: info.foto, dados: pacoteDaConta(idConta) } }, sala);
    selecionarSala(sala);
    avisar(`🔑 Acesso mandado pra ${nome}!`);
  };
}

function verAcessos() {
  const acessos = ler('acessos', []).slice().sort((a, b) => a.ts - b.ts);
  const fundo = janela(`<h3>👥 Quem tem acesso a "${esc(eu.apelido)}"</h3>
    <div class="membros">${acessos.length ? acessos.map(x => `<div class="membro"><div class="avatar" style="background:${corDe(x.nome)}">${esc(inicial(x.nome))}</div>
      <div class="info"><div class="nome-sala">${esc(x.nome)}</div><div class="previa">desde ${new Date(x.ts).toLocaleDateString('pt-BR')}</div></div></div>`).join('') : '<p>Ninguém anotado ainda.</p>'}</div>
    <p class="dica-num">Pra tirar o acesso de alguém não tem jeito: quem tem a chave, tem. Se precisar, crie outra conta.</p>
    <div class="botoes"><button class="bt claro fechar">Fechar</button></div>`);
  fundo.querySelector('.fechar').onclick = () => fundo.remove();
}

async function usarContaRecebida(conta) {
  const d = conta && conta.dados;
  if (!d || typeof d.uid !== 'string' || !d.identidade || !d.identidade.priv || !d.identidade.pub) { avisar('Esse acesso está com defeito. 😕'); return; }
  if (d.uid === eu.uid) { avisar('Você já está nessa conta! 😄'); return; }
  const id = 'c-' + d.uid.replace(/[^0-9a-z]/g, '').slice(0, 20);
  const ja = lerContas().some(c => c.id === id);
  if (!ja) {
    for (const k of CHAVES_CONTA) if (d[k] !== undefined) guardarEm(id, k, d[k]);
    guardarEm(id, 'compartilhada', true);
    guardarGlobal('frogchat-contas', [...lerContas(), { id }]);
  }
  const sim = await perguntar({ titulo: ja ? `Entrar em "${conta.nome}"?` : `Conta "${conta.nome}" adicionada!`, texto: '<p>Quer entrar nela agora? Você pode voltar pra sua conta pelo botão lá embaixo, à esquerda.</p>', ok: 'Entrar agora', cancelar: 'Depois' });
  if (sim) trocarConta(id);
  else avisar('Ela fica na lista de contas (botão lá embaixo, à esquerda).');
}

// perfil: foto, apelido, recado e o número
function abrirPerfil() {
  let foto = eu.foto;
  const fundo = janela(`<form class="perfil-form">
    <h3>${eu.compartilhada ? 'Perfil da conta' : 'Meu perfil'}</h3>
    <button type="button" class="foto-perfil" title="Trocar foto"><span class="trocar">📷</span></button>
    <label class="rotulo">${eu.compartilhada ? 'Nome da conta' : 'Apelido'}<input class="campo" name="apelido" maxlength="24" value="${esc(eu.apelido)}" required></label>
    <label class="rotulo">Recado <small>(aparece pros amigos)</small><input class="campo" name="recado" maxlength="80" value="${esc(eu.recado)}" placeholder="Ex.: Jogando BATTLE WISH 🎮"></label>
    <div class="meu-numero"><div><small>${eu.compartilhada ? 'Número da conta' : 'Seu número'}</small><b>${eu.num || 'gerando…'}</b></div>
      <button type="button" class="bt claro copiar-num">📋 Copiar</button></div>
    <p class="dica-num">Passa esse número só pra quem você conhece. A pessoa coloca em <b>+ Amigo</b> e você aceita o pedido.</p>
    <div class="botoes">${foto ? '<button type="button" class="bt claro tirar-foto">Tirar foto</button>' : ''}
      <button type="button" class="bt claro cancelar">Cancelar</button><button class="bt">Salvar</button></div></form>`, 'perfil');
  const bFoto = fundo.querySelector('.foto-perfil');
  const pintar = () => {
    bFoto.style.backgroundImage = foto ? `url("${foto}")` : 'none';
    bFoto.style.backgroundColor = foto ? '' : corDe(eu.uid);
    bFoto.dataset.letra = foto ? '' : inicial(eu.apelido);
  };
  pintar();
  bFoto.onclick = async () => {
    const arq = await escolherImagem();
    if (!arq) return;
    try { foto = await reduzirImagem(arq, 128, { quadrado: true, qualidade: 0.72 }); pintar(); }
    catch (e) { avisar('Não consegui abrir essa imagem.'); }
  };
  const tirar = fundo.querySelector('.tirar-foto');
  if (tirar) tirar.onclick = () => { foto = null; pintar(); tirar.remove(); };
  fundo.querySelector('.copiar-num').onclick = async () => { if (eu.num && await copiar(eu.num)) avisar('Número copiado!'); };
  fundo.querySelector('.cancelar').onclick = () => fundo.remove();
  fundo.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    const apelido = f.apelido.value.trim();
    if (!apelido) return;
    eu.apelido = apelido.slice(0, 24); eu.recado = f.recado.value.trim().slice(0, 80); eu.foto = foto;
    guardar('apelido', eu.apelido); guardar('recado', eu.recado); guardar('foto', eu.foto); guardar('perfilTs', Date.now());
    for (const s of salas.values()) prepararTchau(s);
    agendarPessoal(); mudouConta();
    fundo.remove();
    renderTudo();
    avisar('Perfil salvo! ✅');
  };
}

// ================= tela: desenhar =================
function renderStatus() {
  const on = conectado();
  $('#status').classList.toggle('on', on);
  $('#statusTexto').textContent = on ? 'conectado' : 'conectando…';
}

function renderEu() {
  $('#meuNome').textContent = eu.apelido;
  $('#meuNum').textContent = (eu.compartilhada ? '👥 ' : '') + (eu.num ? 'Nº ' + eu.num : 'Nº gerando…');
  $('#meuAvatar').innerHTML = avatarHTML(eu.uid, eu.apelido);
  const outras = lerContas().length - 1;
  $('#qtdContas').textContent = outras > 0 ? outras + 1 : '';
  $('#qtdContas').classList.toggle('escondido', outras <= 0);
}

function renderPedidos() {
  const lista = [...pedidos.values()];
  $('#pedidos').innerHTML = lista.map(p => `<div class="pedido" data-pub="${esc(p.pub)}">
      ${avatarHTML(p.uid, p.nome)}
      <div class="info"><div class="nome-sala">${esc(p.nome)}</div><div class="previa">Nº ${esc(p.num)} quer ser seu amigo</div></div>
      <button class="bt verde aceitar" title="Aceitar">✓</button><button class="bt claro recusar" title="Recusar">✕</button></div>`).join('');
  renderSalas();
}
$('#pedidos').addEventListener('click', e => {
  const card = e.target.closest('.pedido');
  if (!card) return;
  const p = pedidos.get(card.dataset.pub);
  if (!p) return;
  if (e.target.closest('.aceitar')) aceitarPedido(p);
  else if (e.target.closest('.recusar')) recusarPedido(p);
});

function previaMsg(m) {
  if (!m) return null;
  const quem = m.sys ? '' : (m.u === eu.uid ? 'Você' : nomeDe(m.u, m.n)) + ': ';
  if (m.chamar) return (m.u === eu.uid ? 'Você chamou 🔔' : nomeDe(m.u, m.n) + ' te chamou 🔔');
  if (m.voz) return quem + '🎤 Áudio (' + fmtDur(m.voz.dur) + ')';
  if (m.enquete) return quem + '📊 ' + m.enquete.perg;
  if (m.jogo) return quem + ({ velha: '⭕ Jogo da velha', ppt: '✊ Pedra, papel e tesoura', dado: '🎲 Dado: ' + m.jogo.valor })[m.jogo.tipo];
  if (m.fig || m.img) return quem + '🐸 Figurinha';
  if (m.foto) return quem + '📷 ' + (m.txt || 'Foto');
  if (m.arq) return quem + iconeArq(m.arq) + ' ' + (m.txt || (tipoArq(m.arq) === 'video' ? 'Vídeo' : m.arq.nome));
  if (m.conta) return quem + '🔑 Acesso à conta ' + m.conta.nome;
  return quem + m.txt.replace(/\s+/g, ' ');
}

function renderSalas() {
  const ul = $('#listaSalas');
  const lista = [...salas.values()].sort((a, b) => ultimaTs(b) - ultimaTs(a));
  if (!lista.length && !pedidos.size) {
    ul.innerHTML = '<li class="vazio-lista">Adicione um amigo pelo número dele ou crie um grupo! 🐸</li>';
    renderTitulo(); return;
  }
  ul.replaceChildren(...lista.map(sala => {
    const li = document.createElement('li');
    li.className = 'sala' + (sala === atual ? ' ativa' : '');
    const a = sala.tipo === 'dm' ? amigos.get(sala.pub) : null;
    const esperando = a && a.estado !== 'amigo';
    const ult = ultimaMsg(sala);
    const apagada = ult && sala.msgs.some(x => x.apaga && x.apaga.alvo === ult.id);
    const previa = esperando ? '⏳ Esperando aceitar o pedido…'
      : apagada ? '🚫 Mensagem apagada'
      : sala.cfg && sala.cfg.encerrado ? '🛑 Grupo encerrado'
      : previaMsg(ult) || (sala.tipo === 'dm' ? ((perfis.get(a && a.uid) || {}).recado || 'Diga oi! 👋') : (sala.cfg && sala.cfg.desc) || 'Código ' + codigoBonito(sala.codigo));
    const temCall = sala.naCall.size > 0 || call.sala === sala;
    const online = [...sala.online.values()].some(o => o.uid !== eu.uid);
    li.innerHTML = `<div class="av-wrap">${avatarCanal(sala)}${sala.tipo === 'dm' && online ? '<span class="bolinha-on"></span>' : ''}</div>
      <div class="info"><div class="nome-sala">${sala.tipo === 'grupo' ? '<span class="tag-grupo">👥</span> ' : ''}${esc(nomeCanal(sala))}${souAdmin(sala) ? ' <span class="tag-adm" title="Você é admin">⭐</span>' : ''}</div><div class="previa">${esc(previa)}</div></div>
      <div class="lado">${ult ? `<small>${hora(ult.ts)}</small>` : ''}
        <div>${temCall ? '<span class="icone-call" title="Call rolando">🔊</span>' : ''}${sala.naoLidas ? `<span class="badge">${sala.naoLidas > 99 ? '99+' : sala.naoLidas}</span>` : ''}</div></div>`;
    li.onclick = () => selecionarSala(sala);
    return li;
  }));
  renderTitulo();
}
function ultimaMsg(sala) { for (let i = sala.msgs.length - 1; i >= 0; i--) if (!ehEvento(sala.msgs[i])) return sala.msgs[i]; return null; }
function ultimaTs(sala) { const m = ultimaMsg(sala); return m ? m.ts : 0; }

function renderTopo() {
  if (!atual) return;
  $('#nomeSala').textContent = nomeCanal(atual);
  $('#avSala').innerHTML = avatarCanal(atual);
  const grupo = atual.tipo === 'grupo';
  const podeConvidar = grupo && !(atual.cfg && (atual.cfg.encerrado || atual.cfg.movido || (atual.cfg.soAdminsConvidam && !souAdmin(atual))));
  $('#btConvidar').classList.toggle('escondido', !podeConvidar);
  $('#btConfig').classList.toggle('escondido', !grupo);
  $('#btConfig').title = grupo && souAdmin(atual) ? 'Configurações do grupo' : 'Info do grupo';
  $('#btSairSala').title = grupo ? 'Sair do grupo' : 'Desfazer amizade';
}

function renderCaixa() {
  if (!atual) return;
  const permitido = podeFalar(atual), castigo = emCastigo();
  const pode = permitido && !castigo;
  $('#formMsg').classList.toggle('escondido', !pode || !!grav); // gravando áudio: a barra da gravação fica no lugar
  if (!pode) cancelarResposta();
  const c = atual.cfg;
  $('#semPermissao').classList.toggle('escondido', pode);
  $('#semPermissao').classList.toggle('castigo', permitido && castigo);
  if (!permitido) $('#semPermissao').textContent = c.encerrado ? '🛑 Esse grupo foi encerrado.' : c.movido ? '🔄 Esse grupo mudou de código. Se você ainda faz parte, recebe o novo sozinho.' : '🔒 Só admins podem mandar mensagens neste grupo.';
  else if (castigo) $('#semPermissao').textContent = textoCastigo();
  if (!pode) fecharPainelFig();
}

function renderOnline() {
  if (!atual) return;
  const nomes = [...new Map([...atual.online.values()].filter(o => o.uid !== eu.uid).map(o => [o.uid, nomeDe(o.uid, o.n)])).values()];
  let txt;
  if (atual.tipo === 'dm') {
    const a = amigos.get(atual.pub);
    if (a && a.estado !== 'amigo') txt = `⏳ pedido enviado pro nº ${a.num}`;
    else txt = nomes.length ? '🟢 online' : ((perfis.get(a && a.uid) || {}).recado || 'Nº ' + (a ? a.num : ''));
  } else txt = nomes.length ? '🟢 online: ' + nomes.join(', ') : ((atual.cfg && atual.cfg.desc) || 'só você por aqui agora');
  $('#onlineSala').textContent = txt;
}

function renderDigitando() {
  if (!atual) return;
  const agora = Date.now();
  const nomes = [...atual.digitando.values()].filter(d => d.ate > agora).map(d => d.n);
  $('#digitando').textContent = !nomes.length ? '' : nomes.length === 1 ? `${nomes[0]} está digitando…` : `${nomes.join(', ')} estão digitando…`;
}
setInterval(renderDigitando, 1000);

const pertoDoFim = () => { const b = $('#mensagens'); return b.scrollHeight - b.scrollTop - b.clientHeight < 150; };
let novasAbaixo = 0;
function renderDescer() {
  const longe = !pertoDoFim();
  if (!longe) novasAbaixo = 0;
  $('#btDescer').classList.toggle('escondido', !longe);
  $('#novasDescer').textContent = novasAbaixo ? novasAbaixo : '';
  $('#novasDescer').classList.toggle('escondido', !novasAbaixo);
}
$('#mensagens').addEventListener('scroll', renderDescer);
$('#btDescer').onclick = () => { const b = $('#mensagens'); b.scrollTo({ top: b.scrollHeight, behavior: 'smooth' }); };

// texto curtinho que representa a mensagem (pra citação da resposta)
function resumo(m) {
  if (m.txt && !m.foto && !m.arq) return m.txt.replace(/\s+/g, ' ').slice(0, 110);
  if (m.voz) return '🎤 Áudio (' + fmtDur(m.voz.dur) + ')';
  if (m.fig || m.img) return '🐸 Figurinha';
  if (m.foto) return '📷 ' + (m.txt || 'Foto');
  if (m.arq) return iconeArq(m.arq) + ' ' + (m.txt || m.arq.nome);
  return 'Mensagem';
}
function fmtDur(s) { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

function htmlCitacao(m) {
  if (!m.resp) return '';
  const nome = m.resp.u === eu.uid ? 'Você' : nomeDe(m.resp.u, m.resp.n);
  return `<div class="citacao" data-ir="${esc(m.resp.id)}" style="--cor:${corDe(m.resp.u)}"><b>${esc(nome)}</b><span>${esc(m.resp.p)}</span></div>`;
}

function htmlReacoes(id, mapa) {
  if (!mapa) return '';
  const cont = new Map(); // emoji -> [nomes]
  let minha = '';
  for (const [uid, r] of mapa) {
    if (!r.e) continue;
    if (!cont.has(r.e)) cont.set(r.e, []);
    cont.get(r.e).push(uid === eu.uid ? 'Você' : nomeDe(uid, r.n));
    if (uid === eu.uid) minha = r.e;
  }
  if (!cont.size) return '';
  return `<div class="reacoes">${[...cont].map(([e, nomes]) =>
    `<button class="chip-reacao${e === minha ? ' minha' : ''}" data-alvo="${esc(id)}" data-e="${e}" title="${esc(nomes.join(', '))}">${e}${nomes.length > 1 ? ` <small>${nomes.length}</small>` : ''}</button>`).join('')}</div>`;
}

function htmlVoz(m) {
  const ondas = (m.voz.ondas || '').padEnd(40, '2').slice(0, 40);
  const tocando = tocador.id === m.id;
  const prog = tocando && m.voz.dur ? tocador.audio.currentTime / m.voz.dur : 0;
  return `<div class="voz${tocando && !tocador.audio.paused ? ' tocando' : ''}" data-voz-id="${esc(m.id)}">
    <button class="voz-play" data-tocar="${esc(m.id)}" aria-label="Tocar">${tocando && !tocador.audio.paused ? '⏸' : '▶'}</button>
    <div class="voz-ondas" data-pular="${esc(m.id)}">${[...ondas].map((n, i) => `<i style="height:${4 + Number(n) * 2.4}px" class="${i / 40 < prog ? 'tocado' : ''}"></i>`).join('')}</div>
    <button class="voz-tempo" data-vel="1" title="Velocidade">${tocando ? fmtDur(tocador.audio.currentTime) : fmtDur(m.voz.dur)}${tocador.vel !== 1 ? ` · ${tocador.vel}x` : ''}</button>
  </div>`;
}

// ---------- tocar áudio (um tocador só pro app inteiro) ----------
const tocador = { audio: new Audio(), id: null, vel: 1 };
tocador.audio.preload = 'auto';
function atualizarVoz() {
  const el = document.querySelector(`[data-voz-id="${tocador.id}"]`);
  if (!el || !atual) return;
  const m = atual.msgs.find(x => x.id === tocador.id);
  const dur = (m && m.voz.dur) || tocador.audio.duration || 1;
  const prog = Math.min(1, tocador.audio.currentTime / dur);
  el.classList.toggle('tocando', !tocador.audio.paused);
  el.querySelector('.voz-play').textContent = tocador.audio.paused ? '▶' : '⏸';
  el.querySelectorAll('.voz-ondas i').forEach((b, i, l) => b.classList.toggle('tocado', i / l.length < prog));
  el.querySelector('.voz-tempo').textContent = fmtDur(tocador.audio.currentTime) + (tocador.vel !== 1 ? ` · ${tocador.vel}x` : '');
}
['timeupdate', 'play', 'pause'].forEach(ev => tocador.audio.addEventListener(ev, atualizarVoz));
tocador.audio.addEventListener('ended', () => {
  const id = tocador.id;
  tocador.audio.currentTime = 0; atualizarVoz();
  // emenda o próximo áudio da conversa (igual no zap)
  if (!atual) return;
  const lista = atual.msgs.filter(x => x.voz);
  const i = lista.findIndex(x => x.id === id);
  if (i >= 0 && lista[i + 1] && lista[i + 1].u !== eu.uid) tocarVoz(lista[i + 1]);
});
function tocarVoz(m) {
  if (tocador.id === m.id) { tocador.audio.paused ? tocador.audio.play().catch(() => {}) : tocador.audio.pause(); return; }
  const antes = tocador.id;
  tocador.id = m.id;
  tocador.audio.src = m.voz.src;
  tocador.audio.playbackRate = tocador.vel;
  tocador.audio.play().catch(() => avisar('Não consegui tocar esse áudio neste aparelho. 😕'));
  if (antes) { const el = document.querySelector(`[data-voz-id="${antes}"]`); if (el) { el.classList.remove('tocando'); el.querySelector('.voz-play').textContent = '▶'; el.querySelectorAll('.voz-ondas i').forEach(b => b.classList.remove('tocado')); } }
}

// ---------- gravar áudio ----------
let grav = null; // {rec, pedacos, inicio, stream, an, buf, ondas:[], timer}
function tipoGravacao() {
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}
async function comecarGravacao() {
  if (grav || !atual) return;
  if (!podeFalar(atual)) { avisar('Você não pode mandar mensagem neste grupo. 🔒'); return; }
  if (emCastigo()) { avisar(textoCastigo()); return; }
  if (!window.MediaRecorder) { avisar('Esse navegador não sabe gravar áudio. 😕'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (e) { avisar('Não deu pra usar o microfone. Libera o microfone pro site e tenta de novo.'); return; }
  const tipo = tipoGravacao();
  const rec = new MediaRecorder(stream, { ...(tipo ? { mimeType: tipo } : {}), audioBitsPerSecond: 16000 });
  const g = { rec, pedacos: [], inicio: Date.now(), stream, ondas: [], sala: atual };
  rec.ondataavailable = e => { if (e.data && e.data.size) g.pedacos.push(e.data); };
  try {
    const ctx = audioCtx();
    g.an = ctx.createAnalyser(); g.an.fftSize = 256; g.buf = new Uint8Array(g.an.fftSize);
    ctx.createMediaStreamSource(stream).connect(g.an);
  } catch (e) {}
  rec.start(250);
  grav = g;
  $('#barraGravacao').classList.remove('escondido');
  $('#formMsg').classList.add('escondido');
  $('#ondasGravacao').innerHTML = '';
  g.timer = setInterval(() => {
    const seg = (Date.now() - g.inicio) / 1000;
    $('#tempoGravacao').textContent = fmtDur(seg);
    let nivel = 2;
    if (g.an) {
      g.an.getByteTimeDomainData(g.buf);
      let s = 0; for (const v of g.buf) { const x = (v - 128) / 128; s += x * x; }
      nivel = Math.min(9, Math.round(Math.sqrt(s / g.buf.length) * 40));
    }
    g.ondas.push(nivel);
    const i = document.createElement('i'); i.style.height = (4 + nivel * 2.4) + 'px';
    $('#ondasGravacao').appendChild(i);
    if ($('#ondasGravacao').children.length > 60) $('#ondasGravacao').firstChild.remove();
    if (seg >= VOZ_SEG) pararGravacao(true);
  }, 150);
}
function pararGravacao(enviarAudio) {
  const g = grav;
  if (!g) return;
  grav = null;
  clearInterval(g.timer);
  $('#barraGravacao').classList.add('escondido');
  renderCaixa();
  const dur = (Date.now() - g.inicio) / 1000;
  g.rec.onstop = async () => {
    g.stream.getTracks().forEach(t => t.stop());
    if (!enviarAudio) return;
    if (dur < 0.8) { avisar('Áudio muito curtinho. Toca no 🎤, fala e depois toca no ➤.'); return; }
    const blob = new Blob(g.pedacos, { type: g.rec.mimeType || 'audio/webm' });
    // 40 barrinhas pras ondas do áudio
    const o = g.ondas, ondas = Array.from({ length: 40 }, (_, i) => o.length ? Math.max(...o.slice(Math.floor(i * o.length / 40), Math.floor((i + 1) * o.length / 40) + 1)) : 2).join('');
    const src = await lerComoDataURL(blob);
    if (src.length <= MAX_VOZ) mandarConteudo({ voz: { src, dur: Math.round(dur * 10) / 10, ondas } }, g.sala);
    else { // muito grande pra ir na mensagem: vai como arquivo (direto entre aparelhos)
      const arq = { id: idAleatorio(16), nome: 'audio.' + (blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'), tam: blob.size, tipo: blob.type, thumb: null };
      await DB.set('arq:' + arq.id, blob); arqUrls.set(arq.id, URL.createObjectURL(blob)); arqChecado.add(arq.id);
      mandarConteudo({ arq }, g.sala);
    }
  };
  try { g.rec.stop(); } catch (e) { g.stream.getTracks().forEach(t => t.stop()); }
}
$('#btMic').onclick = () => { audioCtx(); comecarGravacao(); };
$('#btEnviaVoz').onclick = () => pararGravacao(true);
$('#btCancelaVoz').onclick = () => pararGravacao(false);

// ---------- responder ----------
let respondendo = null; // {sala, id, u, n, p}
function responder(m) {
  if (editando) cancelarEdicao();
  respondendo = { sala: atual, id: m.id, u: m.u, n: m.n, p: resumo(m) };
  $('#respNome').textContent = m.u === eu.uid ? 'Você' : nomeDe(m.u, m.n);
  $('#respNome').style.color = corDe(m.u);
  $('#respTexto').textContent = respondendo.p;
  $('#barraResposta').classList.remove('escondido');
  $('#campoMsg').focus();
}
function cancelarResposta() { respondendo = null; $('#barraResposta').classList.add('escondido'); }
$('#btCancelaResp').onclick = () => { if (editando) cancelarEdicao(); else cancelarResposta(); };
function irPraMensagem(id) {
  const el = document.querySelector(`.linha[data-id="${CSS.escape(id)}"]`);
  if (!el) { avisar('Essa mensagem é antiga demais e não está mais aqui.'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('piscar'); void el.offsetWidth; el.classList.add('piscar');
}

// ---------- reagir ----------
function minhaReacao(alvo) {
  let r = null;
  for (const m of atual.msgs) if (m.reage && m.u === eu.uid && m.reage.alvo === alvo && (!r || r.ts <= m.ts)) r = m;
  return r ? r.reage.e : '';
}
function reagir(alvo, e) {
  if (!atual) return;
  const agora = Date.now();
  if (agora - (reagir.ultima || 0) < 350) return; // não deixa metralhar reação
  reagir.ultima = agora;
  mandarConteudo({ reage: { alvo, e: minhaReacao(alvo) === e ? '' : e } });
}

// ---------- menu da mensagem (reagir, responder, copiar) ----------
function abrirMenuMsg(id, ancora) {
  const m = atual && atual.msgs.find(x => x.id === id);
  if (!m || m.sys || m.chamar || m.conta) return;
  const ctx = contextoEventos(atual);
  if (ctx.apagadas.has(id)) return;
  const menu = $('#menuMsg');
  const minha = minhaReacao(id);
  const podeResponder = podeFalar(atual) && !emCastigo();
  const dono = m.u === eu.uid;
  const podeEditar = dono && !m.voz && !m.fig && !m.img && !m.enquete && !m.jogo;
  const podeApagar = dono || (atual.tipo === 'grupo' && souAdmin(atual));
  const txtAtual = ctx.edits.has(id) ? ctx.edits.get(id).txt : m.txt;
  menu.innerHTML = `<div class="menu-emojis">${REACOES.map(e => `<button data-e="${e}" class="${e === minha ? 'minha' : ''}">${e}</button>`).join('')}</div>
    <div class="menu-acoes">${podeResponder ? '<button data-acao="responder">↩ Responder</button>' : ''}
      ${txtAtual ? '<button data-acao="copiar">📋 Copiar</button>' : ''}</div>
    ${podeEditar || podeApagar ? `<div class="menu-acoes">${podeEditar ? '<button data-acao="editar">✏️ Editar</button>' : ''}
      ${podeApagar ? '<button data-acao="apagar" class="perigo">🗑️ Apagar</button>' : ''}</div>` : ''}`;
  menu.classList.remove('escondido');
  const r = ancora.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight;
  let x = Math.min(Math.max(8, r.left + r.width / 2 - mw / 2), innerWidth - mw - 8);
  let y = r.top - mh - 8;
  if (y < 8) y = Math.min(innerHeight - mh - 8, r.bottom + 8);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.onclick = async ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    fecharMenuMsg();
    if (b.dataset.e) reagir(id, b.dataset.e);
    else if (b.dataset.acao === 'responder') responder(m);
    else if (b.dataset.acao === 'copiar') { if (await copiar(txtAtual)) avisar('Copiado! 📋'); }
    else if (b.dataset.acao === 'editar') editar(m);
    else if (b.dataset.acao === 'apagar') apagarMsg(m);
  };
}
function fecharMenuMsg() { $('#menuMsg').classList.add('escondido'); }
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menuMsg') && !e.target.closest('[data-menu]')) fecharMenuMsg(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') fecharMenuMsg(); });
$('#mensagens').addEventListener('scroll', fecharMenuMsg);
// celular: segurar a mensagem abre o menu; PC: botão direito
(() => {
  let timer = 0, inicio = null;
  const box = $('#mensagens');
  box.addEventListener('pointerdown', e => {
    const b = e.target.closest('.balao, .figura');
    if (!b || e.pointerType === 'mouse') return;
    inicio = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      const linha = b.closest('.linha');
      if (linha) { if (navigator.vibrate) navigator.vibrate(20); abrirMenuMsg(linha.dataset.id, b); }
    }, 450);
  });
  const cancela = e => { if (timer && (!inicio || e.type !== 'pointermove' || Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) > 10)) { clearTimeout(timer); timer = 0; } };
  ['pointerup', 'pointercancel', 'pointermove'].forEach(ev => box.addEventListener(ev, cancela));
  box.addEventListener('contextmenu', e => {
    const b = e.target.closest('.balao, .figura');
    const linha = b && b.closest('.linha');
    if (!linha || e.target.closest('a, video, audio')) return;
    e.preventDefault();
    abrirMenuMsg(linha.dataset.id, b);
  });
})();

// ================= eventos: reação, edição, apagar, voto e jogada =================
function contextoEventos(sala) {
  const porId = new Map();
  for (const m of sala.msgs) if (!ehEvento(m)) porId.set(m.id, m);
  const reacoes = new Map(), edits = new Map(), apagadas = new Map(), votos = new Map(), jogadas = new Map();
  const ultimo = (mapa, chave, uid, valor, ts) => {   // vale o último de cada pessoa
    if (!mapa.has(chave)) mapa.set(chave, new Map());
    const r = mapa.get(chave), ant = r.get(uid);
    if (!ant || ant.ts <= ts) r.set(uid, { ...valor, ts });
  };
  for (const e of sala.msgs) {
    if (e.reage) ultimo(reacoes, e.reage.alvo, e.u, { e: e.reage.e, n: e.n }, e.ts);
    else if (e.edita) {  // só o autor edita a própria mensagem
      const o = porId.get(e.edita.alvo);
      if (o && o.u === e.u && (o.txt !== undefined || o.foto || o.arq)) {
        const ant = edits.get(o.id);
        if (!ant || ant.ts <= e.ts) edits.set(o.id, { txt: e.edita.txt, ts: e.ts });
      }
    } else if (e.apaga) {  // o autor apaga a dele; admin do grupo apaga a de qualquer um
      const o = porId.get(e.apaga.alvo);
      if (o && (o.u === e.u || (sala.tipo === 'grupo' && ehAdminUid(sala, e.u)))) apagadas.set(o.id, o.u === e.u ? 'autor' : 'admin');
    } else if (e.voto) {
      const o = porId.get(e.voto.alvo);
      if (o && o.enquete) ultimo(votos, o.id, e.u, { ops: o.enquete.multi ? e.voto.ops : e.voto.ops.slice(0, 1), n: e.n }, e.ts);
    } else if (e.jogada && porId.has(e.jogada.alvo)) {
      if (!jogadas.has(e.jogada.alvo)) jogadas.set(e.jogada.alvo, []);
      jogadas.get(e.jogada.alvo).push(e);
    }
  }
  for (const l of jogadas.values()) l.sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1)); // mesma ordem em todo aparelho
  return { reacoes, edits, apagadas, votos, jogadas };
}

// ---------- ✏️ editar / 🗑️ apagar ----------
let editando = null; // {sala, id}
function editar(m) {
  cancelarResposta();
  editando = { sala: atual, id: m.id };
  const ev = contextoEventos(atual);
  const txt = ev.edits.has(m.id) ? ev.edits.get(m.id).txt : (m.txt || '');
  $('#respNome').textContent = '✏️ Editando mensagem';
  $('#respNome').style.color = '';
  $('#respTexto').textContent = txt.replace(/\s+/g, ' ').slice(0, 110);
  $('#barraResposta').classList.remove('escondido');
  const campo = $('#campoMsg');
  campo.value = txt; ajustarAltura(); trocarBotaoEnviar(); campo.focus();
}
function cancelarEdicao() {
  if (!editando) return;
  editando = null;
  $('#barraResposta').classList.add('escondido');
  $('#campoMsg').value = ''; ajustarAltura(); trocarBotaoEnviar();
}
async function apagarMsg(m) {
  const minha = m.u === eu.uid;
  const ok = await perguntar({
    titulo: 'Apagar mensagem?', perigo: true, ok: 'Apagar',
    texto: `<p>${minha ? 'Ela some pra todo mundo e fica escrito "mensagem apagada".' : 'Você é admin: ela some pra todo mundo e fica escrito "apagada por um admin".'}</p>`,
  });
  if (ok) mandarConteudo({ apaga: { alvo: m.id } });
}

// ---------- 📊 enquete ----------
function htmlEnquete(m, votosMapa) {
  const ops = m.enquete.ops, tot = ops.map(() => 0), nomes = ops.map(() => []);
  const meus = new Set();
  let pessoas = 0;
  for (const [uid, v] of votosMapa || []) {
    if (!v.ops.length) continue;
    pessoas++;
    for (const i of v.ops) if (i < ops.length) {
      tot[i]++; nomes[i].push(uid === eu.uid ? 'Você' : nomeDe(uid, v.n));
      if (uid === eu.uid) meus.add(i);
    }
  }
  return `<div class="enquete"><div class="enq-perg">📊 ${esc(m.enquete.perg)}</div>
    <div class="enq-tipo">${m.enquete.multi ? 'Pode escolher mais de uma' : 'Escolha uma'}</div>
    ${ops.map((o, i) => {
      const pct = pessoas ? Math.round(tot[i] / pessoas * 100) : 0;
      return `<button class="enq-op${meus.has(i) ? ' minha' : ''}" data-votar="${esc(m.id)}" data-i="${i}" title="${esc(nomes[i].join(', ') || 'ninguém ainda')}">
        <span class="enq-barra" style="width:${pct}%"></span><span class="enq-marca">${meus.has(i) ? '✓' : ''}</span>
        <span class="enq-txt">${esc(o)}</span><b>${tot[i]}</b></button>`;
    }).join('')}
    <div class="enq-total">${pessoas} ${pessoas === 1 ? 'pessoa votou' : 'pessoas votaram'}</div></div>`;
}
function votar(id, i) {
  const m = atual && atual.msgs.find(x => x.id === id);
  if (!m || !m.enquete) return;
  const meu = (contextoEventos(atual).votos.get(id) || new Map()).get(eu.uid);
  const atuais = new Set(meu ? meu.ops : []);
  let ops;
  if (m.enquete.multi) { atuais.has(i) ? atuais.delete(i) : atuais.add(i); ops = [...atuais]; }
  else ops = atuais.has(i) ? [] : [i];
  mandarConteudo({ voto: { alvo: id, ops } });
}
function criarEnquete() {
  const fundo = janela(`<form class="form-enquete"><h3>📊 Nova enquete</h3>
    <input class="campo" name="perg" maxlength="200" placeholder="Pergunta (ex.: Qual lutador eu faço agora?)" required>
    <div class="enq-opcoes">
      <input class="campo" maxlength="60" placeholder="Opção 1" required><input class="campo" maxlength="60" placeholder="Opção 2" required>
    </div>
    <button type="button" class="bt claro mais-op">+ Opção</button>
    <label class="chave"><input type="checkbox" name="multi"><span></span>Pode votar em mais de uma</label>
    <div class="botoes"><button type="button" class="bt claro fechar">Cancelar</button><button class="bt">Enviar ➤</button></div></form>`);
  const lista = fundo.querySelector('.enq-opcoes');
  fundo.querySelector('.mais-op').onclick = () => {
    const n = lista.children.length;
    if (n >= 6) { avisar('No máximo 6 opções.'); return; }
    const i = document.createElement('input');
    i.className = 'campo'; i.maxLength = 60; i.placeholder = 'Opção ' + (n + 1);
    lista.appendChild(i); i.focus();
  };
  fundo.querySelector('.fechar').onclick = () => fundo.remove();
  fundo.querySelector('form').onsubmit = e => {
    e.preventDefault();
    const ops = [...lista.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
    if (ops.length < 2) { avisar('A enquete precisa de pelo menos 2 opções.'); return; }
    fundo.remove();
    mandarConteudo({ enquete: { perg: e.target.perg.value.trim(), ops, multi: e.target.multi.checked } });
  };
  fundo.querySelector('[name=perg]').focus();
}

// ---------- 🎮 minijogos ----------
const LINHAS_VELHA = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function estadoVelha(m, js) {
  const tab = Array(9).fill(null);
  let O = null, On = null, vez = 'X', fim = null, linha = null;
  for (const j of js) {
    const c = j.jogada.casa;
    if (fim || c === undefined || tab[c]) continue;
    if (vez === 'X') { if (j.u !== m.u) continue; }
    else if (O === null) { if (j.u === m.u) continue; O = j.u; On = j.n; }  // o primeiro que jogar vira o ⭕
    else if (j.u !== O) continue;
    tab[c] = vez;
    linha = LINHAS_VELHA.find(l => l.every(i => tab[i] === vez)) || null;
    fim = linha ? vez : (tab.every(Boolean) ? 'velha' : null);
    vez = vez === 'X' ? 'O' : 'X';
  }
  return { tab, X: m.u, Xn: m.n, O, On, vez, fim, linha };
}
function estadoPPT(m, js) {
  const A = m.u;
  let B = null, Bn = null;
  const comp = {}, rev = {};
  for (const j of js) {
    if (j.jogada.comp) {
      if (j.u === A) { if (!comp[A]) comp[A] = j.jogada.comp; }
      else if (B === null) { B = j.u; Bn = j.n; comp[B] = j.jogada.comp; }  // o primeiro que aceitar o desafio
    } else if (j.jogada.rev && (j.u === A || j.u === B) && !rev[j.u] && comp[j.u]) {
      const ok = conferePPT(j, comp[j.u]);
      if (ok === true) rev[j.u] = j.jogada.rev.e;
      else if (ok === undefined) rev[j.u] = '?';  // ainda conferindo
    }
  }
  return { A, An: m.n, B, Bn, comp, rev };
}
// confere se a escolha revelada é a mesma que a pessoa "trancou" antes (ninguém troca depois de ver a do outro)
const conferidas = new Map();
function conferePPT(j, compromisso) {
  if (conferidas.has(j.id)) return conferidas.get(j.id);
  conferidas.set(j.id, undefined);
  sha(j.jogada.rev.e + ':' + j.jogada.rev.sal).then(h => { conferidas.set(j.id, hex(h) === compromisso); agendarRender(); });
  return undefined;
}
function htmlJogo(m, js) {
  const j = m.jogo;
  const quem = uid => uid === eu.uid ? 'Você' : nomeDe(uid);
  if (j.tipo === 'dado') {
    return `<div class="jogo-dado${novasNaTela.has(m.id) ? ' rolando' : ''}"><span class="dado">${'⚀⚁⚂⚃⚄⚅'[j.valor - 1]}</span>
      <div>🎲 ${esc(quem(m.u))} tirou <b>${j.valor}</b></div></div>`;
  }
  if (j.tipo === 'velha') {
    const s = estadoVelha(m, js);
    const minhaVez = !s.fim && ((s.vez === 'X' && eu.uid === s.X) || (s.vez === 'O' && (s.O ? eu.uid === s.O : eu.uid !== s.X)));
    let status;
    if (s.fim === 'velha') status = '🤝 Deu velha! Empate.';
    else if (s.fim) status = `🏆 ${esc(quem(s.fim === 'X' ? s.X : s.O))} venceu!`;
    else if (minhaVez) status = `👉 Sua vez (${s.vez === 'X' ? '❌' : '⭕'})`;
    else if (s.vez === 'O' && !s.O) status = `Esperando alguém aceitar o desafio de ${esc(quem(s.X))}…`;
    else status = `Vez de ${esc(quem(s.vez === 'X' ? s.X : s.O))} (${s.vez === 'X' ? '❌' : '⭕'})`;
    return `<div class="jogo-velha"><div class="jogo-titulo">⭕ Jogo da velha</div>
      <div class="jogo-quem">❌ ${esc(quem(s.X))} &nbsp;vs&nbsp; ⭕ ${s.O ? esc(quem(s.O)) : '???'}</div>
      <div class="velha">${s.tab.map((v, i) => `<button class="casa${s.linha && s.linha.includes(i) ? ' venceu' : ''}" data-velha="${esc(m.id)}" data-casa="${i}" ${v || !minhaVez ? 'disabled' : ''}>${v === 'X' ? '❌' : v === 'O' ? '⭕' : ''}</button>`).join('')}</div>
      <div class="jogo-status">${status}</div>
      ${s.fim && (eu.uid === s.X || eu.uid === s.O) ? '<button class="bt claro mini" data-revanche="velha">🔁 Revanche</button>' : ''}</div>`;
  }
  // ✊ pedra, papel e tesoura
  const s = estadoPPT(m, js);
  const segredo = ler('ppt:' + m.id, null);
  let corpo;
  const botoes = `<div class="ppt-botoes">${Object.entries(JOKENPO).map(([k, e]) => `<button data-ppt="${esc(m.id)}" data-e="${k}" title="${k}">${e}</button>`).join('')}</div>`;
  if (s.B && s.rev[s.A] && s.rev[s.B] && s.rev[s.A] !== '?' && s.rev[s.B] !== '?') {
    const a = s.rev[s.A], b = s.rev[s.B];
    const res = a === b ? '🤝 Empate!' : `🏆 ${esc(quem(GANHA_DE[a] === b ? s.A : s.B))} venceu!`;
    corpo = `<div class="ppt-mao">${JOKENPO[a]} <small>vs</small> ${JOKENPO[b]}</div>
      <div class="jogo-quem">${esc(quem(s.A))} &nbsp;·&nbsp; ${esc(quem(s.B))}</div><div class="jogo-status">${res}</div>
      ${eu.uid === s.A || eu.uid === s.B ? '<button class="bt claro mini" data-revanche="ppt">🔁 Revanche</button>' : ''}`;
  } else if (s.B) {
    corpo = `<div class="ppt-mao">❔ <small>vs</small> ❔</div><div class="jogo-status">Os dois escolheram! Revelando… 🥁</div>`;
  } else if (eu.uid === s.A) {
    corpo = `<div class="jogo-status">Você escolheu ${segredo ? JOKENPO[segredo.e] : '✅'} (só você vê).<br>Esperando alguém aceitar o desafio…</div>`;
  } else {
    corpo = `<div class="jogo-status">${esc(quem(s.A))} já escolheu em segredo. Escolha a sua:</div>${botoes}`;
  }
  return `<div class="jogo-ppt"><div class="jogo-titulo">✊✋✌️ Pedra, papel e tesoura</div>${corpo}</div>`;
}
async function jogarPPT(alvo, e) {
  const sal = idAleatorio(16);
  const comp = hex(await sha(e + ':' + sal));
  guardar('ppt:' + alvo, { e, sal, revelado: false });
  mandarConteudo({ jogada: { alvo, comp } });
}
function criarJogo(tipo) {
  if (!atual) return;
  if (tipo === 'dado') { mandarConteudo({ jogo: { tipo: 'dado', valor: 1 + crypto.getRandomValues(new Uint8Array(1))[0] % 6 } }); return; }
  if (tipo === 'velha') { mandarConteudo({ jogo: { tipo: 'velha' } }); return; }
  // pedra-papel-tesoura: escolhe já e "tranca" a escolha
  const fundo = janela(`<h3>✊✋✌️ Desafiar</h3><p>Escolha a sua em segredo. Quem aceitar o desafio escolhe sem ver a sua!</p>
    <div class="ppt-botoes grande">${Object.entries(JOKENPO).map(([k, e]) => `<button data-e="${k}" title="${k}">${e}</button>`).join('')}</div>
    <div class="botoes"><button class="bt claro fechar">Cancelar</button></div>`);
  fundo.querySelector('.fechar').onclick = () => fundo.remove();
  fundo.querySelector('.ppt-botoes').onclick = async ev => {
    const b = ev.target.closest('[data-e]');
    if (!b) return;
    fundo.remove();
    const m = mandarConteudo({ jogo: { tipo: 'ppt' } });
    if (m) await jogarPPT(m.id, b.dataset.e);
  };
}
// quando chega uma jogada: no pedra-papel-tesoura, se os dois já escolheram, eu revelo a minha (sozinho)
function aoEvento(sala, ev) {
  if (!ev.jogada) return;
  const alvo = ev.jogada.alvo;
  const jogo = sala.msgs.find(x => x.id === alvo);
  if (!jogo || !jogo.jogo || jogo.jogo.tipo !== 'ppt') return;
  const segredo = ler('ppt:' + alvo, null);
  if (!segredo || segredo.revelado) return;
  const s = estadoPPT(jogo, contextoEventos(sala).jogadas.get(alvo) || []);
  if (!s.B || !s.comp[s.A] || !s.comp[s.B] || (eu.uid !== s.A && eu.uid !== s.B)) return;
  guardar('ppt:' + alvo, { ...segredo, revelado: true });
  setTimeout(() => mandarConteudo({ jogada: { alvo, rev: { e: segredo.e, sal: segredo.sal } } }, sala), 700); // 🥁 suspense
}

// ---------- 📎 menu: arquivo, enquete, minijogos ----------
function abrirMenuAnexo() {
  if (!atual) return;
  if (!podeFalar(atual)) { avisar('Você não pode mandar mensagem neste grupo. 🔒'); return; }
  const menu = $('#menuMsg');
  menu.innerHTML = `<div class="menu-lista">
    <button data-a="arquivo">📁 Foto, vídeo ou arquivo</button>
    <button data-a="enquete">📊 Enquete</button>
    <button data-a="velha">⭕ Jogo da velha</button>
    <button data-a="ppt">✊ Pedra, papel e tesoura</button>
    <button data-a="dado">🎲 Jogar o dado</button></div>`;
  menu.classList.remove('escondido');
  const r = $('#btAnexo').getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.left - 10, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = (r.top - menu.offsetHeight - 10) + 'px';
  menu.onclick = ev => {
    const b = ev.target.closest('[data-a]');
    if (!b) return;
    fecharMenuMsg();
    const a = b.dataset.a;
    if (a === 'arquivo') escolherArquivos();
    else if (a === 'enquete') criarEnquete();
    else criarJogo(a);
  };
}

// ---------- botão 🎤 / ➤ (igual no zap: caixa vazia mostra o microfone) ----------
function trocarBotaoEnviar() {
  const vazio = !$('#campoMsg').value.trim();
  $('#btEnviar').classList.toggle('escondido', vazio);
  $('#btMic').classList.toggle('escondido', !vazio);
}
$('#campoMsg').addEventListener('input', trocarBotaoEnviar);

function htmlArquivo(m) {
  const a = m.arq, tp = tipoArq(a);
  const url = arqUrls.get(a.id);
  if (!url) conferirArquivo(a.id);
  const b = baixando.get(a.id);
  const barra = b ? `<div class="progresso"><div data-prog="${esc(a.id)}" style="width:${b.pct}%"></div></div>` : '';
  const botao = b ? '' : `<button class="bt-baixar" data-baixar="${esc(m.id)}">⬇ ${fmtTam(a.tam)}</button>`;
  const salvar = url ? `<a class="salvar-arq" href="${esc(url)}" download="${esc(a.nome)}">⬇ Salvar · ${fmtTam(a.tam)}</a>` : '';
  if (url && tp === 'video') return `<video class="video-msg" src="${esc(url)}" controls playsinline preload="metadata" ${a.thumb ? `poster="${esc(a.thumb)}"` : ''}></video>${salvar}`;
  if (url && tp === 'imagem') return `<img class="foto-msg" src="${esc(url)}" data-verarq="${esc(m.id)}" alt="">${salvar}`;
  if (url && tp === 'audio') return `<div class="arq-card"><span class="arq-icone">🎵</span><div class="arq-info"><b>${esc(a.nome)}</b></div></div><audio src="${esc(url)}" controls></audio>${salvar}`;
  if (!url && a.thumb) return `<div class="midia-espera"><img class="foto-msg" src="${esc(a.thumb)}" alt="">${tp === 'video' ? '<span class="play">▶</span>' : ''}<div class="espera-baixo">${botao}${barra}</div></div>`;
  return `<div class="arq-card"><span class="arq-icone">${iconeArq(a)}</span><div class="arq-info"><b>${esc(a.nome)}</b><small>${fmtTam(a.tam)}</small></div>
    ${url ? `<a class="bt-baixar" href="${esc(url)}" download="${esc(a.nome)}" title="Salvar">⬇</a>` : b ? '' : `<button class="bt-baixar" data-baixar="${esc(m.id)}" title="Baixar">⬇</button>`}</div>${barra}`;
}

function renderMsgs(irProFim) {
  const box = $('#mensagens');
  if (!atual) return;
  const perto = pertoDoFim();
  // os eventos escondidos (reação, edição, apagar, voto, jogada) viram o "estado" de cada mensagem
  const ev = contextoEventos(atual);
  const reacoes = ev.reacoes;
  const msgs = atual.msgs.filter(m => !ehEvento(m)).map(m => ev.edits.has(m.id) ? { ...m, txt: ev.edits.get(m.id).txt, editada: true } : m);
  if (!msgs.length) {
    box.innerHTML = atual.tipo === 'dm'
      ? `<div class="dica">${amigos.get(atual.pub) && amigos.get(atual.pub).estado !== 'amigo' ? '📨 Pedido de amizade enviado!<br>Quando a pessoa aceitar, aparece aqui.' : 'Diga oi! 👋'}</div>`
      : `<div class="dica">Nenhuma mensagem ainda. Manda um oi! 👋<br><br>Código do grupo:<br><b>${codigoBonito(atual.codigo)}</b></div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  let diaAnt = '';
  const junta = (a, b) => a && b && !a.sys && !b.sys && !a.chamar && !b.chamar && !a.conta && !b.conta && a.u === b.u && Math.abs(b.ts - a.ts) < 180000 && rotuloDia(a.ts) === rotuloDia(b.ts);
  const grupo = atual.tipo === 'grupo';
  msgs.forEach((m, i) => {
    const dia = rotuloDia(m.ts);
    if (dia !== diaAnt) { const d = document.createElement('div'); d.className = 'dia'; d.textContent = dia; frag.appendChild(d); diaAnt = dia; }
    if (m.sys) { const d = document.createElement('div'); d.className = 'sistema'; d.textContent = m.txt; frag.appendChild(d); return; }
    if (m.chamar) {
      const d = document.createElement('div');
      d.className = 'sistema chamada' + (novasNaTela.has(m.id) ? ' nova' : '');
      const quem = m.u === eu.uid ? 'Você' : nomeDe(m.u, m.n);
      d.textContent = `🔔 ${quem} ${m.u === eu.uid ? (grupo ? 'chamou todo mundo' : 'chamou') : (grupo ? 'chamou todo mundo' : 'te chamou')} · ${hora(m.ts)}`;
      frag.appendChild(d); return;
    }
    const juntaAnt = junta(msgs[i - 1], m), juntaProx = junta(m, msgs[i + 1]);
    const minha = m.u === eu.uid;
    const figura = m.fig || m.img;
    const nome = nomeDe(m.u, m.n);
    const linha = document.createElement('div');
    linha.className = 'linha ' + (minha ? 'minha' : 'outra') + (juntaAnt ? ' continua' : '') + (juntaProx ? '' : ' cauda')
      + (figura ? ' com-fig' : '') + (novasNaTela.has(m.id) ? ' nova' : '');
    linha.dataset.id = m.id;
    let html = '';
    if (!minha && grupo) html += juntaProx ? '<div class="avatar vazio-av"></div>' : avatarHTML(m.u, nome);
    const adm = grupo && ehAdminUid(atual, m.u) ? ' <span class="tag-adm-msg">admin</span>' : '';
    const nomeHTML = (!minha && grupo && !juntaAnt ? `<div class="nome" style="color:${corDe(m.u)}">${esc(nome)}${adm}</div>` : '') + htmlCitacao(m);
    const chips = htmlReacoes(m.id, reacoes.get(m.id));
    const horaTxt = (m.editada ? 'editada · ' : '') + hora(m.ts);
    if (ev.apagadas.has(m.id)) {  // 🚫 apagada (pelo autor ou por um admin do grupo)
      const quem = ev.apagadas.get(m.id) === 'admin' ? 'Apagada por um admin' : (minha ? 'Você apagou esta mensagem' : 'Mensagem apagada');
      html += `<div class="balao apagada">${!minha && grupo && !juntaAnt ? `<div class="nome" style="color:${corDe(m.u)}">${esc(nome)}</div>` : ''}<div class="txt">🚫 ${quem}</div><div class="hora">${hora(m.ts)}</div></div>`;
      linha.innerHTML = html; frag.appendChild(linha);
      return;
    }
    if (m.enquete) {
      html += `<div class="balao cartao-jogo">${nomeHTML}${htmlEnquete(m, ev.votos.get(m.id))}<div class="hora">${horaTxt}</div>${chips}</div>`;
    } else if (m.jogo) {
      html += `<div class="balao cartao-jogo">${nomeHTML}${htmlJogo(m, ev.jogadas.get(m.id) || [])}<div class="hora">${horaTxt}</div>${chips}</div>`;
    } else if (figura) {
      const f = m.fig && FIGURINHAS.porId.get(m.fig);
      const src = f ? f.url : m.img;
      html += `<div class="figura">${nomeHTML}<img src="${esc(src)}" class="${f ? (f.pixel ? 'pixel' : 'lutador') : 'propria'}" alt="figurinha" ${m.img && !minha ? 'data-salvar="1" title="Toque pra salvar"' : ''}>${chips}<div class="hora">${hora(m.ts)}</div></div>`;
    } else if (m.foto) {
      html += `<div class="balao midia">${nomeHTML}<img class="foto-msg" src="${esc(m.foto)}" data-ver="${esc(m.id)}" alt="foto">
        ${m.txt ? `<div class="txt">${linkar(m.txt)}</div>` : ''}<div class="hora">${hora(m.ts)}</div>${chips}</div>`;
    } else if (m.arq) {
      html += `<div class="balao midia">${nomeHTML}${htmlArquivo(m)}${m.txt ? `<div class="txt">${linkar(m.txt)}</div>` : ''}<div class="hora">${hora(m.ts)}</div>${chips}</div>`;
    } else if (m.voz) {
      html += `<div class="balao">${nomeHTML}${htmlVoz(m)}<div class="hora">${hora(m.ts)}</div>${chips}</div>`;
    } else if (m.conta) {
      const fotoC = m.conta.foto ? `<img class="avatar" src="${esc(m.conta.foto)}" alt="">` : `<div class="avatar av-grupo">${esc(inicial(m.conta.nome))}</div>`;
      html += `<div class="balao cartao-conta">${nomeHTML}<div class="cc-topo">${fotoC}<div><small>🔑 Acesso à conta</small><b>${esc(m.conta.nome)}</b></div></div>
        ${minha ? '<div class="cc-info">Você deu acesso a essa conta.</div>' : `<button class="bt verde usar-conta" data-id="${esc(m.id)}">Usar essa conta</button>`}
        <div class="hora">${hora(m.ts)}</div></div>`;
    } else {
      html += `<div class="balao">${nomeHTML}<div class="txt${soEmoji(m.txt) ? ' emoji-grande' : ''}">${linkar(m.txt)}</div><div class="hora">${horaTxt}</div>${chips}</div>`;
    }
    if (!m.conta) html += `<button class="bt-reagir" data-menu="${esc(m.id)}" title="Reagir / responder">☺</button>`;
    linha.innerHTML = html;
    frag.appendChild(linha);
  });
  novasNaTela.clear();
  // vídeo/áudio que já estava na tela continua o mesmo (não reinicia se estiver tocando)
  const players = new Map([...box.querySelectorAll('video, audio')].map(v => [v.getAttribute('src'), v]));
  frag.querySelectorAll('video, audio').forEach(n => { const v = players.get(n.getAttribute('src')); if (v) n.replaceWith(v); });
  box.replaceChildren(frag);
  if (irProFim || perto) {
    box.scrollTop = box.scrollHeight;
    // foto carrega depois: desce de novo quando ela aparecer
    box.querySelectorAll('img.foto-msg, video').forEach(el => el.addEventListener(el.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', () => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 400) box.scrollTop = box.scrollHeight;
    }, { once: true }));
  }
  renderDescer();
}
$('#mensagens').addEventListener('click', e => {
  if (!atual) return;
  const acha = id => atual.msgs.find(x => x.id === id);
  const t = e.target;
  const menu = t.closest('[data-menu]');
  if (menu) { abrirMenuMsg(menu.dataset.menu, menu.closest('.linha').querySelector('.balao, .figura') || menu); return; }
  const chip = t.closest('.chip-reacao');
  if (chip) { reagir(chip.dataset.alvo, chip.dataset.e); return; }
  const voto = t.closest('[data-votar]');
  if (voto) { votar(voto.dataset.votar, Number(voto.dataset.i)); return; }
  const casa = t.closest('[data-velha]');
  if (casa) { mandarConteudo({ jogada: { alvo: casa.dataset.velha, casa: Number(casa.dataset.casa) } }); return; }
  const ppt = t.closest('[data-ppt]');
  if (ppt) { jogarPPT(ppt.dataset.ppt, ppt.dataset.e); return; }
  const revanche = t.closest('[data-revanche]');
  if (revanche) { criarJogo(revanche.dataset.revanche); return; }
  const ir = t.closest('[data-ir]');
  if (ir) { irPraMensagem(ir.dataset.ir); return; }
  const tocar = t.closest('[data-tocar]');
  if (tocar) { const m = acha(tocar.dataset.tocar); if (m) tocarVoz(m); return; }
  const pular = t.closest('[data-pular]');
  if (pular) {
    const m = acha(pular.dataset.pular);
    if (!m) return;
    const r = pular.getBoundingClientRect(), k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (tocador.id !== m.id) tocarVoz(m);
    const ir2 = () => { tocador.audio.currentTime = k * (m.voz.dur || tocador.audio.duration || 0); };
    if (tocador.audio.readyState >= 1) ir2(); else tocador.audio.addEventListener('loadedmetadata', ir2, { once: true });
    return;
  }
  if (t.closest('[data-vel]')) {
    tocador.vel = tocador.vel === 1 ? 1.5 : tocador.vel === 1.5 ? 2 : 1;
    tocador.audio.playbackRate = tocador.vel;
    atualizarVoz(); renderMsgs();
    return;
  }
  const img = e.target.closest('img[data-salvar]');
  if (img) { salvarFigurinhaRecebida(img.getAttribute('src')); return; }
  const ver = e.target.closest('[data-ver]');
  if (ver && atual) { const m = atual.msgs.find(x => x.id === ver.dataset.ver); if (m) verFoto(m.foto, 'foto-frogchat.jpg'); return; }
  const verArq = e.target.closest('[data-verarq]');
  if (verArq && atual) { const m = atual.msgs.find(x => x.id === verArq.dataset.verarq); if (m) verFoto(arqUrls.get(m.arq.id), m.arq.nome); return; }
  const baixar = e.target.closest('[data-baixar]');
  if (baixar && atual) { const m = atual.msgs.find(x => x.id === baixar.dataset.baixar); if (m) baixarArquivo(atual, m); return; }
  const usar = e.target.closest('.usar-conta');
  if (usar && atual) { const m = atual.msgs.find(x => x.id === usar.dataset.id); if (m) usarContaRecebida(m.conta); }
});

function renderCall() {
  const btCall = $('#btCall');
  if (!atual) return;
  const euNaCall = call.sala === atual;
  const tem = atual.naCall.size > 0 || euNaCall;
  btCall.classList.toggle('ativo', tem);
  btCall.title = euNaCall ? 'Você está na call' : tem ? 'Call rolando — entrar' : 'Começar call de voz';
  $('#barraCall').classList.toggle('escondido', !tem);
  if (!tem) return;
  const pessoas = [];
  if (euNaCall) pessoas.push({ id: 'eu', n: 'Você', uid: eu.uid, mudo: call.mudo, conectando: false });
  for (const [id, p] of atual.naCall) {
    const peer = call.peers.get(id);
    pessoas.push({ id, n: nomeDe(p.uid, p.n), uid: p.uid, mudo: p.mudo, conectando: euNaCall && (!peer || peer.estado !== 'connected') });
  }
  $('#pessoasCall').innerHTML = pessoas.map(p =>
    `<div class="pessoa-call${p.conectando ? ' conectando' : ''}${p.mudo ? ' mudo' : ''}" data-voz="${esc(p.id)}" title="${esc(p.n)}${p.conectando ? ' (conectando…)' : ''}">
       <div class="av-call">${avatarHTML(p.uid, p.n)}</div><span>${esc(p.n)}</span></div>`).join('');
  $('#btEntrarCall').classList.toggle('escondido', euNaCall);
  $('#btMudo').classList.toggle('escondido', !euNaCall);
  $('#btDesligar').classList.toggle('escondido', !euNaCall);
  $('#btMudo').textContent = call.mudo ? '🔇 Desmutar' : '🎤 Mutar';
  $('#btTela').classList.toggle('escondido', !euNaCall || !podeMostrarTela());
  $('#btTela').textContent = call.telaTipo === 'tela' ? '⏹️ Parar tela' : '🖥️ Tela';
  $('#btCamera').classList.toggle('escondido', !euNaCall || !podeCamera());
  $('#btCamera').textContent = call.telaTipo === 'camera' ? '⏹️ Parar câmera' : '📷 Câmera';
  $('#emojisCall').classList.toggle('escondido', !euNaCall);
  $('#btVerPalco').classList.toggle('escondido', !(euNaCall && call.telas.size && call.palcoFechado));
  renderPalco();
}

function renderTudo() {
  renderEu(); renderSalas(); renderPedidos(); renderStatusLista(); renderBannerNotif();
  if (atual) { renderTopo(); renderOnline(); renderMsgs(); renderCall(); renderCaixa(); }
}

function selecionarSala(sala) {
  if (atual !== sala) { cancelarResposta(); cancelarEdicao(); if (grav) pararGravacao(false); }
  atual = sala;
  sala.naoLidas = 0; salvarMsgs(sala);
  novasAbaixo = 0;
  trocarAba('conversas');
  document.body.classList.add('vendo-chat');
  $('#vazio').classList.add('escondido');
  $('#chat').classList.remove('escondido');
  fecharPainelFig();
  renderTopo(); renderOnline(); renderDigitando(); renderCall(); renderSalas(); renderCaixa();
  renderMsgs(true);
  if (!celular && podeFalar(sala)) $('#campoMsg').focus();
}

function fecharChat() {
  atual = null;
  document.body.classList.remove('vendo-chat');
  $('#chat').classList.add('escondido');
  $('#vazio').classList.remove('escondido');
  renderSalas();
}

function trocarAba(aba) {
  document.querySelectorAll('.aba').forEach(b => b.classList.toggle('ativa', b.dataset.aba === aba));
  $('#abaConversas').classList.toggle('escondido', aba !== 'conversas');
  $('#abaStatus').classList.toggle('escondido', aba !== 'status');
  if (aba === 'status') renderStatusLista();
}
document.querySelectorAll('.aba').forEach(b => b.onclick = () => trocarAba(b.dataset.aba));

// ================= ações =================
function mandarConteudo(conteudo, sala = atual) {
  if (!sala) return;
  const a = sala.tipo === 'dm' ? amigos.get(sala.pub) : null;
  if (a && a.estado !== 'amigo') { avisar('Espera a pessoa aceitar o pedido de amizade pra mandar mensagem. ⏳'); return false; }
  const evento = ehEvento(conteudo);
  if (evento) {
    // evento (reação, voto, jogada, editar, apagar): pode até em grupo de "só admins" (só não em grupo encerrado);
    // não conta no anti-spam
    if (sala.cfg && (sala.cfg.encerrado || sala.cfg.movido)) return false;
    for (const tipo of ['reage', 'voto', 'edita']) {  // desses, só vale o último: tira os meus velhos
      if (conteudo[tipo]) sala.msgs = sala.msgs.filter(x => !(x[tipo] && x.u === eu.uid && x[tipo].alvo === conteudo[tipo].alvo));
    }
  } else {
    if (!conteudo.sys && !podeFalar(sala)) { avisar('Você não pode mandar mensagem neste grupo. 🔒'); return false; }
    if (!conteudo.sys && !conteudo.conta) {
      if (emCastigo()) { avisar(textoCastigo()); renderCaixa(); return false; }
      if (!contarEnvio()) return false;
    }
    // respondendo alguém: a mensagem leva a citação junto
    if (respondendo && respondendo.sala === sala && !conteudo.sys && !conteudo.chamar) {
      conteudo = { ...conteudo, resp: { id: respondendo.id, u: respondendo.u, n: respondendo.n, p: respondendo.p } };
      cancelarResposta();
    }
  }
  const m = { id: idAleatorio(12), u: eu.uid, n: eu.apelido, ts: Date.now(), ...conteudo };
  adicionarMsg(sala, m, evento);
  enviar(sala, 'msg', { id: m.id, ts: m.ts, ...conteudo });
  agendarCaixa(sala);
  if (evento) { salvarMsgs(sala); aoEvento(sala, m); }
  if (sala === atual) { if (evento) renderMsgs(); else renderMsgs(true); }
  renderSalas();
  return m;
}

function mandarMensagem() {
  const campo = $('#campoMsg');
  const txt = campo.value.trim();
  if (!txt || !atual) return;
  if (editando && editando.sala === atual) {  // ✏️ editando uma mensagem minha
    const id = editando.id;
    cancelarEdicao();
    mandarConteudo({ edita: { alvo: id, txt: txt.slice(0, 2000) } });
    campo.value = ''; ajustarAltura(); trocarBotaoEnviar();
    return;
  }
  if (mandarConteudo({ txt: txt.slice(0, 2000) }) === false) return;
  campo.value = ''; ajustarAltura(); trocarBotaoEnviar();
  ultimoDig = 0; // a próxima tecla já avisa "digitando" de novo
}

function ajustarAltura() {
  const c = $('#campoMsg');
  c.style.height = 'auto';
  c.style.height = Math.min(c.scrollHeight + 3, 140) + 'px';
}

let ultimoDig = 0;
$('#campoMsg').addEventListener('input', () => {
  ajustarAltura();
  if (atual && $('#campoMsg').value.trim() && Date.now() - ultimoDig > 2500) { ultimoDig = Date.now(); enviar(atual, 'dig'); }
});
$('#campoMsg').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !celular) { e.preventDefault(); mandarMensagem(); }
});
$('#campoMsg').addEventListener('focus', fecharPainelFig);
$('#formMsg').addEventListener('submit', e => { e.preventDefault(); mandarMensagem(); if (celular) $('#campoMsg').focus(); });

$('#btAmigo').onclick = async () => {
  const txt = await perguntar({
    titulo: 'Adicionar amigo',
    texto: `<p>Digite o número de 5 dígitos do seu amigo. Ele recebe um pedido e precisa aceitar.</p><p class="dica-num">${eu.compartilhada ? 'Número desta conta' : 'Seu número'}: <b>${eu.num || 'gerando…'}</b></p>`,
    campo: 'Ex.: 48213', ok: 'Mandar pedido', max: 7, modo: 'num',
  });
  if (txt === null) return;
  const num = txt.replace(/\D/g, '');
  if (!/^\d{5}$/.test(num)) { avisar('O número tem 5 dígitos, tipo 48213.'); return; }
  adicionarAmigo(num);
};

$('#btNova').onclick = async () => {
  const nome = await perguntar({ titulo: 'Novo grupo', texto: '<p>Você vai ser o <b>dono</b> do grupo e pode mexer nas configurações (⚙️).</p>', campo: 'Nome do grupo (ex.: Galera do Sapo)', ok: 'Criar' });
  if (nome === null) return;
  const sala = await abrirGrupo(novoCodigo(), nome || 'Grupo novo');
  await publicarCfg(sala, {});   // quem cria vira o dono
  salvarListaSalas();
  selecionarSala(sala);
  mostrarConvite(sala);
};

$('#btCodigo').onclick = async () => {
  const txt = await perguntar({ titulo: 'Entrar num grupo', texto: '<p>Digite o código do grupo que seu amigo te mandou.</p>', campo: 'Ex.: ABCD-2345', ok: 'Entrar', max: 20 });
  if (txt === null) return;
  const codigo = limparCodigo(txt);
  if (!codigoValido(codigo)) { avisar('Esse código não existe. Ele tem 8 letras/números, tipo ABCD-2345.'); return; }
  selecionarSala(await abrirGrupo(codigo, null));
};

$('#btPerfil').onclick = abrirContas;
$('#btConvidar').onclick = () => { if (atual && atual.tipo === 'grupo') mostrarConvite(atual); };
$('#btConfig').onclick = () => { if (atual && atual.tipo === 'grupo') abrirConfig(atual); };
$('#btVoltar').onclick = fecharChat;
$('#btSairSala').onclick = async () => {
  if (!atual) return;
  const sala = atual;
  const dm = sala.tipo === 'dm';
  const ok = await perguntar({
    titulo: dm ? 'Desfazer amizade?' : 'Sair do grupo?',
    texto: dm ? `<p>A conversa com <b>${esc(nomeCanal(sala))}</b> some deste aparelho. Pra voltar, um de vocês precisa mandar pedido de novo.</p>`
      : `<p>Você sai de "<b>${esc(nomeCanal(sala))}</b>" e as mensagens somem deste aparelho. Pra voltar, precisa do código de novo.</p>${souDono(sala) ? '<p class="dica-num">Você é o dono: se sair, o grupo continua sem você.</p>' : ''}`,
    ok: dm ? 'Desfazer' : 'Sair', perigo: true,
  });
  if (!ok) return;
  if (dm) { amigos.delete(sala.pub); apagados.amigos[sala.pub] = Date.now(); guardar('apagados', apagados); salvarAmigos(); }
  largarCanal(sala);
};
$('#btCall').onclick = () => {
  if (!atual || call.sala === atual) return;
  const a = atual.tipo === 'dm' ? amigos.get(atual.pub) : null;
  if (a && a.estado !== 'amigo') { avisar('Espera a pessoa aceitar o pedido pra ligar. ⏳'); return; }
  entrarCall(atual);
};
$('#btEntrarCall').onclick = () => { if (atual) entrarCall(atual); };
$('#btDesligar').onclick = sairCall;
$('#btMudo').onclick = alternarMudo;

// ================= começo =================
function lerConvite() {
  const h = new URLSearchParams(location.hash.slice(1));
  const codigo = limparCodigo(h.get('entrar'));
  if (!codigo) return null;
  history.replaceState(null, '', location.pathname + location.search);
  const dono = (h.get('dono') || '').toLowerCase();
  return codigoValido(codigo) ? { codigo, nome: (h.get('nome') || '').trim().slice(0, 40) || null, dono: /^[0-9a-f]{16}$/.test(dono) ? dono : null } : null;
}

async function carregarDados() {
  const p = await DB.get('perfis');
  if (p) for (const [uid, v] of Object.entries(p)) perfis.set(uid, v);
  meusStatus = statusAtivos((await DB.get('meusStatus')) || []);
  minhasFig = (await DB.get('minhasFig')) || [];
  for (const c of ler('contatos', [])) await registrarContato(c.u, c.k);
  // salas da 1ª versão (antes dos amigos) → viram grupos
  const antigas = ler('salas', null);
  if (antigas) {
    for (const s of antigas) if (s && codigoValido(s.codigo)) {
      const velhas = ler('msgs:' + s.codigo, null);
      if (velhas) { await DB.set('msgs:g-' + s.codigo, velhas); apagar('msgs:' + s.codigo); }
      apagar('nl:' + s.codigo);
      await abrirGrupo(s.codigo, s.nome);
    }
    apagar('salas');
  }
  for (const c of ler('canais', [])) {
    const tsAdd = c.ts || 0;
    if (c.tipo === 'grupo' && codigoValido(c.codigo)) await abrirGrupo(c.codigo, c.nome, { tsAdd, donoHash: c.dono || null });
    else if (c.tipo === 'dm' && amigos.has(c.pub)) await abrirDM(amigos.get(c.pub), { tsAdd });
  }
  for (const a of amigos.values()) if (!salas.has('dm-' + (await segredoCom(a.pub)).id)) await abrirDM(a);
}

async function comecar() {
  $('#entrada').classList.add('escondido');
  $('#app').classList.remove('escondido');
  await carregarIdentidade();
  renderEu(); renderStatus();
  conectar();
  await carregarDados();
  if (!(await usarConvite()) && salas.size && !matchMedia('(max-width: 720px)').matches) {
    selecionarSala([...salas.values()].sort((a, b) => ultimaTs(b) - ultimaTs(a))[0]);
  }
  renderTudo();
  addEventListener('hashchange', usarConvite); // clicou num convite com o app já aberto
}

async function usarConvite() {
  const convite = lerConvite();
  if (!convite) return false;
  const ja = salas.has('g-' + convite.codigo);
  const sala = await abrirGrupo(convite.codigo, convite.nome, { donoHash: convite.dono });
  selecionarSala(sala);
  avisar(ja ? `Você já está em "${nomeCanal(sala)}".` : `Você entrou em "${nomeCanal(sala)}"! 🎉`);
  return true;
}

function iniciar() {
  if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
    document.body.innerHTML = '<p style="padding:2em;font-family:sans-serif">O FrogTalk precisa ser aberto por um link <b>https://</b>.</p>';
    return;
  }
  if (eu.apelido) { comecar(); return; }
  $('#entrada').classList.remove('escondido');
  if (location.hash.includes('entrar=')) $('.sub').textContent = 'Te chamaram pra um grupo! Escolhe seu apelido:';
  $('#campoApelido').focus();
  $('#formEntrada').onsubmit = e => {
    e.preventDefault();
    const a = $('#campoApelido').value.trim();
    if (!a) return;
    eu.apelido = a.slice(0, 24); guardar('apelido', eu.apelido); guardar('perfilTs', Date.now());
    comecar();
  };
}

// pra testes automáticos
window.__frogchat = { eu, salas, call, amigos, pedidos, perfis, conectado, adicionarAmigo, aceitarPedido, CONTA, enviar };

iniciar();
