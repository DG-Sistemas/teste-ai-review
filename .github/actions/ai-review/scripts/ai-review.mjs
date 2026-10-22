// Agente de Code Review com IA — v0 (agnóstico de provedor: qualquer API compatível com OpenAI)
// Sem dependências: usa só o Node 20+ (fetch nativo).
//
// O que faz:
//  1. Pega os arquivos alterados do PR (API do GitHub) — ou de um arquivo .diff local, para testes
//  2. Ignora o que não precisa revisar (lockfiles, vendor, imagens)
//  3. Classifica o PR: SIMPLES (modelo menor e rápido) ou COMPLEXO (modelo maior)
//  4. Divide diffs grandes em partes, para caber no limite do plano gratuito
//  5. Chama a IA principal (padrão: Groq); se bater o limite, espera; se falhar, usa a reserva (padrão: Cerebras)
//  6. Publica ou atualiza UM comentário no PR com a revisão
//  7. (Opcional) Falha o check se o veredito for "pedir mudanças"

import { readFile, appendFile } from "node:fs/promises";

// ---------- Configuração (vem das variáveis de ambiente) ----------
const env = (name, fallback) => (process.env[name] ?? "").trim() || fallback;
// Nome amigável do provedor a partir da URL (ex.: api.groq.com -> groq), para aparecer no comentário
const providerName = (url) => new URL(url).hostname.replace(/^api\./, "").split(".")[0];

function parsePrices(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    console.log("LLM_PRICES não é um JSON válido — custo não será estimado.");
    return {};
  }
}

const cfg = {
  githubToken: env("GITHUB_TOKEN"),
  repo: env("GITHUB_REPOSITORY"), // "dono/repo" — o Actions preenche sozinho
  pr: env("PR_NUMBER"),
  diffFile: env("DIFF_FILE"), // teste local: caminho de um arquivo gerado com `git diff`

  // Provedor principal (padrão: Groq). Trocar de provedor = mudar LLM_BASE_URL/LLM_API_KEY/modelos
  primary: {
    name: providerName(env("LLM_BASE_URL", "https://api.groq.com/openai/v1")),
    apiKey: env("LLM_API_KEY"),
    baseUrl: env("LLM_BASE_URL", "https://api.groq.com/openai/v1"),
    modelSimple: env("LLM_MODEL_SIMPLE", "openai/gpt-oss-20b"),
    modelComplex: env("LLM_MODEL_COMPLEX", "openai/gpt-oss-120b"),
  },
  // Provedor reserva (opcional, padrão: Cerebras)
  fallback: {
    name: providerName(env("FALLBACK_BASE_URL", "https://api.cerebras.ai/v1")),
    apiKey: env("FALLBACK_API_KEY"),
    baseUrl: env("FALLBACK_BASE_URL", "https://api.cerebras.ai/v1"),
    modelSimple: env("FALLBACK_MODEL", "gpt-oss-120b"),
    modelComplex: env("FALLBACK_MODEL", "gpt-oss-120b"),
  },

  // Quando um PR é considerado COMPLEXO
  complexLines: Number(env("COMPLEX_LINES", "300")), // linhas alteradas (+ e -)
  criticalPaths: new RegExp(
    env("CRITICAL_PATHS", "fiscal|financ|nfe|nfce|nfse|imposto|caixa|pagamento|migration|migrat|\\.sql$|auth|login|senha|password|permiss|token"),
    "i",
  ),

  // Tamanho de cada parte do diff (caracteres). ~12.000 cabe no limite gratuito de ~8.000 tokens/minuto.
  chunkChars: Number(env("CHUNK_CHARS", "12000")),
  maxChunks: Number(env("MAX_CHUNKS", "8")), // acima disso, o resto do diff é ignorado
  maxOutputTokens: Number(env("MAX_OUTPUT_TOKENS", "2000")),

  // Preço por modelo, em US$ por 1 milhão de tokens: {"modelo": [entrada, saida]}. Vazio = não estima custo.
  prices: parsePrices(env("LLM_PRICES")),

  failOnChanges: env("FAIL_ON_CHANGES") === "true",
  dryRun: env("DRY_RUN") === "1", // 1 = só imprime no terminal, não comenta no PR
  rulesFile: env("RULES_FILE", ".github/ai-review-rules.md"),
};

