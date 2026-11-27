// Testes da identificação cadastral (js/empresa.js) e do Worker. Dados 100% sintéticos: nenhum representa cadastro real.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import worker, { normalizarBrasilApi as wBrasil, normalizarCnpjWs, validarCnpj as wValida } from "../cloudflare-worker/worker.js";
const E = createRequire(import.meta.url)("../js/empresa.js");

const CNPJ = "37570756000186";
const MOCK = { cnpj: CNPJ, razao_social: "EMPRESA MOCK LTDA", nome_fantasia: "MOCK", descricao_situacao_cadastral: "ATIVA", data_situacao_cadastral: "2020-01-10",
  cnae_fiscal: 7112000, cnae_fiscal_descricao: "Serviços de engenharia",
  cnaes_secundarios: [{ codigo: 4399103, descricao: "Obras de alvenaria" }, { codigo: 0, descricao: "" }],
  descricao_tipo_de_logradouro: "RUA", logradouro: "TESTE", numero: "10", bairro: "CENTRO", cep: "01000000", municipio: "SAO PAULO", uf: "SP",
  codigo_municipio_ibge: 3550308, natureza_juridica: "Sociedade Empresária Limitada", porte: "DEMAIS", opcao_pelo_simples: false, opcao_pelo_mei: false,
  regime_tributario: [{ ano: 2024, forma_de_tributacao: "LUCRO REAL" }, { ano: 2025, forma_de_tributacao: "LUCRO PRESUMIDO" }] };
const resp = (status, corpo) => ({ status, ok: status >= 200 && status < 300, json: async () => corpo });
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k), m }; };
const base = (extra = {}) => ({ storage: mem(), esperar: async () => {}, intervaloMs: 0, backoffMs: 0, fallbackDireto: true, ...extra });

test("CNPJ: dígitos verificadores, repetidos e tamanho", () => {
  assert.ok(E.validarCnpj("37.570.756/0001-86") && wValida(CNPJ));
  assert.ok(!E.validarCnpj("37570756000187") && !E.validarCnpj("11111111111111") && !E.validarCnpj("123") && !E.validarCnpj(""));
  assert.equal(E.formatarCnpj(CNPJ), "37.570.756/0001-86");
  assert.equal(E.formatarCnae("7112000"), "7112-0/00");
});

test("normalização: CNAE principal e secundários, placeholder zero descartado, regime mais recente", () => {
  const d = E.normalizarBrasilApi(MOCK);
  assert.equal(d.cnaePrincipal.codigo, "7112000");
  assert.deepEqual(d.cnaesSecundarios.map(c => c.codigo), ["4399103"]);
  assert.equal(d.regime.formaTributacao, "LUCRO PRESUMIDO (2025)");
  assert.equal(d.endereco.logradouro, "RUA TESTE");
  assert.equal(E.normalizarBrasilApi({}), null);
  assert.deepEqual(wBrasil(MOCK), d, "Worker e navegador normalizam igual");
});

test("normalização CNPJ.ws é defensiva", () => {
  const d = normalizarCnpjWs({ razao_social: "X LTDA", natureza_juridica: { descricao: "LTDA" }, porte: { descricao: "ME" }, simples: { simples: "Sim", mei: "Não" },
    estabelecimento: { cnpj: CNPJ, situacao_cadastral: "Ativa", atividade_principal: { id: "7112000", subclasse: "7112-0/00", descricao: "Eng." },
      atividades_secundarias: [], cidade: { nome: "SP", ibge_id: 3550308 }, estado: { sigla: "SP" } } });
  assert.equal(d.cnaePrincipal.codigo, "7112000"); assert.equal(d.regime.simples, true); assert.equal(d.regime.mei, false);
  assert.equal(normalizarCnpjWs({ razao_social: "só isso" }), null);
});

test("consulta: sucesso grava cache e a segunda chamada não usa a rede", async () => {
  let n = 0; const o = base({ fetchImpl: async () => (n++, resp(200, MOCK)) });
  const a = await E.consultarCnpj(CNPJ, o), b = await E.consultarCnpj(CNPJ, o);
  assert.equal(a.status, "OK"); assert.equal(b.status, "CACHE"); assert.equal(n, 1);
  assert.match(a.fonte, /BrasilAPI/); assert.ok(a.consultadoEm && b.validoAte);
});

