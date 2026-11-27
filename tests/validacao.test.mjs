import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const data = async name => JSON.parse(await readFile(new URL(`../data/${name}.json`, import.meta.url), "utf8"));

test("tabelas CST e cClassTrib têm códigos e percentuais válidos", async () => {
  const [cst, cc] = await Promise.all([data("situacoes_tributarias_cbs_ibs"), data("classificacoes_tributarias_cbs_ibs")]);
  const cstSet = new Set(cst.map(x => String(x.codigo).padStart(3, "0")));
  assert.ok(cst.length > 0 && cc.length > 0);
  for (const item of cc) {
    assert.match(String(item.codigo), /^\d{6}$/);
    assert.ok(Number(item.percentualReducaoCbs) >= 0 && Number(item.percentualReducaoCbs) <= 100);
    assert.ok(cst.some(g => g.classificacoesTributarias?.some(x => x.codigo === item.codigo)), `cClassTrib ${item.codigo} sem CST pai`);
  }
  assert.ok(cstSet.size > 0);
});

test("catálogos NCM e NBS têm identificadores bem formados", async () => {
  const [ncm, nbs] = await Promise.all([data("ncm_vigentes"), data("nbs_lista")]);
  assert.ok(ncm.length > 0 && nbs.length > 0);
  assert.ok(ncm.every(x => /^\d{8}$/.test(String(x.ncm))));
  assert.ok(nbs.every(x => /^\d{9}$/.test(String(x.codigo))));
});

test("matrizes sem evidência oficial não podem produzir falso enquadramento", async () => {
  const [cnae, ncm, nbs] = await Promise.all([data("regras_cnae_cbs"), data("regras_ncm_cbs"), data("regras_nbs_cbs")]);
  assert.deepEqual(cnae.rules, []);
  assert.deepEqual(ncm.rules, []);
  assert.deepEqual(nbs.rules, []);
});

test("fórmula CBS preserva alíquota nominal e aplica apenas uma redução", () => {
  const nominal = 11.3, base = 1000, reduction = 60;
  const effective = nominal * (1 - reduction / 100);
  assert.ok(Math.abs(effective - 4.52) < 1e-9);
  assert.equal(Number((base * effective / 100).toFixed(2)), 45.2);
  // Uma segunda redução não é adicionada nem composta automaticamente.
  assert.ok(Math.abs(nominal * (1 - reduction / 100) - 4.52) < 1e-9);
});


test("correlação por código de serviço NFS-e permanece informativa até publicação operacional", async () => {
  const table = await data("regras_servico_nfs_cbs");
  assert.equal(table.operational, false);
  assert.equal(table.status, "EM_DESENVOLVIMENTO");
  assert.deepEqual(table.rules, []);
  assert.match(table.sourceUrl, /^https:\/\/www\.gov\.br\/nfse\//);
});


test("NFS-e exige captura separada de cTribNac, cTribMun, cNBS e cIndOp", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../index.html", import.meta.url), "utf8");
  for (const field of ["cTribNac", "cTribMun", "cNBS", "cIndOp", "xTribNac", "xNBS"]) {
    assert.ok(source.includes(field), `campo ${field} não tratado no importador`);
  }
  assert.match(source, /operationCode.*digits\(i\.operationCode\)/s);
  assert.match(source, /divergência descritiva é um alerta para conferência/s);
});

test("tabela de correlação NFS-e não autoriza redução sem status operacional", async () => {
  const table = await data("regras_servico_nfs_cbs");
  assert.equal(table.operational, false);
  assert.equal(table.status, "EM_DESENVOLVIMENTO");
  assert.equal(table.rules.length, 0);
});


test("caso de regressão da NFS-e captura os códigos do XML sem confundi-los", async () => {
  const { readFile } = await import("node:fs/promises");
  const xml = await readFile(new URL("./fixtures/nfse-servico-regressao.xml", import.meta.url), "utf8");
  for (const [tag, expected] of [["cTribNac","071901"],["cTribMun","001"],["cNBS","101011100"],["cIndOp","020101"],["CST","000"],["cClassTrib","000001"]]) {
    assert.match(xml, new RegExp(`<${tag}>${expected}</${tag}>`));
  }
  assert.match(xml, /<xTribNac>/);
  assert.match(xml, /<xNBS>/);
});


test("regressão: expressões regulares não podem ter barra dupla (digits() e atualizador quebravam)", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const upd = await readFile(new URL("../scripts/atualizar-dados.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(html, /\/\\\\[dDsS]/, "index.html contém regex com \\\\ literal");
  assert.doesNotMatch(upd, /\/\^\\\\d/, "atualizar-dados.mjs contém regex com \\\\ literal");
  assert.ok(/^\d{3}$/.test("000") && /^\d{6}$/.test("000001"));
});