const MARKER = "<!-- ai-code-review -->"; // usado para achar e atualizar o próprio comentário
const INLINE_MARKER = "<!-- ai-code-review-inline -->"; // marca os comentários na linha, para não repetir
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arquivos que não vale a pena mandar para a IA (gastam limite e não agregam)
const IGNORE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock)$/,
  /(^|\/)(vendor|node_modules|dist|build)\//,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|svg|ico|pdf|zip|woff2?|ttf|eot)$/i,
];

function required(name, value) {
  if (!value) {
    console.error(`Faltando variável obrigatória: ${name}`);
    process.exit(1);
  }
}

// ---------- GitHub ----------
async function gh(path, options = {}) {
  const res = await fetch(`${env("GITHUB_API_URL", "https://api.github.com")}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} em ${path}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function getPrFiles() {
  const files = [];
  for (let page = 1; ; page++) {
    const batch = await gh(`/repos/${cfg.repo}/pulls/${cfg.pr}/files?per_page=100&page=${page}`);
    files.push(...batch);
    if (batch.length < 100) break;
  }
  return files;
}

// Primeira linha de cada commit: a IA avalia se o histórico explica a intenção da mudança
async function getPrCommits() {
  const commits = await gh(`/repos/${cfg.repo}/pulls/${cfg.pr}/commits?per_page=100`);
  return commits.map((c) => c.commit.message.split("\n")[0]);
}

async function upsertComment(body) {
  const comments = await gh(`/repos/${cfg.repo}/issues/${cfg.pr}/comments?per_page=100`);
  const mine = comments.find((c) => c.body?.includes(MARKER));
  if (mine) {
    await gh(`/repos/${cfg.repo}/issues/comments/${mine.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
  } else {
    await gh(`/repos/${cfg.repo}/issues/${cfg.pr}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }
}

// Achados que dá para comentar na linha: a linha precisa estar no diff (o GitHub recusa as outras)
function inlineCandidates(achados, validLines) {
  return achados.filter((a) => validLines.get(a.arquivo)?.has(Number(a.linha)));
}

function inlineBody(a) {
  return [
    INLINE_MARKER,
    `${ICON[a.severidade] ?? "•"} **${a.severidade}** — ${a.problema}`,
    a.sugestao ? `\n💡 ${a.sugestao}` : null,
  ].filter(Boolean).join("\n");
}

// Publica os achados como um review do GitHub (um comentário em cada linha).
// Não repete: se já existe comentário nosso ainda válido no mesmo arquivo a até 3 linhas, pula.
// (rodando de novo, a IA às vezes aponta o mesmo problema numa linha vizinha)
async function postInlineReview(achados, headSha) {
  const existing = await gh(`/repos/${cfg.repo}/pulls/${cfg.pr}/comments?per_page=100`);
  const already = existing.filter((c) => c.body?.includes(INLINE_MARKER) && c.line != null); // line null = desatualizado
  const isRepeated = (a) => already.some((c) => c.path === a.arquivo && Math.abs(c.line - Number(a.linha)) <= 3);
  const comments = achados
    .filter((a) => !isRepeated(a))
    .map((a) => ({ path: a.arquivo, line: Number(a.linha), side: "RIGHT", body: inlineBody(a) }));
  if (!comments.length) return 0;

  await gh(`/repos/${cfg.repo}/pulls/${cfg.pr}/reviews`, {
    method: "POST",
    body: JSON.stringify({
      commit_id: headSha,
      event: "COMMENT", // não bloqueia: quem bloqueia é o check (FAIL_ON_CHANGES)
      body: `🤖 ${comments.length} comentário(s) da IA na linha. Resumo geral no comentário "Code Review com IA".`,
      comments,
    }),
  });
  return comments.length;
}

// ---------- Teste local: lê um arquivo .diff no mesmo formato que a API do GitHub devolve ----------
function parseUnifiedDiff(text) {
  const files = [];
  for (const part of text.split(/^diff --git /m).slice(1)) {
    const header = part.split("\n")[0];
    const filename = (header.match(/ b\/(.+)$/) || [])[1] || header;
    const hunkStart = part.indexOf("\n@@");
    const patch = hunkStart >= 0 ? part.slice(hunkStart + 1).trimEnd() : "";
    const lines = patch.split("\n");
    files.push({
      filename,
      status: /\nnew file mode/.test(part) ? "added" : /\ndeleted file mode/.test(part) ? "removed" : "modified",
      additions: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
      deletions: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
      patch,
    });
  }
  return files;
}

// ---------- Numeração das linhas ----------
// Põe o número da linha do arquivo NOVO em cada linha do diff, para a IA apontar a linha real:
//    24 | +$sql = "SELECT ...";      (adicionada)
//    25 |  return $x;                (contexto)
//       | -$id = (int) $param['id']; (removida: não existe mais no arquivo)
// Também devolve as linhas que o GitHub aceita para comentário inline (adicionadas e de contexto).
function numberPatch(patch) {
  const out = [];
  const valid = new Set();
  let line = 0;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      line = Number(hunk[1]);
      out.push(raw);
    } else if (raw.startsWith("-")) {
      out.push(`      | ${raw}`);
    } else if (raw.startsWith("+") || raw.startsWith(" ")) {
      valid.add(line);
      out.push(`${String(line).padStart(5)} | ${raw}`);
      line++;
    } else {
      out.push(raw); // "\ No newline at end of file"
    }
  }
  return { text: out.join("\n"), valid };
}

// ---------- Montagem do contexto ----------
function prepare(files) {
  const reviewed = [];
  const skipped = [];
  for (const f of files) {
    if (IGNORE.some((re) => re.test(f.filename)) || !f.patch) skipped.push(f.filename);
    else reviewed.push(f);
  }

  const changedLines = reviewed.reduce((n, f) => n + f.additions + f.deletions, 0);
  const criticalFiles = reviewed.filter((f) => cfg.criticalPaths.test(f.filename)).map((f) => f.filename);
  const complex = changedLines > cfg.complexLines || criticalFiles.length > 0;

  // Divide em partes que caibam no limite do plano gratuito
  const chunks = [];
  let current = "";
  const ignoredBySize = [];
  const validLines = new Map(); // arquivo -> Set de linhas onde dá para comentar inline
  for (const f of reviewed) {
    const numbered = numberPatch(f.patch);
    validLines.set(f.filename, numbered.valid);
    let block = `\n### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n\`\`\`diff\n${numbered.text}\n\`\`\`\n`;
    if (block.length > cfg.chunkChars) {
      block = block.slice(0, cfg.chunkChars - 200) + "\n... (arquivo cortado: diff muito grande)\n```\n";
      ignoredBySize.push(`final de ${f.filename} (diff muito grande)`);
    }
    if (current.length + block.length > cfg.chunkChars && current) {
      chunks.push(current);
      current = "";
    }
    current += block;
  }
  if (current) chunks.push(current);

  const kept = chunks.slice(0, cfg.maxChunks);
  if (chunks.length > cfg.maxChunks) ignoredBySize.push(`${chunks.length - cfg.maxChunks} parte(s) do diff`);

  return { reviewed: reviewed.map((f) => f.filename), skipped, changedLines, criticalFiles, complex, chunks: kept, ignoredBySize, validLines };
}

async function loadRules() {
  try {
    return await readFile(cfg.rulesFile, "utf8");
  } catch {
    return "(Nenhum arquivo de regras encontrado — use boas práticas gerais.)";
  }
}

// ---------- Modelo ----------
const SYSTEM_PROMPT = `Você é um revisor de código sênior. O contexto do projeto vem nas "Regras do projeto".
Revise APENAS o que mudou no diff. Seja objetivo e útil: aponte bugs, falhas de segurança,
problemas de lógica, quebras de regra de negócio e violações das regras do projeto.
Não elogie à toa e não comente estilo trivial que um linter resolveria. Escreva em português.

Responda SOMENTE com um JSON válido neste formato:
{
  "resumo": "2-4 frases sobre o que o PR faz e a avaliação geral",
  "veredito": "aprovar" | "comentar" | "pedir_mudancas",
  "achados": [
    {
      "arquivo": "caminho/do/arquivo",
      "linha": 123,
      "severidade": "critico" | "alto" | "medio" | "baixo",
      "problema": "o que está errado e por quê",
      "sugestao": "como corrigir (pode incluir código curto)"
    }
  ],
  "revisao_humana": [
    { "arquivo": "caminho", "motivo": "por que um humano precisa olhar (ex.: fiscal, financeiro, migration, segurança)" }
  ],
  "qualidade_pr": { "ok": true | false, "comentario": "1-2 frases" }
}
Use "pedir_mudancas" somente se houver achado crítico ou alto. Se não houver nada relevante, "achados" deve ser [].
"linha": cada linha do diff vem no formato "  24 | +código" — o número à esquerda é a linha no arquivo.
Use exatamente esse número, da linha "+" onde está o problema (ou de contexto, se o problema for ali).
Linhas removidas ("      | -código") não têm número: aponte a linha "+" mais próxima.
"revisao_humana": se o diff mexe em algo que as Regras do projeto chamam de crítico, liste o arquivo
MESMO que o veredito seja "aprovar" — aprovar não dispensa o olho humano em área crítica.
"qualidade_pr": só preencha se a mensagem trouxer "Commits". Avalie se título, descrição e commits
explicam a intenção da mudança (ex.: "hotfix", "ajuste", "fix" sozinhos não dizem nada; bom é
"fix: busca de pedidos filtra pela loja da sessão"). Isso não muda o veredito. Sem "Commits", omita o campo.`;

class RateLimitError extends Error {}

async function chat(provider, model, userContent, { simpleRequest = false } = {}) {
  const body = {
    model,
    temperature: 0.1,
    max_tokens: cfg.maxOutputTokens,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };
  if (!simpleRequest) {
    body.response_format = { type: "json_object" };
    if (/gpt-oss/i.test(model)) body.reasoning_effort = "low"; // gasta menos tokens "pensando"
  }

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after")) || 30;
    throw Object.assign(new RateLimitError(`limite atingido em ${provider.name}`), { wait });
  }
  if (res.status === 400 && !simpleRequest) {
    // Alguns modelos não aceitam response_format/reasoning_effort: tenta de novo sem eles
    return chat(provider, model, userContent, { simpleRequest: true });
  }
  if (!res.ok) throw new Error(`${provider.name} ${res.status}: ${(await res.text()).slice(0, 500)}`);

  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content ?? "", usage: data.usage ?? {}, provider: provider.name, model };
}