test("consulta: cache vencido é renovado; se a renovação falhar, usa o vencido com aviso", async () => {
  let t = 1_000_000, falha = false, n = 0;
  const o = base({ ttlMs: 1000, agora: () => t, fetchImpl: async () => (n++, falha ? resp(503, {}) : resp(200, MOCK)) });
  await E.consultarCnpj(CNPJ, o); t += 5000;
  assert.equal((await E.consultarCnpj(CNPJ, o)).status, "OK"); assert.equal(n, 2);
  t += 5000; falha = true;
  const r = await E.consultarCnpj(CNPJ, o);
  assert.equal(r.status, "CACHE_VENCIDO"); assert.match(r.aviso, /vencido/); assert.equal(E.statusEmpresa(r).status, "VÁLIDO");
});

test("consulta: indisponível tenta 2 vezes e não inventa dados; 404 não repete; CNPJ inválido não consulta", async () => {
  let n = 0;
  const r = await E.consultarCnpj(CNPJ, base({ fetchImpl: async () => (n++, resp(503, {})) }));
  assert.equal(r.status, "INDISPONIVEL"); assert.equal(n, 2); assert.equal(r.dados, undefined);
  n = 0; const r404 = await E.consultarCnpj(CNPJ, base({ fetchImpl: async () => (n++, resp(404, {})) }));
  assert.equal(r404.status, "NAO_ENCONTRADO"); assert.equal(n, 1);
  n = 0; const ri = await E.consultarCnpj("37570756000187", base({ fetchImpl: async () => (n++, resp(200, MOCK)) }));
  assert.equal(ri.status, "INVALIDO"); assert.equal(n, 0);
  assert.equal(E.statusEmpresa(ri).status, "NÃO IDENTIFICADO");
});

test("consulta: erro de rede recupera na 2ª tentativa; consultas simultâneas são unificadas", async () => {
  let n = 0;
  const o = base({ fetchImpl: async () => { n++; if (n === 1) throw new Error("rede"); return resp(200, MOCK); } });
  assert.equal((await E.consultarCnpj(CNPJ, o)).status, "OK"); assert.equal(n, 2);
  let m = 0; const o2 = base({ fetchImpl: async () => (m++, resp(200, MOCK)) });
  const [x, y] = await Promise.all([E.consultarCnpj(CNPJ, o2), E.consultarCnpj(CNPJ, o2)]);
  assert.equal(m, 1); assert.equal(x.status, y.status);
});

test("consulta: Worker primeiro; se falhar, BrasilAPI direta; sem fallback não sai do Worker", async () => {
  const urls = []; const fi = async u => { urls.push(u); return u.includes("worker.exemplo") ? resp(503, {}) : resp(200, MOCK); };
  const r = await E.consultarCnpj(CNPJ, base({ workerUrl: "https://worker.exemplo/", fetchImpl: fi }));
  assert.equal(r.status, "OK"); assert.ok(urls[0].startsWith("https://worker.exemplo/cnpj/")); assert.ok(urls.at(-1).startsWith("https://brasilapi.com.br/"));
  urls.length = 0;
  const r2 = await E.consultarCnpj(CNPJ, base({ workerUrl: "https://worker.exemplo", fallbackDireto: false, fetchImpl: fi }));
  assert.equal(r2.status, "INDISPONIVEL"); assert.ok(urls.every(u => u.includes("worker.exemplo")));
  const reg = E.registroFontes(); assert.ok(reg.length > 0 && reg.at(-1).fonte);
});

test("consulta: resposta do Worker no formato empresa/v1 e dados desatualizados não renovam o cache", async () => {
  const dados = E.normalizarBrasilApi(MOCK), o = base({ workerUrl: "https://w.exemplo", fetchImpl: async () => resp(200, { schema: "empresa/v1", fonte: "BrasilAPI — espelho", consultadoEm: "2026-11-01T10:00:00Z", desatualizado: true, dados }) });
  const r = await E.consultarCnpj(CNPJ, o);
  assert.equal(r.status, "OK"); assert.match(r.aviso, /cópia anterior/); assert.equal(o.storage.m.size, 0);
});

