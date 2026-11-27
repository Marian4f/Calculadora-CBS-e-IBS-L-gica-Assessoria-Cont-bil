// Atualiza tabelas públicas da Receita Federal/RTC com validação e gravação atômica por arquivo.
// Não altera as matrizes de enquadramento CNAE/NCM/NBS: elas exigem curadoria normativa.
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";

const BASE = process.env.RTC_API || "https://piloto-cbs.tributos.gov.br/servico/calculadora-consumo/api";
const data = new Date().toISOString().slice(0, 10);
const get = async path => {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Falha ao consultar ${path}: HTTP ${response.status}`);
  const value = await response.json();
  if (value == null || (Array.isArray(value) && value.length === 0))
    throw new Error(`Resposta vazia/inválida em ${path}; arquivos locais preservados.`);
  return value;
};
const validateArray = (value, name, predicate) => {
  if (!Array.isArray(value) || !value.length || !value.every(predicate))
    throw new Error(`Estrutura inválida para ${name}; arquivos locais preservados.`);
  return value;
};
const atomicWrite = async (name, value) => {
  const target = `data/${name}.json`, temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, target);
};

await mkdir("data", { recursive: true });
const [situacoes, classificacoes] = await Promise.all([
  get(`/calculadora/dados-abertos/situacoes-tributarias/cbs-ibs?data=${data}`),
  get(`/calculadora/dados-abertos/classificacoes-tributarias/cbs-ibs?data=${data}`)
]);
validateArray(situacoes, "situações tributárias", x => x && /^\\d{3}$/.test(String(x.codigo)) && Array.isArray(x.classificacoesTributarias));
validateArray(classificacoes, "classificações tributárias", x =>
  x && /^\\d{6}$/.test(String(x.codigo)) && Number.isFinite(Number(x.percentualReducaoCbs)) &&
  Number(x.percentualReducaoCbs) >= 0 && Number(x.percentualReducaoCbs) <= 100);

const current = JSON.parse(await readFile("data/meta_validacao.json", "utf8"));
const nextMeta = { ...current, updatedAt: new Date().toISOString(),
  officialTables: { source: BASE, date, situacoes: situacoes.length, classificacoes: classificacoes.length } };

// Todos os downloads e validações terminam antes de qualquer substituição.
// Os JSON são gravados em arquivos temporários e renomeados; falha de rede/schema não apaga a versão válida.
await atomicWrite("situacoes_tributarias_cbs_ibs", situacoes);
await atomicWrite("classificacoes_tributarias_cbs_ibs", classificacoes);
await atomicWrite("meta_validacao", nextMeta);
console.log(`Tabelas oficiais CBS atualizadas: ${situacoes.length} CSTs e ${classificacoes.length} cClassTrib.`);