// Tenta o principal (esperando se bater o limite); se não der, tenta a reserva
async function callWithFallback(userContent, complex) {
  const providers = [cfg.primary, cfg.fallback].filter((p) => p.apiKey);
  let lastError;
  for (const p of providers) {
    const model = complex ? p.modelComplex : p.modelSimple;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await chat(p, model, userContent);
      } catch (err) {
        lastError = err;
        if (err instanceof RateLimitError && attempt < 3 && err.wait <= 90) {
          console.log(`${err.message} — aguardando ${err.wait}s (tentativa ${attempt}/3)...`);
          await sleep(err.wait * 1000);
          continue;
        }
        console.log(`Falha em ${p.name} (${model}): ${err.message}`);
        break; // vai para o próximo provedor
      }
    }
  }
  throw lastError ?? new Error("Nenhum provedor configurado");
}

function parseJson(text) {
  // Alguns modelos embrulham o JSON em ```json ... ``` ou escrevem algo antes
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("sem JSON");
  return JSON.parse(text.slice(start, end + 1));
}

// ---------- Junta o resultado das partes ----------
const RANK = { aprovar: 0, comentar: 1, pedir_mudancas: 2 };

// incompleto = alguma parte falhou ou foi cortada por tamanho: o que não foi lido não pode ser aprovado
function merge(results, incompleto) {
  let veredito = results.reduce((v, r) => ((RANK[r.veredito] ?? 1) > (RANK[v] ?? 0) ? r.veredito : v), "aprovar");
  if (incompleto && veredito === "aprovar") veredito = "comentar";
  const resumos = results.map((r) => r.resumo).filter(Boolean);
  return {
    veredito,
    resumo: resumos.length > 1 ? resumos.map((s, i) => `**Parte ${i + 1}:** ${s}`).join("\n\n") : resumos[0] ?? "",
    achados: results.flatMap((r) => r.achados ?? []),
    revisao_humana: results.flatMap((r) => r.revisao_humana ?? []),
    qualidade_pr: results.find((r) => r.qualidade_pr)?.qualidade_pr,
  };
}