test("status da empresa: ativa, baixada, sem CNAE, Simples, manual", () => {
  const dados = E.normalizarBrasilApi(MOCK), ok = { status: "OK", dados };
  assert.equal(E.statusEmpresa(ok).status, "VÁLIDO");
  assert.equal(E.statusEmpresa({ status: "OK", dados: { ...dados, situacao: "BAIXADA" } }).status, "INCOMPATÍVEL");
  assert.equal(E.statusEmpresa({ status: "OK", dados: { ...dados, cnaePrincipal: null } }).status, "NECESSITA ANÁLISE");
  const sn = E.statusEmpresa({ status: "OK", dados: { ...dados, regime: { simples: true, mei: false, formaTributacao: null } } });
  assert.equal(sn.status, "VÁLIDO"); assert.ok(sn.avisos.some(a => /Simples/.test(a)));
  assert.equal(E.statusEmpresa({ status: "MANUAL", dados }).status, "NECESSITA ANÁLISE");
});

test("cruzamentos: divergência serviço × NBS do caso de teste, LC 116 e CFOP", async () => {
  const xml = await readFile(new URL("./fixtures/nfse-servico-regressao.xml", import.meta.url), "utf8");
  assert.match(xml, new RegExp(`<CNPJ>${CNPJ}</CNPJ>`));
  const serv = xml.match(/<xTribNac>(.*?)<\/xTribNac>/)[1], nbs = xml.match(/<xNBS>(.*?)<\/xNBS>/)[1];
  const dv = E.divergenciaServicoNbs(serv, nbs);
  assert.equal(dv.divergente, true); assert.equal(dv.nivel, "BAIXO");
  assert.equal(E.divergenciaServicoNbs("Construção de edificações residenciais", "Serviços de construção de edificações residenciais").divergente, false);
  assert.equal(E.divergenciaServicoNbs("", nbs).nivel, "SEM_DADOS");
  assert.deepEqual(E.itemLc116("071901"), { item: "07", subitem: "19", desdobro: "01", referencia: "7.19" });
  assert.equal(E.itemLc116("7"), null);
  assert.equal(E.tipoOperacaoCfop("6102"), "saída (outra UF)");
  const d = E.normalizarBrasilApi(MOCK), c = [d.cnaePrincipal, ...d.cnaesSecundarios];
  assert.equal(E.cruzarCnaes(c, "Serviços de engenharia consultiva").nivel, "ALTO");
  assert.equal(E.cruzarCnaes([], "qualquer").nivel, "SEM_DADOS");
});

// ---- Worker ----
const mkCache = () => { const m = new Map(); return { match: async r => { const v = m.get(r.url); return v ? new Response(v) : undefined; }, put: async (r, res) => { m.set(r.url, await res.text()); } }; };
const call = (path, { env = { ALLOWED_ORIGIN: "https://site.exemplo" }, origin = "https://site.exemplo", ip = "1.1.1.1", fetch: ff, cache } = {}) =>
  worker.fetch(new Request("https://w.exemplo" + path, { headers: { ...(origin ? { Origin: origin } : {}), "CF-Connecting-IP": ip } }), env, { waitUntil: p => p },
    { fetch: ff || (async () => new Response(JSON.stringify(MOCK), { status: 200 })), cache: cache || mkCache(), agora: () => 1_700_000_000_000 });

test("Worker: valida CNPJ, rotas e origem; CORS só para a origem autorizada", async () => {
  assert.equal((await call("/cnpj/37570756000187")).status, 400);
  assert.equal((await call("/outra")).status, 404);
  assert.equal((await call("/cnpj/" + CNPJ, { origin: "https://intruso.exemplo" })).status, 403);
  const ok = await call("/cnpj/" + CNPJ);
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "https://site.exemplo");
  const semConfig = await call("/cnpj/" + CNPJ, { env: {}, origin: null });
  assert.equal(semConfig.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await call("/cnpj/" + CNPJ, { env: {} })).status, 403, "sem ALLOWED_ORIGIN nenhuma origem de navegador é liberada");
  const h = await (await call("/health")).json(); assert.equal(h.origemConfigurada, true);
});

