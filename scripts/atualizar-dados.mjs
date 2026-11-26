// Atualiza somente as tabelas oficiais necessárias para a simulação da CBS.
import { mkdir, writeFile } from "node:fs/promises";

const BASE = process.env.RTC_API || "https://piloto-cbs.tributos.gov.br/servico/calculadora-consumo/api";
const data = new Date().toISOString().slice(0, 10);
const get = async path => {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Falha ao consultar ${path}: HTTP ${response.status}`);
  return response.json();
};
const save = (name, value) => writeFile(`data/${name}.json`, JSON.stringify(value));

await mkdir("data", { recursive: true });
const [situacoes, classificacoes] = await Promise.all([
  get(`/calculadora/dados-abertos/situacoes-tributarias/cbs-ibs?data=${data}`),
  get(`/calculadora/dados-abertos/classificacoes-tributarias/cbs-ibs?data=${data}`)
]);

await Promise.all([
  save("situacoes_tributarias_cbs_ibs", situacoes),
  save("classificacoes_tributarias_cbs_ibs", classificacoes)
]);
console.log("Tabelas de classificação CBS atualizadas com sucesso.");