// Custo em US$ somando cada modelo usado; null se algum modelo não tiver preço em LLM_PRICES
function estimateCost(usageByModel) {
  let total = 0;
  for (const [model, u] of Object.entries(usageByModel)) {
    const price = cfg.prices[model];
    if (!Array.isArray(price)) return null;
    total += (u.in * price[0] + u.out * price[1]) / 1_000_000;
  }
  return total;
}

// ---------- Formatação do comentário ----------
const ICON = { critico: "🔴", alto: "🟠", medio: "🟡", baixo: "🔵" };
const VERDICT = {
  aprovar: "✅ Aprovado pela IA",
  comentar: "💬 Comentários (não bloqueia)",
  pedir_mudancas: "❌ Pede mudanças",
};

function formatComment(review, meta) {
  const lines = [MARKER, "## 🤖 Code Review com IA", "", `**${VERDICT[review.veredito] ?? review.veredito}**`, "", review.resumo];

  const order = ["critico", "alto", "medio", "baixo"];
  const achados = [...(review.achados ?? [])].sort((a, b) => order.indexOf(a.severidade) - order.indexOf(b.severidade));
  if (achados.length) {
    lines.push("", "### Achados", "");
    for (const a of achados) {
      const where = a.linha ? `\`${a.arquivo}:${a.linha}\`` : `\`${a.arquivo}\``;
      lines.push(`- ${ICON[a.severidade] ?? "•"} **${a.severidade}** — ${where}`, `  - ${a.problema}`);
      if (a.sugestao) lines.push(`  - 💡 ${a.sugestao}`);
    }
  }

  // Arquivos críticos sempre pedem olho humano, mesmo que a IA não diga
  const humanos = new Map((review.revisao_humana ?? []).map((h) => [h.arquivo, h.motivo]));
  for (const f of meta.criticalFiles) if (!humanos.has(f)) humanos.set(f, "área crítica (regra do projeto)");
  if (humanos.size) {
    lines.push("", "### 👀 Precisa de olho humano", "");
    for (const [arquivo, motivo] of humanos) lines.push(`- \`${arquivo}\` — ${motivo}`);
  }

  if (meta.incompleto) {
    lines.push("", "> ⚠️ Parte do diff não foi analisada (veja os detalhes), então a IA não pode aprovar este PR sozinha.");
  }

  // Só mostra se os commits foram enviados (modelos pequenos às vezes preenchem mesmo sem eles)
  const q = review.qualidade_pr;
  if (meta.hasCommits && q?.comentario) {
    lines.push("", `### 📝 Título, descrição e commits: ${q.ok ? "ok" : "podem melhorar"}`, "", q.comentario);
  }

  lines.push(
    "",
    "<details><summary>Detalhes da execução</summary>",
    "",
    `- Tipo de PR: **${meta.complex ? "complexo" : "simples"}** (${meta.changedLines} linhas alteradas${meta.criticalFiles.length ? ", toca área crítica" : ""})`,
    `- Modelo: \`${meta.models.join(", ")}\` via ${meta.providers.join(", ")}`,
    `- Partes analisadas: ${meta.parts} · arquivos revisados: ${meta.reviewed.length} · ignorados: ${meta.skipped.length}`,
    meta.ignoredBySize.length ? `- ⚠️ Não analisado por tamanho: ${meta.ignoredBySize.join(", ")}` : null,
    meta.failedParts ? `- ⚠️ ${meta.failedParts} parte(s) falharam (limite de uso do provedor) — rode de novo mais tarde` : null,
    `- Comentários na linha: ${meta.inlineCount} de ${(review.achados ?? []).length} achado(s) (os demais só aparecem aqui)`,
    `- Tokens: ${meta.tokensIn} entrada / ${meta.tokensOut} saída`,
    meta.cost === null
      ? "- Custo estimado: defina `LLM_PRICES` para calcular"
      : `- Custo estimado: US$ ${meta.cost.toFixed(4)} (preços de \`LLM_PRICES\`)`,
    "",
    "</details>",
  );
  return lines.filter((l) => l !== null).join("\n");
}

