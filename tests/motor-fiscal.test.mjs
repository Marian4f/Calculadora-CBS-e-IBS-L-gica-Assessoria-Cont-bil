import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { construirVinculos, pareceRegressao } from "../scripts/lib/vinculos.mjs";
import worker from "../cloudflare-worker/worker.js";
const require = createRequire(import.meta.url);
const M = require("../js/motor-fiscal.js");
const json = async n => JSON.parse(await readFile(new URL(`../data/${n}.json`, import.meta.url), "utf8"));
const fx = n => readFile(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const tag = (xml, t) => (xml.match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];

const [classificacoes, situacoes, vinculosReais] = await Promise.all([json("classificacoes_tributarias_cbs_ibs"), json("situacoes_tributarias_cbs_ibs"), json("vinculos_nbs_cclasstrib")]);
// FIXTURE SINTÉTICA — não é a base oficial. Reproduz apenas o formato que scripts/atualizar-dados.mjs grava.
const vinculosFixture = { status: "SINCRONIZADO", classificacoes: {
  "000001": { todos: true }, "200052": { todos: true }, "200027": { todos: true },
  "200046": { todos: false, nbs: ["101011100", "101011200"] } } };
const mk = (over = {}) => M.criarTabelas({ classificacoes, situacoes, vinculos: vinculosFixture, ...over });
const T = mk();

// Item montado a partir do XML real de referência (nunca copiando CST/cClassTrib como verdade).
async function itemReferencia() {
  const xml = await fx("nfse-referencia-campinas.xml");
  return {
    tipo: "servico", dfe: "NFS-e", codigo: tag(xml, "cNBS"), serviceCode: tag(xml, "cTribNac"), operationCode: tag(xml, "cIndOp"),
    data: tag(xml, "dhProc").slice(0, 10), base: 120000 - 780 - 3600 - 6000, tomadorTipo: "PF",
    declarado: { cst: xml.match(/<gIBSCBS><CST>(\d+)<\/CST>/)[1], cc: tag(xml, "cClassTrib") },
    xml: { vBCIbsCbs: 109620, pCBS: 0.9, vCBS: 986.58, pIBSUF: 0.1, vIBSUF: 109.62, pIBSMun: 0, vIBSMun: 0,
      tpRetISSQN: 1, vISSQN: 6000, pAliqAplic: 5, vBCIss: 120000, tpRetPisCofins: 0, vBCPisCofins: 120000, pAliqPis: 0.65, pAliqCofins: 3, vPis: 780, vCofins: 3600 }
  };
}

test("XML de referência: CST 000 / cClassTrib 000001 não são aceitos; redução oficial é aplicada e as divergências são listadas", async () => {
  const it = await itemReferencia();
  assert.deepEqual([it.codigo, it.serviceCode, it.operationCode, it.declarado.cst, it.declarado.cc], ["101011100", "071901", "020101", "000", "000001"]);
  const r = M.avaliarItem(it, T, { aliquotaCbs: 11.3, cnaes: ["4120400"] });
  assert.equal(r.status, "RECALCULADO");
  assert.equal(r.oficial.codigo, "200046");
  assert.equal(r.oficial.cst, "200");
  assert.equal(r.oficial.reducaoCbs, 50);
  assert.equal(r.aplicada, true);
  const campos = Object.fromEntries(r.divergencias.map(d => [d.campo, d]));
  assert.equal(campos["cClassTrib"].xml, "000001"); assert.equal(campos["cClassTrib"].oficial, "200046");
  assert.equal(campos["CST"].xml, "000"); assert.equal(campos["CST"].oficial, "200");
  assert.equal(campos["Redução CBS (%)"].oficial, 50);
  assert.equal(campos["Valor CBS"].xml, 986.58); assert.equal(campos["Valor CBS"].oficial, 493.29);
  assert.equal(campos["Valor IBS UF"].oficial, 54.81);
  assert.equal(campos["Base de cálculo IBS/CBS"], undefined, "base confere com o XML");
  assert.equal(r.recalculo.documento.cbs, 493.29);
  assert.equal(r.recalculo.projecao.cbs, +(109620 * 11.3 * 0.5 / 100).toFixed(2));
  // 200052 (profissões intelectuais, 30%) existe como alternativa, mas depende de requisito não comprovado no XML.
  assert.ok(r.alternativas.some(a => a.codigo === "200052" && a.reducaoCbs === 30));
});

test("estado atual do repositório: sem vínculos sincronizados, a NFS-e de referência NÃO recebe redução inventada", async () => {
  assert.equal(vinculosReais.status, "NAO_SINCRONIZADO");
  const Tv = M.criarTabelas({ classificacoes, situacoes, vinculos: vinculosReais });
  const r = M.avaliarItem(await itemReferencia(), Tv, { aliquotaCbs: 11.3 });
  assert.equal(r.status, "NECESSITA ANÁLISE"); assert.equal(r.aplicada, false); assert.equal(r.oficial, null);
  assert.equal(r.recalculo.projecao.efetivaCbs, 11.3);
  assert.match(r.motivos.join(" "), /não sincronizada/);
});

test("integral declarado e integral oficial: VÁLIDO, sem divergência", async () => {
  const it = { ...(await itemReferencia()), codigo: "115012300", xml: {} };
  const r = M.avaliarItem(it, T, { aliquotaCbs: 11.3 });
  assert.equal(r.status, "VÁLIDO"); assert.equal(r.oficial.codigo, "000001"); assert.equal(r.recalculo.projecao.efetivaCbs, 11.3);
  assert.equal(r.divergencias.length, 0);
});

test("XML declara redução genérica (200052) sem requisito comprovado: adota integral e sinaliza", async () => {
  const it = { ...(await itemReferencia()), codigo: "115012300", declarado: { cst: "200", cc: "200052" }, xml: {} };
  const r = M.avaliarItem(it, T, { aliquotaCbs: 11.3 });
  assert.equal(r.status, "RECALCULADO"); assert.equal(r.oficial.codigo, "000001");
  assert.match(r.motivos.join(" "), /requisito do emitente/);
  assert.ok(r.divergencias.some(d => d.campo === "cClassTrib" && d.gravidade === "ALTA"));
});

test("par CST × cClassTrib incompatível no XML é apontado como divergência", async () => {
  const r = M.avaliarItem({ ...(await itemReferencia()), codigo: "115012300", declarado: { cst: "000", cc: "200046" }, xml: {} }, T, {});
  assert.ok(r.divergencias.some(d => d.campo === "CST × cClassTrib"));
});

test("código ausente ou fora do catálogo: NÃO IDENTIFICADO, sem redução", async () => {
  assert.equal(M.avaliarItem({ ...(await itemReferencia()), codigo: "" }, T, {}).status, "NÃO IDENTIFICADO");
  const r = M.avaliarItem(await itemReferencia(), T, { catalogoOk: false });
  assert.equal(r.status, "NÃO IDENTIFICADO"); assert.equal(r.aplicada, false);
});

// ---- Produtos (NCM) ----
const nfe = (over = {}) => ({ tipo: "produto", dfe: "NF-e", codigo: "10063021", data: "2026-10-10", base: 1000, declarado: { cst: "000", cc: "000001" }, xml: { pCBS: 0.9, vCBS: 9 }, ...over });

test("NCM: classes a consultar são apenas as que admitem NCM no DF-e", () => {
  const cls = M.classesParaConsultaNcm(T, "NF-e");
  assert.ok(cls.includes("200034") && cls.includes("000001"));
  assert.ok(!cls.includes("200028"), "200028 é só NBS");
});

test("NCM com CST integral no XML e uma única redução oficial validada: redução automática", () => {
  const r = M.avaliarItem(nfe(), T, { aliquotaCbs: 11.3, ncmValidos: { ...Object.fromEntries(M.classesParaConsultaNcm(T, "NF-e").map(c => [c, false])), "000001": true, "200034": true } });
  assert.equal(r.status, "RECALCULADO"); assert.equal(r.oficial.codigo, "200034"); assert.equal(r.oficial.reducaoCbs, 60);
  assert.equal(r.recalculo.documento.cbs, 3.6); // 1000 × 0,9% × 40%
  assert.ok(r.divergencias.some(d => d.campo === "Valor CBS" && d.xml === 9 && d.oficial === 3.6));
});

test("NCM com classificações concorrentes e reduções diferentes: análise, nenhuma redução", () => {
  const todas = Object.fromEntries(M.classesParaConsultaNcm(T, "NF-e").map(c => [c, false]));
  const r = M.avaliarItem(nfe(), T, { aliquotaCbs: 11.3, ncmValidos: { ...todas, "000001": true, "200034": true, "200003": true } });
  assert.equal(r.status, "NECESSITA ANÁLISE"); assert.equal(r.aplicada, false);
  assert.equal(r.recalculo.projecao.efetivaCbs, 11.3);
  assert.equal(r.alternativas.length, 2);
});

test("NCM sem Worker/consulta oficial ou com consulta incompleta não aplica redução", () => {
  assert.equal(M.avaliarItem(nfe(), T, {}).status, "NECESSITA ANÁLISE");
  const r = M.avaliarItem(nfe(), T, { ncmValidos: { "000001": true, "200034": true } });
  assert.equal(r.aplicada, false);
});

// ---- CNAE ----
test("CNAE: regra curada vigente resolve o conflito; sem o CNAE, permanece em análise", () => {
  const todas = Object.fromEntries(M.classesParaConsultaNcm(T, "NF-e").map(c => [c, false]));
  const val = { ...todas, "000001": true, "200047": true, "200034": true };
  const regra = { cnaes: ["5611-2/01"], codes: ["10063021"], cClassTrib: "200047", reduction: 40, from: "2026-01-01", to: null, requiresCnae: true, source: "FIXTURE", legal: "FIXTURE" };
  const Tc = mk({ regras: { cnae: [regra] } });
  const com = M.avaliarItem(nfe(), Tc, { aliquotaCbs: 11.3, ncmValidos: val, cnaes: ["5611201"] });
  assert.equal(com.oficial.codigo, "200047"); assert.equal(com.oficial.reducaoCbs, 40); assert.match(com.oficial.origem, /CNAE/);
  const sem = M.avaliarItem(nfe(), Tc, { aliquotaCbs: 11.3, ncmValidos: val, cnaes: ["4120400"] });
  assert.equal(sem.status, "NECESSITA ANÁLISE");
  const vencida = mk({ regras: { cnae: [{ ...regra, to: "2026-06-30" }] } });
  assert.equal(M.avaliarItem(nfe(), vencida, { ncmValidos: val, cnaes: ["5611201"] }).status, "NECESSITA ANÁLISE");
  const recusada = mk({ regras: { cnae: [{ ...regra, cClassTrib: "200049" }] } }); // base oficial não aceita 200049 para o NCM
  assert.equal(M.avaliarItem(nfe(), recusada, { ncmValidos: val, cnaes: ["5611201"] }).status, "NECESSITA ANÁLISE");
});

test("regras curadas concorrentes não acumulam reduções", () => {
  const val = { ...Object.fromEntries(M.classesParaConsultaNcm(T, "NF-e").map(c => [c, false])), "000001": true, "200047": true, "200034": true };
  const base = { cnaes: ["5611201"], codes: ["10063021"], from: "2026-01-01", source: "F", legal: "F" };
  const Tc = mk({ regras: { cnae: [{ ...base, cClassTrib: "200047", reduction: 40 }, { ...base, cClassTrib: "200034", reduction: 60 }] } });
  const r = M.avaliarItem(nfe(), Tc, { ncmValidos: val, cnaes: ["5611201"] });
  assert.equal(r.status, "NECESSITA ANÁLISE"); assert.equal(r.aplicada, false);
});

// ---- Retenções ----
test("retenções declaradas são conferidas aritmeticamente; ISSQN adulterado gera alerta", async () => {
  const it = await itemReferencia();
  const ok = M.avaliarItem(it, T, {});
  assert.equal(ok.retencoes.iss.declarado, "não retido"); assert.equal(ok.retencoes.pisCofins.declarado, "não retido");
  assert.deepEqual(ok.retencoes.alertas, []);
  const ruim = M.avaliarItem({ ...it, xml: { ...it.xml, vISSQN: 5000 } }, T, {});
  assert.ok(ruim.retencoes.alertas.some(a => /ISSQN/.test(a)));
  assert.equal(ok.retencoes.cbsIbs.aplicada, false);
});

test("retenção de CBS/IBS só ocorre com regra oficial cadastrada e condições atendidas", async () => {
  const regra = { id: "FIXTURE-1", from: "2026-01-01", tomadorTipo: "PJ", nbs: ["101011100"], cbs: true, ibs: true, percentual: 100, fonte: "FIXTURE", fundamento: "FIXTURE" };
  const Tr = mk({ regras: { retencao: [regra] } });
  const it = await itemReferencia();
  assert.equal(M.avaliarItem(it, Tr, { aliquotaCbs: 11.3 }).retencoes.cbsIbs.aplicada, false, "tomador PF");
  const r = M.avaliarItem({ ...it, tomadorTipo: "PJ" }, Tr, { aliquotaCbs: 11.3 }).retencoes.cbsIbs;
  assert.equal(r.aplicada, true); assert.equal(r.regra, "FIXTURE-1"); assert.equal(r.cbs, 493.29); assert.equal(r.ibs, 54.81);
});

test("compra governamental: redutor oficial vigente reduz a alíquota efetiva, sem acumular com outra redução", async () => {
  const Tg = mk({ redutoresGov: [{ inicioVigencia: "2025-01-01", valor: 0 }, { inicioVigencia: "2026-07-01", valor: 10 }] });
  const r = M.avaliarItem({ ...(await itemReferencia()), tomadorGoverno: true }, Tg, { aliquotaCbs: 10 });
  assert.equal(r.recalculo.redutorGovernamental, 10);
  assert.equal(r.recalculo.projecao.efetivaCbs, 4.5); // 10% × (1−50%) × (1−10%)
});

// ---- Atualizador ----
test("atualizador: distingue vínculo explícito de classificação genérica e preserva dados em falha", async () => {
  const nbsTodas = Array.from({ length: 100 }, (_, i) => ({ codigo: String(100000000 + i) }));
  const get = async path => {
    const cc = path.match(/cClassTrib=(\d+)/)[1];
    if (cc === "000001") return nbsTodas;
    if (cc === "200046") return [{ codigo: "1.0101.11.00" }, { codigo: "101011100" }].map(x => ({ codigo: x.codigo.replace(/\D/g, "").padEnd(9, "0") }));
    return [];
  };
  const classes = [{ codigo: "000001", nomenclatura: "NBS ou NCM" }, { codigo: "200046", nomenclatura: "NBS ou NCM" }, { codigo: "200003", nomenclatura: "NCM" }, { codigo: "200099", nomenclatura: "NBS" }];
  const v = await construirVinculos({ get, classificacoes: classes, totalNbsVigentes: 100, data: "2026-11-26" });
  assert.equal(v.status, "SINCRONIZADO");
  assert.deepEqual(v.classificacoes["000001"], { todos: true });
  assert.deepEqual(v.classificacoes["200046"], { todos: false, nbs: ["101011100"] });
  assert.equal(v.classificacoes["200003"], undefined, "NCM apenas: não consulta NBS");
  assert.equal(v.classificacoes["200099"], undefined, "lista vazia: não aplicável a serviços");
  await assert.rejects(construirVinculos({ get: async () => { throw new Error("HTTP 503"); }, classificacoes: classes, totalNbsVigentes: 100, data: "2026-11-26" }), /preservado/);
  assert.equal(pareceRegressao({ status: "SINCRONIZADO", classificacoes: { a: 1, b: 1, c: 1, d: 1 } }, { classificacoes: { a: 1 } }), true);
  assert.equal(pareceRegressao({ status: "NAO_SINCRONIZADO", classificacoes: {} }, { classificacoes: { a: 1 } }), false);
});

// ---- Worker: ncm-aplicavel ----
const callW = (path, ff, cache = new Map()) => worker.fetch(new Request("https://w.exemplo" + path, { headers: { Origin: "https://site.exemplo", "CF-Connecting-IP": "2.2.2.2" } }),
  { ALLOWED_ORIGIN: "https://site.exemplo" }, { waitUntil: p => p },
  { fetch: ff, cache: { match: async r => cache.has(r.url) ? new Response(cache.get(r.url)) : undefined, put: async (r, res) => { cache.set(r.url, await res.text()); } }, agora: () => 1_700_000_000_000 });

test("Worker /rtc/ncm-aplicavel: valida parâmetros, consulta a Receita, cacheia e não repassa lixo", async () => {
  const urls = []; const ff = async u => { urls.push(u); return new Response(JSON.stringify({ valido: true })); };
  const cache = new Map(), q = "?cClassTrib=200034&ncm=10063021&data=2026-10-10";
  assert.equal((await callW("/rtc/ncm-aplicavel?cClassTrib=x&ncm=1&data=y", ff)).status, 400);
  const a = await callW("/rtc/ncm-aplicavel" + q, ff, cache), corpo = await a.json();
  assert.equal(a.status, 200); assert.equal(corpo.valido, true); assert.match(urls[0], /ncm-aplicavel\?cClassTrib=200034&ncm=10063021&dataOcorrenciaFatoGerador=2026-10-10$/);
  assert.equal((await callW("/rtc/ncm-aplicavel" + q, ff, cache)).headers.get("X-Cache"), "HIT"); assert.equal(urls.length, 1);
  assert.equal((await callW("/rtc/ncm-aplicavel" + q, async () => new Response("x", { status: 500 }))).status, 503);
  assert.equal((await callW("/rtc/ncm-aplicavel" + q, async () => new Response(JSON.stringify({ outro: 1 })))).status, 503);
});

test("integração: index.html usa o motor, não copia CST/cClassTrib do XML como verdade e publica o relatório de divergências", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /js\/motor-fiscal\.js/);
  assert.match(html, /MotorFiscal\.avaliarItem/);
  assert.match(html, /Relatório de divergências/);
  assert.match(html, /vinculos_nbs_cclasstrib\.json/);
  assert.doesNotMatch(html, /const reduction=match\?\.reduction\?\?reducao/);
});
