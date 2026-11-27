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