// ---------- Execução ----------
async function main() {
  required("LLM_API_KEY", cfg.primary.apiKey);
  const local = Boolean(cfg.diffFile);

  let title = "(teste local)";
  let description = "";
  let commits = [];
  let headSha = "";
  let files;
  if (local) {
    files = parseUnifiedDiff(await readFile(cfg.diffFile, "utf8"));
  } else {
    required("GITHUB_TOKEN", cfg.githubToken);
    required("GITHUB_REPOSITORY", cfg.repo);
    required("PR_NUMBER", cfg.pr);
    const pr = await gh(`/repos/${cfg.repo}/pulls/${cfg.pr}`);
    title = pr.title;
    description = pr.body || "";
    headSha = pr.head.sha; // o review inline precisa saber em qual commit está comentando
    files = await getPrFiles();
    commits = await getPrCommits();
  }

  const ctx = prepare(files);
  if (!ctx.chunks.length) {
    console.log("Nada para revisar (só arquivos ignorados).");
    return;
  }
  console.log(`PR ${ctx.complex ? "COMPLEXO" : "SIMPLES"}: ${ctx.changedLines} linhas, ${ctx.chunks.length} parte(s).`);

  const rules = await loadRules();
  const results = [];
  const providers = new Set();
  const usageByModel = {}; // { modelo: { in, out } } — para o custo, já que cada parte pode cair em outro modelo
  let tokensIn = 0;
  let tokensOut = 0;
  let failedParts = 0;

  for (let i = 0; i < ctx.chunks.length; i++) {
    const userContent = [
      "## Regras do projeto",
      rules,
      "## Pull Request",
      `Título: ${title}`,
      `Descrição:\n${description || "(sem descrição)"}`,
      // Commits só na 1ª parte: avaliados uma vez, sem gastar tokens repetindo
      i === 0 && commits.length ? `Commits:\n${commits.slice(0, 50).map((m) => `- ${m}`).join("\n")}` : null,
      ctx.chunks.length > 1 ? `## Diff — parte ${i + 1} de ${ctx.chunks.length}` : "## Diff",
      ctx.chunks[i],
    ].filter((s) => s !== null).join("\n\n");

    try {
      const r = await callWithFallback(userContent, ctx.complex);
      providers.add(r.provider);
      const u = (usageByModel[r.model] ??= { in: 0, out: 0 });
      u.in += r.usage.prompt_tokens ?? 0;
      u.out += r.usage.completion_tokens ?? 0;
      tokensIn += r.usage.prompt_tokens ?? 0;
      tokensOut += r.usage.completion_tokens ?? 0;
      try {
        results.push(parseJson(r.text));
      } catch {
        results.push({ resumo: "A IA não devolveu JSON válido nesta parte. Resposta bruta:\n\n" + r.text.slice(0, 3000), veredito: "comentar", achados: [] });
      }
    } catch (err) {
      failedParts++;
      console.error(`Parte ${i + 1} falhou: ${err.message}`);
    }
  }

  if (!results.length) {
    console.error("Nenhuma parte foi revisada (limite de uso do provedor ou chave inválida).");
    process.exit(1);
  }

  const models = Object.keys(usageByModel);
  const incompleto = failedParts > 0 || ctx.ignoredBySize.length > 0;
  const cost = estimateCost(usageByModel);
  const review = merge(results, incompleto);
  const inline = inlineCandidates(review.achados, ctx.validLines);
  const body = formatComment(review, {
    ...ctx,
    parts: ctx.chunks.length,
    failedParts,
    incompleto,
    inlineCount: inline.length,
    hasCommits: commits.length > 0,
    models,
    providers: [...providers],
    tokensIn,
    tokensOut,
    cost,
  });

  if (cfg.dryRun || local) {
    console.log("\n" + body);
    console.log(`\nComentários na linha (${inline.length}): ${inline.map((a) => `${a.arquivo}:${a.linha}`).join(", ") || "nenhum"}`);
  } else {
    await upsertComment(body);
    try {
      const posted = await postInlineReview(inline, headSha);
      console.log(`Comentários na linha: ${posted} novo(s) de ${inline.length} achado(s) com linha no diff.`);
    } catch (err) {
      // O resumo já foi publicado: falha no inline não derruba o review
      console.error(`Não foi possível publicar os comentários na linha: ${err.message}`);
    }
  }

  if (env("GITHUB_STEP_SUMMARY")) {
    await appendFile(
      env("GITHUB_STEP_SUMMARY"),
      `| PR | Tipo | Modelo | Partes | Tokens in | Tokens out | Custo (US$) | Veredito |\n|---|---|---|---|---|---|---|---|\n| #${cfg.pr} | ${ctx.complex ? "complexo" : "simples"} | ${models.join(", ")} | ${ctx.chunks.length} | ${tokensIn} | ${tokensOut} | ${cost === null ? "-" : cost.toFixed(4)} | ${review.veredito} |\n`,
    );
  }
  console.log(`\nConcluído. Veredito: ${review.veredito}. Tokens ${tokensIn}/${tokensOut}.${cost === null ? "" : ` Custo estimado: US$ ${cost.toFixed(4)}.`}`);

  if (cfg.failOnChanges && review.veredito === "pedir_mudancas") {
    console.error("A IA pediu mudanças — check marcado como falho.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
