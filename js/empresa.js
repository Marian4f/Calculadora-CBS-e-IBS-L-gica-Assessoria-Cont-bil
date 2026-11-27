/*
 * Identificação cadastral automática por CNPJ e cruzamentos informativos.
 * Script clássico (window.Empresa) e módulo CommonJS (testes em Node).
 *
 * Princípios:
 *  - nunca inventa dado: sem resposta de fonte confiável, o resultado é "NÃO IDENTIFICADO";
 *  - nenhuma credencial neste arquivo; fontes com credencial ficam no Worker;
 *  - similaridade textual é só um INDÍCIO e nunca confirma nem nega enquadramento.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Empresa = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const digits = v => String(v ?? "").replace(/\D/g, "");

  // ---------- CNPJ ----------
  function validarCnpj(valor) {
    const c = digits(valor);
    if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
    const dv = n => {
      const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const r = pesos.reduce((s, p, i) => s + p * Number(c[i]), 0) % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
  }
  const formatarCnpj = v => {
    const c = digits(v);
    return c.length === 14 ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : String(v || "");
  };
  const formatarCnae = v => {
    const c = digits(v);
    return c.length === 7 ? c.replace(/^(\d{4})(\d)(\d{2})$/, "$1-$2/$3") : String(v || "");
  };

  // ---------- Normalização da resposta cadastral ----------
  const cnae = (codigo, descricao) => {
    const c = digits(codigo);
    return c && Number(c) !== 0 ? { codigo: c.padStart(7, "0"), descricao: String(descricao || "") } : null;
  };

  function normalizarBrasilApi(j) {
    if (!j || typeof j !== "object" || !j.razao_social) return null;
    const regimes = Array.isArray(j.regime_tributario) ? [...j.regime_tributario] : [];
    regimes.sort((a, b) => Number(a.ano) - Number(b.ano));
    const ultimo = regimes[regimes.length - 1];
    return {
      cnpj: digits(j.cnpj),
      razaoSocial: String(j.razao_social || ""),
      nomeFantasia: String(j.nome_fantasia || ""),
      situacao: String(j.descricao_situacao_cadastral || ""),
      dataSituacao: String(j.data_situacao_cadastral || ""),
      motivoSituacao: String(j.descricao_motivo_situacao_cadastral || ""),
      cnaePrincipal: cnae(j.cnae_fiscal, j.cnae_fiscal_descricao),
      cnaesSecundarios: (Array.isArray(j.cnaes_secundarios) ? j.cnaes_secundarios : [])
        .map(x => cnae(x?.codigo, x?.descricao)).filter(Boolean),
      endereco: {
        logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" "),
        numero: String(j.numero || ""), complemento: String(j.complemento || ""),
        bairro: String(j.bairro || ""), cep: String(j.cep || "")
      },
      municipio: String(j.municipio || ""), uf: String(j.uf || ""),
      codigoMunicipioIbge: j.codigo_municipio_ibge ?? null,
      naturezaJuridica: String(j.natureza_juridica || ""),
      porte: String(j.porte || j.descricao_porte || ""),
      dataInicioAtividade: String(j.data_inicio_atividade || ""),
      regime: {
        simples: typeof j.opcao_pelo_simples === "boolean" ? j.opcao_pelo_simples : null,
        mei: typeof j.opcao_pelo_mei === "boolean" ? j.opcao_pelo_mei : null,
        formaTributacao: ultimo?.forma_de_tributacao ? `${ultimo.forma_de_tributacao}${ultimo.ano ? " (" + ultimo.ano + ")" : ""}` : null
      }
    };
  }

  // Aceita o formato já normalizado do Worker ("empresa/v1") ou o JSON bruto da BrasilAPI.
  function normalizar(bruto) {
    if (bruto?.schema === "empresa/v1" && bruto.dados?.razaoSocial) return bruto.dados;
    return normalizarBrasilApi(bruto);
  }

  // ---------- Cache local com validade ----------
  function criarCache(storage, prefixo = "cnpj:") {
    return {
      get(cnpj) {
        try { const v = storage?.getItem(prefixo + cnpj); return v ? JSON.parse(v) : null; } catch { return null; }
      },
      set(cnpj, registro) {
        try { storage?.setItem(prefixo + cnpj, JSON.stringify(registro)); } catch { /* cota cheia: segue sem cache */ }
      },
      remove(cnpj) { try { storage?.removeItem(prefixo + cnpj); } catch { /* ignora */ } }
    };
  }

  // ---------- Consulta ----------
  const REGISTRO = [];
  const registrar = (e) => { REGISTRO.push({ quando: new Date().toISOString(), ...e }); if (REGISTRO.length > 200) REGISTRO.shift(); };
  const registroFontes = () => REGISTRO.slice();

  const emVoo = new Map();
  let cadeia = Promise.resolve(), ultimaChamada = 0;
  const dormir = ms => new Promise(r => setTimeout(r, ms));
  function limitar(fn, { intervaloMs, agora, esperar }) {
    const p = cadeia.then(async () => {
      const falta = intervaloMs - (agora() - ultimaChamada);
      if (falta > 0) await esperar(falta);
      ultimaChamada = agora();
      return fn();
    });
    cadeia = p.catch(() => {});
    return p;
  }

  async function tentarFonte(fonte, cnpj, o) {
    for (let t = 1; t <= o.maxTentativas; t++) {
      let http = null;
      try {
        const r = await limitar(() => o.fetchImpl(fonte.url(cnpj), { headers: { accept: "application/json" } }), o);
        http = r.status;
        if (r.status === 404) { registrar({ cnpj, fonte: fonte.nome, resultado: "NÃO ENCONTRADO", http, tentativa: t }); return { naoEncontrado: true }; }
        if (r.status === 400) { registrar({ cnpj, fonte: fonte.nome, resultado: "REQUISIÇÃO RECUSADA", http, tentativa: t }); return { recusado: true, erro: "CNPJ recusado pela fonte (HTTP 400)." }; }
        if (r.ok) {
          const json = await r.json();
          const dados = normalizar(json);
          if (!dados) { registrar({ cnpj, fonte: fonte.nome, resultado: "RESPOSTA SEM DADOS ÚTEIS", http, tentativa: t }); return { erro: "Resposta da fonte sem os campos esperados." }; }
          registrar({ cnpj, fonte: fonte.nome, resultado: "OK", http, tentativa: t });
          return { dados, fonte: json.fonte || fonte.nome, consultadoEm: json.consultadoEm || new Date(o.agora()).toISOString(), desatualizado: !!json.desatualizado };
        }
        registrar({ cnpj, fonte: fonte.nome, resultado: "FALHA TEMPORÁRIA", http, tentativa: t });
        if (r.status !== 429 && r.status < 500) return { erro: "HTTP " + r.status };
      } catch (e) {
        registrar({ cnpj, fonte: fonte.nome, resultado: "SEM CONEXÃO: " + (e?.message || e), http, tentativa: t });
      }
      if (t < o.maxTentativas) await o.esperar(o.backoffMs * t);
    }
    return { erro: "Fonte indisponível após " + o.maxTentativas + " tentativa(s)." };
  }

  /**
   * Retorna { status, dados?, fonte?, consultadoEm?, validoAte?, aviso?, erro? }.
   * status: OK | CACHE | CACHE_VENCIDO | INVALIDO | NAO_ENCONTRADO | INDISPONIVEL
   */
  function consultarCnpj(cnpjBruto, opcoes = {}) {
    const c = digits(cnpjBruto);
    const o = {
      workerUrl: "", fallbackDireto: true, ttlMs: 7 * 864e5, maxTentativas: 2, backoffMs: 700, intervaloMs: 400,
      storage: typeof localStorage !== "undefined" ? localStorage : null,
      fetchImpl: (...a) => fetch(...a), agora: () => Date.now(), esperar: dormir, ...opcoes
    };
    if (!validarCnpj(c)) return Promise.resolve({ status: "INVALIDO", cnpj: c, erro: c ? "CNPJ inválido (dígitos verificadores não conferem)." : "CNPJ do emitente não encontrado no XML." });
    if (emVoo.has(c)) return emVoo.get(c);
    const p = (async () => {
      const cache = criarCache(o.storage), reg = cache.get(c), agora = o.agora();
      if (reg?.dados && agora - reg.salvoEm < o.ttlMs)
        return { status: "CACHE", cnpj: c, dados: reg.dados, fonte: reg.fonte, consultadoEm: reg.consultadoEm, validoAte: new Date(reg.salvoEm + o.ttlMs).toISOString() };
      const fontes = [];
      if (o.workerUrl) fontes.push({ nome: "Worker (backend próprio)", url: x => o.workerUrl.replace(/\/+$/, "") + "/cnpj/" + x });
      if (o.fallbackDireto || !o.workerUrl) fontes.push({ nome: "BrasilAPI (consulta direta do navegador)", url: x => "https://brasilapi.com.br/api/cnpj/v1/" + x });
      let ultimoErro = "";
      for (const f of fontes) {
        const r = await tentarFonte(f, c, o);
        if (r.naoEncontrado) return { status: "NAO_ENCONTRADO", cnpj: c, erro: "CNPJ não localizado na fonte cadastral." };
        if (r.dados) {
          const fonte = r.fonte.includes("BrasilAPI") || r.fonte.includes("Worker") ? r.fonte : r.fonte + " · via " + f.nome;
          // Dados já marcados como desatualizados pelo Worker não renovam o prazo local.
          if (!r.desatualizado) cache.set(c, { salvoEm: agora, dados: r.dados, fonte, consultadoEm: r.consultadoEm });
          return { status: "OK", cnpj: c, dados: r.dados, fonte, consultadoEm: r.consultadoEm, validoAte: new Date(agora + o.ttlMs).toISOString(),
            aviso: r.desatualizado ? "A fonte devolveu uma cópia anterior do cadastro (consulta atual indisponível)." : "" };
        }
        ultimoErro = r.erro || ultimoErro;
      }
      if (reg?.dados)
        return { status: "CACHE_VENCIDO", cnpj: c, dados: reg.dados, fonte: reg.fonte, consultadoEm: reg.consultadoEm, aviso: "Cadastro em cache já vencido; não foi possível atualizar agora (" + ultimoErro + ")." };
      return { status: "INDISPONIVEL", cnpj: c, erro: ultimoErro || "Nenhuma fonte cadastral respondeu." };
    })().finally(() => emVoo.delete(c));
    emVoo.set(c, p);
    return p;
  }

  async function consultarVarios(lista, opcoes = {}, progresso = () => {}) {
    const unicos = [...new Set(lista.map(digits))];
    const saida = {};
    for (let i = 0; i < unicos.length; i++) {
      progresso(i + 1, unicos.length, unicos[i]);
      saida[unicos[i]] = await consultarCnpj(unicos[i], opcoes);
    }
    return saida;
  }

  // ---------- Status da empresa ----------
  const SITUACOES_IMPEDITIVAS = ["BAIXADA", "INAPTA", "SUSPENSA", "NULA"];
  function statusEmpresa(res) {
    const motivos = [], avisos = [];
    if (!res || ["INVALIDO", "NAO_ENCONTRADO", "INDISPONIVEL"].includes(res.status)) {
      motivos.push(res?.erro || "Empresa não identificada.");
      return { status: "NÃO IDENTIFICADO", motivos, avisos };
    }
    const d = res.dados, sit = String(d.situacao || "").trim().toUpperCase();
    if (res.status === "MANUAL") avisos.push("CNAE declarado pelo operador; não confirmado em cadastro oficial.");
    if (res.aviso) avisos.push(res.aviso);
    if (res.status === "CACHE_VENCIDO") avisos.push("Cadastro possivelmente desatualizado.");
    if (d.regime?.simples === true || d.regime?.mei === true)
      avisos.push("Emitente optante pelo " + (d.regime.mei ? "MEI/" : "") + "Simples Nacional: a apuração de IBS/CBS tem regras próprias; este cálculo usa a alíquota do regime regular.");
    if (d.regime?.simples == null && !d.regime?.formaTributacao) avisos.push("Regime tributário não disponível na fonte consultada.");
    if (SITUACOES_IMPEDITIVAS.includes(sit)) {
      motivos.push("Situação cadastral do emitente: " + d.situacao + (d.dataSituacao ? " desde " + d.dataSituacao : "") + ".");
      return { status: "INCOMPATÍVEL", motivos, avisos };
    }
    if (!d.cnaePrincipal) { motivos.push("A fonte não informou o CNAE principal."); return { status: "NECESSITA ANÁLISE", motivos, avisos }; }
    if (res.status === "MANUAL") return { status: "NECESSITA ANÁLISE", motivos: ["CNAE informado manualmente."], avisos };
    if (sit !== "ATIVA") { motivos.push("Situação cadastral não confirmada como ATIVA (" + (d.situacao || "não informada") + ")."); return { status: "NECESSITA ANÁLISE", motivos, avisos }; }
    return { status: "VÁLIDO", motivos, avisos };
  }

  // ---------- Cruzamentos informativos ----------
  const PARADAS = new Set(("servico servicos outro outros outra outras demais exceto inclusive incluindo relacionado relacionados relacionada relacionadas " +
    "atividade atividades especificado especificados especificada especificadas nao para por com sem como que dos das uma uns umas ente entre sobre " +
    "mediante onde quando bem bens ainda apenas todo toda todos todas seus suas sua seu pelo pela pelos pelas").split(" "));
  const normalizarTexto = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  function tokens(t) {
    const s = new Set();
    for (const w of normalizarTexto(t).split(/[^a-z0-9]+/)) {
      if (w.length < 3 || PARADAS.has(w) || /^\d+$/.test(w)) continue;
      s.add(w.length > 5 ? w.slice(0, 5) : w);
    }
    return s;
  }
  function similaridade(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return null;
    let n = 0; for (const x of A) if (B.has(x)) n++;
    return n / Math.min(A.size, B.size);
  }
  const nivel = s => s === null ? "SEM_DADOS" : s >= 0.5 ? "ALTO" : s >= 0.2 ? "MÉDIO" : "BAIXO";

  /** Divergência descritiva entre o serviço (cTribNac) e a NBS informada. Indício, não prova. */
  function divergenciaServicoNbs(descServico, descNbs) {
    const score = similaridade(descServico, descNbs), n = nivel(score);
    return { score, nivel: n, divergente: n === "BAIXO" };
  }

  /** Aderência textual entre a descrição da operação e cada CNAE. Indício, não enquadramento. */
  function cruzarCnaes(cnaes, texto) {
    const lista = (cnaes || []).filter(Boolean);
    if (!lista.length || !String(texto || "").trim()) return { nivel: "SEM_DADOS", melhor: null, score: null };
    let melhor = null;
    for (const c of lista) {
      const s = similaridade(c.descricao, texto);
      if (s !== null && (melhor === null || s > melhor.score)) melhor = { codigo: c.codigo, descricao: c.descricao, score: s };
    }
    return melhor ? { nivel: nivel(melhor.score), melhor, score: melhor.score } : { nivel: "SEM_DADOS", melhor: null, score: null };
  }

  /** Estrutura do cTribNac: 2 dígitos de item, 2 de subitem e 2 de desdobro nacional (item/subitem da LC 116/2003). */
  function itemLc116(cTribNac) {
    const c = digits(cTribNac);
    if (c.length !== 6) return null;
    return { item: c.slice(0, 2), subitem: c.slice(2, 4), desdobro: c.slice(4, 6), referencia: `${Number(c.slice(0, 2))}.${c.slice(2, 4)}` };
  }

  const TIPO_CFOP = { 1: "entrada (mesma UF)", 2: "entrada (outra UF)", 3: "entrada do exterior", 5: "saída (mesma UF)", 6: "saída (outra UF)", 7: "saída para o exterior" };
  const tipoOperacaoCfop = cfop => TIPO_CFOP[String(digits(cfop))[0]] || "";

  return { digits, validarCnpj, formatarCnpj, formatarCnae, normalizarBrasilApi, normalizar, criarCache, consultarCnpj, consultarVarios,
    registroFontes, statusEmpresa, similaridade, divergenciaServicoNbs, cruzarCnaes, itemLc116, tipoOperacaoCfop };
});
