// Constrói a tabela oficial de vínculos NBS -> cClassTrib a partir da API de dados abertos do Piloto RTC.
// Endpoint: GET /calculadora/dados-abertos/nbs-aplicaveis?cClassTrib=...&data=...
// Regra da API: sem NBS associadas, devolve TODAS as NBS vigentes (classificação genérica); só NCM -> lista vazia.
const digits = v => String(v == null ? "" : v).replace(/\D/g, "");

export async function construirVinculos({ get, classificacoes, totalNbsVigentes, data, concorrencia = 4 }) {
  const alvo = classificacoes.filter(c => String(c.nomenclatura || "").includes("NBS"));
  const resultado = {};
  const fila = [...alvo];
  const falhas = [];
  async function worker() {
    while (fila.length) {
      const c = fila.shift();
      try {
        const lista = await get(`/calculadora/dados-abertos/nbs-aplicaveis?cClassTrib=${c.codigo}&data=${data}`, { permitirVazio: true });
        if (!Array.isArray(lista)) throw new Error("resposta não é lista");
        const codigos = [...new Set(lista.map(x => digits(x.codigo)).filter(x => /^\d{9}$/.test(x)))];
        if (!codigos.length) continue;
        const todos = totalNbsVigentes > 0 && codigos.length >= totalNbsVigentes * 0.95;
        resultado[c.codigo] = todos ? { todos: true } : { todos: false, nbs: codigos.sort() };
      } catch (e) { falhas.push(`${c.codigo}: ${e.message}`); }
    }
  }
  await Promise.all(Array.from({ length: concorrencia }, worker));
  if (falhas.length) throw new Error(`Vínculos incompletos (${falhas.length} falha(s): ${falhas.slice(0, 3).join("; ")}); arquivo anterior preservado.`);
  if (!Object.keys(resultado).length) throw new Error("Nenhum vínculo NBS retornado; arquivo anterior preservado.");
  return {
    schemaVersion: 1, status: "SINCRONIZADO", dataReferencia: data, geradoEm: new Date().toISOString(),
    fonte: "Receita Federal — API de dados abertos do Piloto RTC (/dados-abertos/nbs-aplicaveis)",
    totalNbsVigentes, classificacoes: resultado
  };
}

/** Recusa substituir um arquivo bom por um claramente menor (ex.: API parcial). */
export function pareceRegressao(anterior, novo) {
  if (!anterior || anterior.status !== "SINCRONIZADO") return false;
  const a = Object.keys(anterior.classificacoes || {}).length, n = Object.keys(novo.classificacoes || {}).length;
  return a > 0 && n < a * 0.5;
}
