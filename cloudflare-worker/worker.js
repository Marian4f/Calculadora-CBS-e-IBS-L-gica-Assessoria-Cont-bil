/*
 * Worker de consulta cadastral de CNPJ (Cloudflare Workers).
 * GET /cnpj/{14 dígitos}  ->  { schema:"empresa/v1", fonte, provedor, consultadoEm, desatualizado?, dados }
 * GET /health             ->  estado da configuração (sem expor segredos)
 *
 * - CORS restrito a ALLOWED_ORIGIN (lista separada por vírgula). Sem a variável, nenhuma origem de navegador é liberada.
 * - Cache de borda (Cache API) por 24 h e, se CNPJ_KV existir, cópia por 7 dias usada só como reserva quando as fontes falham.
 * - Limite de requisições por IP/minuto (KV quando existir; senão memória do isolate, "melhor esforço").
 * - Nenhuma credencial no código: tokens, se um dia houver provedor pago, entram por `wrangler secret put`.
 */
const TTL_FRESCO_S = 24 * 3600;
const TTL_RESERVA_S = 7 * 24 * 3600;
const digits = v => String(v ?? "").replace(/\D/g, "");

export function validarCnpj(valor) {
  const c = digits(valor);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dv = n => {
    const p = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = p.reduce((s, x, i) => s + x * Number(c[i]), 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(c[12]) && dv(13) === Number(c[13]);
}

const cnae = (codigo, descricao) => {
  const c = digits(codigo);
  return c && Number(c) !== 0 ? { codigo: c.padStart(7, "0"), descricao: String(descricao || "") } : null;
};

export function normalizarBrasilApi(j) {
  if (!j || typeof j !== "object" || !j.razao_social) return null;
  const reg = (Array.isArray(j.regime_tributario) ? [...j.regime_tributario] : []).sort((a, b) => Number(a.ano) - Number(b.ano));
  const ult = reg[reg.length - 1];
  return {
    cnpj: digits(j.cnpj), razaoSocial: String(j.razao_social), nomeFantasia: String(j.nome_fantasia || ""),
    situacao: String(j.descricao_situacao_cadastral || ""), dataSituacao: String(j.data_situacao_cadastral || ""),
    motivoSituacao: String(j.descricao_motivo_situacao_cadastral || ""),
    cnaePrincipal: cnae(j.cnae_fiscal, j.cnae_fiscal_descricao),
    cnaesSecundarios: (Array.isArray(j.cnaes_secundarios) ? j.cnaes_secundarios : []).map(x => cnae(x?.codigo, x?.descricao)).filter(Boolean),
    endereco: { logradouro: [j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(" "), numero: String(j.numero || ""),
      complemento: String(j.complemento || ""), bairro: String(j.bairro || ""), cep: String(j.cep || "") },
    municipio: String(j.municipio || ""), uf: String(j.uf || ""), codigoMunicipioIbge: j.codigo_municipio_ibge ?? null,
    naturezaJuridica: String(j.natureza_juridica || ""), porte: String(j.porte || j.descricao_porte || ""),
    dataInicioAtividade: String(j.data_inicio_atividade || ""),
    regime: {
      simples: typeof j.opcao_pelo_simples === "boolean" ? j.opcao_pelo_simples : null,
      mei: typeof j.opcao_pelo_mei === "boolean" ? j.opcao_pelo_mei : null,
      formaTributacao: ult?.forma_de_tributacao ? `${ult.forma_de_tributacao}${ult.ano ? " (" + ult.ano + ")" : ""}` : null
    }
  };
}

// Formato da API pública CNPJ.ws (reserva). Mapeamento defensivo: campo ausente vira vazio/null, nunca valor inventado.
export function normalizarCnpjWs(j) {
  const e = j?.estabelecimento;
  if (!j || !e || !j.razao_social) return null;
  const sim = j.simples?.simples, mei = j.simples?.mei;
  const flag = v => (v === "Sim" ? true : v === "Não" ? false : null);
  return {
    cnpj: digits(e.cnpj), razaoSocial: String(j.razao_social), nomeFantasia: String(e.nome_fantasia || ""),
    situacao: String(e.situacao_cadastral || ""), dataSituacao: String(e.data_situacao_cadastral || ""),
    motivoSituacao: String(e.motivo_situacao_cadastral?.descricao || ""),
    cnaePrincipal: cnae(e.atividade_principal?.subclasse || e.atividade_principal?.id, e.atividade_principal?.descricao),
    cnaesSecundarios: (Array.isArray(e.atividades_secundarias) ? e.atividades_secundarias : []).map(x => cnae(x?.subclasse || x?.id, x?.descricao)).filter(Boolean),
    endereco: { logradouro: [e.tipo_logradouro, e.logradouro].filter(Boolean).join(" "), numero: String(e.numero || ""),
      complemento: String(e.complemento || ""), bairro: String(e.bairro || ""), cep: String(e.cep || "") },
    municipio: String(e.cidade?.nome || ""), uf: String(e.estado?.sigla || ""), codigoMunicipioIbge: e.cidade?.ibge_id ?? null,
    naturezaJuridica: String(j.natureza_juridica?.descricao || ""), porte: String(j.porte?.descricao || ""),
    dataInicioAtividade: String(e.data_inicio_atividade || ""),
    regime: { simples: flag(sim), mei: flag(mei), formaTributacao: null }
  };
}

export const PROVEDORES = [
  { nome: "BrasilAPI", fonte: "BrasilAPI — espelho dos dados abertos do CNPJ da Receita Federal", url: c => `https://brasilapi.com.br/api/cnpj/v1/${c}`, normalizar: normalizarBrasilApi },
  { nome: "CNPJ.ws", fonte: "CNPJ.ws (API pública) — dados abertos do CNPJ da Receita Federal", url: c => `https://publica.cnpj.ws/cnpj/${c}`, normalizar: normalizarCnpjWs }
];

const limitesMemoria = new Map();
async function excedeLimite(request, env) {
  const max = Number(env.RATE_LIMIT_PER_MIN) || 30;
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const janela = Math.floor(Date.now() / 60000), chave = `rl:${ip}:${janela}`;
  let n;
  if (env.CNPJ_KV) {
    n = Number(await env.CNPJ_KV.get(chave)) + 1 || 1;
    await env.CNPJ_KV.put(chave, String(n), { expirationTtl: 90 });
  } else {
    for (const k of limitesMemoria.keys()) if (!k.endsWith(":" + janela)) limitesMemoria.delete(k);
    n = (limitesMemoria.get(chave) || 0) + 1;
    limitesMemoria.set(chave, n);
  }
  return n > max;
}

function origensPermitidas(env) {
  return String(env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
function cors(request, env) {
  const origem = request.headers.get("Origin"), ok = origensPermitidas(env);
  const h = { "Vary": "Origin" };
  if (origem && ok.includes(origem)) {
    h["Access-Control-Allow-Origin"] = origem;
    h["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Accept, Content-Type";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
const json = (corpo, status, extra = {}) => new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extra } });
const erro = (status, codigo, mensagem, extra) => json({ erro: { codigo, mensagem } }, status, extra);

async function buscarNaFonte(prov, cnpj, ff) {
  for (let t = 1; t <= 2; t++) {
    try {
      const r = await ff(prov.url(cnpj), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return { naoEncontrado: true };
      if (r.ok) {
        const dados = prov.normalizar(await r.json());
        return dados ? { dados } : { falha: "resposta sem campos esperados" };
      }
      if (r.status !== 429 && r.status < 500) return { falha: "HTTP " + r.status };
    } catch (e) { /* tenta de novo / próxima fonte */ }
    if (t < 2) await new Promise(res => setTimeout(res, 500));
  }
  return { falha: "indisponível" };
}

// Proxy somente-leitura (lista fechada de parâmetros) do endpoint oficial ncm-aplicavel do Piloto RTC.
const RTC_BASE_PADRAO = "https://piloto-cbs.tributos.gov.br/servico/calculadora-consumo/api";
async function rtcNcmAplicavel(url, request, env, ctx, deps, c) {
  const cc = url.searchParams.get("cClassTrib") || "", ncm = url.searchParams.get("ncm") || "", data = url.searchParams.get("data") || "";
  if (!/^\d{6}$/.test(cc) || !/^\d{8}$/.test(ncm) || !/^\d{4}-\d{2}-\d{2}$/.test(data))
    return erro(400, "PARAMETROS_INVALIDOS", "Informe cClassTrib (6 dígitos), ncm (8 dígitos) e data (AAAA-MM-DD).", c);
  if (await excedeLimite(request, env)) return erro(429, "LIMITE_EXCEDIDO", "Muitas consultas; tente novamente em instantes.", { ...c, "Retry-After": "60" });
  const ff = deps.fetch || fetch, cache = deps.cache || (typeof caches !== "undefined" ? caches.default : null);
  const chave = new Request(`https://rtc-cache.interno/ncm/${cc}/${ncm}/${data}`);
  const hit = cache ? await cache.match(chave) : null;
  if (hit) return json(await hit.json(), 200, { ...c, "X-Cache": "HIT" });
  const base = (env.RTC_BASE || RTC_BASE_PADRAO).replace(/\/$/, "");
  try {
    const r = await ff(`${base}/calculadora/dados-abertos/classificacoes-tributarias/ncm-aplicavel?cClassTrib=${cc}&ncm=${ncm}&dataOcorrenciaFatoGerador=${data}`, { headers: { accept: "application/json" } });
    if (!r.ok) return erro(r.status === 404 ? 404 : 503, "RTC_INDISPONIVEL", "Consulta à base oficial falhou (HTTP " + r.status + ").", c);
    const o = await r.json();
    if (typeof o?.valido !== "boolean") return erro(503, "RTC_RESPOSTA_INVALIDA", "Resposta inesperada da base oficial.", c);
    const corpo = { schema: "rtc-ncm/v1", cClassTrib: cc, ncm, data, valido: o.valido, fonte: "Receita Federal — Piloto RTC (ncm-aplicavel)", consultadoEm: new Date((deps.agora || Date.now)()).toISOString() };
    if (cache) ctx.waitUntil(cache.put(chave, new Response(JSON.stringify(corpo), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL_FRESCO_S}` } })));
    return json(corpo, 200, { ...c, "X-Cache": "MISS" });
  } catch (e) { return erro(503, "RTC_INDISPONIVEL", "Base oficial indisponível agora.", c); }
}

export default {
  async fetch(request, env = {}, ctx = { waitUntil() {} }, deps = {}) {
    const ff = deps.fetch || fetch, agora = deps.agora || (() => Date.now());
    const url = new URL(request.url), c = cors(request, env);
    const origem = request.headers.get("Origin");
    if (origem && !origensPermitidas(env).includes(origem)) return erro(403, "ORIGEM_NAO_PERMITIDA", "Origem não autorizada para este serviço.", c);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: c });
    if (request.method !== "GET") return erro(405, "METODO_NAO_PERMITIDO", "Use GET.", c);
    if (url.pathname === "/health")
      return json({ ok: true, origemConfigurada: origensPermitidas(env).length > 0, kv: !!env.CNPJ_KV, provedores: PROVEDORES.map(p => p.nome) }, 200, c);
    if (url.pathname === "/rtc/ncm-aplicavel") return rtcNcmAplicavel(url, request, env, ctx, deps, c);
    const m = url.pathname.match(/^\/cnpj\/(\d{14})$/);
    if (!m) return erro(404, "ROTA_INEXISTENTE", "Use /cnpj/{14 dígitos} ou /rtc/ncm-aplicavel.", c);
    const cnpj = m[1];
    if (!validarCnpj(cnpj)) return erro(400, "CNPJ_INVALIDO", "CNPJ inválido (dígitos verificadores não conferem).", c);
    if (await excedeLimite(request, env)) return erro(429, "LIMITE_EXCEDIDO", "Muitas consultas; tente novamente em instantes.", { ...c, "Retry-After": "60" });

    const cache = deps.cache || (typeof caches !== "undefined" ? caches.default : null);
    const chaveCache = new Request("https://cnpj-cache.interno/" + cnpj);
    const hit = cache ? await cache.match(chaveCache) : null;
    if (hit) return json(await hit.json(), 200, { ...c, "X-Cache": "HIT" });

    for (const prov of PROVEDORES) {
      const r = await buscarNaFonte(prov, cnpj, ff);
      if (r.naoEncontrado) return erro(404, "NAO_ENCONTRADO", "CNPJ não localizado na fonte cadastral.", c);
      if (r.dados) {
        const corpo = { schema: "empresa/v1", fonte: prov.fonte, provedor: prov.nome, consultadoEm: new Date(agora()).toISOString(), dados: r.dados };
        if (cache) ctx.waitUntil(cache.put(chaveCache, new Response(JSON.stringify(corpo), { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL_FRESCO_S}` } })));
        if (env.CNPJ_KV) ctx.waitUntil(env.CNPJ_KV.put("cnpj:" + cnpj, JSON.stringify(corpo), { expirationTtl: TTL_RESERVA_S }));
        return json(corpo, 200, { ...c, "X-Cache": "MISS" });
      }
    }
    if (env.CNPJ_KV) {
      const reserva = await env.CNPJ_KV.get("cnpj:" + cnpj, "json");
      if (reserva) return json({ ...reserva, desatualizado: true }, 200, { ...c, "X-Cache": "STALE" });
    }
    return erro(503, "INDISPONIVEL", "Nenhuma fonte cadastral respondeu agora.", c);
  }
};