test("Worker: normaliza, cacheia (MISS/HIT) e não repete a consulta externa", async () => {
  let n = 0; const cache = mkCache(), ff = async () => (n++, new Response(JSON.stringify(MOCK)));
  const a = await call("/cnpj/" + CNPJ, { fetch: ff, cache }), corpo = await a.json();
  assert.equal(a.headers.get("X-Cache"), "MISS"); assert.equal(corpo.schema, "empresa/v1"); assert.equal(corpo.dados.cnaePrincipal.codigo, "7112000");
  assert.match(corpo.fonte, /BrasilAPI/); assert.equal(corpo.consultadoEm, new Date(1_700_000_000_000).toISOString());
  const b = await call("/cnpj/" + CNPJ, { fetch: ff, cache });
  assert.equal(b.headers.get("X-Cache"), "HIT"); assert.equal(n, 1);
});

test("Worker: usa a segunda fonte quando a primeira falha; 404 é definitivo; falha total vira 503", async () => {
  const ws = { razao_social: "WS LTDA", estabelecimento: { cnpj: CNPJ, atividade_principal: { id: "7112000", descricao: "Eng." }, cidade: {}, estado: {} } };
  const urls = []; const ff = async u => { urls.push(u); return u.includes("brasilapi") ? new Response("x", { status: 500 }) : new Response(JSON.stringify(ws)); };
  const r = await call("/cnpj/" + CNPJ, { fetch: ff }); const c = await r.json();
  assert.equal(c.provedor, "CNPJ.ws"); assert.ok(urls.some(u => u.includes("publica.cnpj.ws")));
  assert.equal((await call("/cnpj/" + CNPJ, { fetch: async () => new Response("{}", { status: 404 }) })).status, 404);
  const down = await call("/cnpj/" + CNPJ, { fetch: async () => new Response("x", { status: 502 }) });
  assert.equal(down.status, 503);
});

test("Worker: limite por IP devolve 429 com Retry-After; reserva KV vira resposta desatualizada", async () => {
  const env = { ALLOWED_ORIGIN: "https://site.exemplo", RATE_LIMIT_PER_MIN: "2" };
  const s = []; for (let i = 0; i < 3; i++) s.push((await call("/cnpj/" + CNPJ, { env, ip: "9.9.9.9" })).status);
  assert.deepEqual(s, [200, 200, 429]);
  assert.equal((await call("/cnpj/" + CNPJ, { env, ip: "9.9.9.9" })).headers.get("Retry-After"), "60");
  const kv = new Map(); kv.set("cnpj:" + CNPJ, JSON.stringify({ schema: "empresa/v1", fonte: "BrasilAPI", consultadoEm: "2026-11-01T00:00:00Z", dados: E.normalizarBrasilApi(MOCK) }));
  const env2 = { ALLOWED_ORIGIN: "https://site.exemplo", CNPJ_KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) } };
  const r = await call("/cnpj/" + CNPJ, { env: env2, ip: "8.8.8.8", fetch: async () => new Response("x", { status: 503 }) });
  const corpo = await r.json(); assert.equal(r.status, 200); assert.equal(corpo.desatualizado, true); assert.equal(r.headers.get("X-Cache"), "STALE");
});

test("segurança: nenhuma credencial embutida no navegador nem no Worker", async () => {
  for (const f of ["../index.html", "../js/empresa.js", "../cloudflare-worker/worker.js", "../cloudflare-worker/wrangler.toml", "../data/config_empresa.json"]) {
    const t = await readFile(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(t, /(api[_-]?key|secret|password|senha|token)\s*[:=]\s*["'][^"']{8,}/i, f + ": atribuição de credencial");
    assert.doesNotMatch(t, /bearer\s+[A-Za-z0-9._-]{15,}/i, f + ": token Bearer");
  }
});
